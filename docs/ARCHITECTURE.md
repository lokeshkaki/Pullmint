# Architecture

## Overview

Pullmint is a serverless, event-driven platform built on AWS that combines LLM-powered code analysis with automated deployment orchestration.

## Tech Stack

### Backend

- **Runtime**: Node.js 20 + TypeScript 5.3
- **Compute**: AWS Lambda (serverless functions)
- **Orchestration**: Amazon EventBridge + SQS
- **State Management**: DynamoDB (executions, cache, deduplication)
- **Artifact Storage**: Amazon S3
- **Secrets**: AWS Secrets Manager

### AI/LLM

- **Primary LLM**: Anthropic Claude Sonnet 4.5
- **Use Cases**: Architecture analysis, risk scoring, finding generation
- **Token Optimization**: Context packing, diff hash caching

### Infrastructure

- **IaC**: AWS CDK (TypeScript)
- **CI/CD**: GitHub Actions with OIDC
- **Monitoring**: CloudWatch Logs, Metrics, Alarms
- **Testing**: Jest + aws-sdk-client-mock

### GitHub Integration

- **GitHub App**: Private app with PR read/write permissions
- **Webhook Events**: `pull_request` (opened, synchronize, reopened)
- **API Operations**: Fetch diff, post comments, update deployment status

## How It Works

### Event-Driven Flow

```
GitHub PR Event
    ↓
API Gateway → Webhook Receiver Lambda
    ↓
EventBridge (pullmint-bus)
    ↓
├─→ SQS Queue → Architecture Agent Lambda
│       ↓
│   LLM Analysis (Claude Sonnet 4.5)
│       ↓
│   EventBridge (analysis.completed)
│       ↓
├─→ GitHub Integration Lambda
│       ↓
│   Post PR Comment + Evaluate Risk
│       ↓
│   [If risk < threshold] EventBridge (deployment.approved)
│       ↓
└─→ Deployment Orchestrator Lambda
        ↓
    Webhook POST → Your Deploy System
        ↓
    Update Status in DynamoDB + GitHub
```

### Detailed Flow

1. **PR Created/Updated** → GitHub sends webhook event
2. **Webhook Receiver** → Validates HMAC signature, deduplicates via DynamoDB, creates execution record, publishes to EventBridge
3. **EventBridge** → Routes `pr.opened` event to SQS queue
4. **Architecture Agent** → Fetches PR diff, analyzes with Claude Sonnet 4.5, calculates risk score, publishes `analysis.completed` event
5. **GitHub Integration** → Posts findings as PR comment, evaluates deployment gates, publishes `deployment.approved` if low-risk
6. **Deployment Orchestrator** → POSTs to deployment webhook, tracks status in DynamoDB, updates GitHub deployment status
7. **Dashboard** → Queries DynamoDB for execution history, serves real-time UI

## Resilience Patterns

### Idempotency

- **Webhook Deduplication**: DynamoDB stores delivery IDs with TTL
- **Deployment Idempotency**: `executionId` ensures same deploy request is not processed twice
- **SQS Message Deduplication**: EventBridge uses content-based deduplication

### Retry Logic

- **SQS Visibility Timeout**: Failed messages return to queue after timeout
- **Exponential Backoff**: Deployment webhook retries with 1s, 2s, 4s delays
- **Dead Letter Queues**: Failed messages after max retries go to DLQ for investigation

### Error Boundaries

- **Try-Catch in All Handlers**: Every Lambda has top-level error handling
- **CloudWatch Alarms**: Alert on elevated error rates (≥3 errors/5min for deployment, ≥5 errors/5min for webhook/GitHub)
- **Structured Logging**: JSON logs with correlation IDs for tracing

## Risk Scoring Algorithm

```typescript
let riskScore = 0;

// LLM-identified findings
riskScore += findings.filter((f) => f.severity === 'critical').length * 30;
riskScore += findings.filter((f) => f.severity === 'high').length * 15;
riskScore += findings.filter((f) => f.severity === 'medium').length * 7;
riskScore += findings.filter((f) => f.severity === 'low').length * 3;
riskScore += findings.filter((f) => f.severity === 'info').length * 1;

// Diff size heuristics (future enhancement)
// riskScore += Math.min(diffLines / 100, 20);

return Math.min(riskScore, 100);
```

### Risk Thresholds

- **Auto-Approve** (< 30): Trivial changes (typos, docs, formatting)
- **Auto-Deploy** (< 40): Low-risk changes (minor features, refactors)
- **Manual Review** (≥ 40): High-risk changes (architecture, security, API changes)

## Data Models

### PR Execution (DynamoDB)

```typescript
{
  executionId: string;           // Partition key (UUID v4)
  repoFullName: string;          // GSI partition key "owner/repo"
  prNumber: number;              // GSI sort key
  headSha: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'deploying' | 'deployed';
  timestamp: number;             // Unix timestamp
  riskScore?: number;            // 0-100
  findings?: Finding[];          // LLM analysis results
  deploymentStatus?: 'pending' | 'approved' | 'deploying' | 'deployed' | 'failed';
  deploymentEnvironment?: string; // e.g., "staging"
  deploymentApprovedAt?: number;
  deploymentStartedAt?: number;
  deploymentCompletedAt?: number;
  error?: string;                // Error message if failed
  ttl: number;                   // Auto-delete after 90 days
}
```

### Deduplication (DynamoDB)

```typescript
{
  deliveryId: string; // Partition key (GitHub webhook delivery ID)
  processedAt: number; // Timestamp
  ttl: number; // Auto-delete after 24 hours
}
```

### Cache (DynamoDB)

```typescript
{
  cacheKey: string; // Partition key (diff hash or prompt hash)
  cacheValue: string; // Serialized LLM response
  createdAt: number;
  ttl: number; // Auto-delete after 7 days
}
```

## Lambda Functions

### webhook-receiver

- **Trigger**: API Gateway POST /webhook
- **Purpose**: Validate GitHub webhooks, deduplicate, publish to EventBridge
- **Timeout**: 10 seconds
- **Memory**: 256 MB
- **Environment Variables**: `WEBHOOK_SECRET_ARN`, `EXECUTIONS_TABLE_NAME`, `DEDUP_TABLE_NAME`, `EVENT_BUS_NAME`

### architecture-agent

- **Trigger**: SQS queue (EventBridge rule)
- **Purpose**: Analyze PR with Claude Sonnet 4.5, calculate risk score
- **Timeout**: 5 minutes
- **Memory**: 512 MB
- **Environment Variables**: `ANTHROPIC_API_KEY_ARN`, `EXECUTIONS_TABLE_NAME`, `CACHE_TABLE_NAME`, `EVENT_BUS_NAME`

### github-integration

- **Trigger**: EventBridge rule (analysis.completed event)
- **Purpose**: Post findings to PR, evaluate deployment gates
- **Timeout**: 30 seconds
- **Memory**: 256 MB
- **Environment Variables**: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_ARN`, `EXECUTIONS_TABLE_NAME`, `EVENT_BUS_NAME`

### deployment-orchestrator

- **Trigger**: EventBridge rule (deployment.approved event)
- **Purpose**: Trigger deployments via webhook, track status
- **Timeout**: 2 minutes
- **Memory**: 256 MB
- **Environment Variables**: `DEPLOYMENT_WEBHOOK_URL`, `DEPLOYMENT_WEBHOOK_AUTH_TOKEN_ARN`, `EXECUTIONS_TABLE_NAME`, `DEPLOYMENT_STRATEGY`

### dashboard-api

- **Trigger**: API Gateway GET /dashboard/executions\*
- **Purpose**: Query execution history from DynamoDB
- **Timeout**: 10 seconds
- **Memory**: 256 MB
- **Environment Variables**: `EXECUTIONS_TABLE_NAME`

### dashboard-ui

- **Trigger**: API Gateway GET /dashboard
- **Purpose**: Serve single-page dashboard application
- **Timeout**: 5 seconds
- **Memory**: 128 MB
- **Environment Variables**: None

## Security Architecture

### Authentication & Authorization

- **GitHub Webhooks**: HMAC-SHA256 signature validation
- **GitHub API**: JWT-based GitHub App authentication (1-hour tokens)
- **Deployment Webhooks**: Bearer token authentication
- **AWS IAM**: Least-privilege policies for Lambda functions

### Secret Management

- **AWS Secrets Manager**: All credentials stored with automatic rotation
- **Secret Rotation**: Webhook secret (90 days), API keys (manual), GitHub App key (annual)
- **Access Logging**: CloudTrail tracks all secret access

### Network Security

- **API Gateway**: Rate limiting (100 req/sec), throttling
- **Lambda**: VPC isolation for sensitive operations (future)
- **CORS**: Configured for dashboard browser access

## Observability

### CloudWatch Metrics

- **Lambda**: Invocations, Errors, Duration, Throttles, Concurrent Executions
- **DynamoDB**: Read/Write Capacity, Throttles, System Errors
- **EventBridge**: Invocations, Failed Invocations, TriggeredRules
- **API Gateway**: Count, Latency, 4XX/5XX Errors

### CloudWatch Alarms

- `pullmint-deployment-orchestrator-errors`: ≥3 errors/5min
- `pullmint-github-integration-errors`: ≥5 errors/5min
- `pullmint-webhook-handler-errors`: ≥5 errors/5min

### Structured Logging

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

## Performance Characteristics

### Latency

- **Webhook Processing**: < 200ms (validate + publish)
- **LLM Analysis**: 15-45 seconds (depends on diff size)
- **GitHub Comment Post**: < 2 seconds
- **Deployment Trigger**: < 5 seconds
- **End-to-End**: 20-60 seconds (PR opened → comment posted)

### Throughput

- **Concurrent PRs**: Up to 100 concurrent Lambda executions
- **API Gateway**: 100 requests/second (configurable)
- **DynamoDB**: On-demand scaling (no provisioned capacity)

### Cost Efficiency

- **Lambda**: $0 (within free tier for 250 PRs/month)
- **DynamoDB**: $1/month (on-demand, low traffic)
- **EventBridge**: $0 (within free tier)
- **LLM API**: $25/month (primary variable cost)
- **Total**: ~$32/month for 250 PRs

## Design Decisions

### Why Serverless?

- **Low Operational Overhead**: No servers to patch or scale
- **Cost Efficiency**: Pay only for actual usage
- **Auto-Scaling**: Handles traffic spikes without configuration
- **Built-in HA**: AWS manages availability across zones

### Why EventBridge?

- **Decoupling**: Services don't need to know about each other
- **Extensibility**: Easy to add new agents or integrations
- **Replay**: Can reprocess events from archive
- **Filtering**: Route events based on content

### Why DynamoDB?

- **Serverless**: No database servers to manage
- **Low Latency**: Single-digit millisecond reads/writes
- **Auto-Scaling**: On-demand capacity handles traffic
- **TTL**: Automatic deletion of old records

### Why Claude Sonnet 4.5?

- **Code Understanding**: Excellent at analyzing diffs and architecture
- **Structured Output**: Reliable JSON response format
- **Cost Efficiency**: $3/M input tokens vs GPT-4 Turbo ($10/M)
- **Context Window**: 200K tokens handles large PRs
