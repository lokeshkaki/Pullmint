# Pullmint

> AI-powered PR analysis and risk-gated deployment for GitHub — self-hosted or as a GitHub Action

[![CI](https://github.com/lokeshkaki/pullmint/actions/workflows/ci.yml/badge.svg)](https://github.com/lokeshkaki/pullmint/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Pullmint reviews every PR with specialized AI agents, posts inline review comments on specific code lines, tracks finding lifecycle across pushes, scores risk with adaptive learning, and auto-deploys low-risk changes — with custom agents, cost tracking, team analytics, and notifications built in.

## How It Works

```
PR opened → Webhook → 4+ AI agents analyze in parallel → Risk score → Auto-deploy if safe → Monitor
```

1. **Multi-agent analysis** — Architecture, Security, Performance, and Maintainability agents review the diff in parallel, plus custom user-defined agents
2. **Inline PR review** — Findings posted as inline comments anchored to specific diff lines with lifecycle badges (new/persisted/resolved)
3. **Incremental analysis** — On force-pushes, only re-analyzes agents whose relevant files changed, reusing prior results for the rest
4. **Finding lifecycle** — Tracks findings across PR iterations — see what's new, what persists, and what was resolved
5. **Risk scoring** — Findings are deduplicated, weighted, and synthesized into a 0–100 risk score with adaptive signal weights that learn from deployment outcomes
6. **Deployment gating** — Low-risk PRs auto-deploy to staging; high-risk PRs are held for review
7. **Post-deploy monitoring** — Tracks deployment health and auto-rolls back on failure
8. **Real-time dashboard** — React SPA with team analytics, cost tracking, risk board, trend charts, and notification management
9. **Cost tracking** — Per-repo LLM token usage monitoring with configurable monthly budgets
10. **Notifications** — Push results to Slack, Discord, Teams, or generic webhooks

## Quick Start

### GitHub Action (zero infra)

```yaml
# .github/workflows/pullmint.yml
- uses: lokeshkaki/pullmint@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### One-Command Setup (self-hosted)

```bash
npx create-pullmint@latest
```

### Manual Setup (self-hosted)

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
cp .env.example .env   # Fill in required values
npm install
docker compose up
```

The dashboard is at `http://localhost:3001`. Multi-arch Docker images (amd64 + arm64) support everything from Raspberry Pi to cloud.

### LLM Provider Configuration

Pullmint supports multiple LLM providers through `LLM_PROVIDER`.

| Provider      | `LLM_PROVIDER` value | Required environment variables |
| ------------- | -------------------- | ------------------------------ |
| Anthropic     | `anthropic`          | `ANTHROPIC_API_KEY`            |
| OpenAI        | `openai`             | `OPENAI_API_KEY`               |
| Google Gemini | `google`             | `GOOGLE_API_KEY`               |

Optional for OpenAI-compatible endpoints: `OPENAI_BASE_URL`.
When switching providers, set per-agent model overrides such as `LLM_ARCHITECTURE_MODEL`, `LLM_SECURITY_MODEL`, `LLM_PERFORMANCE_MODEL`, and `LLM_MAINTAINABILITY_MODEL`. See `.env.example` for full examples.

### Per-Repo Configuration

Drop a `.pullmint.yml` in your repo root to customize analysis:

```yaml
severity_threshold: medium
ignore_paths: ['generated/**']
agents:
  performance: false
auto_approve_below: 25
monthly_budget_usd: 50

# Define custom agents for your domain
custom_agents:
  - name: accessibility
    type: accessibility
    prompt: |
      You are an accessibility expert. Analyze for WCAG compliance,
      missing ARIA attributes, keyboard navigation, and color contrast.
    include_paths: ['src/components/**', '**/*.css']
    weight: 0.10
```

## Tech Stack

| Layer          | Technology                                       |
| -------------- | ------------------------------------------------ |
| API            | Fastify (Node.js 20)                             |
| Workers        | BullMQ job processors                            |
| Database       | PostgreSQL 16 (pgvector)                         |
| Queue/Events   | Redis 7 (BullMQ + Pub/Sub)                       |
| Object Storage | MinIO (S3-compatible)                            |
| Dashboard      | React + Vite + shadcn/ui + Tailwind SPA          |
| AI             | Multi-provider: Anthropic, OpenAI, Google Gemini |
| ORM            | Drizzle                                          |
| CI/CD          | GitHub Actions → GHCR                            |

## Project Structure

```
services/
├── api/            # Fastify HTTP server (webhooks, dashboard API, analytics, demo, SSE)
├── workers/        # BullMQ processors (analysis, synthesis, deployment, notification, calibration)
├── shared/         # Database schema, queue config, LLM provider, cost tracker, notifications, types
├── dashboard/      # Nginx reverse proxy + React SPA serving
├── dashboard-ui/   # React + Vite + shadcn/ui dashboard
└── e2e/            # End-to-end test suite
action/             # GitHub Action for zero-infra PR analysis
site/               # Astro + Tailwind landing page & demo
packages/
└── create-pullmint/ # npx create-pullmint CLI setup wizard
benchmarks/         # Performance benchmark suite
```

## Key Features

| Feature                    | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| **Multi-agent analysis**   | 4 built-in + up to 5 custom agents analyze PRs in parallel     |
| **Multi-LLM provider**     | Anthropic, OpenAI, Google Gemini — switch with one env var     |
| **Inline PR comments**     | Findings anchored to specific diff lines with lifecycle badges |
| **Finding lifecycle**      | Tracks new/persisted/resolved across PR iterations             |
| **Incremental analysis**   | Re-runs only changed agents on force-pushes                    |
| **Adaptive risk scoring**  | Signal weights learn from deployment outcomes                  |
| **Cost tracking**          | Per-repo token usage monitoring with monthly budgets           |
| **Team analytics**         | Org summary, trends, author leaderboard, repo comparison       |
| **Notifications**          | Slack, Discord, Teams, generic webhooks                        |
| **GitHub Action**          | Zero-infra mode — no servers needed                            |
| **Interactive demo**       | Try it at `/demo` without installing                           |
| **Multi-arch Docker**      | Runs on Raspberry Pi to cloud (amd64 + arm64)                  |
| **One-command setup**      | `npx create-pullmint@latest`                                   |
| **Performance benchmarks** | CI regression detection with p50/p95/p99 stats                 |

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — System design, data flow, multi-agent analysis, SSE
- **[Development](docs/DEVELOPMENT.md)** — Local setup, testing, code style, CI
- **[Deployment](docs/DEPLOYMENT.md)** — Production deployment with Docker Compose
- **[Security](docs/SECURITY.md)** — Auth model, secret management, network security
- **[Monitoring](docs/MONITORING.md)** — Health checks, logging, tracing, Bull Board

## License

MIT — Copyright (c) 2026 Lokesh Kaki
