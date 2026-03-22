import { mkdtempSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('config', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('should read from environment variable', () => {
    process.env.TEST_SECRET = 'my-secret-value';
    const { getConfig } = require('../config');
    expect(getConfig('TEST_SECRET')).toBe('my-secret-value');
    delete process.env.TEST_SECRET;
  });

  it('should read from file via _PATH suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pullmint-test-'));
    const filePath = join(dir, 'secret.txt');
    writeFileSync(filePath, 'file-secret-value\n');
    process.env.TEST_KEY_PATH = filePath;

    const { getConfig } = require('../config');
    expect(getConfig('TEST_KEY')).toBe('file-secret-value');

    delete process.env.TEST_KEY_PATH;
    unlinkSync(filePath);
  });

  it('should throw when key not found', () => {
    const { getConfig } = require('../config');
    expect(() => getConfig('NONEXISTENT_KEY')).toThrow(/not found/);
  });

  it('should return undefined for optional missing keys', () => {
    const { getConfigOptional } = require('../config');
    expect(getConfigOptional('NONEXISTENT_KEY')).toBeUndefined();
  });
});
