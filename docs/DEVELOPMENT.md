# Development Guide

## Prerequisites

- Node.js 20+
- npm 10+
- Docker & Docker Compose

## Setup

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
cp .env.example .env   # Fill in required values
npm install
docker compose up
```

- **Dashboard:** http://localhost:3001
- **API:** http://localhost:3000
- **MinIO Console:** http://localhost:9001
- **Bull Board:** http://localhost:3001/admin/queues

## Project Structure

```
pullmint/
├── services/
│   ├── api/              # Fastify HTTP server
│   ├── workers/          # BullMQ job processors
│   ├── shared/           # Shared DB, queue, LLM, types, utilities
│   ├── dashboard/        # Nginx config + Dockerfile
│   ├── dashboard-ui/     # React + Vite + shadcn/ui SPA
│   └── e2e/              # End-to-end test suite
├── action/               # GitHub Action (zero-infra mode)
├── site/                 # Astro landing page
├── packages/create-pullmint/  # CLI setup wizard
├── benchmarks/           # Performance benchmarks
├── docker-compose.yml
└── docker-compose.prod.yml
```

This is an npm workspace monorepo. The three main TypeScript packages are `services/shared`, `services/api`, and `services/workers`.

## Commands

```bash
# Type check
npx tsc --noEmit

# Lint
npx eslint <file>

# Format
npx prettier --check <file>
npx prettier --write <file>

# Test by service
cd services/shared && npm run test:coverage
cd services/api && npm run test:coverage
cd services/workers && npm run test:coverage
cd services/dashboard-ui && npx vitest run --coverage
cd action && npm run test:coverage

# Single test
cd services/<name> && npx jest --no-coverage -t "test name pattern"

# E2E tests (requires Docker containers running)
cd services/e2e && RUN_E2E_TESTS=true npm test

# Dashboard UI dev server (Vite with API proxy)
cd services/dashboard-ui && npm run dev

# Build Docker images
docker compose build

# Start with split worker groups
docker compose --profile split up --scale workers=0
```

## Testing

| Suite                   | Framework                   | Coverage Threshold |
| ----------------------- | --------------------------- | ------------------ |
| `services/shared`       | Jest + ts-jest              | 80%                |
| `services/api`          | Jest + ts-jest              | 70% global         |
| `services/workers`      | Jest + ts-jest              | 76-95% varied      |
| `services/dashboard-ui` | Vitest + Testing Library    | 60-70%             |
| `action`                | Jest + ts-jest              | Coverage enforced  |
| `services/e2e`          | Jest (real Docker services) | None (integration) |
| `benchmarks`            | tinybench harness           | None (perf)        |

- **API tests** use Fastify's `app.inject()` — no running server needed
- **Worker tests** create mock BullMQ `Job` objects with `{ id, name, data }`
- **Dashboard tests** use `@testing-library/react` with TanStack Query providers
- **E2E tests** run the full pipeline against real Postgres, Redis, and MinIO; LLM and GitHub API mocked via nock
- **Mocks** use `jest.mock()` at top of file for shared modules (`@pullmint/shared/db`, `@pullmint/shared/queue`, `@pullmint/shared/config`, `@pullmint/shared/storage`, `@pullmint/shared/llm`)

## Code Style

- TypeScript strict mode — `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- Prettier for formatting, ESLint with `@typescript-eslint`
- Drizzle query builder for all DB operations (no raw SQL unless needed for JSONB)
- Structured JSON logging via Fastify's pino logger
- `withErrorHandling()` for consistent error wrapping
- `retryWithBackoff()` for transient failure recovery
- `timingSafeTokenCompare()` for all secret comparisons

## CI Pipeline

GitHub Actions runs on every PR and push to `main`:

1. **Lint** — ESLint across all code
2. **Test** — Jest coverage for shared, api, workers, action
3. **Test (dashboard)** — Vitest coverage for dashboard-ui
4. **Typecheck** — `tsc --noEmit`
5. **Docker build** — `docker compose build`
6. **Security** — `npm audit --production`
7. **Format** — Prettier check
8. **Benchmarks** — CPU benchmarks on every PR, full suite nightly
9. **E2E** — Full pipeline tests nightly with real infrastructure

## Git Workflow

- Branch from `main` for all work
- Branch naming: `feat/`, `fix/`, `chore/`, `test/`, `security/` prefixes
- PRs require CI to pass before merge
- Squash merge to `main`

## Environment Variables

See [.env.example](../.env.example) for the full list. Key variables:

| Variable                       | Required | Description                                                    |
| ------------------------------ | -------- | -------------------------------------------------------------- |
| `GITHUB_APP_ID`                | Yes      | GitHub App ID                                                  |
| `GITHUB_APP_PRIVATE_KEY_PATH`  | Yes      | Path to `.pem` file                                            |
| `GITHUB_WEBHOOK_SECRET`        | Yes      | Webhook signature verification                                 |
| `ANTHROPIC_API_KEY`            | Yes\*    | Claude API access (\*or another LLM provider key)              |
| `SIGNAL_INGESTION_HMAC_SECRET` | Yes      | Signal endpoint auth                                           |
| `DASHBOARD_AUTH_TOKEN`         | No       | Dashboard auth (auto-generated if empty)                       |
| `ADMIN_AUTH_TOKEN`             | No       | Separate admin/Bull Board auth (falls back to dashboard token) |
| `DATABASE_URL`                 | No       | PostgreSQL connection (default: localhost)                     |
| `REDIS_URL`                    | No       | Redis connection (default: localhost)                          |
| `LLM_PROVIDER`                 | No       | `anthropic` (default), `openai`, or `google`                   |
