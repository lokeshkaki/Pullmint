/**
 * Tests for main.ts bootstrap routing logic.
 *
 * main.ts calls start() at module load time, so each test uses jest.isolateModules()
 * with jest.doMock() to load a fresh copy with controlled environment variables.
 */

let startAnalysisGroupMock: jest.Mock;
let startIntegrationGroupMock: jest.Mock;
let startBackgroundGroupMock: jest.Mock;

function buildMockShutdown(): jest.Mock {
  return jest.fn().mockResolvedValue(undefined);
}

function setupMocks(): void {
  startAnalysisGroupMock = jest.fn().mockResolvedValue({ shutdown: buildMockShutdown() });
  startIntegrationGroupMock = jest.fn().mockResolvedValue({ shutdown: buildMockShutdown() });
  startBackgroundGroupMock = jest.fn().mockResolvedValue({ shutdown: buildMockShutdown() });
}

/** Load main.ts in an isolated module scope with fresh group mocks. */
function loadMain(): void {
  jest.isolateModules(() => {
    jest.doMock('../src/groups/analysis-group', () => ({
      startAnalysisGroup: startAnalysisGroupMock,
    }));
    jest.doMock('../src/groups/integration-group', () => ({
      startIntegrationGroup: startIntegrationGroupMock,
    }));
    jest.doMock('../src/groups/background-group', () => ({
      startBackgroundGroup: startBackgroundGroupMock,
    }));
    require('../src/main');
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupMocks();
  delete process.env.WORKER_GROUP;
});

describe('main.ts routing', () => {
  it('starts only the analysis group when WORKER_GROUP=analysis', async () => {
    process.env.WORKER_GROUP = 'analysis';

    loadMain();
    await new Promise((r) => setImmediate(r));

    expect(startAnalysisGroupMock).toHaveBeenCalledTimes(1);
    expect(startIntegrationGroupMock).not.toHaveBeenCalled();
    expect(startBackgroundGroupMock).not.toHaveBeenCalled();
  });

  it('starts only the integration group when WORKER_GROUP=integration', async () => {
    process.env.WORKER_GROUP = 'integration';

    loadMain();
    await new Promise((r) => setImmediate(r));

    expect(startAnalysisGroupMock).not.toHaveBeenCalled();
    expect(startIntegrationGroupMock).toHaveBeenCalledTimes(1);
    expect(startBackgroundGroupMock).not.toHaveBeenCalled();
  });

  it('starts only the background group when WORKER_GROUP=background', async () => {
    process.env.WORKER_GROUP = 'background';

    loadMain();
    await new Promise((r) => setImmediate(r));

    expect(startAnalysisGroupMock).not.toHaveBeenCalled();
    expect(startIntegrationGroupMock).not.toHaveBeenCalled();
    expect(startBackgroundGroupMock).toHaveBeenCalledTimes(1);
  });

  it('starts all three groups in unified mode when WORKER_GROUP is not set', async () => {
    loadMain();
    await new Promise((r) => setImmediate(r));

    expect(startAnalysisGroupMock).toHaveBeenCalledTimes(1);
    expect(startIntegrationGroupMock).toHaveBeenCalledTimes(1);
    expect(startBackgroundGroupMock).toHaveBeenCalledTimes(1);
  });

  it('registers SIGTERM and SIGINT signal handlers', async () => {
    const processSpy = jest.spyOn(process, 'on');

    process.env.WORKER_GROUP = 'analysis';
    loadMain();
    await new Promise((r) => setImmediate(r));

    expect(processSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processSpy.mockRestore();
  });

  it('SIGTERM handler invokes shutdown and exits in single-group mode', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);
    startAnalysisGroupMock.mockResolvedValue({ shutdown: mockShutdown });

    process.env.WORKER_GROUP = 'analysis';
    loadMain();
    await new Promise((r) => setImmediate(r));

    const sigTermCall = (processSpy.mock.calls as [string, () => void][]).find(
      (c) => c[0] === 'SIGTERM'
    );
    sigTermCall?.[1]?.();
    await new Promise((r) => setImmediate(r));

    expect(mockShutdown).toHaveBeenCalled();

    processSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('SIGINT handler invokes shutdown and exits in single-group mode', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);
    startAnalysisGroupMock.mockResolvedValue({ shutdown: mockShutdown });

    process.env.WORKER_GROUP = 'analysis';
    loadMain();
    await new Promise((r) => setImmediate(r));

    const sigIntCall = (processSpy.mock.calls as [string, () => void][]).find(
      (c) => c[0] === 'SIGINT'
    );
    sigIntCall?.[1]?.();
    await new Promise((r) => setImmediate(r));

    expect(mockShutdown).toHaveBeenCalled();

    processSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('shutdown error path logs and exits with code 1', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockShutdown = jest.fn().mockRejectedValue(new Error('shutdown failed'));
    startAnalysisGroupMock.mockResolvedValue({ shutdown: mockShutdown });

    process.env.WORKER_GROUP = 'analysis';
    loadMain();
    await new Promise((r) => setImmediate(r));

    const sigTermCall = (processSpy.mock.calls as [string, () => void][]).find(
      (c) => c[0] === 'SIGTERM'
    );
    sigTermCall?.[1]?.();
    await new Promise((r) => setImmediate(r));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed during worker shutdown:'),
      expect.any(Error)
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    processSpy.mockRestore();
    mockExit.mockRestore();
    consoleSpy.mockRestore();
  });

  it('SIGTERM handler in unified mode calls all group shutdowns', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const analysisShutdown = jest.fn().mockResolvedValue(undefined);
    const integrationShutdown = jest.fn().mockResolvedValue(undefined);
    const backgroundShutdown = jest.fn().mockResolvedValue(undefined);

    startAnalysisGroupMock.mockResolvedValue({ shutdown: analysisShutdown });
    startIntegrationGroupMock.mockResolvedValue({ shutdown: integrationShutdown });
    startBackgroundGroupMock.mockResolvedValue({ shutdown: backgroundShutdown });

    loadMain();
    await new Promise((r) => setImmediate(r));

    const sigTermCall = (processSpy.mock.calls as [string, () => void][]).find(
      (c) => c[0] === 'SIGTERM'
    );
    sigTermCall?.[1]?.();
    await new Promise((r) => setImmediate(r));

    expect(analysisShutdown).toHaveBeenCalled();
    expect(integrationShutdown).toHaveBeenCalled();
    expect(backgroundShutdown).toHaveBeenCalled();

    processSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('second signal is ignored while shutdown is in progress', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Use a never-resolving shutdown to keep isShuttingDown = true between two handler calls
    const mockShutdown = jest.fn().mockReturnValue(new Promise(() => {}));
    startAnalysisGroupMock.mockResolvedValue({ shutdown: mockShutdown });

    process.env.WORKER_GROUP = 'analysis';
    loadMain();
    await new Promise((r) => setImmediate(r));

    const allSigTermCalls = (processSpy.mock.calls as [string, () => void][]).filter(
      (c) => c[0] === 'SIGTERM'
    );
    // Most recent registration belongs to this isolated module instance
    const handler = allSigTermCalls[allSigTermCalls.length - 1]?.[1];
    handler?.(); // First call: isShuttingDown becomes true, shutdown() called
    handler?.(); // Second call: isShuttingDown already true → return immediately (line 50 covered)

    expect(mockShutdown).toHaveBeenCalledTimes(1); // Only called once

    processSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('logs error and exits if start() fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    startAnalysisGroupMock.mockRejectedValue(new Error('Redis unavailable'));

    process.env.WORKER_GROUP = 'analysis';
    loadMain();
    await new Promise((r) => setImmediate(r));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start workers:'),
      expect.any(Error)
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    mockExit.mockRestore();
  });
});
