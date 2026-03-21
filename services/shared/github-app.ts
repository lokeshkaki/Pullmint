import { App } from 'octokit';
import { getSecret } from './secrets';

if (!process.env.GITHUB_APP_PRIVATE_KEY_ARN) {
  throw new Error('GITHUB_APP_PRIVATE_KEY_ARN environment variable is required');
}
const GITHUB_APP_PRIVATE_KEY_ARN: string = process.env.GITHUB_APP_PRIVATE_KEY_ARN;
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
      addLabels: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }) => Promise<unknown>;
    };
    repos: {
      createDeployment: (params: {
        owner: string;
        repo: string;
        ref: string;
        environment?: string;
        auto_merge?: boolean;
        required_contexts?: string[];
        payload?: Record<string, unknown>;
      }) => Promise<unknown>;
      getCombinedStatusForRef: (params: { owner: string; repo: string; ref: string }) => Promise<{
        data: {
          state: string;
          statuses: { context?: string; state?: string }[];
        };
      }>;
    };
  };
};

type GitHubAppClient = {
  octokit: {
    request: (
      route: string,
      params: { owner: string; repo: string }
    ) => Promise<{ data: { id: number } }>;
  };
  getInstallationOctokit: (installationId: number) => Promise<GitHubRestClient>;
};

export type GitHubClient = GitHubRestClient;

let installationClient: GitHubClient | undefined;
let cachedRepoFullName: string | undefined;
let cachedAt: number | undefined;
let appClient: GitHubAppClient | undefined;

const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes (tokens expire at 60, refresh early)

export async function getGitHubInstallationClient(repoFullName: string): Promise<GitHubClient> {
  const now = Date.now();
  const isExpired = cachedAt !== undefined && now - cachedAt > TOKEN_TTL_MS;

  if (installationClient && cachedRepoFullName === repoFullName && !isExpired) {
    return installationClient;
  }

  if (!GITHUB_APP_ID) {
    throw new Error('GITHUB_APP_ID is required to authenticate the GitHub App');
  }

  const privateKey = await getSecret(GITHUB_APP_PRIVATE_KEY_ARN);
  appClient = new App({ appId: GITHUB_APP_ID, privateKey }) as GitHubAppClient;

  let installationId = GITHUB_APP_INSTALLATION_ID ? Number(GITHUB_APP_INSTALLATION_ID) : undefined;

  if (!installationId) {
    const [owner, repo] = repoFullName.split('/');
    const installation = await appClient.octokit.request('GET /repos/{owner}/{repo}/installation', {
      owner,
      repo,
    });
    installationId = installation.data.id;
  }

  installationClient = await appClient.getInstallationOctokit(installationId);
  cachedRepoFullName = repoFullName;
  cachedAt = Date.now();
  return installationClient;
}
