# Deployment Guide

Pullmint runs as Docker containers orchestrated by Docker Compose. Any host with Docker can run it — from a Raspberry Pi to a cloud VM.

## Production Setup

### 1. Prepare the host

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
cp .env.example .env
```

### 2. Configure environment

Edit `.env` with production values:

```bash
# Required
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
ANTHROPIC_API_KEY=<your-api-key>
SIGNAL_INGESTION_HMAC_SECRET=<random-secret>

# Deployment (if using auto-deploy)
DEPLOYMENT_WEBHOOK_URL=<your-deploy-endpoint>
DEPLOYMENT_WEBHOOK_SECRET=<random-secret>

# Dashboard
DASHBOARD_AUTH_TOKEN=<random-token>
ADMIN_AUTH_TOKEN=<random-token>        # Optional, falls back to DASHBOARD_AUTH_TOKEN
ALLOWED_ORIGINS=https://your-domain.com
```

### 3. Start services

```bash
docker compose -f docker-compose.prod.yml up -d
```

### 4. Verify

```bash
curl http://localhost:3000/health        # Liveness
curl http://localhost:3000/health/ready   # Readiness (Postgres + Redis)
```

## GitHub App Setup

1. Create a GitHub App at https://github.com/settings/apps/new
2. Set the webhook URL to `https://your-domain.com/webhook`
3. Required permissions:
   - **Pull requests:** Read & Write
   - **Contents:** Read
   - **Checks:** Read & Write
   - **Deployments:** Read & Write (if using auto-deploy)
4. Subscribe to events: Pull request, Deployment status
5. Generate and download the private key (`.pem` file)
6. Install the app on your target repositories

Or use the setup wizard: `npx create-pullmint@latest` walks through everything interactively.

## Services

| Service             | Port      | Purpose                          |
| ------------------- | --------- | -------------------------------- |
| `dashboard` (Nginx) | 3001 → 80 | Dashboard UI + API reverse proxy |
| `api` (Fastify)     | 3000      | HTTP API + SSE endpoint          |
| `workers`           | —         | Background job processors        |
| `postgres`          | 5432      | Primary database                 |
| `redis`             | 6379      | Job queues + Pub/Sub             |
| `minio`             | 9000/9001 | Object storage                   |

## Worker Scaling

Workers can run as a single process (default) or split into 3 independently scalable groups:

```bash
# Split mode — scale analysis workers independently
docker compose --profile split up --scale workers=0
```

| Group       | `WORKER_GROUP` | Queues                                                          | Scale with         |
| ----------- | -------------- | --------------------------------------------------------------- | ------------------ |
| Analysis    | `analysis`     | analysis, agent, synthesis                                      | PR volume          |
| Integration | `integration`  | github-integration, deployment, deployment-status, notification | Webhook throughput |
| Background  | `background`   | calibration, repo-indexing, cleanup                             | Batch workload     |

## Database

Migrations run automatically on API startup via Drizzle. No manual migration step needed.

To generate new migrations after schema changes:

```bash
npx drizzle-kit generate
```

## Data Persistence

Docker volumes store persistent data:

- `postgres_data` — database
- `redis_data` — queue state (AOF persistence enabled)
- `minio_data` — analysis artifacts

## Secrets

Pullmint reads secrets two ways:

1. **Environment variable** — `ANTHROPIC_API_KEY=sk-...`
2. **File path** — `ANTHROPIC_API_KEY_PATH=./secrets/anthropic.key`

The file-based approach is compatible with Docker secrets and Kubernetes secrets. `getConfig()` checks the env var first, then falls back to reading the file at `${KEY}_PATH`.

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

All services have `stop_grace_period` configured (30s for workers, 15s for API) to allow in-flight work to complete during rolling updates.

## CI/CD

GitHub Actions builds multi-arch Docker images (amd64 + arm64) on every push to `main` and publishes to GHCR. See `.github/workflows/deploy.yml` for the full pipeline.
