# Architecture

Pullmint is a TypeScript monorepo running as Docker containers. PostgreSQL stores state, Redis handles job queues and real-time events, MinIO stores large artifacts, and Nginx serves the dashboard.

## Services

### API (`services/api/`)

Fastify HTTP server handling:

- **GitHub webhooks** — receives PR events, enqueues analysis jobs
- **Dashboard REST API** — execution history, risk board, calibration data, repo management
- **SSE endpoint** — `GET /dashboard/events` pushes real-time execution updates to the dashboard
- **Signal ingestion** — accepts external CI/CD signals (test results, deploy status, error rates)
- **Health checks** — `/health` (liveness), `/health/ready` (readiness: Postgres + Redis)
- **Bull Board** — admin UI for queue inspection at `/admin/queues`

### Workers (`services/workers/`)

BullMQ job processors, one per queue:

| Processor               | Queue                | Purpose                                                 |
| ----------------------- | -------------------- | ------------------------------------------------------- |
| `analysis.ts`           | `analysis`           | Dispatches multi-agent analysis flow                    |
| `agent.ts`              | `agent`              | Runs individual AI agent (4 specializations)            |
| `synthesis.ts`          | `synthesis`          | Merges agent results, deduplicates, scores risk         |
| `github-integration.ts` | `github-integration` | Posts results to GitHub, triggers deployment            |
| `deployment.ts`         | `deployment`         | Executes deployment orchestration                       |
| `deployment-status.ts`  | `deployment-status`  | Monitors post-deploy health                             |
| `calibration.ts`        | `calibration`        | Updates risk calibration + signal weights from outcomes |
| `repo-indexing.ts`      | `repo-indexing`      | Indexes repository structure                            |
| `cleanup.ts`            | `cleanup`            | Prunes expired data                                     |

**Scheduled jobs** (in `scheduled.ts`):

- Deployment monitor — every 5 minutes
- Dependency scanner — daily at 2 AM
- Cleanup — hourly
- Signal recalibration — weekly (Sunday 3 AM)

### Dashboard (`services/dashboard/` + `services/dashboard-ui/`)

Nginx serves the static SPA and reverse-proxies API routes. The SPA is vanilla HTML/CSS/JS with no build step.

**Views:** Execution list, Kanban risk board, execution detail, calibration metrics, repo management.

**Real-time updates:** The dashboard connects to `/dashboard/events` via `EventSource` (SSE) for instant status changes, with a 60-second fallback poll.

### Shared (`services/shared/`)

Common modules used by both API and Workers:

- `db.ts` / `schema.ts` — Drizzle ORM, PostgreSQL schema (11 tables)
- `queue.ts` — BullMQ queue definitions, `addJob()` helper
- `risk-evaluator.ts` — Risk score computation with configurable signal weights
- `signal-weights.ts` — Adaptive weight resolution (repo → global → hardcoded fallback)
- `execution-events.ts` — Redis Pub/Sub for real-time execution status events
- `config.ts` — Environment variable access with file-based secret support
- `storage.ts` — MinIO/S3-compatible object storage
- `types.ts` / `schemas.ts` — Shared TypeScript types and Zod validators

## Data Flow

### PR Analysis

```
PR webhook
  → analysis queue (dispatcher)
    → agent queue × 4 (parallel via BullMQ Flow)
      → synthesis queue (parent job, waits for children)
        → github-integration queue
          → deployment queue (if auto-deploy)
            → deployment-status queue (monitoring)
              → calibration queue (outcome learning)
```

The dispatcher creates a BullMQ Flow with 4 agent children and a synthesis parent. Agents run in parallel; the synthesizer collects results via `job.getChildrenValues()`.

### AI Agents

| Agent           | Model             | Focus                                             |
| --------------- | ----------------- | ------------------------------------------------- |
| Architecture    | Claude Sonnet 4.6 | Structural impact, coupling, API changes          |
| Security        | Claude Sonnet 4.6 | Vulnerabilities, auth, injection, data exposure   |
| Performance     | Claude Haiku 4.5  | N+1 queries, memory leaks, algorithmic complexity |
| Maintainability | Claude Haiku 4.5  | Readability, naming, duplication, test coverage   |

Small diffs (< 200 lines) only run Architecture + Security. Agent weights are configurable via `AGENT_WEIGHT_*` env vars (default: 0.35/0.35/0.15/0.15).

### Risk Scoring

1. Each agent produces findings with individual risk scores
2. Findings are deduplicated (exact match + Levenshtein overlap)
3. Agent scores are weighted and combined
4. External signals (CI status, error rates, coverage) adjust the score via learned signal weights
5. Final score: 0–100, where higher = riskier

### Signal Weight Learning

Signal weights adapt over time using exponential moving averages:

- **Rollback** → weight increases (signal was right but too weak)
- **False positive** (held then confirmed safe) → weight decreases
- **Confirmed good** → no change

Three-tier resolution: repo-specific weights (after 10+ observations) → global baseline → hardcoded defaults.

### Real-Time Updates (SSE)

```
Worker status change → Redis Pub/Sub → API subscriber → fan-out to SSE clients → Dashboard
```

Workers publish events on every execution status transition. The API maintains a single Redis subscriber connection shared across all connected dashboard clients. Events are filtered per-client by repository.

## Database

PostgreSQL 16 with pgvector extension. 11 tables managed by Drizzle ORM with auto-migration on API startup.

Key tables: `executions`, `findings`, `calibrations`, `signal_weight_defaults`, `repositories`, `module_narratives` (with 1536-dim embeddings), `webhook_dedup`, `llm_cache`, `llm_rate_limits`, `dependency_graphs`, `deployment_records`.

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

All services defined in `docker-compose.yml` (dev) and `docker-compose.prod.yml` (production). CI/CD via GitHub Actions builds Docker images and pushes to GHCR.
