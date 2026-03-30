import fs from 'fs';
import { startHealthHeartbeat, stopHealthHeartbeat } from '../src/health';

jest.useFakeTimers();

describe('health heartbeat', () => {
  afterEach(() => {
    stopHealthHeartbeat();
    jest.restoreAllMocks();
  });

  it('writes heartbeat file on start', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    startHealthHeartbeat();

    expect(writeSpy).toHaveBeenCalledWith('/tmp/pullmint-worker-health', expect.any(String));
  });

  it('writes heartbeat periodically', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    startHealthHeartbeat();
    jest.advanceTimersByTime(10_000);

    expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stop clears interval', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    startHealthHeartbeat();
    const callsAfterStart = writeSpy.mock.calls.length;
    stopHealthHeartbeat();
    jest.advanceTimersByTime(10_000);

    expect(writeSpy.mock.calls.length).toBe(callsAfterStart);
  });

  it('handles write errors gracefully', () => {
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });

    expect(() => startHealthHeartbeat()).not.toThrow();
    expect(() => {
      jest.advanceTimersByTime(10_000);
    }).not.toThrow();
  });
});