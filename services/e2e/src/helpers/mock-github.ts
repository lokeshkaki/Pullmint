// services/e2e/src/helpers/mock-github.ts
import nock from 'nock';
import { SAMPLE_DIFF_LARGE } from './fixtures';

const INSTALLATION_ID = 88888;

/**
 * Mock the GitHub App installation token exchange.
 * Called once per Octokit client instantiation (cached for 50 min in github-app.ts).
 */
export function mockGitHubAppAuth(): nock.Scope {
  return nock('https://api.github.com')
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, {
      token: 'ghs_test_token',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
}

/**
 * Mock the diff fetch used by the analysis dispatcher.
 * GitHub returns diffs as `application/vnd.github.v3.diff` content type.
 */
export function mockGetDiff(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  diff?: string;
}): nock.Scope {
  const { owner, repo, prNumber, diff = SAMPLE_DIFF_LARGE } = opts;
  return nock('https://api.github.com')
    .get(`/repos/${owner}/${repo}/pulls/${prNumber}`)
    .reply(200, diff, { 'content-type': 'application/vnd.github.v3.diff' });
}

/**
 * Mock the `.pullmint.yml` contents fetch (returns 404 → default config used).
 */
export function mockNoPullmintConfig(opts: {
  owner: string;
  repo: string;
  headSha: string;
}): nock.Scope {
  return nock('https://api.github.com')
    .get(`/repos/${opts.owner}/${opts.repo}/contents/.pullmint.yml`)
    .query({ ref: opts.headSha })
    .reply(404, { message: 'Not Found' });
}

/**
 * Mock a `.pullmint.yml` with specific content.
 */
export function mockPullmintConfig(opts: {
  owner: string;
  repo: string;
  headSha: string;
  config: string;
}): nock.Scope {
  const encoded = Buffer.from(opts.config).toString('base64');
  return nock('https://api.github.com')
    .get(`/repos/${opts.owner}/${opts.repo}/contents/.pullmint.yml`)
    .query({ ref: opts.headSha })
    .reply(200, { content: encoded, encoding: 'base64' });
}

/**
 * Mock CI status checks fetch (returns empty — no checks running).
 */
export function mockGetCheckRuns(opts: {
  owner: string;
  repo: string;
  headSha: string;
}): nock.Scope {
  return nock('https://api.github.com')
    .get(`/repos/${opts.owner}/${opts.repo}/commits/${opts.headSha}/check-runs`)
    .reply(200, { check_runs: [], total_count: 0 });
}

/**
 * Mock the PR review creation — capture the posted body so tests can assert on it.
 * Returns a Jest mock function that receives the intercepted request body.
 */
export function mockCreateReview(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  onCall?: (body: Record<string, unknown>) => void;
}): nock.Scope {
  return nock('https://api.github.com')
    .post(`/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}/reviews`, (body) => {
      opts.onCall?.(body as Record<string, unknown>);
      return true;
    })
    .reply(200, { id: 1, body: 'review posted' });
}

/**
 * Mock the check-runs status update (used by github-integration to post CI status).
 */
export function mockCreateCheckRun(opts: { owner: string; repo: string }): nock.Scope {
  return nock('https://api.github.com')
    .post(`/repos/${opts.owner}/${opts.repo}/check-runs`)
    .reply(201, { id: 1 });
}

export function cleanupGitHubMocks(): void {
  nock.cleanAll();
}
