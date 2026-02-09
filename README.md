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
- **Agent-Driven Analysis:** Dedicated LLM agents provide structured findings and risk scoring
- **Serverless-First:** Built entirely on AWS Lambda + DynamoDB for cost optimization
- **Risk-Gated Deployments:** Optional staging deploys triggered by low-risk PRs
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
2. **Webhook Receiver** → Validates signature, creates execution record, publishes to EventBridge
3. **EventBridge** → Routes event to LLM agent queue (SQS)
4. **Architecture Agent** → Fetches PR diff, analyzes with Claude Sonnet 4.5, publishes results
5. **GitHub Integration** → Posts findings as PR comment, evaluates deployment gates
6. **Risk Gate (Phase B)** → Low-risk PRs (score < 30) trigger deployment orchestration
7. **Deployment Orchestrator** → Executes deployment, updates status in DynamoDB and GitHub
8. **Auto-Approval** → Low-risk PRs (score < 30) automatically approved

## Deployment Configuration

Pullmint supports risk-gated automatic deployments with the following environment variables:

**Risk Thresholds:**

- `DEPLOYMENT_RISK_THRESHOLD` (default: `30`) - Maximum risk score to allow deployment
- `AUTO_APPROVE_RISK_THRESHOLD` (default: `30`) - Maximum risk score to auto-approve PR

**Deployment Strategy:**

- `DEPLOYMENT_STRATEGY` (default: `eventbridge`) - Options: `eventbridge`, `label`, `deployment`
  - `eventbridge`: Trigger deployment via EventBridge orchestrator (recommended)
  - `label`: Add deployment label to PR (legacy)
  - `deployment`: Create GitHub deployment event (future)

**Deployment Gates:**

- `DEPLOYMENT_REQUIRE_TESTS` (default: `false`) - Block deployment until tests pass
- `DEPLOYMENT_REQUIRED_CONTEXTS` (CSV) - List of required GitHub status checks (e.g., `ci,security-scan`)

**Deployment Environment:**

- `DEPLOYMENT_ENVIRONMENT` (default: `staging`) - Target environment name
- `DEPLOYMENT_LABEL` (default: `deploy:staging`) - Label to add for label-based strategy

**Note:** The current deployment orchestrator is a mock implementation for testing. See TODO comments in `services/deployment-orchestrator/index.ts` for integration points with real deployment systems (CodeDeploy, ECS, Kubernetes, etc.).

## Monitoring and Observability

Pullmint includes CloudWatch monitoring for production reliability:

**CloudWatch Alarms:**

- `pullmint-deployment-orchestrator-errors` - Alerts when deployment orchestrator has elevated error rate (≥3 errors in 5 minutes)
- `pullmint-github-integration-errors` - Alerts when GitHub integration has elevated error rate (≥5 errors in 5 minutes)
- `pullmint-webhook-handler-errors` - Alerts when webhook handler has elevated error rate (≥5 errors in 5 minutes)

**Lambda Metrics:**

- All Lambda functions expose standard metrics: Invocations, Errors, Duration, Throttles
- Use CloudWatch Logs Insights to query execution logs and trace request flows

**DynamoDB Metrics:**

- Read/Write capacity monitoring for `pullmint-executions`, `pullmint-cache`, and `pullmint-dedup` tables
- Prevent throttling with auto-scaling or on-demand billing

**EventBridge Metrics:**

- Event publishing success/failure rates
- Rule invocation counts and failed invocations

**Recommended Dashboards:**

- Create CloudWatch dashboards to visualize PR processing latency, deployment success rate, and error rates
- Set up SNS topics for alarm notifications

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
- [x] End-to-end testing
- [x] Documentation

**Phase 2: Auto-Deploy and Dashboard** (IN PROGRESS)

- [x] EventBridge-driven deployment orchestrator
- [x] Risk-gated deployment triggers (score < 30)
- [x] Test gate support for deployment approval
- [x] Deployment status sync to GitHub and DynamoDB
- [x] CloudWatch monitoring and alarms
- [ ] Dashboard API for execution history
- [ ] Lightweight UI with polling

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
