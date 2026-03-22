import { processCleanupJob } from '../src/processors/cleanup';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    webhookDedup: {},
    llmRateLimits: {},
    llmCache: {},
    dependencyGraphs: {},
  },
}));

let mockDb: { delete: jest.Mock };
let mockDeleteReturning: jest.Mock;
let mockDeleteWhere: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteReturning = jest.fn().mockResolvedValue([{ id: 'a' }]);
  mockDeleteWhere = jest.fn().mockReturnValue({ returning: mockDeleteReturning });
  mockDb = { delete: jest.fn().mockReturnValue({ where: mockDeleteWhere }) };
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
});

describe('processCleanupJob', () => {
  it('calls delete on all 4 tables', async () => {
    await processCleanupJob();
    expect(mockDb.delete).toHaveBeenCalledTimes(4);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(4);
    expect(mockDeleteReturning).toHaveBeenCalledTimes(4);
  });

  it('logs correct deleted row counts', async () => {
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await processCleanupJob();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[cleanup] Completed',
      expect.objectContaining({
        webhookDedupDeleted: 1,
        rateLimitsDeleted: 1,
        cacheEntriesDeleted: 1,
        dependencyEdgesDeleted: 1,
      })
    );
    consoleSpy.mockRestore();
  });

  it('logs zero counts when tables are already clean', async () => {
    mockDeleteReturning.mockResolvedValue([]);
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await processCleanupJob();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[cleanup] Completed',
      expect.objectContaining({
        webhookDedupDeleted: 0,
        rateLimitsDeleted: 0,
        cacheEntriesDeleted: 0,
        dependencyEdgesDeleted: 0,
      })
    );
    consoleSpy.mockRestore();
  });
});
