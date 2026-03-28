import { execSync } from 'child_process';

export interface GitHubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export function buildAppManifest(webhookUrl: string, appName = 'pullmint'): GitHubAppManifest {
  const baseUrl = webhookUrl.replace(/\/$/, '');

  return {
    name: appName,
    url: baseUrl,
    hook_attributes: {
      url: `${baseUrl}/webhook`,
      active: true,
    },
    redirect_url: `${baseUrl}/setup/callback`,
    public: false,
    default_permissions: {
      pull_requests: 'write',
      checks: 'read',
      contents: 'read',
      deployments: 'read',
      statuses: 'read',
    },
    default_events: ['pull_request', 'deployment_status'],
  };
}

export function buildManifestUrl(
  webhookUrl: string,
  appName = 'pullmint',
  orgOrUser?: string
): string {
  const manifest = buildAppManifest(webhookUrl, appName);
  const encoded = encodeURIComponent(JSON.stringify(manifest));

  const base = orgOrUser
    ? `https://github.com/organizations/${orgOrUser}/settings/apps/new`
    : 'https://github.com/settings/apps/new';

  return `${base}?manifest=${encoded}`;
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
      return;
    }

    if (process.platform === 'win32') {
      execSync(`cmd /c start "" "${url}"`, { stdio: 'ignore' });
      return;
    }

    execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    // Ignore browser launch errors; caller prints the URL as fallback.
  }
}

export function isValidPem(pem: string): boolean {
  return (
    pem.includes('-----BEGIN RSA PRIVATE KEY-----') || pem.includes('-----BEGIN PRIVATE KEY-----')
  );
}
