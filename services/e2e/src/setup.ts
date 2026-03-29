// services/e2e/src/setup.ts — runs ONCE before all tests (separate process)
import { readFileSync } from 'fs';
import { join } from 'path';

export default async function globalSetup(): Promise<void> {
  // Check that containers are up
  const dbUrl =
    process.env.E2E_DATABASE_URL || 'postgresql://pullmint:pullmint@127.0.0.1:5434/pullmint_e2e';
  const redisUrl = process.env.E2E_REDIS_URL || 'redis://127.0.0.1:6381';
  const minioEndpoint = process.env.E2E_MINIO_ENDPOINT || 'http://127.0.0.1:9003';

  // Set env so runMigrations() and storage client connect to test infra
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.MINIO_ENDPOINT = minioEndpoint;
  process.env.MINIO_ACCESS_KEY = 'minioadmin';
  process.env.MINIO_SECRET_KEY = 'minioadmin';
  process.env.ANALYSIS_RESULTS_BUCKET = 'pullmint-e2e-results';
  process.env.GITHUB_WEBHOOK_SECRET = 'e2e-webhook-secret';
  process.env.DASHBOARD_AUTH_TOKEN = 'e2e-dashboard-token';
  process.env.ANTHROPIC_API_KEY = 'test-key-intercepted-by-nock';
  process.env.GITHUB_APP_ID = '99999';
  process.env.GITHUB_APP_PRIVATE_KEY = loadTestPrivateKey();
  process.env.GITHUB_APP_INSTALLATION_ID = '88888';
  process.env.SIGNAL_INGESTION_HMAC_SECRET = 'e2e-hmac-secret';
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  process.env.LLM_HOURLY_LIMIT_PER_REPO = '1000';
  process.env.AWS_CRT_NODEJS_DISABLED = '1';

  // Ensure Redis is clean before each E2E run so stale BullMQ jobs from prior
  // local runs do not get picked up and break deterministic test behavior.
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  await redis.quit();

  // Run DB migrations
  const { runMigrations } = await import('@pullmint/shared/migrate');
  await runMigrations();

  // Ensure MinIO bucket exists
  const { ensureBucket } = await import('@pullmint/shared/storage');
  await ensureBucket('pullmint-e2e-results');

  console.log('[e2e setup] Infrastructure ready.');
}

/**
 * Load the test RSA private key for GitHub App JWT signing.
 * This key is committed to the repo under services/e2e/src/fixtures/ — it is NOT a real secret.
 * All GitHub API calls in e2e tests are intercepted by nock and never reach real GitHub.
 */
function loadTestPrivateKey(): string {
  if (process.env.E2E_GITHUB_PRIVATE_KEY) {
    return process.env.E2E_GITHUB_PRIVATE_KEY;
  }
  const keyPath = join(__dirname, 'fixtures', 'test-rsa-key.pem');
  return readFileSync(keyPath, 'utf-8');
}
