import * as childProcess from 'child_process';
import { checkDockerInstalled, checkToolInstalled, waitForHealth } from '../src/docker';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  exec: jest.fn(),
}));

const mockExecSync = childProcess.execSync as jest.Mock;

describe('checkDockerInstalled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns dockerOk=true and composeOk=true when both are present', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'docker --version') return Buffer.from('Docker version 25.0.0');
      if (cmd === 'docker compose version') return Buffer.from('Docker Compose version v2.24.0');
      throw new Error('unknown');
    });

    const result = checkDockerInstalled();
    expect(result.dockerOk).toBe(true);
    expect(result.composeOk).toBe(true);
  });

  it('returns dockerOk=false when docker is not installed', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = checkDockerInstalled();
    expect(result.dockerOk).toBe(false);
    expect(result.composeOk).toBe(false);
  });

  it('falls back to legacy docker-compose when docker compose fails', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'docker --version') return Buffer.from('Docker version 25.0.0');
      if (cmd === 'docker compose version') throw new Error('subcommand not found');
      if (cmd === 'docker-compose --version') return Buffer.from('docker-compose version 1.29');
      throw new Error('unknown');
    });

    const result = checkDockerInstalled();
    expect(result.dockerOk).toBe(true);
    expect(result.composeOk).toBe(true);
  });
});

describe('checkToolInstalled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when which succeeds', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/cloudflared'));
    expect(checkToolInstalled('cloudflared')).toBe(true);
  });

  it('returns false when which throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(checkToolInstalled('cloudflared')).toBe(false);
  });
});

describe('waitForHealth', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('resolves when both health checks return 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    await expect(
      waitForHealth({ apiBase: 'http://localhost:3000', intervalMs: 10, timeoutMs: 5000 })
    ).resolves.toBeUndefined();
  });

  it('rejects when timeout is exceeded', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await expect(
      waitForHealth({ apiBase: 'http://localhost:3000', intervalMs: 10, timeoutMs: 50 })
    ).rejects.toThrow('Timed out');
  });
});
