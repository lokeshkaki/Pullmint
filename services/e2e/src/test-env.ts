// services/e2e/src/test-env.ts
// Sets env vars in the test worker process so imported modules use test infrastructure
process.env.DATABASE_URL =
  process.env.E2E_DATABASE_URL || 'postgresql://pullmint:pullmint@127.0.0.1:5434/pullmint_e2e';
process.env.REDIS_URL = process.env.E2E_REDIS_URL || 'redis://127.0.0.1:6381';
process.env.MINIO_ENDPOINT = process.env.E2E_MINIO_ENDPOINT || 'http://127.0.0.1:9003';
process.env.MINIO_ACCESS_KEY = 'minioadmin';
process.env.MINIO_SECRET_KEY = 'minioadmin';
process.env.ANALYSIS_RESULTS_BUCKET = 'pullmint-e2e-results';
process.env.GITHUB_WEBHOOK_SECRET = 'e2e-webhook-secret';
process.env.DASHBOARD_AUTH_TOKEN = 'e2e-dashboard-token';
process.env.ANTHROPIC_API_KEY = 'test-key-intercepted-by-nock';
process.env.GITHUB_APP_ID = '99999';
process.env.GITHUB_APP_INSTALLATION_ID = '88888';
process.env.SIGNAL_INGESTION_HMAC_SECRET = 'e2e-hmac-secret';
process.env.LLM_PROVIDER = 'anthropic';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.LLM_HOURLY_LIMIT_PER_REPO = '1000';
process.env.AWS_CRT_NODEJS_DISABLED = '1';
process.env.MULTI_AGENT_MIN_DIFF_LINES = '5'; // small threshold so both 2-agent and 4-agent tests work with small fixtures
