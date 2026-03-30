import { getConfig } from '../config';

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

jest.mock('../config', () => ({
  getConfig: jest.fn(),
  getConfigOptional: jest.fn(),
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

function getMockedConfig() {
  return jest.requireMock('../config') as {
    getConfig: jest.Mock;
    getConfigOptional: jest.Mock;
  };
}

describe('getGitHubInstallationClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { getConfigOptional } = getMockedConfig();

    (getConfig as jest.Mock).mockImplementation((key: string) => {
      if (key === 'GITHUB_APP_PRIVATE_KEY') return 'test-private-key';
      return 'test-value';
    });
    getConfigOptional.mockImplementation((key: string) => {
      if (key === 'GITHUB_APP_ID') return '123456';
      if (key === 'GITHUB_APP_INSTALLATION_ID') return undefined;
      return undefined;
    });
    mockRequest.mockResolvedValue({ data: { id: 999 } });
    mockGetInstallationOctokit.mockResolvedValue(mockClient);
    mockApp.mockImplementation(() => ({
      octokit: { request: mockRequest },
      getInstallationOctokit: mockGetInstallationOctokit,
    }));
  });

  it('throws when GITHUB_APP_PRIVATE_KEY is missing', async () => {
    (getConfig as jest.Mock).mockImplementation((key: string) => {
      if (key === 'GITHUB_APP_PRIVATE_KEY') {
        throw new Error(
          'Configuration key "GITHUB_APP_PRIVATE_KEY" not found. Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH environment variable.'
        );
      }
      return 'test-value';
    });
    const { getGitHubInstallationClient } = loadModule();
    await expect(getGitHubInstallationClient('owner/repo')).rejects.toThrow(
      'Configuration key "GITHUB_APP_PRIVATE_KEY" not found'
    );
  });

  it('throws when GITHUB_APP_ID is missing', async () => {
    const { getConfigOptional } = getMockedConfig();
    getConfigOptional.mockImplementation((key: string) => {
      if (key === 'GITHUB_APP_ID') return undefined;
      if (key === 'GITHUB_APP_INSTALLATION_ID') return undefined;
      return undefined;
    });

    const { getGitHubInstallationClient } = loadModule();

    await expect(getGitHubInstallationClient('owner/repo')).rejects.toThrow(
      'GITHUB_APP_ID is required'
    );
  });

  it('uses the installation id when provided', async () => {
    const { getConfigOptional } = getMockedConfig();
    getConfigOptional.mockImplementation((key: string) => {
      if (key === 'GITHUB_APP_ID') return '123456';
      if (key === 'GITHUB_APP_INSTALLATION_ID') return '321';
      return undefined;
    });

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

  it('should refresh client after token TTL expires', async () => {
    jest.useFakeTimers();

    const client1 = {
      rest: {
        pulls: { get: jest.fn(), createReview: jest.fn() },
        issues: { createComment: jest.fn() },
        repos: { createDeployment: jest.fn(), getCombinedStatusForRef: jest.fn() },
        checks: { listForRef: jest.fn() },
      },
    };
    const client2 = {
      rest: {
        pulls: { get: jest.fn(), createReview: jest.fn() },
        issues: { createComment: jest.fn() },
        repos: { createDeployment: jest.fn(), getCombinedStatusForRef: jest.fn() },
        checks: { listForRef: jest.fn() },
      },
    };
    mockGetInstallationOctokit.mockResolvedValueOnce(client1).mockResolvedValueOnce(client2);

    const { getGitHubInstallationClient } = loadModule();

    const first = await getGitHubInstallationClient('owner/repo');
    expect(first).toBe(client1);

    // Advance time past 50-minute TTL
    jest.advanceTimersByTime(51 * 60 * 1000);

    const second = await getGitHubInstallationClient('owner/repo');
    expect(second).toBe(client2);
    expect(second).not.toBe(first);
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('reads app id through getConfigOptional', async () => {
    const { getConfigOptional } = getMockedConfig();
    const { getGitHubInstallationClient } = loadModule();

    await getGitHubInstallationClient('owner/repo');

    expect(getConfigOptional).toHaveBeenCalledWith('GITHUB_APP_ID');
  });
});
