import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  afterEach(() => {
    delete process.env.PULLMINT_API_URL;
    delete process.env.PULLMINT_AUTH_TOKEN;
    delete process.env.PULLMINT_REQUEST_TIMEOUT_MS;
  });

  it('requires API URL and auth token without disclosing token values', () => {
    process.env.PULLMINT_AUTH_TOKEN = 'do-not-print-this';
    expect(() => loadConfig()).toThrow('PULLMINT_API_URL is required');
    try {
      loadConfig();
    } catch (error) {
      expect(String(error)).not.toContain('do-not-print-this');
    }
  });

  it('parses required values and the optional request timeout', () => {
    process.env.PULLMINT_API_URL = 'http://localhost:3000/';
    process.env.PULLMINT_AUTH_TOKEN = 'local-token';
    process.env.PULLMINT_REQUEST_TIMEOUT_MS = '2500';
    expect(loadConfig()).toEqual({
      apiUrl: 'http://localhost:3000',
      authToken: 'local-token',
      requestTimeoutMs: 2500,
    });
  });

  it('rejects non-http URLs and non-positive timeout values', () => {
    process.env.PULLMINT_API_URL = 'file:///tmp/pullmint';
    process.env.PULLMINT_AUTH_TOKEN = 'token';
    expect(() => loadConfig()).toThrow('PULLMINT_API_URL must be an http or https URL');
    process.env.PULLMINT_API_URL = 'http://localhost:3000';
    process.env.PULLMINT_REQUEST_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow('PULLMINT_REQUEST_TIMEOUT_MS must be a positive integer');
  });
});
