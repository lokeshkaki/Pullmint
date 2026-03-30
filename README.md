# Pullmint

AI-powered PR analysis and risk-gated deployment for GitHub.

[![CI](https://github.com/lokeshkaki/pullmint/actions/workflows/ci.yml/badge.svg)](https://github.com/lokeshkaki/pullmint/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Pullmint runs specialized AI agents on every pull request — Architecture, Security, Performance, and Maintainability — posts inline review comments on the exact lines that matter, scores risk with weights that learn from your deployment outcomes, and auto-deploys what's safe.

```
PR opened → 4 AI agents in parallel → inline review + risk score → auto-deploy or hold → monitor
```

## Get Started

**GitHub Action** — no servers, no setup:

```yaml
- uses: lokeshkaki/pullmint@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Self-hosted** — full pipeline with dashboard:

```bash
npx create-pullmint@latest
```

Or manually: `git clone`, `cp .env.example .env`, `docker compose up`. Dashboard at `localhost:3001`.

## What It Does

- **Multi-agent analysis** — 4 built-in agents + up to 5 custom agents analyze diffs in parallel via BullMQ Flows
- **Inline PR comments** — findings anchored to specific diff lines, with lifecycle badges (new / persisted / resolved)
- **Incremental analysis** — on force-pushes, only re-runs agents whose files changed
- **Adaptive risk scoring** — signal weights learn from deployment outcomes using exponential moving averages
- **Deployment gating** — low-risk PRs auto-deploy; high-risk PRs are held
- **Real-time dashboard** — React SPA with analytics, cost tracking, kanban risk board, and trend charts
- **Notifications** — Slack, Discord, Teams, or generic webhooks with HMAC signing
- **Cost tracking** — per-repo token usage with monthly budgets
- **Multi-provider LLM** — Anthropic, OpenAI, Google Gemini — switch with one env var

## Per-Repo Config

Drop a `.pullmint.yml` in your repo root:

```yaml
severity_threshold: medium
ignore_paths: ['generated/**']
agents:
  performance: false
auto_approve_below: 25
monthly_budget_usd: 50
custom_agents:
  - name: accessibility
    type: accessibility
    prompt: 'Analyze for WCAG compliance, ARIA attributes, keyboard navigation.'
    include_paths: ['src/components/**']
    weight: 0.10
```

## Architecture

| Layer        | Tech                                    |
| ------------ | --------------------------------------- |
| API          | Fastify, Node.js 20                     |
| Workers      | BullMQ (3 scalable groups)              |
| Database     | PostgreSQL 16 + pgvector                |
| Queue/Events | Redis 7 (BullMQ + Pub/Sub SSE)          |
| Storage      | MinIO (S3-compatible)                   |
| Dashboard    | React, Vite, shadcn/ui, Tailwind        |
| AI           | Anthropic, OpenAI, Google Gemini        |
| CI/CD        | GitHub Actions, multi-arch Docker, GHCR |

```
services/
├── api/             # Fastify server — webhooks, dashboard API, SSE, demo
├── workers/         # BullMQ processors — analysis, synthesis, deployment, notifications
├── shared/          # DB schema, queues, LLM providers, risk evaluator, types
├── dashboard-ui/    # React SPA
├── dashboard/       # Nginx reverse proxy
└── e2e/             # End-to-end tests
action/              # GitHub Action (zero-infra mode)
site/                # Astro landing page + demo playground
packages/create-pullmint/  # CLI setup wizard
benchmarks/          # Performance benchmarks with CI regression detection
```

## Docs

- **[Architecture](docs/ARCHITECTURE.md)** — system design, data flow, agent pipeline, SSE
- **[Development](docs/DEVELOPMENT.md)** — local setup, testing, commands, CI
- **[Deployment](docs/DEPLOYMENT.md)** — production setup with Docker Compose
- **[Security](docs/SECURITY.md)** — auth, secrets, rate limiting, SSRF protection
- **[Monitoring](docs/MONITORING.md)** — health checks, logging, tracing, Bull Board

## License

MIT
