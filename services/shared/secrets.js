"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSecret = getSecret;
exports.clearSecretsCache = clearSecretsCache;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const secretsClient = new client_secrets_manager_1.SecretsManagerClient({});
const secretsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
/**
 * Get a secret from AWS Secrets Manager with caching
 */
async function getSecret(secretArn) {
    const now = Date.now();
    const cached = secretsCache.get(secretArn);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const command = new client_secrets_manager_1.GetSecretValueCommand({ SecretId: secretArn });
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
function clearSecretsCache() {
    secretsCache.clear();
}
