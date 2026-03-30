/**
 * Tests for the three worker entrypoint files.
 *
 * Each entrypoint (analysis.ts, background.ts, integration.ts) calls run() at module
 * load time, so each test uses jest.isolateModules() with jest.doMock() to load a
 * fresh copy with its group start function mocked.
 */

beforeEach(() => {
  jest.clearAllMocks();
});

describe('entrypoints/analysis.ts', () => {
  it('calls startAnalysisGroup on load', async () => {
    const mockStartAnalysisGroup = jest.fn().mockResolvedValue({ shutdown: jest.fn() });

    jest.isolateModules(() => {
      jest.doMock('../src/groups/analysis-group', () => ({
        startAnalysisGroup: mockStartAnalysisGroup,
      }));
      require('../src/entrypoints/analysis');
    });

    await new Promise((r) => setImmediate(r));

    expect(mockStartAnalysisGroup).toHaveBeenCalledTimes(1);
  });

  it('registers SIGTERM and SIGINT handlers', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/analysis-group', () => ({
        startAnalysisGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/analysis');
    });

    await new Promise((r) => setImmediate(r));

    expect(processSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processSpy.mockRestore();
  });

  it('SIGTERM handler calls shutdown then exits', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/analysis-group', () => ({
        startAnalysisGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/analysis');
    });

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

  it('SIGINT handler calls shutdown then exits', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/analysis-group', () => ({
        startAnalysisGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/analysis');
    });

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

  it('logs error and exits if startAnalysisGroup rejects', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/analysis-group', () => ({
        startAnalysisGroup: jest.fn().mockRejectedValue(new Error('startup failed')),
      }));
      require('../src/entrypoints/analysis');
    });

    await new Promise((r) => setImmediate(r));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start analysis worker group:'),
      expect.any(Error)
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    mockExit.mockRestore();
  });
});

describe('entrypoints/integration.ts', () => {
  it('calls startIntegrationGroup on load', async () => {
    const mockStartIntegrationGroup = jest.fn().mockResolvedValue({ shutdown: jest.fn() });

    jest.isolateModules(() => {
      jest.doMock('../src/groups/integration-group', () => ({
        startIntegrationGroup: mockStartIntegrationGroup,
      }));
      require('../src/entrypoints/integration');
    });

    await new Promise((r) => setImmediate(r));

    expect(mockStartIntegrationGroup).toHaveBeenCalledTimes(1);
  });

  it('registers SIGTERM and SIGINT handlers', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/integration-group', () => ({
        startIntegrationGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/integration');
    });

    await new Promise((r) => setImmediate(r));

    expect(processSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processSpy.mockRestore();
  });

  it('SIGTERM handler calls shutdown then exits', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/integration-group', () => ({
        startIntegrationGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/integration');
    });

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

  it('SIGINT handler calls shutdown then exits', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/integration-group', () => ({
        startIntegrationGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/integration');
    });

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

  it('logs error and exits if startIntegrationGroup rejects', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/integration-group', () => ({
        startIntegrationGroup: jest.fn().mockRejectedValue(new Error('startup failed')),
      }));
      require('../src/entrypoints/integration');
    });

    await new Promise((r) => setImmediate(r));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start integration worker group:'),
      expect.any(Error)
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    mockExit.mockRestore();
  });
});

describe('entrypoints/background.ts', () => {
  it('calls startBackgroundGroup on load', async () => {
    const mockStartBackgroundGroup = jest.fn().mockResolvedValue({ shutdown: jest.fn() });

    jest.isolateModules(() => {
      jest.doMock('../src/groups/background-group', () => ({
        startBackgroundGroup: mockStartBackgroundGroup,
      }));
      require('../src/entrypoints/background');
    });

    await new Promise((r) => setImmediate(r));

    expect(mockStartBackgroundGroup).toHaveBeenCalledTimes(1);
  });

  it('registers SIGTERM and SIGINT handlers', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/background-group', () => ({
        startBackgroundGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/background');
    });

    await new Promise((r) => setImmediate(r));

    expect(processSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processSpy.mockRestore();
  });

  it('SIGTERM handler calls shutdown then exits', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/background-group', () => ({
        startBackgroundGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/background');
    });

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

  it('SIGINT handler calls shutdown then exits', async () => {
    const processSpy = jest.spyOn(process, 'on');
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockShutdown = jest.fn().mockResolvedValue(undefined);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/background-group', () => ({
        startBackgroundGroup: jest.fn().mockResolvedValue({ shutdown: mockShutdown }),
      }));
      require('../src/entrypoints/background');
    });

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

  it('logs error and exits if startBackgroundGroup rejects', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    jest.isolateModules(() => {
      jest.doMock('../src/groups/background-group', () => ({
        startBackgroundGroup: jest.fn().mockRejectedValue(new Error('startup failed')),
      }));
      require('../src/entrypoints/background');
    });

    await new Promise((r) => setImmediate(r));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start background worker group:'),
      expect.any(Error)
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    mockExit.mockRestore();
  });
});
