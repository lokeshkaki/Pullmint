# Pullmint Infrastructure

AWS CDK infrastructure for Pullmint deployment automation platform.

## Quick Start

```bash
npm install
export GITHUB_APP_ID=your-github-app-id
npm run deploy
```

## DynamoDB GSI Deployment

Pullmint uses DynamoDB with multiple Global Secondary Indexes (GSIs) for efficient querying. DynamoDB restricts GSI operations to **one creation or deletion per update**.

### Deployment Strategies

#### For Existing Stacks (Recommended)

If your stack is already deployed with all GSIs, always use `gsiStage=all`:

```bash
npm run deploy -- --require-approval never -c gsiStage=all
```

This is the **default behavior in CI/CD workflows**.

#### For New Stack Initial Deployment

For brand new deployments where the DynamoDB table doesn't exist, you can add GSIs incrementally:

```bash
# Step 1: Create table with first GSI
npm run deploy -- --require-approval never -c gsiStage=ByRepo

# Step 2: Add second GSI
npm run deploy -- --require-approval never -c gsiStage=ByRepoPr

# Step 3: Add third GSI
npm run deploy -- --require-approval never -c gsiStage=ByTimestamp
```

Each deployment adds one GSI, complying with DynamoDB's one-operation-per-update limitation.

### GSI Descriptions

| GSI Name | Partition Key | Sort Key | Purpose |
|----------|---------------|----------|---------|
| **ByRepo** | `repoFullName` | `timestamp` | Query all executions for a repository |
| **ByRepoPr** | `repoPrKey` | `timestamp` | Query executions for specific PR |
| **ByTimestamp** | `entityType` | `timestamp` | Query recent executions across all repos |

### Context Parameters

- `gsiStage=ByRepo` - Include only ByRepo GSI
- `gsiStage=ByRepoPr` - Include ByRepo + ByRepoPr GSIs  
- `gsiStage=ByTimestamp` - Include all three GSIs
- `gsiStage=all` - Include all GSIs (same as ByTimestamp)
- No parameter - Include all GSIs with warning

### How It Works

The `gsiStage` parameter controls which GSIs are defined in the CDK stack:

```typescript
// When gsiStage=ByRepoPr, the stack includes:
- ByRepo GSI ✓
- ByRepoPr GSI ✓
- ByTimestamp GSI ✗ (not included)
```

CDK compares the desired state (code) with current state (AWS):
- **Existing GSI + Still in code = No change** (✓)
- **Missing GSI + Now in code = CREATE** (1 operation)
- **Existing GSI + Not in code = DELETE** (1 operation)

This ensures only one GSI operation per deployment.

### Common Scenarios

#### Scenario 1: Regular Update to Existing Stack
```bash
# Stack has all GSIs, just updating Lambda code
npm run deploy -- -c gsiStage=all
# Result: No GSI changes, only Lambda/config updates
```

#### Scenario 2: Adding Missing GSI
```bash
# Stack has ByRepo, need to add ByRepoPr
npm run deploy -- -c gsiStage=ByRepoPr
# Result: Keeps ByRepo, adds ByRepoPr (1 operation)
```

#### Scenario 3: Fresh Stack Creation
```bash
# No existing resources
npm run deploy -- -c gsiStage=ByRepo     # Creates table + ByRepo
npm run deploy -- -c gsiStage=ByRepoPr   # Adds ByRepoPr
npm run deploy -- -c gsiStage=ByTimestamp # Adds ByTimestamp
```

### Troubleshooting

**Error: "Cannot perform more than one GSI creation or deletion"**

This occurs when the stack definition differs significantly from deployed state.

**Solution**: Use `gsiStage=all` for existing stacks to match the current state without GSI changes.

**Check current GSIs:**
```bash
aws dynamodb describe-table --table-name pullmint-pr-executions \
  --query 'Table.GlobalSecondaryIndexes[].IndexName' --output table
```

## Other Commands

```bash
# Synthesize CloudFormation template
npm run synth

# Show stack differences
npm run diff

# Destroy stack (WARNING: deletes all resources)
npm run destroy
```

## Environment Variables

- `GITHUB_APP_ID` - GitHub App ID (required)
- `GITHUB_APP_INSTALLATION_ID` - Installation ID (optional)
- `CDK_DEFAULT_ACCOUNT` - AWS Account ID (auto-detected from AWS CLI)
- `CDK_DEFAULT_REGION` - AWS Region (default: us-east-1)

## Resources Created

- **Lambda Functions**: 6 functions (webhook receiver, agents, API, UI)
- **API Gateway**: REST API for webhook endpoint
- **DynamoDB Tables**: 3 tables (executions, deduplication, cache)
- **EventBridge**: Custom event bus for orchestration
- **SQS Queues**: Processing queues with DLQ
- **Secrets Manager**: 3 secrets (webhook, API keys, GitHub)
- **CloudWatch**: Logs, metrics, and alarms

## Cost Estimation

See [COST.md](../docs/COST.md) for detailed cost breakdown.

Estimated monthly cost: $10-50 (depends on usage, mostly Lambda + DynamoDB)
