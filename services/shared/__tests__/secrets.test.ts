import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSecret, clearSecretsCache } from '../secrets';

const secretsManagerMock = mockClient(SecretsManagerClient);

describe('Secrets Manager', () => {
  beforeEach(() => {
    secretsManagerMock.reset();
    clearSecretsCache();
  });

  describe('getSecret', () => {
    it('should retrieve secret from Secrets Manager', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:test';
      const secretValue = 'my-secret-value';

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: secretValue,
      });

      const result = await getSecret(secretArn);
      expect(result).toBe(secretValue);
      expect(secretsManagerMock.calls()).toHaveLength(1);
    });

    it('should cache secrets and not call AWS on subsequent requests', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:cached';
      const secretValue = 'cached-secret';

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: secretValue,
      });

      // First call - should hit AWS
      const result1 = await getSecret(secretArn);
      expect(result1).toBe(secretValue);

      // Second call - should use cache
      const result2 = await getSecret(secretArn);
      expect(result2).toBe(secretValue);

      // Should only call AWS once
      expect(secretsManagerMock.calls()).toHaveLength(1);
    });

    it('should refresh cache after TTL expires', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:ttl-test';
      const secretValue = 'ttl-secret';

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: secretValue,
      });

      // Mock Date.now to control time
      const originalDateNow = Date.now;
      let mockTime = 1000000;
      Date.now = jest.fn(() => mockTime);

      // First call
      await getSecret(secretArn);

      // Advance time past TTL (5 minutes + 1ms)
      mockTime += 5 * 60 * 1000 + 1;

      // Second call - should refresh from AWS
      await getSecret(secretArn);

      expect(secretsManagerMock.calls()).toHaveLength(2);

      // Restore Date.now
      Date.now = originalDateNow;
    });

    it('should throw error if secret has no string value', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:no-string';

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretBinary: Buffer.from('binary-data'),
      });

      await expect(getSecret(secretArn)).rejects.toThrow(
        `Secret ${secretArn} has no string value`
      );
    });

    it('should propagate AWS errors', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789:secret:error';

      secretsManagerMock.on(GetSecretValueCommand).rejects(new Error('ResourceNotFoundException'));

      await expect(getSecret(secretArn)).rejects.toThrow('ResourceNotFoundException');
    });

    it('should handle multiple different secrets', async () => {
      const secret1Arn = 'arn:aws:secretsmanager:us-east-1:123:secret:one';
      const secret2Arn = 'arn:aws:secretsmanager:us-east-1:123:secret:two';

      secretsManagerMock
        .on(GetSecretValueCommand, { SecretId: secret1Arn })
        .resolves({ SecretString: 'value1' })
        .on(GetSecretValueCommand, { SecretId: secret2Arn })
        .resolves({ SecretString: 'value2' });

      const result1 = await getSecret(secret1Arn);
      const result2 = await getSecret(secret2Arn);

      expect(result1).toBe('value1');
      expect(result2).toBe('value2');
      expect(secretsManagerMock.calls()).toHaveLength(2);
    });
  });

  describe('clearSecretsCache', () => {
    it('should clear the cache and force new AWS call', async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123:secret:clear-test';
      const secretValue = 'clear-test-value';

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: secretValue,
      });

      // First call
      await getSecret(secretArn);
      expect(secretsManagerMock.calls()).toHaveLength(1);

      // Clear cache
      clearSecretsCache();

      // Second call - should hit AWS again
      await getSecret(secretArn);
      expect(secretsManagerMock.calls()).toHaveLength(2);
    });
  });
});
