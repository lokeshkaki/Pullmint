import { getSecret } from '../secrets';

const mockRequest = jest.fn();
const mockGetInstallationOctokit = jest.fn();
const mockApp = jest.fn();
const mockClient = {
  rest: {
    pulls: {
      get: jest.fn(),
      createReview: jest.fn(),
    },
    issues: {
      createComment: jest.fn(),
    },
  },
};

jest.mock('../secrets', () => ({
  getSecret: jest.fn(),
}));

jest.mock('octokit', () => ({
  App: mockApp,
}));

function loadModule() {
  let mod: typeof import('../github-app');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../github-app');
  });
  return mod!;
}

describe('getGitHubInstallationClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GITHUB_APP_PRIVATE_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';
    process.env.GITHUB_APP_ID = '123456';
    delete process.env.GITHUB_APP_INSTALLATION_ID;

    (getSecret as jest.Mock).mockResolvedValue('test-private-key');
    mockRequest.mockResolvedValue({ data: { id: 999 } });
    mockGetInstallationOctokit.mockResolvedValue(mockClient);
    mockApp.mockImplementation(() => ({
      octokit: { request: mockRequest },
      getInstallationOctokit: mockGetInstallationOctokit,
    }));
  });

  it('throws when GITHUB_APP_ID is missing', async () => {
    delete process.env.GITHUB_APP_ID;
    const { getGitHubInstallationClient } = loadModule();

    await expect(getGitHubInstallationClient('owner/repo')).rejects.toThrow(
      'GITHUB_APP_ID is required'
    );
  });

  it('uses the installation id when provided', async () => {
    process.env.GITHUB_APP_INSTALLATION_ID = '321';
    const { getGitHubInstallationClient } = loadModule();

    const client = await getGitHubInstallationClient('owner/repo');

    expect(client).toBe(mockClient);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith(321);
  });

  it('resolves installation id by repo when not provided', async () => {
    const { getGitHubInstallationClient } = loadModule();

    const client = await getGitHubInstallationClient('owner/repo');

    expect(client).toBe(mockClient);
    expect(mockRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/installation', {
      owner: 'owner',
      repo: 'repo',
    });
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith(999);
  });

  it('caches the installation client', async () => {
    const { getGitHubInstallationClient } = loadModule();

    const first = await getGitHubInstallationClient('owner/repo');
    const second = await getGitHubInstallationClient('owner/repo');

    expect(first).toBe(second);
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(1);
  });
});
