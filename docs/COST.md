# Cost Analysis

## Monthly Cost Breakdown (250 PRs/month)

### Fixed Costs

| Service | Cost | Notes |
|---------|------|-------|
| CloudWatch Logs | ~$3.00 | Log storage + Insights queries |
| DynamoDB | ~$1.00 | On-demand pricing, low traffic |
| API Gateway | ~$0.35 | $1 per million requests + data transfer |
| S3 Storage | ~$0.50 | Minimal storage for artifacts |
| EventBridge | $0.00 | Within free tier (1M events/month) |
| Secrets Manager | $0.40 | 4 secrets × $0.40/secret/month |
| **Subtotal** | **~$5.25/month** | |

### Variable Costs

| Service | Cost | Calculation |
|---------|------|-------------|
| **Anthropic API** | **~$25.00** | Primary cost driver |
| ├─ Input tokens | $2.25 | 250 PRs × 3K avg tokens × $3/M |
| ├─ Output tokens | $5.63 | 250 PRs × 1.5K avg tokens × $15/M |
| └─ Buffer (retries, large PRs) | $17.12 | ~3x for safety margin |
| Lambda Compute | $0.00 | Within free tier (1M requests + 400K GB-seconds) |
| Data Transfer | ~$2.00 | GitHub API + webhook responses |
| **Subtotal** | **~$27.00/month** | |

### **Total: ~$32/month**

## Cost Drivers Analysis

### 1. LLM API (~78% of total cost)

**Why it dominates:**
- Claude Sonnet 4.5: $3/M input, $15/M output
- Average PR diff: ~3,000 tokens
- Average response: ~1,500 tokens
- No free tier

**Cost per PR:**
- Input: 3,000 tokens × $3/M = $0.009
- Output: 1,500 tokens × $15/M = $0.0225
- **Total: $0.0315/PR (~$0.03)**

**Monthly projection:**
- 250 PRs × $0.03 = $7.50 (baseline)
- 3x safety margin = **$25/month**

### 2. Lambda (~0% within free tier)

**Free tier:**
- 1M requests/month
- 400,000 GB-seconds compute time/month

**Actual usage (250 PRs):**
- Requests: ~1,250 (250 PRs × 5 Lambda invocations avg)
- Compute: ~50 GB-seconds (5 functions × 30s avg × 256MB-512MB)
- **Cost: $0** (well within free tier)

**Above free tier:**
- Requests: $0.20 per 1M requests
- Compute: $0.0000166667 per GB-second

### 3. DynamoDB (~3% of total cost)

**On-demand pricing:**
- Write: $1.25 per million write request units
- Read: $0.25 per million read request units

**Monthly usage (250 PRs):**
- Writes: ~1,000 (4 writes per PR)
- Reads: ~2,000 (8 reads per PR + dashboard queries)
- **Cost: ~$1/month**

**Storage:**
- $0.25 per GB-month
- Estimated storage: < 1 GB (with TTL cleanup)
- **Cost: ~$0.25/month**

### 4. CloudWatch (~9% of total cost)

**Log storage:**
- $0.50 per GB ingested
- $0.03 per GB stored
- Estimated: 5-10 GB/month (structured JSON logs)
- **Cost: ~$2.50-$5/month**

**Logs Insights queries:**
- $0.005 per GB scanned
- Estimated: 50 queries × 1 GB avg = $0.25/month

## Cost Optimization Strategies

### 1. LLM API Optimization

**Caching:**
```typescript
// Hash PR diff for cache key
const diffHash = crypto.createHash('sha256').update(prDiff).digest('hex');

// Check cache before calling LLM
const cached = await ddb.get({
  TableName: CACHE_TABLE,
  Key: { cacheKey: diffHash },
});

if (cached.Item) {
  return JSON.parse(cached.Item.cacheValue);
}

// Call LLM only if not cached
const response = await anthropic.messages.create({...});

// Store in cache
await ddb.put({
  TableName: CACHE_TABLE,
  Item: {
    cacheKey: diffHash,
    cacheValue: JSON.stringify(response),
    ttl: Date.now() / 1000 + 604800, // 7 days
  },
});
```

**Potential savings:**
- Cache hit rate: 20-30% (PRs with multiple pushes)
- Cost reduction: ~$5-$7.50/month

**Prompt optimization:**
```typescript
// Before: Send full file content (wasteful)
const prompt = `Analyze this file:\n${fullFileContent}`;

// After: Send only diff (efficient)
const prompt = `Analyze this diff:\n${prDiff}`;
```

**Potential savings:**
- Token reduction: 50-70%
- Cost reduction: ~$12-$17/month

**Batch processing:**
```typescript
// Process multiple PRs in single LLM call (future)
const prompt = `Analyze these PRs:\n${prs.map(formatPR).join('\n')}`;
```

**Potential savings:**
- Reduced API calls: -50%
- Cost reduction: ~$3-$5/month (API overhead)

### 2. Lambda Cost Optimization

**Right-size memory:**
```typescript
// Architecture agent: CPU-bound (LLM waiting)
memory: 512, // Reduce to 256 MB

// Webhook receiver: Lightweight
memory: 256, // Reduce to 128 MB
```

**Potential savings:**
- Not applicable (within free tier)
- Benefit: Faster cold starts

**Provisioned concurrency (if above free tier):**
```typescript
const version = lambda.currentVersion;
new lambda.Alias(this, 'ProdAlias', {
  aliasName: 'prod',
  version,
  provisionedConcurrentExecutions: 2, // Keep 2 warm
});
```

**Cost:**
- $0.0000041667/GB-second
- 2 instances × 512 MB × 720 hours = $3/month
- **Only use if cold starts are critical**

### 3. DynamoDB Cost Optimization

**Enable TTL:**
```typescript
new dynamodb.Table(this, 'PRExecutions', {
  timeToLiveAttribute: 'ttl', // Auto-delete old records
});
```

**Savings:**
- Storage cost: -100% (auto-cleanup)
- Read cost: Reduced queries on old data

**Use GSI efficiently:**
```typescript
// Bad: Full table scan
const result = await ddb.scan({
  TableName: EXECUTIONS_TABLE,
  FilterExpression: 'repo = :repo',
});

// Good: Query with GSI
const result = await ddb.query({
  TableName: EXECUTIONS_TABLE,
  IndexName: 'ByRepo',
  KeyConditionExpression: 'repo = :repo',
});
```

**Savings:**
- Read cost: -80% (query vs scan)
- **$0.50/month** for high-traffic repos

**Switch to provisioned capacity (if predictable):**
```typescript
new dynamodb.Table(this, 'PRExecutions', {
  billingMode: dynamodb.BillingMode.PROVISIONED,
  readCapacity: 5,
  writeCapacity: 2,
});
```

**Cost comparison:**
- On-demand: $1.25/M writes, $0.25/M reads
- Provisioned: $0.00013/hour per WCU, $0.00013/hour per RCU
- **Savings: ~$0.50/month** (if traffic is steady)

### 4. CloudWatch Logs Optimization

**Reduce log verbosity:**
```typescript
// Only log errors and warnings in production
if (process.env.NODE_ENV === 'production') {
  if (logLevel !== 'ERROR' && logLevel !== 'WARN') {
    return; // Skip INFO and DEBUG logs
  }
}
```

**Savings:**
- Log volume: -60%
- **Cost reduction: ~$1.50-$2/month**

**Shorter retention:**
```typescript
new logs.LogGroup(this, 'WebhookReceiverLogs', {
  retention: logs.RetentionDays.SEVEN_DAYS, // Instead of 30
});
```

**Savings:**
- Storage cost: -75%
- **Cost reduction: ~$0.50-$1/month**

**Export to S3 (cheaper long-term storage):**
```bash
aws logs create-export-task \
  --log-group-name /aws/lambda/pullmint-webhook-receiver \
  --from 1706918400000 \
  --to 1707523200000 \
  --destination pullmint-logs-archive
```

**Cost:**
- CloudWatch: $0.03/GB/month
- S3 Glacier: $0.004/GB/month
- **Savings: -87%** for archived logs

### 5. API Gateway Optimization

**Enable caching:**
```typescript
api.deploymentStage.methodSettings = [
  {
    resourcePath: '/dashboard/executions',
    httpMethod: 'GET',
    cachingEnabled: true,
    cacheTtlInSeconds: 60, // 1 minute cache
  },
];
```

**Savings:**
- Reduced Lambda invocations: -50% (for dashboard)
- **Cost: Cache charges may offset savings**

## Cost Scaling Projections

### 500 PRs/month (~2x)

| Service | Original | Scaled | Change |
|---------|----------|--------|--------|
| LLM API | $25 | $50 | +100% |
| Lambda | $0 | $0 | +0% (within free tier) |
| DynamoDB | $1 | $2 | +100% |
| CloudWatch | $3 | $5 | +67% |
| Fixed | $5.25 | $5.25 | +0% |
| **Total** | **$32** | **$62** | **+94%** |

### 1,000 PRs/month (~4x)

| Service | Original | Scaled | Change |
|---------|----------|--------|--------|
| LLM API | $25 | $100 | +300% |
| Lambda | $0 | $5 | (exceeds free tier) |
| DynamoDB | $1 | $4 | +300% |
| CloudWatch | $3 | $8 | +167% |
| Fixed | $5.25 | $5.25 | +0% |
| **Total** | **$32** | **$122** | **+281%** |

### 10,000 PRs/month (~40x)

| Service | Original | Scaled | Change |
|---------|----------|--------|--------|
| LLM API | $25 | $1,000 | +3900% |
| Lambda | $0 | $80 | (far exceeds free tier) |
| DynamoDB | $1 | $40 | +3900% |
| CloudWatch | $3 | $50 | +1567% |
| Fixed | $5.25 | $10 | +90% |
| **Total** | **$32** | **$1,180** | **+3587%** |

**Optimization needed at scale:**
- LLM caching (30% hit rate): -$300/month
- Prompt compression: -$200/month
- Provisioned DynamoDB: -$20/month
- Reduced logging: -$10/month
- **Optimized total: ~$650/month**

## Cost Monitoring

### CloudWatch Billing Alerts

```bash
# Create SNS topic for billing alerts
aws sns create-topic --name pullmint-billing-alerts

# Subscribe email
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:pullmint-billing-alerts \
  --protocol email \
  --notification-endpoint team@example.com

# Create billing alarm
aws cloudwatch put-metric-alarm \
  --alarm-name pullmint-monthly-cost-alert \
  --alarm-description "Alert when monthly cost exceeds $50" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 21600 \
  --evaluation-periods 1 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --dimensions Name=Currency,Value=USD \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:pullmint-billing-alerts
```

### Cost Explorer Tags

```typescript
// Tag all resources for cost tracking
cdk.Tags.of(this).add('Project', 'Pullmint');
cdk.Tags.of(this).add('Environment', 'Production');
cdk.Tags.of(this).add('CostCenter', 'Engineering');
```

**Use tags to:**
- Filter costs in Cost Explorer
- Create cost allocation reports
- Track per-environment costs

### Custom Cost Metrics

```typescript
// Publish LLM cost metric
const inputCost = inputTokens * (3 / 1000000);
const outputCost = outputTokens * (15 / 1000000);
const totalCost = inputCost + outputCost;

await cloudwatch.putMetricData({
  Namespace: 'Pullmint/Costs',
  MetricData: [
    {
      MetricName: 'LLMCostPerPR',
      Value: totalCost,
      Unit: 'None',
      Timestamp: new Date(),
    },
  ],
});
```

## Cost Comparison

### Alternative LLM Providers

| Provider | Model | Input Cost | Output Cost | PR Cost | Monthly (250 PRs) |
|----------|-------|------------|-------------|---------|------------------|
| Anthropic | Claude Sonnet 4.5 | $3/M | $15/M | $0.03 | $25 |
| Anthropic | Claude Haiku 3.5 | $0.80/M | $4/M | $0.01 | $7 |
| OpenAI | GPT-4 Turbo | $10/M | $30/M | $0.07 | $58 |
| OpenAI | GPT-3.5 Turbo | $0.50/M | $1.50/M | $0.01 | $6 |
| Cohere | Command R+ | $3/M | $15/M | $0.03 | $25 |

**Recommendation:**
- **Claude Sonnet 4.5**: Best balance of quality and cost
- **Claude Haiku 3.5**: Cheaper option if quality is acceptable
- **GPT-3.5 Turbo**: Cheapest, but lower quality for code analysis

### Serverless vs. Container Costs

**Serverless (current):**
- Lambda: $0 (free tier)
- DynamoDB: $1/month
- **Total: $32/month**

**ECS Fargate (alternative):**
- 2 vCPU, 4 GB RAM
- 24/7 uptime: ~$50/month
- RDS PostgreSQL: ~$30/month
- **Total: ~$110/month** (before LLM costs)

**Savings: -71%** with serverless

## Break-Even Analysis

**Fixed costs per PR (ignoring LLM):**
- Infrastructure: $7.25 / 250 = $0.029/PR
- LLM: $0.03/PR
- **Total: $0.059/PR**

**Time saved per PR:**
- Human review: 30 minutes
- Hourly rate: $100/hour
- **Value: $50/PR**

**ROI:**
- Cost: $0.059/PR
- Value: $50/PR
- **Return: 847x**

**Break-even:**
- Would need to process ~500,000 PRs/month to equal human review cost

## Conclusion

Pullmint is **highly cost-effective** at $32/month for 250 PRs:

✅ **78% of cost is LLM API** (primary value driver)  
✅ **Serverless reduces infrastructure costs by 71%**  
✅ **Scales linearly up to 1,000 PRs/month**  
✅ **ROI of 847x vs. manual review**  

**Optimization priorities:**
1. LLM prompt compression (highest impact)
2. Increase cache hit rate (20-30% savings)
3. Reduce log verbosity (production)
4. Monitor costs with billing alarms
