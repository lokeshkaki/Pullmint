# Pullmint - Autonomous PR Review Platform

> Fresh approvals for clean code

**AI-powered pull request analysis and automation for GitHub workflows**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

## What is Pullmint?

An intelligent PR review automation platform that combines LLM-powered code analysis with traditional CI/CD tools to:

- Reduce review time by 70%
- Auto-approve low-risk changes
- Provide consistent, high-quality feedback
- Integrate seamlessly with GitHub workflows

## Architecture Highlights

- **Event-Driven:** EventBridge orchestrates webhook events to specialized agents
- **Multi-Agent System:** Dedicated LLM agents for architecture, security, and performance analysis
- **Serverless-First:** Built entirely on AWS Lambda + DynamoDB for cost optimization
- **Budget-Conscious:** ~$32/month operating cost for 250 PRs
- **Production-Grade:** Comprehensive error handling, monitoring, and observability

## Tech Stack

**Backend:**

- Node.js 20 + TypeScript
- AWS Lambda (serverless compute)
- AWS Step Functions (workflow orchestration)
- Amazon EventBridge (event routing)
- DynamoDB (state management + caching)
- Amazon SQS (message queuing)
- Amazon S3 (artifact storage)

**AI/LLM:**

- Anthropic Claude Sonnet 4.5 (code analysis)
- Semgrep (SAST security scanning)

**Infrastructure:**

- AWS CDK (TypeScript)
- GitHub Actions (CI/CD)

## Project Structure

```
pullmint/
├── infrastructure/          # AWS CDK infrastructure code
│   ├── bin/                # CDK app entry point
│   ├── lib/                # CDK stacks
│   │   └── webhook-stack.ts
│   └── package.json
├── services/               # Lambda functions
│   ├── webhook-receiver/   # GitHub webhook handler
│   ├── llm-agents/
│   │   └── architecture-agent/  # LLM-based code analysis
│   ├── github-integration/ # Post results to GitHub
│   └── shared/            # Shared utilities
│       ├── types.ts
│       ├── secrets.ts
│       ├── dynamodb.ts
│       ├── eventbridge.ts
│       └── utils.ts
├── package.json           # Root package.json
├── tsconfig.json         # TypeScript config
└── README.md
```

## Quick Start

### Prerequisites

- AWS Account with CLI configured
- Node.js 20+
- AWS CDK CLI: `npm install -g aws-cdk`
- Anthropic API key
- GitHub App private key (PEM)
- GitHub App ID

### Installation

```bash
# Clone repository
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint

# Install dependencies
npm install

# Bootstrap CDK (first time only)
cdk bootstrap

# Navigate to infrastructure
cd infrastructure
npm install

# Deploy infrastructure
export GITHUB_APP_ID=your-github-app-id
npm run deploy
```

### Configuration

After deployment, configure secrets:

1. **Anthropic API Key:**

```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/anthropic-api-key \
  --secret-string "sk-ant-your-anthropic-key"
```

2. **GitHub App Private Key:**

```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/github-app-private-key \
  --secret-string "$(cat /path/to/your/private-key.pem)"
```

3. **Webhook Secret:**

```bash
# Get the generated secret
aws secretsmanager get-secret-value \
  --secret-id pullmint/github-webhook-secret \
  --query SecretString --output text
```

4. **Configure GitHub Webhook:**
   - Go to your repository settings → Webhooks → Add webhook
   - Payload URL: (use the WebhookURL from CDK output)
   - Content type: `application/json`
   - Secret: (use the webhook secret from step 3)
   - Events: Select "Pull requests"
   - Active: ✓

### Migration Note

Pullmint uses Anthropic Claude Sonnet 4.5 for analysis. If you are upgrading from an OpenAI-backed deployment, update your Secrets Manager entry to `pullmint/anthropic-api-key` and refresh any environment references to `ANTHROPIC_API_KEY`.

## How It Works

1. **PR Created/Updated** → GitHub sends webhook event
2. **Webhook Receiver** → Validates signature, creates execution record
3. **EventBridge** → Routes event to LLM agent queue
4. **Architecture Agent** → Fetches PR diff, analyzes with Claude Sonnet 4.5
5. **GitHub Integration** → Posts findings as PR comment
6. **Auto-Approval** → Low-risk PRs (score < 30) automatically approved

## Cost Breakdown

**Fixed Costs:**

- CloudWatch Logs: ~$3/month
- DynamoDB: ~$1/month
- API Gateway: ~$0.35/month
- S3 Storage: ~$0.50/month

**Variable Costs (250 PRs/month):**

- Anthropic API (Claude Sonnet): ~$25/month
  - Input: 250 PRs × 3K tokens avg × $3/M = $2.25
  - Output: 250 PRs × 1.5K tokens avg × $15/M = $5.63
  - Buffer for retries/large PRs: ~$17
- Lambda: ~$0 (within free tier)
- Data transfer: ~$2/month

**Total: ~$32/month**

## Current Status

**Phase 1: Core Infrastructure** (COMPLETED)

- [x] Project structure initialized
- [x] Webhook receiver implementation
- [x] Architecture agent implementation
- [x] GitHub integration
- [x] AWS CDK infrastructure
- [ ] End-to-end testing
- [ ] Documentation

## Development

```bash
# Build all services
npm run build

# Run tests
npm run test

# Lint code
npm run lint

# Format code
npm run format
```

## Deployment

```bash
# Deploy infrastructure only
cd infrastructure
npm run deploy

# Deploy all stacks
npm run deploy:all

# View changes before deploying
npm run diff
```

## Environment Variables

See [.env.example](.env.example) for all configuration options.

## License

MIT License - see [LICENSE](LICENSE)
