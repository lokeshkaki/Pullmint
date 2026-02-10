# Deployment Guide

This guide covers installing and deploying Pullmint to AWS, including the GitHub webhook setup and deployment webhook integration.

## Prerequisites

- AWS Account with CLI configured (`aws configure`)
- Node.js 20+ installed
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- Anthropic API key
- GitHub App created with PR read/write permissions

## Initial Deployment

### 1. Clone and install dependencies

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
npm install
```

### 2. Bootstrap CDK (first time per account/region)

```bash
cdk bootstrap
```

### 3. Deploy infrastructure

```bash
cd infrastructure
npm install

export GITHUB_APP_ID=your-github-app-id
npm run deploy
```

### 4. Save deployment outputs

Copy the following outputs from the deploy command:

```
WebhookURL: https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/webhook
WebhookSecretArn: arn:aws:secretsmanager:us-east-1:xxxxx:secret:pullmint/github-webhook-secret-xxxxx
EventBusName: pullmint-events
ExecutionsTableName: pullmint-pr-executions
```

### 5. Configure secrets

Store the required secrets in AWS Secrets Manager:

**Anthropic API key**

```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/anthropic-api-key \
  --secret-string "sk-ant-your-anthropic-key"
```

**GitHub App private key**

```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/github-app-private-key \
  --secret-string "$(cat /path/to/your/private-key.pem)"
```

**Webhook secret (read-only)**

```bash
aws secretsmanager get-secret-value \
  --secret-id pullmint/github-webhook-secret \
  --query SecretString --output text
```

### 6. Configure the GitHub webhook

1. Go to repository settings and add a webhook.
2. Payload URL: use the `WebhookURL` output from deployment.
3. Content type: `application/json`.
4. Secret: use the webhook secret from the previous step.
5. Events: select Pull requests only.
6. Keep the webhook active.

## Deployment Configuration

### Risk thresholds

```bash
# Maximum risk score to auto-deploy
DEPLOYMENT_RISK_THRESHOLD=30     # Default: 30

# Maximum risk score to auto-approve
AUTO_APPROVE_RISK_THRESHOLD=30   # Default: 30
```

### Deployment strategy

```bash
DEPLOYMENT_STRATEGY=eventbridge  # Options: eventbridge, label, deployment
```

| Strategy    | Use when                     | Pros                             | Cons                   | Status      |
| ----------- | ---------------------------- | -------------------------------- | ---------------------- | ----------- |
| eventbridge | Production deployments       | Retry logic and rollback support | Requires webhook setup | Recommended |
| label       | Existing GitHub Actions flow | Simple integration               | Limited error handling | Legacy      |
| deployment  | GitHub Deployments API       | Native GitHub integration        | Not implemented        | Planned     |

### Deployment gates

```bash
DEPLOYMENT_REQUIRE_TESTS=false   # Default: false
DEPLOYMENT_REQUIRED_CONTEXTS=ci,security-scan,build
DEPLOYMENT_ENVIRONMENT=staging   # Default: staging
DEPLOYMENT_LABEL=deploy:staging  # Default: deploy:staging
```

### Webhook configuration (eventbridge strategy)

```bash
DEPLOYMENT_WEBHOOK_URL=https://your-deploy-system.com/deploy
DEPLOYMENT_WEBHOOK_AUTH_TOKEN=your-bearer-token
DEPLOYMENT_WEBHOOK_TIMEOUT_MS=30000
DEPLOYMENT_WEBHOOK_RETRIES=3
DEPLOYMENT_ROLLBACK_WEBHOOK_URL=https://your-deploy-system.com/rollback
```

### JSON configuration (alternative)

```bash
DEPLOYMENT_CONFIG='{
  "strategy": "eventbridge",
  "riskThreshold": 30,
  "webhookUrl": "https://your-deploy-system.com/deploy",
  "webhookTimeoutMs": 30000,
  "retries": 3,
  "environment": "staging"
}'
```

### Update configuration after deployment

**CDK context**

```bash
cd infrastructure
npm run deploy -- \
  -c deploymentStrategy=eventbridge \
  -c deploymentRiskThreshold=30 \
  -c deploymentWebhookUrl=https://example.com/deploy
```

**Lambda environment variables**

```bash
aws lambda update-function-configuration \
  --function-name pullmint-deployment-orchestrator \
  --environment "Variables={
    DEPLOYMENT_STRATEGY=eventbridge,
    DEPLOYMENT_RISK_THRESHOLD=30,
    DEPLOYMENT_WEBHOOK_URL=https://example.com/deploy
  }"
```

## Deployment webhook integration

### Payload

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

### Requirements

1. Accept POST requests with JSON bodies.
2. Authenticate via `Authorization: Bearer <token>`.
3. Return status codes:
   - 200-299: success
   - 500-599: retry
   - 400-499: fail
4. Implement idempotency using `executionId`.
5. Respond within the configured timeout.

### Rollback webhook payload

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

## Update and rollback

### Update application code

```bash
cd pullmint
git pull origin main
npm install
npm run build
cd infrastructure
npm run deploy
```

### Update configuration only

```bash
cd infrastructure
npm run deploy -- -c deploymentRiskThreshold=35
```

### Roll back the stack

```bash
aws cloudformation describe-stack-events \
  --stack-name PullmintWebhookStack

aws cloudformation rollback-stack \
  --stack-name PullmintWebhookStack
```

## Multi-environment deployment

```bash
# Development
npm run deploy -- --context environment=dev

# Staging
npm run deploy -- --context environment=staging

# Production
npm run deploy -- --context environment=prod
```

```typescript
const env = app.node.tryGetContext('environment') || 'dev';
new WebhookStack(app, `PullmintWebhookStack-${env}`, {
  /* ... */
});
```

## Troubleshooting

### Webhook not triggering

1. Check GitHub webhook delivery history.
2. Verify the webhook secret matches Secrets Manager.
3. Check CloudWatch logs for the webhook-receiver Lambda.
4. Verify the API Gateway endpoint is accessible.

### Deployment not triggered

1. Verify the risk score is below the deployment threshold (default 30).
2. Ensure `DEPLOYMENT_WEBHOOK_URL` is configured.
3. Confirm the EventBridge rule is enabled.
4. Review deployment-orchestrator Lambda logs.

### High LLM costs

1. Review cache hit rates.
2. Check for unusually large PR diffs.
3. Consider tighter thresholds or caching improvements.

### DynamoDB throttling

1. Check read/write capacity metrics.
2. Switch tables to on-demand billing.
3. Add GSIs for common query patterns.

### Lambda timeouts

1. Increase timeouts in the CDK stack.
2. Review logs for slow operations.
3. Optimize prompt size or diff filtering.
