# Monitoring and Observability

## CloudWatch Alarms

Pullmint includes three critical CloudWatch alarms for production reliability:

### Deployment Orchestrator Errors

```typescript
new cloudwatch.Alarm(this, 'DeploymentOrchestratorErrors', {
  alarmName: 'pullmint-deployment-orchestrator-errors',
  alarmDescription: 'Alert when deployment orchestrator has elevated error rate',
  metric: deploymentOrchestrator.metricErrors({
    period: cdk.Duration.minutes(5),
    statistic: 'Sum',
  }),
  threshold: 3,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

**Why ≥3 errors/5min?**

- Deployment runs are lower volume than webhook/analysis
- Single deployment failure could indicate infrastructure issue
- 3 failures in 5 minutes suggests systemic problem

### GitHub Integration Errors

```typescript
new cloudwatch.Alarm(this, 'GitHubIntegrationErrors', {
  alarmName: 'pullmint-github-integration-errors',
  alarmDescription: 'Alert when GitHub integration has elevated error rate',
  metric: githubIntegration.metricErrors({
    period: cdk.Duration.minutes(5),
    statistic: 'Sum',
  }),
  threshold: 5,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

**Why ≥5 errors/5min?**

- Higher throughput service (every PR gets analysis)
- Temporary GitHub API issues may cause transient errors
- 5 failures indicates persistent problem

### Webhook Handler Errors

```typescript
new cloudwatch.Alarm(this, 'WebhookHandlerErrors', {
  alarmName: 'pullmint-webhook-handler-errors',
  alarmDescription: 'Alert when webhook handler has elevated error rate',
  metric: webhookHandler.metricErrors({
    period: cdk.Duration.minutes(5),
    statistic: 'Sum',
  }),
  threshold: 5,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

**Why ≥5 errors/5min?**

- Highest throughput service (every webhook event)
- Signature validation errors may be malicious traffic
- 5 failures suggests webhook secret mismatch or DynamoDB issue

## Lambda Metrics

All Lambda functions expose standard AWS metrics:

### Function-Level Metrics

**Invocations:**

- Total number of function invocations
- Use to track PR volume and system usage

**Errors:**

- Number of invocations that resulted in function errors
- Includes both handled and unhandled exceptions

**Duration:**

- Execution time in milliseconds (min, max, avg)
- Use to identify performance regressions

**Throttles:**

- Number of invocations throttled due to concurrency limits
- Indicates need to increase reserved concurrency

**Concurrent Executions:**

- Number of function instances running simultaneously
- Use to right-size concurrency limits

**DeadLetterErrors:**

- Number of failed asynchronous invocations sent to DLQ
- Critical for identifying lost events

### Querying Lambda Metrics

```bash
# Get error count for architecture-agent
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions Name=FunctionName,Value=pullmint-architecture-agent \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Sum

# Get average duration
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=pullmint-architecture-agent \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Average
```

## CloudWatch Logs

### Log Groups

Each Lambda function has a dedicated log group:

- `/aws/lambda/pullmint-webhook-receiver`
- `/aws/lambda/pullmint-architecture-agent`
- `/aws/lambda/pullmint-github-integration`
- `/aws/lambda/pullmint-deployment-orchestrator`
- `/aws/lambda/pullmint-dashboard-api`
- `/aws/lambda/pullmint-dashboard-ui`

### Structured Logging

All logs use JSON format for machine readability:

```json
{
  "timestamp": "2026-02-09T10:30:00Z",
  "level": "INFO",
  "service": "architecture-agent",
  "executionId": "abc-123-def-456",
  "prNumber": 42,
  "repo": "owner/repo",
  "event": "analysis.started",
  "metadata": {
    "diffSize": 1234,
    "filesChanged": 5
  }
}
```

### CloudWatch Logs Insights Queries

**Find all failed executions:**

```sql
fields @timestamp, executionId, repo, prNumber, error
| filter status = "failed"
| sort @timestamp desc
| limit 20
```

**Calculate average LLM latency:**

```sql
fields @timestamp, executionId, duration
| filter service = "architecture-agent" and event = "llm.completed"
| stats avg(duration) as avgDuration by bin(5m)
```

**Identify slow PR analyses:**

```sql
fields @timestamp, executionId, repo, prNumber, duration
| filter service = "architecture-agent" and duration > 30000
| sort duration desc
| limit 10
```

**Track deployment success rate:**

```sql
fields @timestamp, executionId, deploymentStatus
| filter service = "deployment-orchestrator"
| stats count(*) as total,
        count(deploymentStatus = "deployed") as successful
| extend successRate = (successful / total) * 100
```

**Find webhook signature validation failures:**

```sql
fields @timestamp, deliveryId, error
| filter service = "webhook-receiver" and error like /signature/
| count by bin(1h)
```

## DynamoDB Metrics

### Table-Level Metrics

**Read/Write Capacity:**

- `ConsumedReadCapacityUnits`: Actual read capacity consumed
- `ConsumedWriteCapacityUnits`: Actual write capacity consumed
- Important for on-demand billing cost estimation

**Throttled Requests:**

- `SystemErrors`: Server-side errors (usually throttling)
- `UserErrors`: Client-side errors (validation failures)

**Latency:**

- `SuccessfulRequestLatency`: Time to complete requests
- Use to identify slow queries or index inefficiencies

### Querying DynamoDB Metrics

```bash
# Get consumed read capacity
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=pullmint-executions \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Sum

# Check for throttling
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name SystemErrors \
  --dimensions Name=TableName,Value=pullmint-executions \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Sum
```

## EventBridge Metrics

### Event Bus Metrics

**Invocations:**

- Total number of events published to bus
- Use to track event volume

**FailedInvocations:**

- Events that failed to invoke targets
- Critical for identifying dead letter queue issues

**TriggeredRules:**

- Number of rules matched by events
- Use to verify routing is working

### Querying EventBridge Metrics

```bash
# Get total events published
aws cloudwatch get-metric-statistics \
  --namespace AWS/Events \
  --metric-name Invocations \
  --dimensions Name=EventBusName,Value=pullmint-bus \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Sum
```

## API Gateway Metrics

### Request Metrics

**Count:**

- Total number of API requests
- Use to track dashboard usage

**Latency:**

- Time between receiving request and returning response
- Use to identify performance issues

**4XXError:**

- Client errors (bad requests, unauthorized)
- High rate indicates API misuse or bugs

**5XXError:**

- Server errors (Lambda failures, timeouts)
- Critical for identifying system issues

### Querying API Gateway Metrics

```bash
# Get total API requests
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name Count \
  --dimensions Name=ApiName,Value=PullmintAPI \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Sum

# Check error rate
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name 5XXError \
  --dimensions Name=ApiName,Value=PullmintAPI \
  --start-time 2026-02-09T00:00:00Z \
  --end-time 2026-02-09T23:59:59Z \
  --period 3600 \
  --statistics Sum
```

## Custom Metrics

### Publishing Custom Metrics

```typescript
import { CloudWatch } from '@aws-sdk/client-cloudwatch';

const cloudwatch = new CloudWatch({});

// Publish LLM token usage
await cloudwatch.putMetricData({
  Namespace: 'Pullmint',
  MetricData: [
    {
      MetricName: 'LLMTokensUsed',
      Value: tokensUsed,
      Unit: 'Count',
      Timestamp: new Date(),
      Dimensions: [
        { Name: 'Service', Value: 'architecture-agent' },
        { Name: 'Model', Value: 'claude-sonnet-4.5' },
      ],
    },
  ],
});

// Publish risk score distribution
await cloudwatch.putMetricData({
  Namespace: 'Pullmint',
  MetricData: [
    {
      MetricName: 'RiskScore',
      Value: riskScore,
      Unit: 'None',
      Timestamp: new Date(),
      Dimensions: [{ Name: 'Repo', Value: repoFullName }],
    },
  ],
});
```

### Recommended Custom Metrics

**Business Metrics:**

- `PRAnalysisCompleted`: Count of PRs analyzed
- `AutoDeploymentTriggered`: Count of auto-deployed PRs
- `HumanOverride`: Count of manual approvals after high risk score
- `CacheHitRate`: Percentage of LLM cache hits

**Performance Metrics:**

- `LLMLatency`: Time to complete LLM analysis
- `DeploymentLatency`: Time from approval to deployment
- `EndToEndLatency`: Time from webhook to comment posted

**Cost Metrics:**

- `LLMTokensUsed`: Total tokens consumed
- `DynamoDBReadCapacity`: Actual read capacity units used
- `DynamoDBWriteCapacity`: Actual write capacity units used

## Dashboards

### CloudWatch Dashboard

Pullmint includes a comprehensive CloudWatch dashboard (`pullmint-overview`) that provides real-time visibility into system health and performance.

**Access the dashboard:**

```bash
# Get dashboard URL from CDK outputs
aws cloudformation describe-stacks --stack-name WebhookStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudWatchDashboardURL`].OutputValue' \
  --output text

# Or navigate directly in AWS Console:
# CloudWatch → Dashboards → pullmint-overview
```

**Dashboard Layout:**

The dashboard is organized into 6 rows covering all key metrics:

#### Row 1: Lambda Invocations and Errors
- **Lambda Invocations**: Total invocation count for all Lambda functions
- **Lambda Errors**: Error count with color-coded severity (red for critical services)

#### Row 2: Lambda Performance
- **Lambda Duration**: Average and maximum execution times
- **Lambda Throttles & Concurrent Executions**: Throttling events and concurrent execution capacity

#### Row 3: DynamoDB Metrics
- **DynamoDB Consumed Capacity**: Read/Write capacity units consumed by tables
- **DynamoDB Throttles & Latency**: System errors, user errors, and request latency

#### Row 4: API Gateway Metrics
- **API Gateway Requests**: Total requests and HTTP error rates (4XX, 5XX)
- **API Gateway Latency**: Average and p99 latency for API responses

#### Row 5: EventBridge and SQS
- **EventBridge Events**: Published events and failed invocations
- **SQS Queue Metrics**: Queue depth for LLM queue and DLQ message counts

#### Row 6: Summary Statistics (24h)
- **Total PR Executions**: Webhook invocations in last 24 hours
- **Total Errors**: Sum of all Lambda errors across services
- **Avg Analysis Duration**: Average LLM analysis time (1h window)
- **DLQ Messages**: Total messages in all dead letter queues

**Key Features:**

- **Real-time monitoring**: 5-minute refresh interval for live metrics
- **Color-coded alerts**: Red for errors, orange for warnings, blue for normal operations
- **Multi-metric correlation**: See relationships between services at a glance
- **Deployment tracking**: Monitor deployments and their success rates

### Dashboard Implementation

The dashboard is automatically deployed as part of the infrastructure stack. See [infrastructure/lib/webhook-stack.ts](../infrastructure/lib/webhook-stack.ts) for the complete implementation.

**Key code example:**

```typescript
const dashboard = new cloudwatch.Dashboard(this, 'PullmintDashboard', {
  dashboardName: 'pullmint-overview',
});

// Lambda invocations widget
dashboard.addWidgets(
  new cloudwatch.GraphWidget({
    title: 'Lambda Invocations',
    width: 12,
    left: [
      webhookHandler.metricInvocations({ statistic: 'Sum', label: 'Webhook Handler' }),
      architectureAgent.metricInvocations({ statistic: 'Sum', label: 'Architecture Agent' }),
      githubIntegration.metricInvocations({ statistic: 'Sum', label: 'GitHub Integration' }),
      deploymentOrchestrator.metricInvocations({ statistic: 'Sum', label: 'Deployment Orchestrator' }),
    ],
  })
);
```

The dashboard includes 20+ metrics across 6 functional areas, providing comprehensive visibility into system health.

## Alerting

### SNS Topics for Alarms

```typescript
const alertTopic = new sns.Topic(this, 'AlertTopic', {
  displayName: 'Pullmint Alerts',
});

// Subscribe email
alertTopic.addSubscription(new subscriptions.EmailSubscription('team@example.com'));

// Subscribe Slack (via Lambda)
alertTopic.addSubscription(new subscriptions.LambdaSubscription(slackNotifierLambda));

// Add SNS action to alarms
alarm.addAlarmAction(new actions.SnsAction(alertTopic));
```

### Slack Integration

```typescript
// Slack notifier Lambda
export async function handler(event: SNSEvent) {
  const message = JSON.parse(event.Records[0].Sns.Message);

  await fetch(process.env.SLACK_WEBHOOK_URL!, {
    method: 'POST',
    body: JSON.stringify({
      text: `🚨 *${message.AlarmName}*\n${message.NewStateReason}`,
      channel: '#pullmint-alerts',
    }),
  });
}
```

### PagerDuty Integration

```typescript
// PagerDuty integration via Events API
await fetch('https://events.pagerduty.com/v2/enqueue', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
  },
  body: JSON.stringify({
    routing_key: process.env.PAGERDUTY_ROUTING_KEY,
    event_action: 'trigger',
    payload: {
      summary: alarm.alarmName,
      severity: 'error',
      source: 'pullmint',
      custom_details: {
        alarm: alarm.alarmName,
        reason: alarm.stateReason,
      },
    },
  }),
});
```

## Tracing

### X-Ray Integration (Future)

```typescript
const lambda = new lambda.Function(this, 'ArchitectureAgent', {
  tracing: lambda.Tracing.ACTIVE, // Enable X-Ray
  // ...
});
```

**Benefits:**

- Visualize request flow across services
- Identify bottlenecks in event processing
- Trace errors to specific service

**Sample Trace:**

```
API Gateway → Lambda (webhook-receiver) → EventBridge →
  SQS → Lambda (architecture-agent) → EventBridge →
  Lambda (github-integration)
```

## Log Retention

### Configuring Retention Policies

```typescript
new logs.LogGroup(this, 'WebhookReceiverLogs', {
  logGroupName: '/aws/lambda/pullmint-webhook-receiver',
  retention: logs.RetentionDays.ONE_MONTH, // 30 days
});
```

**Recommended Retention:**

- **Production**: 30 days (compliance, debugging)
- **Development**: 7 days (cost optimization)
- **Audit logs**: 90 days or longer

## Troubleshooting Guides

### High Error Rate

1. Check CloudWatch alarms for triggered alarms
2. Review Lambda logs for error messages
3. Check DynamoDB throttling metrics
4. Verify secrets are not expired in Secrets Manager
5. Review GitHub webhook delivery history

### Slow Performance

1. Check Lambda duration metrics
2. Review DynamoDB latency metrics
3. Analyze LLM response times in logs
4. Check for cold starts (increase provisioned concurrency)
5. Verify network connectivity (VPC NAT gateway)

### Missing Events

1. Check EventBridge invocations vs. failed invocations
2. Review SQS dead letter queue for failures
3. Verify event patterns in EventBridge rules
4. Check Lambda concurrent execution limits
5. Review webhook deduplication logs

### Cost Spike

1. Check LLM token usage (custom metrics)
2. Review DynamoDB consumed capacity
3. Analyze Lambda invocation count
4. Check for runaway processes or loops
5. Review CloudWatch Logs storage costs

## Best Practices

### Logging

- Use structured JSON logs for machine readability
- Include correlation IDs (executionId) in all logs
- Log at appropriate levels (INFO, WARN, ERROR)
- Avoid logging sensitive data (secrets, PII)

### Metrics

- Publish custom metrics for business KPIs
- Use dimensions for filtering and grouping
- Set appropriate alarm thresholds based on SLOs
- Monitor cost metrics to prevent budget overruns

### Alerting

- Alert on symptoms, not causes (SLI-based)
- Reduce alert fatigue (tune thresholds)
- Route alerts to appropriate teams (SNS topics)
- Include actionable information in alerts

### Dashboards

- Build dashboards for different audiences (ops, business)
- Include both technical and business metrics
- Use appropriate visualizations (gauge, graph, number)
- Update dashboards as system evolves
