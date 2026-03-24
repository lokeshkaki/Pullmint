# Monitoring & Observability

## Health Checks

| Endpoint            | Type      | Checks                          |
| ------------------- | --------- | ------------------------------- |
| `GET /health`       | Liveness  | API is running                  |
| `GET /health/ready` | Readiness | PostgreSQL + Redis connectivity |

Docker Compose health checks are configured for Postgres, Redis, and MinIO. Services wait for dependencies to be healthy before starting.

## Logging

Structured JSON logging via Fastify's built-in pino logger.

- Log level configurable via `LOG_LEVEL` env var (default: `info`)
- Correlation IDs on structured errors via `createStructuredError()`
- Worker processors log job lifecycle events (start, complete, fail)

## Queue Monitoring

**Bull Board** is available at `/admin/queues` (behind dashboard auth). It shows:

- Active, waiting, completed, and failed jobs per queue
- Job data, return values, and error messages
- Retry controls for failed jobs

All 9 queues are visible: `analysis`, `agent`, `synthesis`, `github-integration`, `deployment`, `deployment-status`, `calibration`, `repo-indexing`, `cleanup`.

## Tracing

Optional OpenTelemetry integration — enabled by setting `OTEL_EXPORTER_OTLP_ENDPOINT`.

- `addTraceAnnotations()` from `shared/tracing.ts` adds span attributes
- No-op when tracing is not configured (zero overhead)
- Compatible with any OTLP-compatible collector (Jaeger, Grafana Tempo, etc.)

## Key Metrics to Watch

| Metric               | Where to Check                     | Concern Threshold       |
| -------------------- | ---------------------------------- | ----------------------- |
| Failed jobs          | Bull Board                         | Any persistent failures |
| Queue depth          | Bull Board                         | Growing backlog         |
| Analysis latency     | Job completion times in Bull Board | > 60s per agent         |
| SSE connections      | API logs                           | Unusual spikes          |
| Database connections | PostgreSQL logs                    | Near pool limit         |
| Redis memory         | `redis-cli info memory`            | > 80% of available      |

## Scheduled Jobs

| Job                  | Interval          | Purpose                                       |
| -------------------- | ----------------- | --------------------------------------------- |
| Deployment monitor   | 5 min             | Check post-deploy health                      |
| Cleanup              | Hourly            | Prune expired dedup/cache/rate-limit rows     |
| Dependency scanner   | Daily (2 AM)      | Index repository dependencies                 |
| Signal recalibration | Weekly (Sun 3 AM) | Recompute signal weights from outcome history |

## Alerting

No built-in alerting. Recommended approach:

- Monitor `/health/ready` with your preferred uptime checker
- Watch Bull Board for failed job accumulation
- Set up log-based alerts on error-level log entries
- If using OpenTelemetry, configure alerts in your tracing backend
