import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { writeEnvFiles } from '../src/env-generator';
import { EnvConfig } from '../src/templates/env.template';

const baseConfig: EnvConfig = {
  llmProvider: 'anthropic',
  llmApiKey: 'sk-ant-test-key',
  githubAppId: '123456',
  githubAppPrivateKeyPath: './secrets/github-app.pem',
  githubWebhookSecret: 'webhook-secret-abc',
  signalIngestionHmacSecret: 'hmac-secret-abc',
  dashboardAuthToken: 'dash-token-abc',
  minioAccessKey: 'minio-key',
  minioSecretKey: 'minio-secret',
  postgresPassword: 'pg-password',
  allowedOrigins: 'http://localhost:3001',
  autoApproveRiskThreshold: 25,
};

describe('env-generator', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pullmint-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('writes .env file with all required variables', async () => {
    const { envPath } = await writeEnvFiles({ installDir: tmpDir, config: baseConfig });

    expect(await fs.pathExists(envPath)).toBe(true);
    const content = await fs.readFile(envPath, 'utf8');

    expect(content).toContain('LLM_PROVIDER=anthropic');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-test-key');
    expect(content).toContain('GITHUB_APP_ID=123456');
    expect(content).toContain('GITHUB_WEBHOOK_SECRET=webhook-secret-abc');
    expect(content).toContain('DASHBOARD_AUTH_TOKEN=dash-token-abc');
    expect(content).toContain('MINIO_ACCESS_KEY=minio-key');
    expect(content).toContain('POSTGRES_PASSWORD=pg-password');
    expect(content).toContain('AUTO_APPROVE_RISK_THRESHOLD=25');
  });

  it('uses OPENAI_API_KEY var for openai provider', async () => {
    const config: EnvConfig = { ...baseConfig, llmProvider: 'openai', llmApiKey: 'sk-openai' };
    const { envPath } = await writeEnvFiles({ installDir: tmpDir, config });
    const content = await fs.readFile(envPath, 'utf8');

    expect(content).toContain('OPENAI_API_KEY=sk-openai');
    expect(content).not.toContain('ANTHROPIC_API_KEY');
  });

  it('uses GOOGLE_API_KEY var for google provider', async () => {
    const config: EnvConfig = { ...baseConfig, llmProvider: 'google', llmApiKey: 'AIza-test' };
    const { envPath } = await writeEnvFiles({ installDir: tmpDir, config });
    const content = await fs.readFile(envPath, 'utf8');

    expect(content).toContain('GOOGLE_API_KEY=AIza-test');
  });

  it('writes PEM file when privateKeyPemContent is provided', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtest\n-----END RSA PRIVATE KEY-----';

    const { pemPath } = await writeEnvFiles({
      installDir: tmpDir,
      config: baseConfig,
      privateKeyPemContent: pem,
    });

    expect(pemPath).toBeDefined();
    expect(await fs.pathExists(pemPath as string)).toBe(true);

    const written = await fs.readFile(pemPath as string, 'utf8');
    expect(written.trim()).toBe(pem.trim());
  });

  it('does not write PEM file when content is empty', async () => {
    const { pemPath } = await writeEnvFiles({
      installDir: tmpDir,
      config: baseConfig,
      privateKeyPemContent: '',
    });

    expect(pemPath).toBeUndefined();
  });

  it('.env file has mode 0o600', async () => {
    const { envPath } = await writeEnvFiles({ installDir: tmpDir, config: baseConfig });
    const stat = await fs.stat(envPath);

    expect(stat.mode & 0o777).toBe(0o600);
  });
});
