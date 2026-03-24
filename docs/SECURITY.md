# Security

## Authentication

| Endpoint         | Method                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| GitHub webhooks  | HMAC-SHA256 signature verification (`X-Hub-Signature-256`)              |
| Dashboard API    | Bearer token (`DASHBOARD_AUTH_TOKEN`)                                   |
| SSE endpoint     | Token via query param (`?token=`) — EventSource doesn't support headers |
| Signal ingestion | HMAC-SHA256 signature                                                   |
| Bull Board admin | Dashboard auth token                                                    |

## Secret Management

- All secrets via environment variables or file-based paths (Docker/K8s secrets compatible)
- `getConfig(key)` checks `KEY` env var first, then reads file at `KEY_PATH`
- GitHub App private key read from file path, never stored in env vars directly
- GitHub installation tokens cached for 50 minutes, auto-refreshed

## Network Security

- **CORS** — Environment-based origin allowlist (`ALLOWED_ORIGINS`), no wildcards
- **Rate limiting** — Fastify rate limiter on API routes
- **SSE connection limit** — Max 5 concurrent SSE connections per IP
- **Nginx** — Reverse proxy with `X-Real-IP` and `X-Forwarded-For` headers

## Data Protection

- Analysis diffs stored in MinIO with execution-scoped keys, not in the database
- LLM cache entries expire automatically (cleaned up hourly)
- Webhook dedup records expire automatically
- No PII stored beyond GitHub usernames and repo names

## API Security

- Webhook payloads verified before processing (signature + event type validation)
- All database operations use parameterized queries via Drizzle ORM (no SQL injection)
- 256KB payload limit enforced on job queue entries
- Structured error responses — no stack traces in production

## Container Security

- Non-root container users where possible
- Minimal base images (Alpine for Redis)
- `npm audit` runs in CI on every PR
- No secrets baked into Docker images
