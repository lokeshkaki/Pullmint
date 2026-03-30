# Security

## Authentication

| Endpoint          | Method                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| GitHub webhooks   | HMAC-SHA256 signature verification (`X-Hub-Signature-256`) via `crypto.timingSafeEqual()`       |
| Dashboard API     | Bearer token (`DASHBOARD_AUTH_TOKEN`), timing-safe comparison                                   |
| Bull Board admin  | Bearer token (`ADMIN_AUTH_TOKEN`, falls back to `DASHBOARD_AUTH_TOKEN`)                         |
| SSE endpoint      | Token via query param (`?token=`) — EventSource doesn't support headers; timing-safe comparison |
| Signal ingestion  | HMAC-SHA256 signature (`X-Pullmint-Signature`)                                                  |
| Outgoing webhooks | Optional HMAC-SHA256 signing (`X-Pullmint-Signature`)                                           |

All token and secret comparisons use `timingSafeTokenCompare()` to prevent timing attacks. Length-mismatch cases compare against a dummy buffer to avoid early-exit leaks.

## Secret Management

- All secrets via environment variables or file-based paths (Docker/K8s secrets compatible)
- `getConfig(key)` checks `KEY` env var first, then reads file at `KEY_PATH`
- `getConfigOptional(key)` returns `undefined` instead of throwing — used for optional config
- GitHub App private key read from file path, never stored in env vars directly
- GitHub installation tokens cached for 50 minutes, auto-refreshed

## Rate Limiting

| Endpoint             | Limit               | Backend                                 |
| -------------------- | ------------------- | --------------------------------------- |
| Global API           | 100 req/s           | Redis-backed via `@fastify/rate-limit`  |
| Signal ingestion     | 30 req/min per IP   | Redis-backed, configurable via env vars |
| Demo analysis        | 5 req/hour per IP   | Redis-backed via `@fastify/rate-limit`  |
| SSE connections      | 5 concurrent per IP | In-memory (per instance)                |
| SSE connect attempts | 20/min per IP       | In-memory (per instance)                |

The global rate limiter uses Redis, so limits are shared across API instances. SSE limits are per-instance since connections are inherently sticky.

## SSRF Protection

Outgoing notification webhooks validate URLs before sending:

- Blocks private IP ranges (RFC 1918, loopback, link-local, IPv6 ULA)
- Blocks known metadata endpoints (`169.254.169.254`, `metadata.google.internal`)
- Resolves DNS and checks all returned addresses against private ranges
- Rejects non-HTTP protocols
- URLs validated both at channel creation (422 response) and at send time (silent skip)

## Network Security

- **CORS** — environment-based origin allowlist (`ALLOWED_ORIGINS`), no wildcards
- **Nginx** — reverse proxy with `X-Real-IP` and `X-Forwarded-For` headers
- **SSE streaming** — `proxy_buffering off`, `proxy_cache off`, 24-hour `proxy_read_timeout`

## Data Protection

- Analysis diffs stored in MinIO with execution-scoped keys, not in the database
- LLM cache entries expire automatically (cleaned up hourly)
- Webhook dedup records expire automatically
- No PII stored beyond GitHub usernames and repo names

## API Security

- Webhook payloads verified before processing (signature + event type validation)
- All database operations use parameterized queries via Drizzle ORM
- 256KB payload limit on job queue entries
- Structured error responses — no stack traces in production
- Input validation via Zod schemas on dashboard and notification endpoints

## Container Security

- Minimal base images (Node 20 slim for services, Alpine for Redis/Nginx)
- Resource limits and memory reservations on all containers
- `stop_grace_period` on all services for graceful shutdown (30s workers, 15s API)
- Worker heartbeat-based health checks (not `pgrep`)
- `npm audit` runs in CI on every PR
- No secrets baked into Docker images
