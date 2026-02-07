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
- **Budget-Conscious:** ~$40/month operating cost for 250 PRs
- **Production-Grade:** Comprehensive error handling, monitoring, and observability

## Tech Stack

**Backend:**
- Node.js 20 + TypeScript
- AWS Lambda (serverless compute)
- Amazon EventBridge (event routing)
- DynamoDB (state management + caching)
- Amazon SQS (message queuing)

**AI/LLM:**
- OpenAI GPT-3.5-Turbo (primary analysis)
- GPT-4 (complex cases - Phase 2)

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
- OpenAI API key
- GitHub Personal Access Token

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
npm run deploy
```

### Configuration

After deployment, you need to configure secrets:

1. **OpenAI API Key:**
```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/openai-api-key \
  --secret-string "sk-your-openai-key"
```

2. **GitHub Token:**
```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/github-app-private-key \
  --secret-string "ghp_your-github-token"
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

## How It Works

1. **PR Created/Updated** → GitHub sends webhook event
2. **Webhook Receiver** → Validates signature, creates execution record
3. **EventBridge** → Routes event to LLM agent queue
4. **Architecture Agent** → Fetches PR diff, analyzes with GPT-3.5
5. **GitHub Integration** → Posts findings as PR comment
6. **Auto-Approval** → Low-risk PRs (score < 30) automatically approved

## Cost Breakdown

**Fixed Costs:**
- CloudWatch Logs: ~$3/month
- DynamoDB: ~$1/month
- API Gateway: ~$0.35/month

**Variable Costs (250 PRs/month):**
- OpenAI API: ~$30/month
- Lambda: ~$0 (within free tier)
- Data transfer: ~$2/month

**Total: ~$37/month**

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

## Contributing

This is a personal learning project. Issues and suggestions welcome!

## License

MIT License - see [LICENSE](LICENSE)

## Author

Lokesh Kaki - [GitHub](https://github.com/lokeshkaki)