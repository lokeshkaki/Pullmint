import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

jest.mock('../../shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));

jest.mock('../../shared/error-handling', () => ({
  retryWithBackoff: jest.fn().mockImplementation(async (fn: () => Promise<unknown>) => await fn()),
}));

import { handler } from '../index';
import { getGitHubInstallationClient } from '../../shared/github-app';
import { retryWithBackoff } from '../../shared/error-handling';

const ddbMock = mockClient(DynamoDBDocumentClient);

const EXECUTIONS_TABLE = 'test-executions';
const DEP_GRAPH_TABLE = 'test-dep-graph';

const getGitHubMock = getGitHubInstallationClient as jest.Mock;
const retryMock = retryWithBackoff as jest.Mock;

function makePackageJsonContent(deps: Record<string, string>): string {
  const pkg = { name: 'some-package', version: '1.0.0', dependencies: deps };
  return Buffer.from(JSON.stringify(pkg)).toString('base64');
}

beforeAll(() => {
  process.env.EXECUTIONS_TABLE_NAME = EXECUTIONS_TABLE;
  process.env.DEPENDENCY_GRAPH_TABLE_NAME = DEP_GRAPH_TABLE;
  process.env.GITHUB_APP_ID = 'test-app-id';
  process.env.GITHUB_APP_PRIVATE_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';
});

afterAll(() => {
  delete process.env.EXECUTIONS_TABLE_NAME;
  delete process.env.DEPENDENCY_GRAPH_TABLE_NAME;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY_ARN;
});

describe('dependency-scanner handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    ddbMock.reset();
    // Default: retryWithBackoff just calls fn() directly
    retryMock.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
  });

  it('scans executions table and writes dependency edges for known inter-repo dependencies', async () => {
    // Two repos: org/repo-a depends on org/repo-b (via '@org/repo-b')
    ddbMock.on(ScanCommand).resolves({
      Items: [{ repoFullName: 'org/repo-a' }, { repoFullName: 'org/repo-b' }],
    });
    ddbMock.on(PutCommand).resolves({});

    const requestMock = jest
      .fn()
      .mockImplementation((_route: string, params: Record<string, string>) => {
        if (params.repo === 'repo-a') {
          // repo-a depends on @org/repo-b
          return Promise.resolve({
            data: {
              content: makePackageJsonContent({ '@org/repo-b': '^1.0.0' }),
              encoding: 'base64',
            },
          });
        }
        // repo-b has no known inter-repo deps
        return Promise.resolve({
          data: {
            content: makePackageJsonContent({}),
            encoding: 'base64',
          },
        });
      });

    getGitHubMock.mockResolvedValue({ request: requestMock });

    await handler({} as never, {} as never, {} as never);

    const putCalls = ddbMock.commandCalls(PutCommand);
    // One edge: org/repo-b (upstream) → org/repo-a (dependent)
    expect(putCalls.length).toBe(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.repoFullName).toBe('org/repo-b');
    expect(item.dependentRepo).toBe('org/repo-a');
    expect(item.dependencyType).toBe('npm');
    // TTL should be approximately 48h from now
    expect(typeof item.ttl).toBe('number');
    expect(item.ttl as number).toBeGreaterThan(Math.floor(Date.now() / 1000) + 47 * 3600);
  });

  it('skips repo when GitHub returns 404 (no package.json)', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ repoFullName: 'org/repo' }] });

    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    getGitHubMock.mockResolvedValue({
      request: jest.fn().mockRejectedValue(notFoundError),
    });

    // Should not throw
    await expect(handler({} as never, {} as never, {} as never)).resolves.toBeUndefined();

    // No edges written for 404
    expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
  });

  it('does not write edges for packages that are not known repos in the org', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ repoFullName: 'org/my-service' }] });
    ddbMock.on(PutCommand).resolves({});

    getGitHubMock.mockResolvedValue({
      request: jest.fn().mockResolvedValue({
        data: {
          // axios and lodash are not known repos in this org
          content: makePackageJsonContent({ axios: '^1.0.0', lodash: '^4.0.0' }),
          encoding: 'base64',
        },
      }),
    });

    await handler({} as never, {} as never, {} as never);

    // No edges written for external packages
    expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
  });

  it('retries on GitHub rate limiting and succeeds on second call', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ repoFullName: 'org/repo' }] });
    ddbMock.on(PutCommand).resolves({});

    const rateLimitError = Object.assign(new Error('Rate exceeded'), {
      name: 'TooManyRequestsException',
    });
    const requestMock = jest
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        data: { content: makePackageJsonContent({}), encoding: 'base64' },
      });

    getGitHubMock.mockResolvedValue({ request: requestMock });

    // Override retryWithBackoff to simulate one retry
    retryMock.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch {
        return await fn(); // retry once
      }
    });

    await handler({} as never, {} as never, {} as never);

    // request was called twice (once failed, once succeeded)
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('handles empty executions table gracefully — no GitHub calls', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler({} as never, {} as never, {} as never);

    expect(getGitHubMock).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
  });

  it('continues to next repo when one repo fails unexpectedly', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ repoFullName: 'org/failing-repo' }, { repoFullName: 'org/ok-repo' }],
    });
    ddbMock.on(PutCommand).resolves({});

    const requestMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('Unexpected error')) // failing-repo throws
      .mockResolvedValueOnce({
        // ok-repo has no inter-repo deps
        data: { content: makePackageJsonContent({}), encoding: 'base64' },
      });

    getGitHubMock.mockResolvedValue({ request: requestMock });

    // Should not throw — continues to next repo
    await expect(handler({} as never, {} as never, {} as never)).resolves.toBeUndefined();

    // Both repos were attempted
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repos — calls GitHub API once per unique repo', async () => {
    // Items contains duplicate repoFullName entries
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { repoFullName: 'org/repo', status: 'confirmed' },
        { repoFullName: 'org/repo', status: 'monitoring' },
        { repoFullName: 'org/repo', status: 'deployed' },
      ],
    });

    const requestMock = jest.fn().mockResolvedValue({
      data: { content: makePackageJsonContent({}), encoding: 'base64' },
    });
    getGitHubMock.mockResolvedValue({ request: requestMock });

    await handler({} as never, {} as never, {} as never);

    // Only one GitHub API call despite 3 execution records for same repo
    expect(getGitHubMock).toHaveBeenCalledTimes(1);
  });
});
