import { App, Octokit } from 'octokit';
import { getSecret } from './secrets';

const GITHUB_APP_PRIVATE_KEY_ARN = process.env.GITHUB_APP_PRIVATE_KEY_ARN!;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;

let installationClient: Octokit | undefined;
let appClient: App | undefined;

export async function getGitHubInstallationClient(repoFullName: string): Promise<Octokit> {
  if (installationClient) {
    return installationClient;
  }

  if (!GITHUB_APP_ID) {
    throw new Error('GITHUB_APP_ID is required to authenticate the GitHub App');
  }

  const privateKey = await getSecret(GITHUB_APP_PRIVATE_KEY_ARN);
  appClient = new App({ appId: GITHUB_APP_ID, privateKey });

  let installationId = GITHUB_APP_INSTALLATION_ID
    ? Number(GITHUB_APP_INSTALLATION_ID)
    : undefined;

  if (!installationId) {
    const [owner, repo] = repoFullName.split('/');
    const installation = await appClient.octokit.request('GET /repos/{owner}/{repo}/installation', {
      owner,
      repo,
    });
    installationId = installation.data.id;
  }

  installationClient = await appClient.getInstallationOctokit(installationId);
  return installationClient;
}
