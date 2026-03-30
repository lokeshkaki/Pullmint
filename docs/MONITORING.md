# Monitoring & Observability

## Health Checks

| Service    | Method              | Details                                                                     |
| ---------- | ------------------- | --------------------------------------------------------------------------- |
| API        | `GET /health`       | Liveness — API is running                                                   |
| API        | `GET /health/ready` | Readiness — checks PostgreSQL + Redis connectivity                          |
| Workers    | Heartbeat file      | Writes `/tmp/pullmint-worker-health` every 5s; Docker checks file age < 30s |
| PostgreSQL | `pg_isready`        | Docker Compose native                                                       |
| Redis      | `redis-cli ping`    | Docker Compose native                                                       |
| MinIO      | HTTP liveness       | `curl` against health endpoint                                              |

All services have `start_period: 30s` to accommodate slow startups in constrained environments. Workers use `stop_grace_period: 30s` for in-flight job completion.

## Logging

Structured JSON logging via Fastify's built-in pino logger.

- Log level configurable via `LOG_LEVEL` env var (default: `info`)
- Correlation IDs on structured errors via `createStructuredError()`
- Worker processors log job lifecycle events (start, complete, fail)
- Notification failures are logged as structured JSON but never fail the analysis pipeline

## Queue Monitoring

**Bull Board** is available at `/admin/queues` (requires `ADMIN_AUTH_TOKEN` or `DASHBOARD_AUTH_TOKEN`). It shows:

- Active, waiting, completed, and failed jobs per queue
- Job data, return values, and error messages
- Retry controls for failed jobs

All 10 queues are visible: `analysis`, `agent`, `synthesis`, `github-integration`, `deployment`, `deployment-status`, `calibration`, `repo-indexing`, `cleanup`, `notification`.

## Tracing

Optional OpenTelemetry integration — enabled by setting `OTEL_EXPORTER_OTLP_ENDPOINT`.

- `addTraceAnnotations()` adds span attributes to the active trace
- No-op when tracing is not configured (zero overhead)
- Compatible with any OTLP-compatible collector (Jaeger, Grafana Tempo, etc.)

## Key Metrics to Watch

| Metric               | Where to Check          | Concern Threshold       |
| -------------------- | ----------------------- | ----------------------- |
| Failed jobs          | Bull Board              | Any persistent failures |
| Queue depth          | Bull Board              | Growing backlog         |
| Analysis latency     | Job completion times    | > 60s per agent         |
| Worker heartbeat     | Docker health status    | Unhealthy container     |
| SSE connections      | API logs                | Unusual spikes          |
| Database connections | PostgreSQL logs         | Near pool limit         |
| Redis memory         | `redis-cli info memory` | > 80% of available      |
| LLM costs            | Dashboard Costs page    | Nearing monthly budget  |

## Scheduled Jobs

| Job                  | Interval          | Purpose                                       |
| -------------------- | ----------------- | --------------------------------------------- |
| Deployment monitor   | 5 min             | Check post-deploy health                      |
| Cleanup              | Hourly            | Prune expired dedup/cache/rate-limit rows     |
| Dependency scanner   | Daily (2 AM)      | Index repository dependencies                 |
| Signal recalibration | Weekly (Sun 3 AM) | Recompute signal weights from outcome history |

Scheduled jobs only run in the background worker group. In unified mode, they run in the single process.

## Alerting

No built-in alerting. Recommended approach:

- Monitor `/health/ready` with your preferred uptime checker
- Watch Bull Board for failed job accumulation
- Set up log-based alerts on error-level log entries
- Use the Costs page or budget webhook notifications for spend alerts
- If using OpenTelemetry, configure alerts in your tracing backend
