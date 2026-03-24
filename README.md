# Pullmint

> AI-powered PR analysis and risk-gated deployment for GitHub

[![CI](https://github.com/lokeshkaki/pullmint/actions/workflows/ci.yml/badge.svg)](https://github.com/lokeshkaki/pullmint/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Pullmint reviews every PR with specialized AI agents, scores risk, and auto-deploys low-risk changes to staging — all with full traceability.

## How It Works

```
PR opened → Webhook → 4 AI agents analyze in parallel → Risk score → Auto-deploy if safe → Monitor
```

1. **Multi-agent analysis** — Architecture, Security, Performance, and Maintainability agents review the diff in parallel using Claude
2. **Risk scoring** — Findings are deduplicated, weighted, and synthesized into a 0–100 risk score with adaptive signal weights that learn from deployment outcomes
3. **Deployment gating** — Low-risk PRs auto-deploy to staging; high-risk PRs are held for review
4. **Post-deploy monitoring** — Tracks deployment health and auto-rolls back on failure
5. **Real-time dashboard** — Live execution status via SSE, Kanban risk board, calibration metrics

## Quick Start

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
cp .env.example .env   # Fill in required values
npm install
docker compose up
```

The dashboard is at `http://localhost:3001`. See the [Development Guide](docs/DEVELOPMENT.md) for full setup.

## Tech Stack

| Layer          | Technology                    |
| -------------- | ----------------------------- |
| API            | Fastify (Node.js 20)          |
| Workers        | BullMQ job processors         |
| Database       | PostgreSQL 16 (pgvector)      |
| Queue/Events   | Redis 7 (BullMQ + Pub/Sub)    |
| Object Storage | MinIO (S3-compatible)         |
| Dashboard      | Nginx + vanilla JS SPA        |
| AI             | Claude Sonnet 4.6 + Haiku 4.5 |
| ORM            | Drizzle                       |
| CI/CD          | GitHub Actions → GHCR         |

## Project Structure

```
services/
├── api/            # Fastify HTTP server (webhooks, dashboard API, SSE)
├── workers/        # BullMQ processors (analysis, synthesis, deployment, calibration)
├── shared/         # Database schema, queue config, types, utilities
├── dashboard/      # Nginx reverse proxy + static file serving
└── dashboard-ui/   # Static SPA (HTML/CSS/JS)
```

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — System design, data flow, multi-agent analysis, SSE
- **[Development](docs/DEVELOPMENT.md)** — Local setup, testing, code style, CI
- **[Deployment](docs/DEPLOYMENT.md)** — Production deployment with Docker Compose
- **[Security](docs/SECURITY.md)** — Auth model, secret management, network security
- **[Monitoring](docs/MONITORING.md)** — Health checks, logging, tracing, Bull Board

## License

MIT — Copyright (c) 2026 Lokesh Kaki
