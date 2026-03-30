# Architecture

Pullmint is a TypeScript monorepo running as Docker containers. PostgreSQL stores state, Redis handles job queues and real-time events, MinIO stores large artifacts, and Nginx serves the dashboard.

## Services

### API (`services/api/`)

Fastify HTTP server handling:

- **GitHub webhooks** — receives PR events, validates HMAC signatures, enqueues analysis jobs
- **Dashboard REST API** — execution history, risk board, calibration, analytics, cost tracking, notifications
- **SSE endpoint** — `GET /dashboard/events` pushes real-time execution updates to the dashboard
- **Signal ingestion** — accepts external CI/CD signals (test results, deploy status, error rates) with per-route rate limiting
- **Demo endpoint** — public live analysis with rate limiting and diff size caps
- **Health checks** — `/health` (liveness), `/health/ready` (readiness: Postgres + Redis)
- **Bull Board** — admin UI for queue inspection at `/admin/queues`

### Workers (`services/workers/`)

BullMQ job processors split into 3 independently scalable groups via `WORKER_GROUP` env var:

| Group           | Processors                                                              | Scaling rationale                 |
| --------------- | ----------------------------------------------------------------------- | --------------------------------- |
| **Analysis**    | `analysis`, `agent`, `synthesis`                                        | LLM-bound — scale with PR volume  |
| **Integration** | `github-integration`, `deployment`, `deployment-status`, `notification` | I/O-bound — GitHub API + webhooks |
| **Background**  | `calibration`, `repo-indexing`, `cleanup` + scheduled jobs              | Low-priority batch work           |

Without `WORKER_GROUP`, all groups run in a single unified process.

**Scheduled jobs** (background group only):

- Deployment monitor — every 5 minutes
- Dependency scanner — daily at 2 AM
- Cleanup — hourly
- Signal recalibration — weekly (Sunday 3 AM)

Workers write a heartbeat file every 5 seconds for Docker health checks, replacing the previous `pgrep`-based approach.

### Dashboard (`services/dashboard/` + `services/dashboard-ui/`)

React + Vite + shadcn/ui + Tailwind SPA served by Nginx. Nginx reverse-proxies API routes and SSE streams.

**Pages:** Executions (with 9-filter bar), Execution detail, Kanban risk board, Analytics, Costs, Calibration, Notifications.

**Real-time:** The dashboard connects to `/dashboard/events` via `EventSource` (SSE) for instant status changes, with a 60-second fallback poll.

### Shared (`services/shared/`)

Common modules used by both API and Workers:

- `db.ts` / `schema.ts` — Drizzle ORM, PostgreSQL schema (13 tables)
- `queue.ts` — BullMQ queue definitions, `addJob()` helper with 256KB payload limit
- `llm.ts` — Provider abstraction (Anthropic, OpenAI, Google Gemini) with `LLMProviderError` for retry logic
- `risk-evaluator.ts` — Risk score computation with configurable signal weights
- `signal-weights.ts` — Adaptive weight resolution (repo → global → hardcoded fallback)
- `execution-events.ts` — Redis Pub/Sub for real-time execution status events
- `notifications.ts` — Slack, Discord, Teams, generic webhooks with SSRF-safe URL validation
- `config.ts` — Environment variable access with file-based secret support (`_PATH` suffix)
- `cost-tracker.ts` — LLM token usage recording with per-repo monthly budgets
- `storage.ts` — MinIO/S3-compatible object storage
- `error-handling.ts` — `withErrorHandling()`, `retryWithBackoff()`, structured errors
- `types.ts` / `schemas.ts` — Shared TypeScript types and Zod validators

## Data Flow

### PR Analysis

```
PR webhook
  → analysis queue (dispatcher)
    → agent queue x4 (parallel via BullMQ Flow)
      → synthesis queue (parent job, waits for children)
        → github-integration queue
          → deployment queue (if auto-deploy)
            → deployment-status queue (monitoring)
              → calibration queue (outcome learning)
```

The dispatcher creates a BullMQ Flow with agent children and a synthesis parent. Agents run in parallel; the synthesizer collects results via `job.getChildrenValues()`. If an agent fails, remaining results are used with renormalized weights (`failParentOnFailure: false`).

### AI Agents

| Agent           | Model             | Focus                                             |
| --------------- | ----------------- | ------------------------------------------------- |
| Architecture    | Claude Sonnet 4.6 | Structural impact, coupling, API changes          |
| Security        | Claude Sonnet 4.6 | Vulnerabilities, auth, injection, data exposure   |
| Performance     | Claude Haiku 4.5  | N+1 queries, memory leaks, algorithmic complexity |
| Maintainability | Claude Haiku 4.5  | Readability, naming, duplication, test coverage   |

Small diffs (< 200 lines) only run Architecture + Security. Agent weights are configurable via `AGENT_WEIGHT_*` env vars (default: 0.35/0.35/0.15/0.15). Users can add up to 5 custom agents via `.pullmint.yml`.

Each agent receives a filtered diff — irrelevant files are excluded per specialization, and large diffs are truncated by dropping whole files (never mid-hunk).

### Risk Scoring

1. Each agent produces findings with individual risk scores
2. Findings are deduplicated (exact match + Levenshtein overlap < 0.30)
3. Finding lifecycle is computed (new/persisted/resolved) via SHA-256 fingerprints
4. Agent scores are weighted and combined
5. External signals (CI status, error rates, coverage) adjust the score via learned signal weights
6. Final score: 0-100, clamped, where higher = riskier

### Signal Weight Learning

Signal weights adapt over time using exponential moving averages:

- **Rollback** — weight increases (signal was right but too weak)
- **False positive** (held then confirmed safe) — weight decreases
- **Confirmed good** — no change

Three-tier resolution: repo-specific weights (after 10+ observations) → global baseline → hardcoded defaults. Weekly batch recalibration corrects drift from outcome history.

### Real-Time Updates (SSE)

```
Worker status change → Redis Pub/Sub → API subscriber → fan-out to SSE clients → Dashboard
```

Workers publish events on every execution status transition. The API maintains a single Redis subscriber connection shared across all connected dashboard clients. Events are filtered per-client by repository.

## Database

PostgreSQL 16 with pgvector extension. 13 tables managed by Drizzle ORM with auto-migration on API startup.

Key tables: `executions`, `calibrations`, `signal_weight_defaults`, `notification_channels`, `token_usage`, `webhook_dedup`, `llm_cache`, `llm_rate_limits`, `file_knowledge`, `author_profiles`, `repo_registry`, `module_narratives` (1536-dim embeddings), `dependency_graphs`.

## Infrastructure

```
                    ┌──────────────┐
                    │    Nginx     │ :3001
                    │  (dashboard) │
                    └──────┬───────┘
                           │ proxy
                    ┌──────┴───────┐
        ┌──────────►│  Fastify API │ :3000
        │           └──────┬───────┘
        │                  │
   ┌────┴────┐      ┌──────┴───────┐
   │  Redis  │◄────►│   Workers    │
   │  :6379  │      └──────┬───────┘
   └─────────┘             │
        ▲           ┌──────┴───────┐
        │           │  PostgreSQL  │ :5432
        │           └──────────────┘
        │           ┌──────────────┐
        └──────────►│    MinIO     │ :9000
                    └──────────────┘
```

All services defined in `docker-compose.yml` (dev) and `docker-compose.prod.yml` (production). Multi-arch Docker images (amd64 + arm64) built via GitHub Actions and pushed to GHCR.
