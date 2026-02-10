# Pullmint

> **AI-powered PR analysis and deployment automation for GitHub**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-Serverless-orange)](https://aws.amazon.com/)

## What is Pullmint?

Pullmint automates PR analysis and risk-gated deployments for GitHub. It reviews code changes with LLMs, posts structured findings, and deploys low-risk changes to staging with full traceability.

## Quick Start

```bash
# Clone and install
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint && npm install

# Deploy to AWS
cd infrastructure
export GITHUB_APP_ID=your-app-id
npm run deploy
```

**Full setup instructions:** [Deployment Guide](docs/DEPLOYMENT.md)

## How It Works

```
PR Created → Webhook → LLM Analysis → Risk Scoring → Auto-Deploy (if low-risk) → Dashboard
```

1. **GitHub webhook** → Pullmint receives PR events
2. **Claude Sonnet 4.5** → Analyzes code changes for quality, security, and risk
3. **Risk scoring** → Calculates 0-100 risk score based on findings
4. **Auto-deployment** → Low-risk PRs deploy to staging (threshold configurable)
5. **Dashboard** → Real-time visibility into all executions

**Detailed architecture:** [Architecture Guide](docs/ARCHITECTURE.md)

## Features

- PR analysis with structured findings and risk scoring
- Risk-gated deployment orchestration with retries and rollback hooks
- Dashboard and REST API for execution history
- Serverless AWS architecture with CloudWatch monitoring

## Tech Stack

- **Compute:** AWS Lambda (Node.js 20)
- **Storage:** DynamoDB + S3
- **Orchestration:** EventBridge + SQS
- **AI:** Anthropic Claude Sonnet 4.5
- **Infra:** AWS CDK (TypeScript)
- **CI/CD:** GitHub Actions

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Dashboard](docs/DASHBOARD.md)
- [Security](docs/SECURITY.md)
- [Monitoring](docs/MONITORING.md)
- [Cost Analysis](docs/COST.md)
- [Development](docs/DEVELOPMENT.md)
- [Critical Gaps](docs/CRITICAL-GAPS.md)

## Project Structure

```
pullmint/
├── infrastructure/       # AWS CDK (CloudFormation templates)
├── services/
│   ├── webhook-receiver/      # GitHub webhook handler
│   ├── architecture-agent/    # LLM-powered analysis
│   ├── github-integration/    # Post results to GitHub
│   ├── deployment-orchestrator/ # Auto-deploy logic
│   ├── dashboard-api/         # REST API
│   ├── dashboard-ui/          # Web interface
│   └── shared/               # Common utilities
└── docs/                 # Full documentation
```

## Cost

~**$32/month** for 250 PRs. See [Cost Analysis](docs/COST.md) for details and scaling projections.

## Development

```bash
# Build all services
npm run build

# Run tests
npm test

# Lint & format
npm run lint
npm run format

# Deploy to AWS
cd infrastructure && npm run deploy
```

**Full development guide:** [Development](docs/DEVELOPMENT.md)

## Status

Phase 2 complete. Phase 3 planned (see [Critical Gaps](docs/CRITICAL-GAPS.md)).

## License

MIT License - Copyright (c) 2026 Lokesh Kaki
