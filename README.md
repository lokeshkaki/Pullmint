# Pullmint

> **AI-powered PR analysis and deployment automation for GitHub**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-Serverless-orange)](https://aws.amazon.com/)

## What is Pullmint?

Pullmint combines LLM-powered code analysis with automated deployment to streamline your GitHub PR workflow:

🚀 **Auto-deploy low-risk PRs** — Changes with risk scores < 40 automatically deploy to staging  
💡 **Instant AI feedback** — Claude Sonnet 4.5 analyzes architecture, security, and code quality  
⚡ **70% faster reviews** — Get structured PR feedback in 20-60 seconds  
📊 **Real-time dashboard** — Monitor all PRs, risk scores, and deployments in one place  
💰 **Budget-friendly** — ~$32/month for 250 PRs (serverless architecture)

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

> 📖 **Full setup instructions:** [Deployment Guide](docs/DEPLOYMENT.md)

## How It Works

```
PR Created → Webhook → LLM Analysis → Risk Scoring → Auto-Deploy (if low-risk) → Dashboard
```

1. **GitHub webhook** → Pullmint receives PR events
2. **Claude Sonnet 4.5** → Analyzes code changes for quality, security, and risk
3. **Risk scoring** → Calculates 0-100 risk score based on findings
4. **Auto-deployment** → PRs < 40 risk automatically deploy to staging
5. **Dashboard** → Real-time visibility into all executions

> 📖 **Detailed architecture:** [Architecture Guide](docs/ARCHITECTURE.md)

## Features

### 🤖 AI-Powered Analysis
- Architecture quality assessment
- Code complexity detection
- Risk score calculation (0-100)
- Structured findings with file/line references
- Auto-approval for trivial changes (< 30 risk)

### 🚀 Auto-Deployment
- Risk-gated deployments (configurable thresholds)
- Webhook-based deployment triggers
- Retry logic with exponential backoff
- Rollback on failure
- DynamoDB + GitHub status tracking

### 📊 Real-Time Dashboard
- Filter by repo, status, risk score
- View findings and deployment timelines
- Auto-refresh with smart polling
- REST API for custom integrations
- Pagination for large datasets

### 🔒 Production-Ready
- Serverless AWS architecture (Lambda, DynamoDB, EventBridge)
- Comprehensive error handling and monitoring
- CloudWatch alarms for critical errors
- Secret management via AWS Secrets Manager
- 80%+ test coverage across all services

## Tech Stack

- **Compute:** AWS Lambda (Node.js 20)
- **Storage:** DynamoDB + S3
- **Orchestration:** EventBridge + SQS
- **AI:** Anthropic Claude Sonnet 4.5
- **Infra:** AWS CDK (TypeScript)
- **CI/CD:** GitHub Actions

## Documentation

📚 **Comprehensive guides:**

- [🚀 Deployment Guide](docs/DEPLOYMENT.md) - Setup, configuration, environment variables
- [🏗️ Architecture](docs/ARCHITECTURE.md) - System design, data models, tech stack
- [📊 Dashboard](docs/DASHBOARD.md) - Features, API endpoints, usage
- [🔒 Security](docs/SECURITY.md) - Best practices, secret management, compliance
- [📈 Monitoring](docs/MONITORING.md) - CloudWatch metrics, alarms, debugging
- [💰 Cost Analysis](docs/COST.md) - Pricing breakdown, optimization tips
- [👨‍💻 Development](docs/DEVELOPMENT.md) - Local setup, testing, contributing
- [⚠️ Critical Gaps](docs/CRITICAL-GAPS.md) - Production gaps, next steps

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

~**$32/month** for 250 PRs:

| Service | Cost | % of Total |
|---------|------|------------|
| Anthropic API (Claude) | ~$25 | 78% |
| AWS Infrastructure | ~$5 | 16% |
| Data Transfer | ~$2 | 6% |

> 💡 **Scales linearly:** 500 PRs = ~$62/month, 1,000 PRs = ~$122/month  
> 📖 **Detailed breakdown:** [Cost Analysis](docs/COST.md)

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

> 📖 **Full development guide:** [Development](docs/DEVELOPMENT.md)

## Status

**✅ Phase 1:** Core infrastructure (completed)  
**✅ Phase 2:** Auto-deployment + Dashboard (completed)  
**📋 Phase 3:** Production hardening (see [Critical Gaps](docs/CRITICAL-GAPS.md))

## License

MIT License - Copyright (c) 2026 Lokesh Kaki

## Links

- [Deployment Guide](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Dashboard](docs/DASHBOARD.md)
- [Security](docs/SECURITY.md)
- [Monitoring](docs/MONITORING.md)
- [Cost Analysis](docs/COST.md)
- [Development](docs/DEVELOPMENT.md)
- [Critical Gaps](docs/CRITICAL-GAPS.md)
