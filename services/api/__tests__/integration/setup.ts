/**
 * Integration test setup. Starts Docker containers, runs migrations,
 * and provides test utilities.
 *
 * Run with: docker compose -f __tests__/integration/docker-compose.test.yml up -d
 * Then: DATABASE_URL=postgresql://pullmint:pullmint@localhost:5433/pullmint_test \
 *       REDIS_URL=redis://localhost:6380 \
 *       MINIO_ENDPOINT=http://localhost:9002 \
 *       npx jest --config jest.integration.config.js
 */

import { runMigrations } from '@pullmint/shared/migrate';

export async function setupIntegration(): Promise<void> {
  process.env.DATABASE_URL = 'postgresql://pullmint:pullmint@localhost:5433/pullmint_test';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.MINIO_ENDPOINT = 'http://localhost:9002';
  process.env.MINIO_ACCESS_KEY = 'minioadmin';
  process.env.MINIO_SECRET_KEY = 'minioadmin';
  process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.DASHBOARD_AUTH_TOKEN = 'test-dashboard-token';
  process.env.ANTHROPIC_API_KEY = 'test-api-key';
  process.env.SIGNAL_INGESTION_HMAC_SECRET = 'test-hmac-secret';
  process.env.ANALYSIS_RESULTS_BUCKET = 'pullmint-test-results';

  await runMigrations();
}
