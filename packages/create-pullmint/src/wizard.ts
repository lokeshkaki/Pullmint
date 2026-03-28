import * as childProcess from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';
import prompts, { PromptObject } from 'prompts';
import {
  checkDockerInstalled,
  checkToolInstalled,
  composeLaunch,
  pullImages,
  waitForHealth,
} from './docker';
import { writeEnvFiles } from './env-generator';
import { buildManifestUrl, isValidPem, openBrowser } from './github-app';
import { randomAlphanumeric, randomHex, validateApiKey } from './secrets';
import { EnvConfig } from './templates/env.template';

const execAsync = promisify(childProcess.exec);

type WizardMode = 'docker' | 'actions';
type LlmProvider = 'anthropic' | 'openai' | 'google';
type ExposureMethod = 'domain' | 'cloudflare' | 'ngrok' | 'later';

interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
}

interface GitHubAppConfig {
  appId: string;
  privateKeyPath: string;
  privateKeyPemContent?: string;
  webhookSecret: string;
}

interface SecurityConfig {
  dashboardAuthToken: string;
  minioAccessKey: string;
  minioSecretKey: string;
  postgresPassword: string;
  signalIngestionHmacSecret: string;
  autoApproveRiskThreshold: number;
}

interface ExposureConfig {
  webhookBaseUrl: string;
  allowedOrigins: string;
  exposureMethod: ExposureMethod;
}

interface PromptResult {
  [key: string]: unknown;
}

async function ask<T extends PromptResult>(question: PromptObject): Promise<T> {
  const response = await prompts(question, {
    onCancel: () => {
      throw new Error('User force closed the prompt');
    },
  });

  return response as T;
}

function printBanner(): void {
  console.log('');
  console.log(
    chalk.cyan.bold('  ██████╗ ██╗   ██╗██╗     ██╗      ███╗   ███╗██╗███╗   ██╗████████╗')
  );
  console.log(
    chalk.cyan.bold('  ██╔══██╗██║   ██║██║     ██║      ████╗ ████║██║████╗  ██║╚══██╔══╝')
  );
  console.log(
    chalk.cyan.bold('  ██████╔╝██║   ██║██║     ██║      ██╔████╔██║██║██╔██╗ ██║   ██║   ')
  );
  console.log(
    chalk.cyan.bold('  ██╔═══╝ ██║   ██║██║     ██║      ██║╚██╔╝██║██║██║╚██╗██║   ██║   ')
  );
  console.log(
    chalk.cyan.bold('  ██║     ╚██████╔╝███████╗███████╗ ██║ ╚═╝ ██║██║██║ ╚████║   ██║   ')
  );
  console.log(
    chalk.cyan.bold('  ╚═╝      ╚═════╝ ╚══════╝╚══════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝   ')
  );
  console.log('');
  console.log(chalk.gray('  AI-powered PR analysis - https://github.com/lokeshkaki/pullmint'));
  console.log('');
}

function checkPrerequisites(): void {
  console.log(chalk.bold('\nChecking prerequisites...\n'));

  const { dockerOk, composeOk, dockerVersion, composeVersion } = checkDockerInstalled();

  let gitOk = false;
  let gitVersion: string | undefined;
  try {
    gitVersion = childProcess.execSync('git --version', { stdio: 'pipe' }).toString().trim();
    gitOk = true;
  } catch {
    gitOk = false;
  }

  const check = (ok: boolean, label: string, version?: string): void => {
    if (ok) {
      console.log(chalk.green(`  ✓ ${label}`) + chalk.gray(version ? `  (${version})` : ''));
      return;
    }

    console.log(chalk.red(`  ✗ ${label} - NOT FOUND`));
  };

  check(dockerOk, 'Docker', dockerVersion);
  check(composeOk, 'Docker Compose', composeVersion);
  check(gitOk, 'Git', gitVersion);
  console.log('');

  const missing: string[] = [];
  if (!dockerOk) missing.push('Docker - https://docs.docker.com/get-docker/');
  if (!composeOk) missing.push('Docker Compose - https://docs.docker.com/compose/install/');
  if (!gitOk) missing.push('Git - https://git-scm.com/downloads');

  if (missing.length === 0) {
    return;
  }

  console.log(chalk.red.bold('Missing required tools:\n'));
  missing.forEach((item) => console.log(chalk.red(`  • ${item}`)));
  console.log('');
  console.log(`Install the tools above and re-run: ${chalk.cyan('npx create-pullmint@latest')}`);
  process.exit(1);
}

async function promptInstallDir(): Promise<string> {
  const { installDir } = await ask<{ installDir?: string }>({
    type: 'text',
    name: 'installDir',
    message: 'Where should Pullmint be installed?',
    initial: './pullmint',
    validate: (value: string) => value.trim().length > 0 || 'Please enter a directory path.',
  });

  const absDir = path.resolve(process.cwd(), (installDir ?? './pullmint').toString());

  if (await fs.pathExists(absDir)) {
    const { overwrite } = await ask<{ overwrite?: boolean }>({
      type: 'confirm',
      name: 'overwrite',
      message: `Directory ${chalk.cyan(absDir)} already exists. Continue and update configuration?`,
      initial: true,
    });

    if (!overwrite) {
      console.log(chalk.yellow('\nSetup cancelled.'));
      process.exit(0);
    }
  }

  return absDir;
}

async function cloneRepo(installDir: string): Promise<void> {
  const spinner = ora('Cloning Pullmint repository...').start();

  try {
    if (await fs.pathExists(path.join(installDir, 'docker-compose.yml'))) {
      spinner.succeed('Pullmint files already present - skipping clone.');
      return;
    }

    await fs.ensureDir(path.dirname(installDir));
    await execAsync(
      `git clone --depth 1 https://github.com/lokeshkaki/pullmint.git "${installDir}"`
    );
    spinner.succeed('Repository cloned.');
  } catch (error: unknown) {
    spinner.fail('Failed to clone repository.');
    console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function promptLlmConfig(): Promise<LlmConfig> {
  console.log(chalk.bold('\nLLM Provider\n'));

  const { provider } = await ask<{ provider?: LlmProvider }>({
    type: 'select',
    name: 'provider',
    message: 'Which LLM provider do you want to use?',
    choices: [
      {
        title: 'Anthropic Claude (recommended)',
        description: 'claude-sonnet-4-6 for deep analysis, claude-haiku for summaries',
        value: 'anthropic',
      },
      {
        title: 'OpenAI',
        description: 'GPT-4o and GPT-4o-mini',
        value: 'openai',
      },
      {
        title: 'Google Gemini',
        description: 'Gemini 1.5 Pro and Gemini 1.5 Flash',
        value: 'google',
      },
    ],
    initial: 0,
  });

  const llmProvider = provider ?? 'anthropic';

  const keyHint: Record<LlmProvider, string> = {
    anthropic: 'sk-ant-...',
    openai: 'sk-...',
    google: 'AIza...',
  };

  const docsUrl: Record<LlmProvider, string> = {
    anthropic: 'https://console.anthropic.com',
    openai: 'https://platform.openai.com/api-keys',
    google: 'https://aistudio.google.com/app/apikey',
  };

  console.log(chalk.gray(`\nGet your API key at: ${docsUrl[llmProvider]}\n`));

  const { apiKey } = await ask<{ apiKey?: string }>({
    type: 'password',
    name: 'apiKey',
    message: `Enter your ${llmProvider} API key (${keyHint[llmProvider]}):`,
    validate: (value: string) => validateApiKey(llmProvider, value),
  });

  return {
    provider: llmProvider,
    apiKey: (apiKey ?? '').toString().trim(),
  };
}

async function promptGitHubApp(webhookBaseUrl: string): Promise<GitHubAppConfig> {
  console.log(chalk.bold('\nGitHub App Setup\n'));

  const { mode } = await ask<{ mode?: 'create' | 'existing' }>({
    type: 'select',
    name: 'mode',
    message: 'How do you want to set up the GitHub App?',
    choices: [
      { title: 'Create a new GitHub App (guided)', value: 'create' },
      { title: 'I already have a GitHub App', value: 'existing' },
    ],
    initial: 0,
  });

  if (mode === 'create') {
    return guidedGitHubAppCreation(webhookBaseUrl);
  }

  return collectGitHubAppCredentials();
}

async function guidedGitHubAppCreation(webhookBaseUrl: string): Promise<GitHubAppConfig> {
  const url = buildManifestUrl(webhookBaseUrl);

  console.log(`\n${chalk.bold('GitHub App Creation')}\n`);
  console.log(
    'Pullmint needs a GitHub App with these permissions:\n' +
      '  • pull_requests: write\n' +
      '  • checks: read\n' +
      '  • contents: read\n' +
      '  • deployments: read\n' +
      '\nEvents to subscribe:\n' +
      '  • pull_request\n' +
      '  • deployment_status\n'
  );

  console.log(chalk.cyan('Opening GitHub App creation page in your browser...\n'));
  console.log(chalk.gray('If the browser does not open, visit:\n') + chalk.cyan(url) + '\n');
  openBrowser(url);

  console.log(
    chalk.yellow(
      'Complete the form in your browser, click "Create GitHub App",\nthen return here and paste the credentials.\n'
    )
  );

  await ask<{ ready?: boolean }>({
    type: 'confirm',
    name: 'ready',
    message: 'Have you created the GitHub App?',
    initial: false,
  });

  return collectGitHubAppCredentials();
}

async function collectGitHubAppCredentials(): Promise<GitHubAppConfig> {
  const { appId } = await ask<{ appId?: string }>({
    type: 'text',
    name: 'appId',
    message: 'GitHub App ID (found in App settings -> About):',
    validate: (value: string) => /^\d+$/.test(value.trim()) || 'App ID must be numeric.',
  });

  const { keySource } = await ask<{ keySource?: 'paste' | 'path' }>({
    type: 'select',
    name: 'keySource',
    message: 'How do you want to provide the private key?',
    choices: [
      { title: 'Paste PEM content directly', value: 'paste' },
      { title: 'Enter path to .pem file', value: 'path' },
    ],
    initial: 0,
  });

  let privateKeyPath = './secrets/github-app.pem';
  let privateKeyPemContent: string | undefined;

  if (keySource === 'paste') {
    const { pem } = await ask<{ pem?: string }>({
      type: 'text',
      name: 'pem',
      message: 'Private key PEM:',
      validate: (value: string) =>
        isValidPem(value.trim()) || 'Does not look like a valid RSA private key.',
    });
    privateKeyPemContent = pem?.trim();
  } else {
    const { pemPath } = await ask<{ pemPath?: string }>({
      type: 'text',
      name: 'pemPath',
      message: 'Path to .pem file:',
      validate: (value: string) => value.trim().length > 0 || 'Please enter a file path.',
    });

    privateKeyPath = (pemPath ?? '').toString().trim();
  }

  const { webhookSecret } = await ask<{ webhookSecret?: string }>({
    type: 'text',
    name: 'webhookSecret',
    message: 'Webhook secret (press Enter to auto-generate):',
    initial: '',
  });

  const finalWebhookSecret = (webhookSecret ?? '').toString().trim() || randomHex(32);
  if (!(webhookSecret ?? '').toString().trim()) {
    console.log(chalk.gray(`  Auto-generated webhook secret: ${finalWebhookSecret}`));
  }

  return {
    appId: (appId ?? '').toString().trim(),
    privateKeyPath,
    privateKeyPemContent,
    webhookSecret: finalWebhookSecret,
  };
}

async function promptSecurityConfig(): Promise<SecurityConfig> {
  console.log(chalk.bold('\nSecurity & Secrets\n'));
  console.log(
    chalk.gray('Most secrets are auto-generated. You only need to configure the risk threshold.\n')
  );

  const dashboardAuthToken = randomHex(32);
  const minioAccessKey = `pullmint-${randomAlphanumeric(12)}`;
  const minioSecretKey = randomAlphanumeric(40);
  const postgresPassword = randomAlphanumeric(24);
  const signalIngestionHmacSecret = randomHex(32);

  console.log(chalk.green('  ✓') + ' Dashboard auth token - auto-generated');
  console.log(chalk.green('  ✓') + ' MinIO credentials - auto-generated');
  console.log(chalk.green('  ✓') + ' Postgres password - auto-generated');
  console.log(chalk.green('  ✓') + ' HMAC secret - auto-generated\n');

  const { autoApproveRiskThreshold } = await ask<{ autoApproveRiskThreshold?: number }>({
    type: 'number',
    name: 'autoApproveRiskThreshold',
    message:
      'Auto-approve PRs with risk score below: (0-100, default 25)\n' +
      chalk.gray('  Higher = more PRs auto-approved. Set 0 to disable.\n  '),
    initial: 25,
    min: 0,
    max: 100,
  });

  return {
    dashboardAuthToken,
    minioAccessKey,
    minioSecretKey,
    postgresPassword,
    signalIngestionHmacSecret,
    autoApproveRiskThreshold: autoApproveRiskThreshold ?? 25,
  };
}

async function promptWebhookExposure(): Promise<ExposureConfig> {
  console.log(chalk.bold('\nWebhook Exposure\n'));
  console.log(
    'GitHub needs to send webhook events to your Pullmint instance.\n' +
      'Your server must be reachable from the internet.\n'
  );

  const { method } = await ask<{ method?: ExposureMethod }>({
    type: 'select',
    name: 'method',
    message: 'How will GitHub reach your server?',
    choices: [
      {
        title: 'I have a public domain (production)',
        description: 'e.g. https://pullmint.example.com',
        value: 'domain',
      },
      {
        title: 'Cloudflare Tunnel (recommended for home/VPS)',
        description: 'Free, no port forwarding required',
        value: 'cloudflare',
      },
      {
        title: 'ngrok (quick dev tunnel)',
        description: 'Easy but URL changes on restart',
        value: 'ngrok',
      },
      {
        title: "I'll configure this later",
        description: 'Skip for now - webhook URL will be placeholder',
        value: 'later',
      },
    ],
    initial: 0,
  });

  if (method === 'domain') {
    const { domain } = await ask<{ domain?: string }>({
      type: 'text',
      name: 'domain',
      message: 'Your public domain (e.g. https://pullmint.example.com):',
      validate: (value: string) =>
        /^https?:\/\/.+/.test(value.trim()) || 'Must be a full URL starting with https://',
    });

    const base = (domain ?? '').toString().replace(/\/$/, '');
    return {
      webhookBaseUrl: base,
      allowedOrigins: base,
      exposureMethod: 'domain',
    };
  }

  if (method === 'cloudflare') {
    const installed = checkToolInstalled('cloudflared');
    if (!installed) {
      console.log(
        '\n' +
          chalk.yellow('cloudflared is not installed.') +
          '\nInstall it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/\nThen run:\n\n' +
          chalk.cyan('  cloudflared tunnel --url http://localhost:3000') +
          '\n\nThe tunnel URL will be your webhook base URL.\n'
      );
    } else {
      console.log(
        '\n' +
          chalk.green('cloudflared is installed.') +
          '\nAfter setup, run in a separate terminal:\n\n' +
          chalk.cyan('  cloudflared tunnel --url http://localhost:3000') +
          '\n\nCopy the HTTPS URL it prints and update ALLOWED_ORIGINS + your GitHub App webhook URL.\n'
      );
    }

    return {
      webhookBaseUrl: 'https://YOUR-TUNNEL-URL.trycloudflare.com',
      allowedOrigins: 'http://localhost:3001',
      exposureMethod: 'cloudflare',
    };
  }

  if (method === 'ngrok') {
    const installed = checkToolInstalled('ngrok');
    if (!installed) {
      console.log(
        '\n' +
          chalk.yellow('ngrok is not installed.') +
          '\nInstall it from: https://ngrok.com/download\nThen run:\n\n' +
          chalk.cyan('  ngrok http 3000') +
          '\n\nUse the Forwarding HTTPS URL as your webhook base URL.\n'
      );
    } else {
      console.log(
        '\n' +
          chalk.green('ngrok is installed.') +
          '\nAfter setup, run in a separate terminal:\n\n' +
          chalk.cyan('  ngrok http 3000') +
          '\n\nCopy the Forwarding HTTPS URL and update ALLOWED_ORIGINS + GitHub App webhook URL.\n'
      );
    }

    return {
      webhookBaseUrl: 'https://YOUR-NGROK-URL.ngrok.io',
      allowedOrigins: 'http://localhost:3001',
      exposureMethod: 'ngrok',
    };
  }

  return {
    webhookBaseUrl: 'https://CONFIGURE-YOUR-WEBHOOK-URL-HERE',
    allowedOrigins: 'http://localhost:3001',
    exposureMethod: 'later',
  };
}

function printReviewSummary(
  installDir: string,
  llm: LlmConfig,
  ghApp: GitHubAppConfig,
  sec: SecurityConfig,
  exposure: ExposureConfig
): void {
  console.log('\n' + chalk.bold('─────────────────────────────────────────'));
  console.log(chalk.bold(' Configuration Summary'));
  console.log(chalk.bold('─────────────────────────────────────────') + '\n');

  const row = (label: string, value: string): void => {
    console.log(`  ${chalk.gray(label.padEnd(28))} ${chalk.white(value)}`);
  };

  row('Install directory:', installDir);
  row('LLM provider:', llm.provider);
  row('LLM API key:', `${llm.apiKey.slice(0, 8)}...${llm.apiKey.slice(-4)}`);
  row('GitHub App ID:', ghApp.appId);
  row('Private key:', ghApp.privateKeyPemContent ? '(pasted PEM)' : ghApp.privateKeyPath);
  row('Webhook secret:', `${ghApp.webhookSecret.slice(0, 8)}...`);
  row('Webhook URL:', exposure.webhookBaseUrl);
  row('Dashboard token:', `${sec.dashboardAuthToken.slice(0, 8)}...`);
  row('Auto-approve below:', String(sec.autoApproveRiskThreshold));
  console.log('');
}

function printSuccessSummary(dashboardToken: string, githubAppId: string): void {
  console.log('');
  console.log(chalk.green.bold('  Pullmint is running!\n'));
  console.log(chalk.bold('  ─────────────────────────────────────────'));
  console.log(`  ${chalk.bold('Dashboard:')}     ${chalk.cyan('http://localhost:3001')}`);
  console.log(`  ${chalk.bold('Token:')}         ${chalk.cyan(dashboardToken)}`);
  console.log(
    `  ${chalk.bold('Admin queues:')} ${chalk.cyan('http://localhost:3000/admin/queues')}`
  );
  console.log(chalk.bold('  ─────────────────────────────────────────\n'));
  console.log(chalk.bold('  Next steps:\n'));
  console.log(
    `  1. Install the GitHub App on your repos:\n     ${chalk.cyan('https://github.com/settings/apps')}\n`
  );
  console.log('  2. Open a pull request on any installed repo.\n');
  console.log(
    '  3. Watch Pullmint analyze it in real-time at:\n     ' +
      `${chalk.cyan('http://localhost:3001')}\n`
  );

  if (githubAppId) {
    console.log(
      chalk.gray(
        '  Tip: update your GitHub App webhook URL if you set up a\n  tunnel (Cloudflare/ngrok) after this setup.\n'
      )
    );
  }
}

async function runGitHubActionsMode(): Promise<void> {
  console.log(chalk.bold('\nGitHub Actions Mode\n'));

  const { apiKey } = await ask<{ apiKey?: string }>({
    type: 'password',
    name: 'apiKey',
    message: 'Enter your Anthropic API key (sk-ant-...):',
    validate: (value: string) => validateApiKey('anthropic', value),
  });

  const workflowDir = path.join(process.cwd(), '.github', 'workflows');
  await fs.ensureDir(workflowDir);

  const workflowPath = path.join(workflowDir, 'pullmint.yml');
  const templatePath = path.join(__dirname, 'templates', 'github-action.yml');
  await fs.copy(templatePath, workflowPath);

  console.log(chalk.green('\n  Workflow written to: ') + chalk.cyan(workflowPath));
  console.log('\n' + chalk.bold('  Next steps:\n'));
  console.log(
    '  1. Add your API key as a GitHub repository secret:\n' +
      `     Name: ${chalk.cyan('ANTHROPIC_API_KEY')}\n` +
      `     Value: ${chalk.cyan(`${(apiKey ?? '').toString().slice(0, 8)}...`)}\n` +
      '     -> Go to: Settings -> Secrets and variables -> Actions\n'
  );
  console.log(
    '  2. Commit and push the workflow file:\n' +
      `${chalk.cyan('     git add .github/workflows/pullmint.yml\n')}` +
      `${chalk.cyan('     git commit -m "ci: add Pullmint PR analysis"\n')}` +
      `${chalk.cyan('     git push\n')}`
  );
  console.log('  3. Open a pull request to trigger your first analysis.\n');
}

export async function runWizard(): Promise<void> {
  printBanner();

  console.log(chalk.bold('Welcome to Pullmint setup!\n'));
  console.log(
    'This wizard will get you from zero to a running Pullmint instance.\nIt takes about 5 minutes.\n'
  );

  const { mode } = await ask<{ mode?: WizardMode }>({
    type: 'select',
    name: 'mode',
    message: 'How do you want to run Pullmint?',
    choices: [
      {
        title: 'Self-hosted (Docker Compose)',
        description: 'Full stack - API, workers, dashboard, Postgres, Redis, MinIO',
        value: 'docker',
      },
      {
        title: 'GitHub Actions only',
        description: 'No self-hosting - runs as a workflow in your existing repo',
        value: 'actions',
      },
    ],
    initial: 0,
  });

  if (mode === 'actions') {
    await runGitHubActionsMode();
    return;
  }

  checkPrerequisites();

  const installDir = await promptInstallDir();
  await cloneRepo(installDir);

  const llm = await promptLlmConfig();
  const exposure = await promptWebhookExposure();
  const ghApp = await promptGitHubApp(exposure.webhookBaseUrl);
  const sec = await promptSecurityConfig();

  printReviewSummary(installDir, llm, ghApp, sec, exposure);

  const { confirmed } = await ask<{ confirmed?: boolean }>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Proceed with setup?',
    initial: true,
  });

  if (!confirmed) {
    console.log(chalk.yellow('\nSetup cancelled. Run again to restart.\n'));
    process.exit(0);
  }

  const envConfig: EnvConfig = {
    llmProvider: llm.provider,
    llmApiKey: llm.apiKey,
    githubAppId: ghApp.appId,
    githubAppPrivateKeyPath: ghApp.privateKeyPath,
    githubWebhookSecret: ghApp.webhookSecret,
    signalIngestionHmacSecret: sec.signalIngestionHmacSecret,
    dashboardAuthToken: sec.dashboardAuthToken,
    minioAccessKey: sec.minioAccessKey,
    minioSecretKey: sec.minioSecretKey,
    postgresPassword: sec.postgresPassword,
    allowedOrigins: exposure.allowedOrigins,
    autoApproveRiskThreshold: sec.autoApproveRiskThreshold,
  };

  const configSpinner = ora('Writing configuration files...').start();
  try {
    const { envPath, pemPath } = await writeEnvFiles({
      installDir,
      config: envConfig,
      privateKeyPemContent: ghApp.privateKeyPemContent,
    });

    configSpinner.succeed(`Configuration written to ${envPath}`);
    if (pemPath) {
      console.log(chalk.gray(`  Private key written to ${pemPath}`));
    }
  } catch (error: unknown) {
    configSpinner.fail('Failed to write configuration files.');
    console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }

  const pullSpinner = ora(
    'Pulling Docker images from GHCR (this may take a few minutes)...'
  ).start();
  try {
    await pullImages(installDir);
    pullSpinner.succeed('Docker images pulled.');
  } catch (error: unknown) {
    pullSpinner.warn('Could not pull images - will use locally built images.');
    console.log(chalk.gray(error instanceof Error ? error.message : String(error)));
  }

  const launchSpinner = ora('Starting Pullmint with Docker Compose...').start();
  try {
    await composeLaunch(installDir);
    launchSpinner.succeed('Containers started.');
  } catch (error: unknown) {
    launchSpinner.fail('docker compose up failed.');
    console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    console.log(chalk.gray(`\nDebug: cd "${installDir}" && docker compose logs`));
    process.exit(1);
  }

  const healthSpinner = ora('Waiting for services to be ready...').start();
  try {
    await waitForHealth({
      timeoutMs: 120_000,
      intervalMs: 2_000,
      onTick: (elapsedMs) => {
        healthSpinner.text = `Waiting for services... (${Math.round(elapsedMs / 1000)}s)`;
      },
    });

    healthSpinner.succeed('All services are healthy.');
  } catch (error: unknown) {
    healthSpinner.fail('Services did not become healthy in time.');
    console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    console.log(chalk.gray(`\nDebug: cd "${installDir}" && docker compose logs api`));
    process.exit(1);
  }

  printSuccessSummary(sec.dashboardAuthToken, ghApp.appId);
}
