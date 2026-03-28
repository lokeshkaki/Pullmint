import { randomAlphanumeric, randomHex, validateApiKey } from '../src/secrets';

describe('API key validation', () => {
  describe('validateApiKey', () => {
    it('returns true for valid Anthropic key', () => {
      expect(validateApiKey('anthropic', 'sk-ant-api03-somevalidkeystring')).toBe(true);
    });

    it('returns error message for Anthropic key with wrong prefix', () => {
      const result = validateApiKey('anthropic', 'sk-openai-key');
      expect(typeof result).toBe('string');
      expect(result as string).toContain('sk-ant-');
    });

    it('returns true for valid OpenAI key', () => {
      expect(validateApiKey('openai', 'sk-proj-somevalidkeystring1234')).toBe(true);
    });

    it('returns true for valid Google key', () => {
      expect(validateApiKey('google', 'AIzaSomeValidGoogleKeyHere1234567890ABCDE')).toBe(true);
    });

    it('returns error for empty key', () => {
      const result = validateApiKey('anthropic', '');
      expect(typeof result).toBe('string');
      expect(result as string).toContain('cannot be empty');
    });
  });
});

describe('secret generation', () => {
  describe('randomHex', () => {
    it('returns string of correct length (2x byteLength)', () => {
      expect(randomHex(32)).toHaveLength(64);
      expect(randomHex(16)).toHaveLength(32);
    });

    it('returns only hex characters', () => {
      expect(randomHex(32)).toMatch(/^[0-9a-f]+$/);
    });

    it('returns different values on subsequent calls', () => {
      expect(randomHex(32)).not.toBe(randomHex(32));
    });
  });

  describe('randomAlphanumeric', () => {
    it('returns string of correct length', () => {
      expect(randomAlphanumeric(24)).toHaveLength(24);
      expect(randomAlphanumeric(40)).toHaveLength(40);
    });

    it('returns only alphanumeric characters', () => {
      expect(randomAlphanumeric(100)).toMatch(/^[A-Za-z0-9]+$/);
    });
  });
});
