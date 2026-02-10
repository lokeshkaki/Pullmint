# Pullmint Deployment Guide

This guide walks you through deploying Pullmint to your AWS account.

## Prerequisites Checklist

- [ ] AWS Account with admin access
- [ ] AWS CLI v2 installed and configured
- [ ] Node.js 20+ installed
- [ ] AWS CDK CLI installed (`npm install -g aws-cdk`)
- [ ] Anthropic API account with API key
- [ ] GitHub account with repository access
- [ ] GitHub App ID (from GitHub App settings)

## Step 1: Initial Setup

### 1.1 Clone and Install

```bash
# Clone the repository
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint

# Install root dependencies
npm install

# Install infrastructure dependencies
cd infrastructure
npm install
cd ..
```

### 1.2 Configure AWS Credentials

```bash
# Configure AWS CLI
aws configure

# Verify configuration
aws sts get-caller-identity
```

### 1.3 Bootstrap CDK

```bash
# Bootstrap CDK in your account (one-time setup)
cdk bootstrap

# Expected output:
# ✅  Environment aws://ACCOUNT/REGION bootstrapped
```

## Step 2: Deploy Infrastructure

### 2.1 Build and Deploy

```bash
cd infrastructure

# Required for GitHub App auth
export GITHUB_APP_ID=your-github-app-id

# Review changes (optional)
npm run diff

# Deploy the webhook stack
npm run deploy

# Expected output will include:
# - WebhookURL
# - WebhookSecretArn
# - EventBusName
# - ExecutionsTableName
```

### 2.2 Configure Deployment Webhook (Optional)

To enable real deployments, configure deployment webhook environment variables before deploying:

**For Development/Testing:**

```bash
# Minimal configuration for testing
export DEPLOYMENT_WEBHOOK_URL=https://your-deployment-endpoint.example.com
export DEPLOYMENT_WEBHOOK_AUTH_TOKEN=test-token-dev
export DEPLOYMENT_WEBHOOK_TIMEOUT_MS=10000
export DEPLOYMENT_WEBHOOK_RETRIES=0
```

**For Staging:**

```bash
# Moderate timeout and retries
export DEPLOYMENT_WEBHOOK_URL=https://staging-deploy.example.com
export DEPLOYMENT_WEBHOOK_AUTH_TOKEN=$(aws secretsmanager get-secret-value --secret-id pullmint/deployment-webhook-token --query SecretString --output text)
export DEPLOYMENT_WEBHOOK_TIMEOUT_MS=30000
export DEPLOYMENT_WEBHOOK_RETRIES=2
```

**For Production:**

```bash
# Maximum reliability with retries and rollback
export DEPLOYMENT_WEBHOOK_URL=https://prod-deploy.example.com
export DEPLOYMENT_WEBHOOK_AUTH_TOKEN=$(aws secretsmanager get-secret-value --secret-id pullmint/deployment-webhook-token --query SecretString --output text)
export DEPLOYMENT_WEBHOOK_TIMEOUT_MS=60000
export DEPLOYMENT_WEBHOOK_RETRIES=3
export DEPLOYMENT_ROLLBACK_WEBHOOK_URL=https://prod-rollback.example.com
```

**Security Best Practice:** Always use Secrets Manager for production tokens:

```bash
# Create secret first
aws secretsmanager create-secret \
  --name pullmint/deployment-webhook-token \
  --secret-string "$(openssl rand -base64 32)"

# Then reference in deployment
export DEPLOYMENT_WEBHOOK_AUTH_TOKEN=$(aws secretsmanager get-secret-value --secret-id pullmint/deployment-webhook-token --query SecretString --output text)
```

**Important Notes:**

- Set these variables **before** running `npm run deploy`
- Deployment webhook is optional; system works without it (analysis only mode)
- Without webhook URL, deployments will be marked as "failed" with message "Deployment webhook URL is not configured"
- See [README.md](README.md#deployment-orchestration-architecture) for webhook payload format and integration requirements

### 2.3 Save Deployment Outputs

Copy the following outputs from the deployment:

```
WebhookURL: https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/webhook
WebhookSecretArn: arn:aws:secretsmanager:us-east-1:xxxxx:secret:pullmint/github-webhook-secret-xxxxx
```

## Step 3: Configure Secrets

### 3.1 Set Anthropic API Key

```bash
# Replace with your actual Anthropic API key
aws secretsmanager put-secret-value \
  --secret-id pullmint/anthropic-api-key \
  --secret-string "sk-ant-your-anthropic-api-key-here"
```

### 3.2 Set GitHub Private Key

Use a GitHub App private key (PEM):

```bash
aws secretsmanager put-secret-value \
  --secret-id pullmint/github-app-private-key \
  --secret-string "$(cat /path/to/your/private-key.pem)"
```

### 3.3 Get Webhook Secret

```bash
# Retrieve the auto-generated webhook secret
aws secretsmanager get-secret-value \
  --secret-id pullmint/github-webhook-secret \
  --query SecretString \
  --output text
```

Save this value - you'll need it for GitHub webhook configuration.

## Step 4: Configure GitHub Webhook

### 4.1 Add Webhook to Repository

1. Navigate to your GitHub repository
2. Go to **Settings** → **Webhooks** → **Add webhook**

### 4.2 Webhook Configuration

Fill in the following:

- **Payload URL:** (WebhookURL from Step 2.2)
- **Content type:** `application/json`
- **Secret:** (Webhook secret from Step 3.3)
- **SSL verification:** Enable SSL verification
- **Which events?** Select "Let me select individual events"
  - Check: **Pull requests**
  - Uncheck: Everything else
- **Active:** ✓ Checked

Click "Add webhook"

### 4.3 Test Webhook

GitHub will send a ping event. Check if it succeeds:

- Look for a green checkmark next to the webhook
- Click on the webhook to see recent deliveries
- The ping should show a `200` or `202` response

## Step 5: Test End-to-End

### 5.1 Create a Test PR

1. Create a new branch in your repo:

```bash
git checkout -b test-pullmint
```

2. Make a simple change:

```bash
echo "console.log('test');" > test.js
git add test.js
git commit -m "test: Pullmint integration"
git push origin test-pullmint
```

3. Create a pull request from GitHub UI

### 5.2 Verify Processing

Within 60 seconds, you should see:

1. **DynamoDB:** A new execution record

```bash
aws dynamodb scan --table-name pullmint-pr-executions --max-items 1
```

2. **CloudWatch Logs:** Lambda execution logs

```bash
aws logs tail /aws/lambda/pullmint-webhook-receiver --follow
aws logs tail /aws/lambda/pullmint-architecture-agent --follow
```

3. **GitHub:** A comment on your PR with analysis results

### 5.3 Check for Errors

If the PR comment doesn't appear:

```bash
# Check webhook receiver logs
aws logs tail /aws/lambda/pullmint-webhook-receiver --since 10m

# Check architecture agent logs
aws logs tail /aws/lambda/pullmint-architecture-agent --since 10m

# Check GitHub integration logs
aws logs tail /aws/lambda/pullmint-github-integration --since 10m

# Check DLQ for failed messages
aws sqs receive-message --queue-url $(aws sqs get-queue-url --queue-name pullmint-webhook-dlq --query QueueUrl --output text)
```

## Step 6: Monitor and Optimize

### 6.1 Set Up CloudWatch Alarms

```bash
# Create an alarm for Lambda errors
aws cloudwatch put-metric-alarm \
  --alarm-name pullmint-lambda-errors \
  --alarm-description "Alert on Lambda errors" \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator GreaterThanThreshold
```

### 6.2 Track Costs

Enable Cost Explorer in AWS Console and create a budget:

```bash
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget file://budget.json
```

budget.json:

```json
{
  "BudgetName": "PullmintMonthly",
  "BudgetLimit": {
    "Amount": "50",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
```

## Troubleshooting

### Issue: Webhook signature validation fails

**Solution:** Verify webhook secret matches:

```bash
# Get secret from AWS
aws secretsmanager get-secret-value --secret-id pullmint/github-webhook-secret --query SecretString --output text

# Compare with GitHub webhook configuration
```

### Issue: Anthropic API errors

**Solution:** Check API key and quota:

```bash
# Verify secret is set
aws secretsmanager get-secret-value --secret-id pullmint/anthropic-api-key

# Check Anthropic usage at: https://console.anthropic.com/usage
```

### Issue: Lambda timeout

**Solution:** Increase timeout in CDK stack:

```typescript
// infrastructure/lib/webhook-stack.ts
timeout: cdk.Duration.minutes(3), // Increase from 2
```

## Cleanup

To remove all resources:

```bash
cd infrastructure
cdk destroy

# Confirm deletion when prompted
```

## Next Steps

- [ ] Review CloudWatch logs for optimization
- [ ] Set up cost alerts
- [ ] Configure additional GitHub repositories
- [ ] Implement Phase 2 features (multi-agent system)

## Support

For issues or questions:

- Check [GitHub Issues](https://github.com/lokeshkaki/pullmint/issues)
- Review [CloudWatch Logs](https://console.aws.amazon.com/cloudwatch)
