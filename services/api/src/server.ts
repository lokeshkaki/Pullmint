import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { initTracing } from '@pullmint/shared/tracing';
import { runMigrations } from '@pullmint/shared/migrate';
import { ensureBucket } from '@pullmint/shared/storage';
import { registerWebhookRoutes } from './routes/webhook';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerSignalRoutes } from './routes/signals';
import { registerHealthRoutes } from './routes/health';
import { registerAdminRoutes } from './routes/admin';
import { registerEventRoutes } from './routes/events';
import { registerDemoRoutes } from './routes/demo';
import { initSSE, closeSSE } from './sse';

async function start() {
  // Optional tracing
  initTracing('pullmint-api');

  // Run DB migrations on startup
  await runMigrations();

  // Ensure required S3/MinIO buckets exist
  const bucketName = process.env.ANALYSIS_RESULTS_BUCKET || 'pullmint-analysis-results';
  await ensureBucket(bucketName);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // CORS
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',');
  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  });

  // Rate limiting (replaces API Gateway 100req/s throttle)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 second',
  });

  // Register routes
  await registerAdminRoutes(app);
  registerHealthRoutes(app);
  registerWebhookRoutes(app);
  registerDashboardRoutes(app);
  registerSignalRoutes(app);
  registerEventRoutes(app);
  registerDemoRoutes(app);

  // Initialize SSE
  initSSE();

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await closeSSE();
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen({ port, host });
  console.log(`Pullmint API listening on ${host}:${port}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
