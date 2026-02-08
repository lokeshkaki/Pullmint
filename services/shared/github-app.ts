import { App } from 'octokit';
import { getSecret } from './secrets';

const GITHUB_APP_PRIVATE_KEY_ARN = process.env.GITHUB_APP_PRIVATE_KEY_ARN!;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;

type GitHubRestClient = {
  rest: {
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format?: string };
      }) => Promise<{ data: unknown }>;
      createReview: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
        body?: string;
      }) => Promise<unknown>;
    };
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
};

type GitHubAppClient = {
  octokit: {
    request: (route: string, params: { owner: string; repo: string }) => Promise<{ data: { id: number } }>;
  };
  getInstallationOctokit: (installationId: number) => Promise<GitHubRestClient>;
};

export type GitHubClient = GitHubRestClient;

let installationClient: GitHubClient | undefined;
let appClient: GitHubAppClient | undefined;

export async function getGitHubInstallationClient(repoFullName: string): Promise<GitHubClient> {
  if (installationClient) {
    return installationClient;
  }

  if (!GITHUB_APP_ID) {
    throw new Error('GITHUB_APP_ID is required to authenticate the GitHub App');
  }

  const privateKey = await getSecret(GITHUB_APP_PRIVATE_KEY_ARN);
  appClient = new App({ appId: GITHUB_APP_ID, privateKey }) as GitHubAppClient;

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
