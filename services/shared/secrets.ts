import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});
const secretsCache = new Map<string, { value: string; expiresAt: number }>();

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get a secret from AWS Secrets Manager with caching
 */
export async function getSecret(secretArn: string): Promise<string> {
  const now = Date.now();
  const cached = secretsCache.get(secretArn);
  
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = await secretsClient.send(command);
  
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`);
  }

  secretsCache.set(secretArn, {
    value: response.SecretString,
    expiresAt: now + CACHE_TTL,
  });

  return response.SecretString;
}

/**
 * Clear the secrets cache (useful for testing)
 */
export function clearSecretsCache(): void {
  secretsCache.clear();
}
