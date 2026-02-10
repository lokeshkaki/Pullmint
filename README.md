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
- Amazon EventBridge (event routing)
- DynamoDB (state management + caching)
- Amazon SQS (message queuing)
- Amazon S3 (artifact storage)

**AI/LLM:**

- Anthropic Claude Sonnet 4.5 (code analysis)

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

### Configuration Notes

Pullmint uses Anthropic Claude Sonnet 4.5 for code analysis. Ensure your API key is stored in AWS Secrets Manager at `pullmint/anthropic-api-key`.

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

- `DEPLOYMENT_RISK_THRESHOLD` (default: `40`) - Maximum risk score to allow deployment
- `AUTO_APPROVE_RISK_THRESHOLD` (default: `30`) - Maximum risk score to auto-approve PR

**Threshold Rationale:**

Risk thresholds provide graduated control over automation:

- **Auto-Approve (30):** Only trivial changes (typos, docs, formatting) auto-approve
- **Auto-Deploy (40):** Low-risk changes (minor features, refactors) deploy to staging
- **Manual Review (>40):** High-risk changes (architecture, security, API changes) require human review

This separation ensures:

- Staging deployments test changes before production
- Human oversight for significant changes
- Fast feedback loop for safe changes

**Deployment Strategy:**

- `DEPLOYMENT_STRATEGY` (default: `eventbridge`) - Options: `eventbridge`, `label`, `deployment`

**Strategy Decision Framework:**

| Strategy      | Use When                                        | Pros                                                       | Cons                                      | Status              |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- | ------------------- |
| `eventbridge` | Production deployments with webhook integration | Full control, error handling, retry logic, status tracking | Requires webhook setup                    | ✅ **Recommended**  |
| `label`       | GitHub Actions-based deployments                | Simple, no webhook needed, uses existing CI/CD             | Limited error handling, no built-in retry | 🟡 Legacy Support   |
| `deployment`  | GitHub Deployments API integration              | Native GitHub integration, deployment history              | Not yet implemented                       | 🔵 Future (Phase C) |

**When to use each:**

- **eventbridge:** Default choice for production. Provides webhook-based deployment with comprehensive error handling, automatic retries, and DynamoDB-tracked status.
- **label:** Use if you have an existing GitHub Actions workflow triggered by labels and don't want to set up a deployment webhook.
- **deployment:** Not yet available. Planned for organizations using GitHub Deployments API for deployment tracking.

**Deployment Gates:**

- `DEPLOYMENT_REQUIRE_TESTS` (default: `false`) - Block deployment until tests pass
- `DEPLOYMENT_REQUIRED_CONTEXTS` (CSV) - Comma-separated list of required GitHub status checks that must pass before deployment (e.g., `ci,security-scan,build`). Leave empty to skip status check requirements.

**Deployment Environment:**

- `DEPLOYMENT_ENVIRONMENT` (default: `staging`) - Target environment name
- `DEPLOYMENT_LABEL` (default: `deploy:staging`) - Label to add for label-based strategy

**Deployment Orchestrator Webhooks:**

- `DEPLOYMENT_WEBHOOK_URL` (required for real deployments) - HTTP endpoint to trigger deployments
- `DEPLOYMENT_WEBHOOK_AUTH_TOKEN` (optional) - Bearer token for webhook authentication
- `DEPLOYMENT_WEBHOOK_TIMEOUT_MS` (default: `30000`) - Webhook timeout in milliseconds
- `DEPLOYMENT_WEBHOOK_RETRIES` (default: `3`) - Retry attempts for webhook failures
- `DEPLOYMENT_ROLLBACK_WEBHOOK_URL` (optional) - HTTP endpoint to trigger rollback

**Webhook Timeout and Retry Configuration:**

**Timeout Guidelines:**

- **Simple deployments (static sites, serverless):** 10-30 seconds
- **Container deployments (ECS, Kubernetes):** 30-60 seconds
- **Complex deployments (multi-stage, database migrations):** 60-120 seconds

**Retry Strategy:**

- Uses exponential backoff: 1s, 2s, 4s delays between retries
- Retries on network errors, 5xx responses, and timeouts
- Does NOT retry on 4xx errors (client errors)
- Failed deployments after all retries trigger rollback webhook (if configured)

**Environment-Specific Configuration:**

```bash
# Development: Short timeout, no retries
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=10000
DEPLOYMENT_WEBHOOK_RETRIES=0

# Staging: Moderate timeout, some retries
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=30000
DEPLOYMENT_WEBHOOK_RETRIES=2

# Production: Long timeout, max retries
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=60000
DEPLOYMENT_WEBHOOK_RETRIES=3
```

**Deployment Config (optional):**

- `DEPLOYMENT_CONFIG` - JSON configuration that can replace individual deployment env vars

**Security Note:** Always store `DEPLOYMENT_WEBHOOK_AUTH_TOKEN` in AWS Secrets Manager for production.

## How Deployment Works

Low-risk PRs trigger automated deployment:

1. **GitHub Integration** evaluates risk score
2. If `riskScore < DEPLOYMENT_RISK_THRESHOLD`, publishes `deployment.approved` event
3. **EventBridge** routes to Deployment Orchestrator
4. **Orchestrator** POSTs to webhook with exponential backoff retries (1s, 2s, 4s)
5. DynamoDB tracks: `pending` → `deploying` → `deployed`|`failed`
6. On failure, calls rollback webhook (if configured)

**Webhook Payload:**

```json
{
  "executionId": "uuid-v4",
  "prNumber": 123,
  "repoFullName": "owner/repo",
  "headSha": "abc123...",
  "deploymentEnvironment": "staging"
}
```

**Requirements:**

- Accept POST with JSON
- Auth: `Authorization: Bearer <token>`
- Return 200-299 (success), 500-599 (retry), 400-499 (fail)
- Implement idempotency via `executionId`

## Security

**Secret Management:**

- All credentials stored in AWS Secrets Manager
- GitHub webhook secret: Auto-generated, 90-day rotation
- Anthropic API key: Manual rotation when needed
- GitHub App private key: Annual rotation
- Deployment webhook token: 30-day rotation

**Authentication:**

- GitHub webhooks: HMAC-SHA256 signature validation
- Deployment webhooks: Bearer token authentication
- GitHub App: JWT-based installation tokens (1-hour expiration)

**Best Practices:**

- Never commit secrets to code
- Use least-privilege IAM policies
- Enable CloudTrail for audit logging
- Monitor secret access with CloudWatch alarms

## Monitoring and Observability

Pullmint includes CloudWatch monitoring for production reliability:

**CloudWatch Alarms:**

- `pullmint-deployment-orchestrator-errors` - Alerts at ≥3 errors/5m (deployment runs are lower volume)
- `pullmint-github-integration-errors` - Alerts at ≥5 errors/5m (higher throughput)
- `pullmint-webhook-handler-errors` - Alerts at ≥5 errors/5m (higher throughput)

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
