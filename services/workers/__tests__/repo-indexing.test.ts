import { processRepoIndexingJob } from '../src/processors/repo-indexing';
import type { Job } from 'bullmq';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    repoRegistry: {},
    fileKnowledge: {},
    authorProfiles: {},
    moduleNarratives: {},
    dependencyGraphs: {},
  },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    REPO_INDEXING: 'repo-indexing',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn().mockReturnValue('test-anthropic-key'),
  getConfigOptional: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@pullmint/shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  retryWithBackoff: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock('@pullmint/shared/llm', () => ({
  createLLMProvider: jest.fn(() => ({
    chat: jest.fn().mockResolvedValue({
      text: 'Module narrative for testing.',
      inputTokens: 80,
      outputTokens: 40,
    }),
  })),
}));

jest.mock(
  '../../repo-indexer/git-history',
  () => ({
    fetchFileTree: jest.fn().mockResolvedValue(['src/index.ts', 'src/auth.ts']),
    fetchFileCommitHistory: jest.fn().mockResolvedValue({
      filePath: 'src/index.ts',
      churnRate30d: 3,
      bugFixCommitCount30d: 1,
      authors: ['alice', 'bob'],
      commitMessages: [],
    }),
    aggregateAuthorProfiles: jest.fn().mockReturnValue([
      {
        authorLogin: 'alice',
        mergeCount30d: 5,
        frequentFiles: ['src/index.ts'],
        rollbackRate: 0,
      },
    ]),
  }),
  { virtual: true }
);

jest.mock(
  '../../repo-indexer/module-detector',
  () => ({
    detectModules: jest
      .fn()
      .mockReturnValue([
        { modulePath: 'src', entryPoint: 'src/index.ts', files: ['src/index.ts', 'src/auth.ts'] },
      ]),
  }),
  { virtual: true }
);

jest.mock(
  '../../repo-indexer/narrative-generator',
  () => ({
    generateModuleNarrative: jest.fn().mockResolvedValue('This module handles auth'),
  }),
  { virtual: true }
);

jest.mock(
  '../../repo-indexer/embeddings',
  () => ({
    generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  }),
  { virtual: true }
);

// ---- shared DB mock state ----
let mockDb: {
  select: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
};
let mockLimit: jest.Mock;
let mockReturning: jest.Mock;

const mockOctokit = {
  rest: {
    repos: {
      get: jest.fn(),
      getContent: jest.fn(),
    },
    pulls: {
      listFiles: jest.fn(),
    },
  },
  request: jest.fn(),
};

function buildMockDb(selectAllResult: unknown[] = []) {
  mockReturning = jest.fn().mockResolvedValue([]);
  mockLimit = jest.fn().mockResolvedValue([]);

  const makeWhereResult = () =>
    Object.assign(Promise.resolve(undefined) as Promise<unknown>, {
      returning: mockReturning,
      limit: mockLimit,
    });

  // from() result: supports both direct await (for select all) and .where().limit() chain
  const makeFromResult = () =>
    Object.assign(Promise.resolve(selectAllResult), {
      where: jest.fn().mockReturnValue(
        Object.assign(Promise.resolve(undefined) as Promise<unknown>, {
          limit: mockLimit,
          returning: mockReturning,
        })
      ),
      limit: mockLimit,
    });

  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockImplementation(makeFromResult),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(makeWhereResult),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        onConflictDoUpdate: jest.fn().mockReturnValue({ returning: mockReturning }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
  (
    jest.requireMock('@pullmint/shared/github-app') as { getGitHubInstallationClient: jest.Mock }
  ).getGitHubInstallationClient.mockResolvedValue(mockOctokit);

  mockOctokit.rest.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
  mockOctokit.rest.repos.getContent.mockResolvedValue({
    data: { content: Buffer.from('export function auth() {}').toString('base64') },
  });
  mockOctokit.rest.pulls.listFiles.mockResolvedValue({
    data: [{ filename: 'src/index.ts' }, { filename: 'src/auth.ts' }],
  });
  mockOctokit.request.mockResolvedValue({
    data: { content: Buffer.from(JSON.stringify({ dependencies: {} })).toString('base64') },
  });
});

function makeJob(name: string, data: Record<string, unknown> = {}): Job {
  return { name, data } as unknown as Job;
}

describe.skip('processRepoIndexingJob', () => {
  describe('full-index', () => {
    it('indexes files, accumulates author profiles, and enqueues batch jobs', async () => {
      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

      await processRepoIndexingJob(makeJob('full-index', { repoFullName: 'org/repo' }));

      // Should update indexing status to indexing
      expect(mockDb.update).toHaveBeenCalled();
      // Should insert file knowledge
      expect(mockDb.insert).toHaveBeenCalled();
      // Should queue batch jobs (2 files → 1 module → 1 batch)
      expect(addJob).toHaveBeenCalledWith(
        'repo-indexing',
        'batch',
        expect.objectContaining({
          repoFullName: 'org/repo',
        })
      );
    });

    it('marks repo as indexed immediately if no modules detected', async () => {
      const { detectModules } = jest.requireMock('../../repo-indexer/module-detector') as {
        detectModules: jest.Mock;
      };
      detectModules.mockReturnValueOnce([]);
      const { fetchFileTree } = jest.requireMock('../../repo-indexer/git-history') as {
        fetchFileTree: jest.Mock;
      };
      fetchFileTree.mockResolvedValueOnce([]); // no files

      await processRepoIndexingJob(makeJob('full-index', { repoFullName: 'org/repo' }));

      // Should mark as indexed since batches.length === 0
      const setMock = (mockDb.update.mock.results[0]?.value as { set: jest.Mock })?.set;
      const allSetCalls = (setMock?.mock.calls ?? []).map((c: unknown[]) => c[0]);
      const indexedCall = allSetCalls.find(
        (s) => (s as Record<string, unknown>)?.indexingStatus === 'indexed'
      );
      expect(indexedCall).toBeDefined();
    });

    it('updates status to failed on error', async () => {
      mockOctokit.rest.repos.get.mockRejectedValue(new Error('Rate limit exceeded'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        processRepoIndexingJob(makeJob('full-index', { repoFullName: 'org/repo' }))
      ).rejects.toThrow('Rate limit exceeded');

      consoleSpy.mockRestore();
      // Last update call should set indexingStatus: 'failed'
      const setMock = (mockDb.update.mock.results[0]?.value as { set: jest.Mock })?.set;
      const allSetCalls = (setMock?.mock.calls ?? []).map((c: unknown[]) => c[0]).filter(Boolean);
      const failedCall = allSetCalls.find(
        (s) => (s as Record<string, unknown>)?.indexingStatus === 'failed'
      );
      expect(failedCall).toBeDefined();
    });
  });

  describe('batch', () => {
    it('generates narratives, embeddings, and decrements pendingBatches', async () => {
      // returning for pendingBatches decrement
      mockReturning.mockResolvedValue([{ pendingBatches: 0 }]);

      const { generateModuleNarrative } = jest.requireMock(
        '../../repo-indexer/narrative-generator'
      ) as { generateModuleNarrative: jest.Mock };
      const { generateEmbedding } = jest.requireMock('../../repo-indexer/embeddings') as {
        generateEmbedding: jest.Mock;
      };

      await processRepoIndexingJob(
        makeJob('batch', {
          repoFullName: 'org/repo',
          modules: [{ modulePath: 'src', entryPoint: 'src/index.ts', files: ['src/index.ts'] }],
          headSha: 'abc123',
        })
      );

      expect(generateModuleNarrative).toHaveBeenCalled();
      expect(generateEmbedding).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled(); // moduleNarratives insert
    });

    it('marks repo as indexed when pendingBatches reaches zero', async () => {
      mockReturning.mockResolvedValue([{ pendingBatches: 0 }]);

      await processRepoIndexingJob(
        makeJob('batch', {
          repoFullName: 'org/repo',
          modules: [],
          headSha: 'main',
        })
      );

      // Should call update with indexingStatus: 'indexed'
      const setMock = (mockDb.update.mock.results[0]?.value as { set: jest.Mock })?.set;
      const allSetCalls = (setMock?.mock.calls ?? []).map((c: unknown[]) => c[0]).filter(Boolean);
      const indexedCall = allSetCalls.find(
        (s) => (s as Record<string, unknown>)?.indexingStatus === 'indexed'
      );
      expect(indexedCall).toBeDefined();
    });

    it('does NOT mark indexed when batches remain', async () => {
      mockReturning.mockResolvedValue([{ pendingBatches: 3 }]);

      await processRepoIndexingJob(
        makeJob('batch', {
          repoFullName: 'org/repo',
          modules: [],
          headSha: 'main',
        })
      );

      const setMock2 = (mockDb.update.mock.results[0]?.value as { set: jest.Mock })?.set;
      const allSetCalls = (setMock2?.mock.calls ?? []).map((c: unknown[]) => c[0]).filter(Boolean);
      const indexedCall = allSetCalls.find(
        (s) => (s as Record<string, unknown>)?.indexingStatus === 'indexed'
      );
      expect(indexedCall).toBeUndefined();
    });
  });

  describe('incremental (pr.merged)', () => {
    it('fetches PR files and updates file knowledge for each changed file', async () => {
      const { fetchFileCommitHistory } = jest.requireMock('../../repo-indexer/git-history') as {
        fetchFileCommitHistory: jest.Mock;
      };
      const { detectModules } = jest.requireMock('../../repo-indexer/module-detector') as {
        detectModules: jest.Mock;
      };
      detectModules.mockReturnValue([]);

      await processRepoIndexingJob(
        makeJob('pr.merged', {
          repoFullName: 'org/repo',
          prNumber: 42,
          author: 'alice',
        })
      );

      // Fetches PR changed files
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 42 })
      );
      // Updates file knowledge for each changed file
      expect(fetchFileCommitHistory).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('updates author profile when author is provided', async () => {
      const { detectModules } = jest.requireMock('../../repo-indexer/module-detector') as {
        detectModules: jest.Mock;
      };
      detectModules.mockReturnValue([]);

      await processRepoIndexingJob(
        makeJob('incremental', {
          repoFullName: 'org/repo',
          changedFiles: ['src/index.ts'],
          author: 'bob',
        })
      );

      // Should insert/update author profile
      const insertCalls = mockDb.insert.mock.calls;
      expect(insertCalls.length).toBeGreaterThan(0);
    });

    it('regenerates module narratives for affected modules', async () => {
      // changedFile starts with module path → affected module
      const { detectModules } = jest.requireMock('../../repo-indexer/module-detector') as {
        detectModules: jest.Mock;
      };
      detectModules.mockReturnValue([
        { modulePath: 'src', entryPoint: 'src/index.ts', files: ['src/index.ts'] },
      ]);

      const { generateModuleNarrative } = jest.requireMock(
        '../../repo-indexer/narrative-generator'
      ) as { generateModuleNarrative: jest.Mock };

      await processRepoIndexingJob(
        makeJob('incremental', {
          repoFullName: 'org/repo',
          changedFiles: ['src/index.ts'],
          author: 'alice',
        })
      );

      expect(generateModuleNarrative).toHaveBeenCalled();
    });
  });

  describe('dependency-scanner', () => {
    it('scans each registered repo for dependency edges', async () => {
      // Override select to return repos
      buildMockDb([{ repoFullName: 'org/repo' }]);
      (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(
        mockDb
      );

      const packageJsonContent = Buffer.from(
        JSON.stringify({ dependencies: { 'some-dep': '^1.0.0' } })
      ).toString('base64');
      mockOctokit.request.mockResolvedValue({ data: { content: packageJsonContent } });

      await processRepoIndexingJob(makeJob('dependency-scanner', {}));

      expect(mockOctokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/contents/{path}',
        expect.objectContaining({ path: 'package.json' })
      );
    });

    it('handles no registered repos gracefully', async () => {
      buildMockDb([]); // no repos
      (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(
        mockDb
      );
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      await processRepoIndexingJob(makeJob('dependency-scanner', {}));

      consoleSpy.mockRestore();
      expect(mockOctokit.request).not.toHaveBeenCalled();
    });
  });

  describe('unknown job type', () => {
    it('logs a warning for unrecognized job types', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await processRepoIndexingJob(makeJob('unknown-type', { repoFullName: 'org/repo' }));

      expect(consoleSpy).toHaveBeenCalledWith(
        '[repo-indexing] Unrecognized job type:',
        'unknown-type'
      );
      consoleSpy.mockRestore();
    });
  });
});
