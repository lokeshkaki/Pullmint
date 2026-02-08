import * as crypto from 'crypto';
import { verifyGitHubSignature, generateExecutionId, calculateTTL, hashContent } from '../utils';

describe('Utils', () => {
  describe('verifyGitHubSignature', () => {
    const secret = 'test-webhook-secret';
    const payload = JSON.stringify({ action: 'opened', number: 123 });

    it('should verify valid GitHub signature', () => {
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(payload);
      const signature = 'sha256=' + hmac.digest('hex');

      const result = verifyGitHubSignature(payload, signature, secret);
      expect(result).toBe(true);
    });

    it('should reject invalid signature', () => {
      const result = verifyGitHubSignature(payload, 'sha256=invalid', secret);
      expect(result).toBe(false);
    });

    it('should reject missing signature', () => {
      const result = verifyGitHubSignature(payload, undefined, secret);
      expect(result).toBe(false);
    });

    it('should reject signature with wrong secret', () => {
      const hmac = crypto.createHmac('sha256', 'wrong-secret');
      hmac.update(payload);
      const signature = 'sha256=' + hmac.digest('hex');

      const result = verifyGitHubSignature(payload, signature, secret);
      expect(result).toBe(false);
    });

    it('should reject signature with modified payload', () => {
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(payload);
      const signature = 'sha256=' + hmac.digest('hex');

      const modifiedPayload = JSON.stringify({ action: 'closed', number: 456 });
      const result = verifyGitHubSignature(modifiedPayload, signature, secret);
      expect(result).toBe(false);
    });

    it('should handle empty payload', () => {
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update('');
      const signature = 'sha256=' + hmac.digest('hex');

      const result = verifyGitHubSignature('', signature, secret);
      expect(result).toBe(true);
    });
  });

  describe('generateExecutionId', () => {
    it('should generate execution ID with correct format', () => {
      const repoFullName = 'owner/repo';
      const prNumber = 123;
      const sha = 'abc1234567890def';

      const result = generateExecutionId(repoFullName, prNumber, sha);
      expect(result).toBe('owner/repo#123#abc1234');
    });

    it('should truncate SHA to 7 characters', () => {
      const result = generateExecutionId('org/project', 42, 'verylongsha123456789');
      expect(result).toBe('org/project#42#verylon');
    });

    it('should handle short SHA', () => {
      const result = generateExecutionId('test/repo', 1, 'abc');
      expect(result).toBe('test/repo#1#abc');
    });

    it('should generate unique IDs for different inputs', () => {
      const id1 = generateExecutionId('repo1', 1, 'sha1');
      const id2 = generateExecutionId('repo2', 1, 'sha1');
      const id3 = generateExecutionId('repo1', 2, 'sha1');
      const id4 = generateExecutionId('repo1', 1, 'sha2');

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id1).not.toBe(id4);
    });
  });

  describe('calculateTTL', () => {
    it('should calculate TTL timestamp correctly', () => {
      const durationSeconds = 3600; // 1 hour
      const beforeCall = Math.floor(Date.now() / 1000);
      const ttl = calculateTTL(durationSeconds);
      const afterCall = Math.floor(Date.now() / 1000);

      expect(ttl).toBeGreaterThanOrEqual(beforeCall + durationSeconds);
      expect(ttl).toBeLessThanOrEqual(afterCall + durationSeconds);
    });

    it('should handle zero duration', () => {
      const ttl = calculateTTL(0);
      const now = Math.floor(Date.now() / 1000);
      expect(ttl).toBeGreaterThanOrEqual(now - 1);
      expect(ttl).toBeLessThanOrEqual(now + 1);
    });

    it('should handle large duration values', () => {
      const durationSeconds = 86400 * 365; // 1 year
      const ttl = calculateTTL(durationSeconds);
      const now = Math.floor(Date.now() / 1000);
      expect(ttl).toBeGreaterThan(now);
    });
  });

  describe('hashContent', () => {
    it('should generate consistent hash for same content', () => {
      const content = 'test content';
      const hash1 = hashContent(content);
      const hash2 = hashContent(content);
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different content', () => {
      const hash1 = hashContent('content1');
      const hash2 = hashContent('content2');
      expect(hash1).not.toBe(hash2);
    });

    it('should generate 64-character hex hash (SHA-256)', () => {
      const hash = hashContent('test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle empty string', () => {
      const hash = hashContent('');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle large content', () => {
      const largeContent = 'a'.repeat(10000);
      const hash = hashContent(largeContent);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
