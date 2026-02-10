# Security

## Secret Management

### AWS Secrets Manager

All sensitive credentials are stored in AWS Secrets Manager with encryption at rest and automatic rotation.

**Secrets:**

- `pullmint/anthropic-api-key` - Anthropic API key for Claude Sonnet
- `pullmint/github-app-private-key` - GitHub App private key (PEM format)
- `pullmint/github-webhook-secret` - Webhook signature validation secret
- `pullmint/deployment-webhook-auth-token` - Deployment webhook bearer token

### Secret Rotation

**Automated Rotation:**

- **Webhook Secret**: 90-day rotation (CloudFormation custom resource)
- **GitHub App Key**: Annual rotation (manual, GitHub requirement)

**Manual Rotation:**

- **Anthropic API Key**: Rotate when needed (security incident, key leak)
- **Deployment Token**: 30-day rotation recommended

**Rotation Process:**

```bash
# Rotate Anthropic API key
aws secretsmanager put-secret-value \
  --secret-id pullmint/anthropic-api-key \
  --secret-string "sk-ant-new-key"

# Rotate deployment token
aws secretsmanager put-secret-value \
  --secret-id pullmint/deployment-webhook-auth-token \
  --secret-string "new-bearer-token"

# Update webhook secret (triggers webhook reconfiguration)
aws secretsmanager rotate-secret \
  --secret-id pullmint/github-webhook-secret
```

### Access Control

**IAM Policies:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": ["arn:aws:secretsmanager:*:*:secret:pullmint/*"]
    }
  ]
}
```

**Principle of Least Privilege:**

- Each Lambda function has access only to secrets it needs
- webhook-receiver: webhook secret only
- architecture-agent: Anthropic API key only
- github-integration: GitHub App key only
- deployment-orchestrator: Deployment token only

### Audit Logging

All secret access is logged to CloudTrail:

```bash
# View secret access logs
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=pullmint/anthropic-api-key \
  --max-items 50
```

**Set up CloudWatch alarm for suspicious access:**

```typescript
new cloudwatch.Alarm(this, 'UnauthorizedSecretAccess', {
  alarmName: 'pullmint-unauthorized-secret-access',
  metric: new cloudwatch.Metric({
    namespace: 'AWS/SecretsManager',
    metricName: 'GetSecretValue',
    statistic: 'Sum',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 100, // Adjust based on normal usage
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

## Authentication

### GitHub Webhook Validation

**HMAC-SHA256 Signature:**

```typescript
import { createHmac } from 'crypto';

function validateSignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}
```

**Protection Against:**

- Replay attacks (validate timestamp)
- Man-in-the-middle attacks (HTTPS required)
- Spoofed webhooks (signature validation)

### GitHub App Authentication

**JWT-Based Installation Tokens:**

```typescript
import jwt from 'jsonwebtoken';

// Generate JWT (valid for 10 minutes)
const token = jwt.sign(
  {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    iss: process.env.GITHUB_APP_ID,
  },
  privateKey,
  { algorithm: 'RS256' }
);

// Exchange for installation access token (valid for 1 hour)
const installationToken = await octokit.apps.createInstallationAccessToken({
  installation_id: installationId,
});
```

**Benefits:**

- Short-lived tokens (1 hour expiration)
- Scoped permissions (read PRs, write comments only)
- Automatic refresh on expiration

### Deployment Webhook Authentication

**Bearer Token:**

```http
POST /deploy HTTP/1.1
Host: your-deploy-system.com
Authorization: Bearer your-secret-token
Content-Type: application/json

{"executionId": "abc-123", "prNumber": 42, ...}
```

**Best Practices:**

- Use long, random tokens (256-bit entropy)
- Rotate every 30 days
- Store in Secrets Manager, not environment variables
- Use HTTPS only (TLS 1.2+)

## Network Security

### API Gateway

**Rate Limiting:**

- **Throttle**: 100 requests/second per account
- **Burst**: 200 requests (short-term spike handling)
- **Quota**: 10,000 requests/day per API key (if using API keys)

**DDoS Protection:**

- AWS Shield Standard (automatic, no cost)
- CloudFront integration (optional) for additional DDoS mitigation

**HTTPS Only:**

- TLS 1.2+ enforced
- No HTTP fallback

### Lambda Security

**Execution Role:**

```typescript
const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
  ],
});

// Grant only necessary permissions
executionsTable.grantReadWriteData(lambdaRole);
secretsManager.grantRead(lambdaRole);
```

**Environment Variables:**

- No secrets in environment variables
- Use Secrets Manager ARNs instead
- Encrypt environment variables at rest

**VPC Isolation (Future):**

```typescript
const vpc = new ec2.Vpc(this, 'PullmintVPC');

new lambda.Function(this, 'ArchitectureAgent', {
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  securityGroups: [securityGroup],
});
```

### DynamoDB Security

**Encryption at Rest:**

- AWS-managed keys (default)
- Customer-managed KMS keys (optional)

**Encryption in Transit:**

- TLS 1.2+ for all API calls

**Access Control:**

- IAM policies restrict access per table
- Condition keys for fine-grained control

**Point-in-Time Recovery:**

```typescript
new dynamodb.Table(this, 'PRExecutions', {
  pointInTimeRecovery: true, // Enable PITR
  removalPolicy: cdk.RemovalPolicy.RETAIN, // Prevent accidental deletion
});
```

## Data Protection

### Sensitive Data Handling

**What We Store:**

- PR metadata (repo, number, SHA)
- Risk scores and findings
- Deployment status
- GitHub webhook delivery IDs

**What We Don't Store:**

- Full PR diffs (only hashes for caching)
- User credentials
- GitHub access tokens (ephemeral, not persisted)

**Data Retention:**

- **Executions**: 90-day TTL (auto-delete)
- **Cache**: 7-day TTL
- **Deduplication**: 24-hour TTL

### Encryption

**At Rest:**

- DynamoDB: AWS-managed encryption
- S3: AES-256 encryption
- Secrets Manager: AWS KMS encryption
- CloudWatch Logs: Encryption with KMS (optional)

**In Transit:**

- HTTPS/TLS 1.2+ for all API calls
- GitHub webhooks over HTTPS
- Deployment webhooks over HTTPS

### PII Handling

**No PII Collected:**

- No user emails, names, or personal data
- GitHub usernames are public information
- Repository names are public (or organization-internal)

**Compliance:**

- No GDPR requirements (no PII)
- No HIPAA requirements (no health data)
- No PCI-DSS requirements (no payment data)

## Security Best Practices

### Development

**Never Commit Secrets:**

```bash
# Add to .gitignore
.env
.env.local
secrets/
*.pem
```

**Use git-secrets:**

```bash
# Install git-secrets
brew install git-secrets

# Scan for secrets
git secrets --scan
git secrets --scan-history
```

**Pre-commit Hooks:**

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Check for AWS keys
if grep -r "AKIA" .; then
  echo "Error: AWS access key detected"
  exit 1
fi

# Check for private keys
if grep -r "BEGIN.*PRIVATE KEY" .; then
  echo "Error: Private key detected"
  exit 1
fi
```

### Deployment

**Use OIDC for GitHub Actions:**

```yaml
# .github/workflows/deploy.yml
permissions:
  id-token: write # Required for OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          aws-region: us-east-1
```

**No Long-Lived Credentials:**

- Use IAM roles for Lambda
- Use temporary credentials for CI/CD
- Rotate secrets regularly

**Least Privilege:**

- Grant minimum permissions required
- Use resource-based policies
- Restrict by source IP (if applicable)

### Monitoring

**CloudWatch Alarms:**

```typescript
// Alert on elevated error rates
new cloudwatch.Alarm(this, 'HighErrorRate', {
  metric: lambda.metricErrors(),
  threshold: 5,
  evaluationPeriods: 1,
});

// Alert on unauthorized API access
new cloudwatch.Alarm(this, 'UnauthorizedAccess', {
  metric: apiGateway.metricClientError(),
  threshold: 10,
  evaluationPeriods: 1,
});
```

**AWS Config:**

- Enable Config Rules for compliance monitoring
- Check for unencrypted S3 buckets
- Verify IAM best practices

**AWS GuardDuty:**

- Enable for threat detection
- Monitor for unusual API activity
- Alert on compromised credentials

## Incident Response

### Security Incident Playbook

**1. Identify:**

- Monitor CloudWatch alarms
- Review CloudTrail logs
- Check GuardDuty findings

**2. Contain:**

```bash
# Rotate compromised secret immediately
aws secretsmanager rotate-secret --secret-id pullmint/anthropic-api-key

# Disable affected Lambda function
aws lambda update-function-configuration \
  --function-name pullmint-architecture-agent \
  --environment Variables={}

# Revoke GitHub App installation
# (via GitHub UI)
```

**3. Investigate:**

```bash
# Review CloudTrail logs
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --start-time 2026-02-01T00:00:00Z

# Check Lambda logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/pullmint-architecture-agent \
  --start-time 1707523200000
```

**4. Remediate:**

- Rotate all secrets
- Update IAM policies
- Patch vulnerable dependencies
- Deploy updated code

**5. Document:**

- Record incident timeline
- Identify root cause
- Create postmortem
- Update security procedures

### Contact Information

**AWS Support:**

- Open security case in AWS Console
- Phone: 1-866-947-6435
- Email: aws-security@amazon.com

**GitHub Security:**

- Report vulnerabilities: security@github.com
- Security advisories: https://github.com/advisories

**Anthropic Security:**

- Email: security@anthropic.com

## Compliance

### AWS Well-Architected Framework

**Security Pillar:**

- ✅ Identity and access management (IAM roles)
- ✅ Detective controls (CloudWatch, CloudTrail)
- ✅ Infrastructure protection (VPC isolation, security groups)
- ✅ Data protection (encryption at rest/transit)
- ✅ Incident response (playbook, monitoring)

### Security Checklist

- [ ] All secrets stored in Secrets Manager
- [ ] Webhook signature validation enabled
- [ ] HTTPS enforced for all endpoints
- [ ] IAM roles use least privilege
- [ ] CloudWatch alarms configured
- [ ] CloudTrail logging enabled
- [ ] DynamoDB encryption at rest
- [ ] Lambda environment variables encrypted
- [ ] API Gateway rate limiting configured
- [ ] Secret rotation schedule defined
- [ ] Incident response playbook documented
- [ ] Security scanning in CI/CD (future)
- [ ] Regular security audits (future)

## Security Roadmap

**Short Term (Phase C):**

- [ ] Add security scanning to CI/CD (Snyk, Dependabot)
- [ ] Implement VPC isolation for sensitive Lambdas
- [ ] Add API authentication for dashboard
- [ ] Enable AWS Config for compliance monitoring

**Medium Term (Phase D):**

- [ ] Implement rate limiting per user/repo
- [ ] Add anomaly detection for unusual activity
- [ ] Create automated security testing
- [ ] Implement WAF rules for API Gateway

**Long Term:**

- [ ] SOC 2 compliance
- [ ] Third-party security audit
- [ ] Bug bounty program
- [ ] Security training for contributors
