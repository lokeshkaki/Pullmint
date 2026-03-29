import https from 'https';

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
        comments?: Array<Record<string, unknown>>;
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
      getContent: (params: { owner: string; repo: string; path: string; ref?: string }) => Promise<{
        data:
          | {
              content?: string;
            }
          | Array<Record<string, unknown>>;
      }>;
    };
    checks: {
      listForRef: (params: { owner: string; repo: string; ref: string }) => Promise<{
        data: { check_runs: { conclusion?: string | null }[] };
      }>;
    };
  };
};

export type GitHubClient = GitHubRestClient;

const GITHUB_API_BASE = 'https://api.github.com';
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '88888';

let cachedClient: GitHubClient | undefined;
let cachedAt = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function fetchText(path: string, token: string, accept?: string): Promise<string> {
  const { statusCode, body } = await requestWithNodeHttp('GET', path, {
    Authorization: `Bearer ${token}`,
    ...(accept ? { Accept: accept } : {}),
  });

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`GitHub GET ${path} failed (${statusCode}): ${body}`);
  }
  return body;
}

async function fetchJson(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const { statusCode, body: text } = await requestWithNodeHttp(
    method,
    path,
    {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body ? JSON.stringify(body) : undefined
  );

  const parsed = text ? (JSON.parse(text) as unknown) : {};

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`GitHub ${method} ${path} failed (${statusCode}): ${text}`);
  }

  return parsed;
}

async function getInstallationToken(): Promise<string> {
  const { statusCode, body: text } = await requestWithNodeHttp(
    'POST',
    `/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      Authorization: 'Bearer e2e-test-jwt',
      Accept: 'application/vnd.github+json',
    }
  );

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`GitHub token exchange failed (${statusCode}): ${text}`);
  }

  const payload = JSON.parse(text) as { token: string };
  return payload.token;
}

function requestWithNodeHttp(
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${GITHUB_API_BASE}${path}`,
      {
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      }
    );

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function createClient(token: string): GitHubClient {
  return {
    rest: {
      pulls: {
        get: async ({ owner, repo, pull_number, mediaType }) => {
          const wantsDiff = mediaType?.format === 'diff';
          const path = `/repos/${owner}/${repo}/pulls/${pull_number}`;
          if (wantsDiff) {
            const data = await fetchText(path, token, 'application/vnd.github.v3.diff');
            return { data };
          }
          const data = await fetchJson('GET', path, token);
          return { data };
        },
        createReview: async ({ owner, repo, pull_number, ...rest }) => {
          return fetchJson(
            'POST',
            `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`,
            token,
            rest
          );
        },
      },
      issues: {
        createComment: async ({ owner, repo, issue_number, body }) => {
          return fetchJson(
            'POST',
            `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
            token,
            {
              body,
            }
          );
        },
        addLabels: async ({ owner, repo, issue_number, labels }) => {
          return fetchJson('POST', `/repos/${owner}/${repo}/issues/${issue_number}/labels`, token, {
            labels,
          });
        },
      },
      repos: {
        createDeployment: async ({ owner, repo, ...rest }) => {
          return fetchJson('POST', `/repos/${owner}/${repo}/deployments`, token, rest);
        },
        getCombinedStatusForRef: async ({ owner, repo, ref }) => {
          const data = (await fetchJson(
            'GET',
            `/repos/${owner}/${repo}/commits/${ref}/status`,
            token
          )) as {
            state?: string;
            statuses?: { context?: string; state?: string }[];
          };
          return {
            data: {
              state: data.state ?? 'success',
              statuses: data.statuses ?? [],
            },
          };
        },
        getContent: async ({ owner, repo, path, ref }) => {
          const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
          const data = (await fetchJson(
            'GET',
            `/repos/${owner}/${repo}/contents/${path}${query}`,
            token
          )) as { content?: string } | Array<Record<string, unknown>>;
          return { data };
        },
      },
      checks: {
        listForRef: async ({ owner, repo, ref }) => {
          const data = (await fetchJson(
            'GET',
            `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
            token
          )) as {
            check_runs?: { conclusion?: string | null }[];
          };
          return {
            data: {
              check_runs: data.check_runs ?? [],
            },
          };
        },
      },
    },
  };
}

export async function getGitHubInstallationClient(_repoFullName: string): Promise<GitHubClient> {
  const now = Date.now();
  if (cachedClient && now - cachedAt < TOKEN_TTL_MS) {
    return cachedClient;
  }

  const token = await getInstallationToken();
  cachedClient = createClient(token);
  cachedAt = now;
  return cachedClient;
}
