# Deployment Guide

## Prerequisites

- AWS Account with CLI configured (`aws configure`)
- Node.js 20+ installed
- AWS CDK CLI: `npm install -g aws-cdk`
- Anthropic API key ([get one here](https://console.anthropic.com/))
- GitHub App created ([guide](https://docs.github.com/en/developers/apps/building-github-apps/creating-a-github-app))

## Initial Deployment

### 1. Clone and Install

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
npm install
```

### 2. Bootstrap CDK (First Time Only)

```bash
cdk bootstrap
```

### 3. Deploy Infrastructure

```bash
cd infrastructure
npm install

export GITHUB_APP_ID=your-github-app-id
npm run deploy
```

### 4. Configure Secrets

After deployment, store your credentials in AWS Secrets Manager:

**Anthropic API Key:**
```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/anthropic-api-key \
  --secret-string "sk-ant-your-anthropic-key"
```

**GitHub App Private Key:**
```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/github-app-private-key \
  --secret-string "$(cat /path/to/your/private-key.pem)"
```

**Get Webhook Secret:**
```bash
aws secretsmanager get-secret-value \
  --secret-id pullmint/github-webhook-secret \
  --query SecretString --output text
```

### 5. Configure GitHub Webhook

1. Go to your repository settings → Webhooks → Add webhook
2. **Payload URL**: (use the WebhookURL from CDK output)
3. **Content type**: `application/json`
4. **Secret**: (use the webhook secret from step 4)
5. **Events**: Select "Pull requests"
6. **Active**: ✓

## Deployment Configuration

### Environment Variables

Configure deployment behavior via CDK context or Lambda environment variables:

#### Risk Thresholds

```bash
# Maximum risk score to auto-deploy
DEPLOYMENT_RISK_THRESHOLD=40     # Default: 40

# Maximum risk score to auto-approve
AUTO_APPROVE_RISK_THRESHOLD=30   # Default: 30
```

**Threshold Rationale:**
- **30 (Auto-Approve)**: Only trivial changes (typos, docs, formatting)
- **40 (Auto-Deploy)**: Low-risk changes (minor features, refactors)
- **>40 (Manual)**: High-risk changes (architecture, security, API changes)

#### Deployment Strategy

```bash
DEPLOYMENT_STRATEGY=eventbridge   # Options: eventbridge, label, deployment
```

**Strategy Comparison:**

| Strategy | Use When | Pros | Cons | Status |
|----------|----------|------|------|--------|
| `eventbridge` | Production deployments | Full control, error handling, retry logic | Requires webhook setup | ✅ Recommended |
| `label` | GitHub Actions CI/CD | Simple, no webhook needed | Limited error handling | 🟡 Legacy |
| `deployment` | GitHub Deployments API | Native GitHub integration | Not implemented | 🔵 Future |

**When to use each:**
- **eventbridge**: Default for production. Webhook-based with full retry/rollback support
- **label**: Existing GitHub Actions workflows triggered by labels
- **deployment**: Future integration with GitHub Deployments API

#### Deployment Gates

```bash
# Require tests to pass before deployment
DEPLOYMENT_REQUIRE_TESTS=false   # Default: false

# Required GitHub status checks (CSV)
DEPLOYMENT_REQUIRED_CONTEXTS=ci,security-scan,build

# Target environment
DEPLOYMENT_ENVIRONMENT=staging   # Default: staging

# Label for label-based strategy
DEPLOYMENT_LABEL=deploy:staging  # Default: deploy:staging
```

#### Webhook Configuration (EventBridge Strategy)

```bash
# Deployment webhook URL (REQUIRED for real deployments)
DEPLOYMENT_WEBHOOK_URL=https://your-deploy-system.com/deploy

# Authentication token (store in Secrets Manager)
DEPLOYMENT_WEBHOOK_AUTH_TOKEN=your-bearer-token

# Timeout in milliseconds
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=30000  # Default: 30 seconds

# Retry attempts
DEPLOYMENT_WEBHOOK_RETRIES=3         # Default: 3

# Rollback webhook (optional)
DEPLOYMENT_ROLLBACK_WEBHOOK_URL=https://your-deploy-system.com/rollback
```

**Webhook Timeout Guidelines:**
- **Static sites, serverless**: 10-30 seconds
- **Container deployments**: 30-60 seconds
- **Complex deployments**: 60-120 seconds

**Retry Strategy:**
- Exponential backoff: 1s, 2s, 4s delays
- Retries on network errors, 5xx responses, timeouts
- No retry on 4xx errors (client errors)
- Failed deployments trigger rollback webhook

**Environment-Specific Configuration:**

```bash
# Development
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=10000
DEPLOYMENT_WEBHOOK_RETRIES=0

# Staging
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=30000
DEPLOYMENT_WEBHOOK_RETRIES=2

# Production
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=60000
DEPLOYMENT_WEBHOOK_RETRIES=3
```

#### JSON Configuration (Alternative)

Instead of individual env vars, you can use:

```bash
DEPLOYMENT_CONFIG='{
  "strategy": "eventbridge",
  "riskThreshold": 40,
  "webhookUrl": "https://your-deploy-system.com/deploy",
  "webhookTimeoutMs": 30000,
  "retries": 3,
  "environment": "staging"
}'
```

### Updating Configuration

**Via CDK Context:**

```bash
cd infrastructure
npm run deploy -- \
  -c deploymentStrategy=eventbridge \
  -c deploymentRiskThreshold=40 \
  -c deploymentWebhookUrl=https://example.com/deploy
```

**Via Environment Variables (after deployment):**

```bash
aws lambda update-function-configuration \
  --function-name pullmint-deployment-orchestrator \
  --environment "Variables={
    DEPLOYMENT_STRATEGY=eventbridge,
    DEPLOYMENT_RISK_THRESHOLD=40,
    DEPLOYMENT_WEBHOOK_URL=https://example.com/deploy
  }"
```

## Deployment Webhook Integration

### Webhook Payload

Pullmint POSTs the following JSON to your deployment webhook:

```json
{
  "executionId": "abc-123-def-456",
  "prNumber": 42,
  "repoFullName": "owner/repo",
  "headSha": "abc123def456...",
  "deploymentEnvironment": "staging",
  "riskScore": 25,
  "timestamp": 1707523200000
}
```

### Webhook Requirements

Your deployment endpoint must:

1. **Accept POST requests** with JSON body
2. **Authenticate** via `Authorization: Bearer <token>` header
3. **Return HTTP status codes**:
   - `200-299`: Success (deployment started/completed)
   - `500-599`: Retry (temporary failure)
   - `400-499`: Fail (do not retry)
4. **Implement idempotency** via `executionId` (ignore duplicate requests)
5. **Respond within timeout** (default: 30 seconds)

### Example Webhook Handler (Node.js)

```javascript
const express = require('express');
const app = express();

app.use(express.json());

// Bearer token authentication
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.DEPLOY_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// In-memory set for idempotency (use Redis/DynamoDB in production)
const processedExecutions = new Set();

app.post('/deploy', authenticate, async (req, res) => {
  const { executionId, repoFullName, headSha, deploymentEnvironment } = req.body;

  // Idempotency check
  if (processedExecutions.has(executionId)) {
    return res.status(200).json({ status: 'already-deployed' });
  }

  try {
    // Your deployment logic here
    await deployToEnvironment({
      repo: repoFullName,
      sha: headSha,
      environment: deploymentEnvironment,
    });

    processedExecutions.add(executionId);
    res.status(200).json({ status: 'success' });
  } catch (error) {
    // Return 5xx for retryable errors, 4xx for non-retryable
    if (error.retryable) {
      res.status(503).json({ error: 'Temporary deployment failure' });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

app.listen(3000);
```

### Rollback Webhook

If configured, Pullmint calls the rollback webhook when deployments fail:

```json
{
  "executionId": "abc-123-def-456",
  "prNumber": 42,
  "repoFullName": "owner/repo",
  "headSha": "abc123def456...",
  "deploymentEnvironment": "staging",
  "reason": "Webhook timeout after 3 retries"
}
```

## Deployment Strategies in Detail

### EventBridge Strategy (Recommended)

**Flow:**
1. GitHub Integration evaluates risk score
2. If low-risk, publishes `deployment.approved` event to EventBridge
3. Deployment Orchestrator Lambda triggered
4. POSTs to webhook with retry logic
5. Updates status in DynamoDB and GitHub

**Pros:**
- Full control over deployment lifecycle
- Retry logic with exponential backoff
- Rollback on failure
- DynamoDB tracks status

**Cons:**
- Requires webhook setup
- More configuration

**Best for:** Production systems requiring reliability and observability

### Label Strategy (Legacy)

**Flow:**
1. GitHub Integration evaluates risk score
2. If low-risk, adds label (e.g., `deploy:staging`) to PR
3. GitHub Actions workflow triggered by label
4. Workflow handles deployment

**Pros:**
- Simple, no webhook needed
- Uses existing CI/CD
- Familiar GitHub Actions patterns

**Cons:**
- Limited error handling
- No built-in retry logic
- Less visibility into deployment status

**Best for:** Teams with existing GitHub Actions deployments

### Deployment API Strategy (Future)

**Flow:**
1. GitHub Integration evaluates risk score
2. If low-risk, creates GitHub Deployment via API
3. Your system listens to deployment webhooks
4. Deployment status updated via GitHub API

**Pros:**
- Native GitHub integration
- Deployment history in GitHub UI
- Standard workflow

**Cons:**
- Not yet implemented
- Requires GitHub Enterprise for environments

**Status:** Planned for Phase C

## Updating Pullmint

### Update Application Code

```bash
cd pullmint
git pull origin main
npm install
npm run build
cd infrastructure
npm run deploy
```

### Update Configuration Only

```bash
cd infrastructure
npm run deploy -- -c deploymentRiskThreshold=35
```

### Rollback Deployment

```bash
# List stack history
aws cloudformation describe-stack-events \
  --stack-name PullmintWebhookStack

# Rollback to previous version
aws cloudformation rollback-stack \
  --stack-name PullmintWebhookStack
```

## Multi-Environment Deployment

Deploy separate stacks for dev/staging/prod:

```bash
# Development
npm run deploy -- --context environment=dev

# Staging
npm run deploy -- --context environment=staging

# Production
npm run deploy -- --context environment=prod
```

Update CDK stack to use environment context:

```typescript
const env = app.node.tryGetContext('environment') || 'dev';
new WebhookStack(app, `PullmintWebhookStack-${env}`, { /* ... */ });
```

## Troubleshooting

### Webhook Not Triggering

1. Check GitHub webhook delivery history
2. Verify webhook secret matches Secrets Manager
3. Check CloudWatch logs for webhook-receiver Lambda
4. Verify API Gateway endpoint is accessible

### Deployment Not Triggered

1. Check risk score meets threshold (< 40 by default)
2. Verify `DEPLOYMENT_WEBHOOK_URL` is set
3. Check EventBridge rule is enabled
4. Review deployment-orchestrator Lambda logs

### High LLM Costs

1. Check cache hit rate in CloudWatch metrics
2. Verify diff size (large PRs cost more)
3. Consider reducing PR frequency or caching improvements

### DynamoDB Throttling

1. Check Read/Write Capacity metrics
2. Switch to on-demand billing mode
3. Add GSI for common query patterns

### Lambda Timeouts

1. Increase timeout in CDK stack
2. Review CloudWatch logs for slow operations
3. Optimize LLM prompt or diff size
