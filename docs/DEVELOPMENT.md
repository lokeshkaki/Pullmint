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
│   ├── shared/           # Shared DB, queue, types, utilities
│   ├── dashboard/        # Nginx config + Dockerfile
│   └── dashboard-ui/     # Static SPA files
├── docker-compose.yml    # Development infrastructure
├── docker-compose.prod.yml
└── .github/workflows/    # CI/CD
```

This is an npm workspace monorepo. The three TypeScript packages are `services/shared`, `services/api`, and `services/workers`.

## Commands

```bash
# Type check
npx tsc --noEmit

# Lint
npx eslint <file>

# Format
npx prettier --check <file>
npx prettier --write <file>

# Test (all)
npm test

# Test (single service)
cd services/shared && npm test
cd services/api && npm test
cd services/workers && npm test

# Test (single test)
cd services/<name> && npx jest --no-coverage -t "test name pattern"

# Test with coverage
cd services/<name> && npm run test:coverage

# Build Docker images
docker compose build

# Start all services
docker compose up

# Start specific service
docker compose up api workers
```

## Testing

- **Framework:** Jest with ts-jest
- **Coverage threshold:** 80% minimum (some routes/processors have higher)
- **API tests:** Use Fastify's `app.inject()` — no running server needed
- **Worker tests:** Create mock BullMQ `Job` objects with `{ id, name, data }`
- **Mocks:** `jest.mock()` at top of file for shared modules (`@pullmint/shared/db`, `@pullmint/shared/queue`, `@pullmint/shared/config`, `@pullmint/shared/storage`)
- **Integration tests:** `services/api/__tests__/integration/` run against real Docker containers

## Code Style

- TypeScript strict mode
- Prettier for formatting
- ESLint with `@typescript-eslint`
- No raw SQL unless needed for JSONB operations — use Drizzle query builder
- Structured JSON logging via Fastify's pino logger
- `withErrorHandling()` for consistent error wrapping
- `retryWithBackoff()` for transient failure recovery

## CI Pipeline

GitHub Actions runs on every PR and push to `main`:

1. **Lint** — ESLint
2. **Test** — Jest with coverage (matrix: shared, api, workers)
3. **Typecheck** — `tsc --noEmit`
4. **Docker build** — `docker compose build`
5. **Security** — `npm audit`
6. **Format** — Prettier check

## Git Workflow

- Branch from `main` for all work
- Branch naming: `feat/`, `fix/`, `chore/` prefixes
- PRs require CI to pass before merge
- Squash merge to `main`

## Environment Variables

See [.env.example](../.env.example) for all configuration. Key variables:

| Variable                       | Required | Description                                |
| ------------------------------ | -------- | ------------------------------------------ |
| `GITHUB_APP_ID`                | Yes      | GitHub App ID                              |
| `GITHUB_APP_PRIVATE_KEY_PATH`  | Yes      | Path to `.pem` file                        |
| `GITHUB_WEBHOOK_SECRET`        | Yes      | Webhook signature verification             |
| `ANTHROPIC_API_KEY`            | Yes      | Claude API access                          |
| `SIGNAL_INGESTION_HMAC_SECRET` | Yes      | Signal endpoint auth                       |
| `DASHBOARD_AUTH_TOKEN`         | No       | Dashboard auth (auto-generated if empty)   |
| `DATABASE_URL`                 | No       | PostgreSQL connection (default: localhost) |
| `REDIS_URL`                    | No       | Redis connection (default: localhost)      |
