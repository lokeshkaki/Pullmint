# Dashboard

## Overview

The Pullmint dashboard provides real-time visibility into PR executions, analysis results, risk scores, and deployment status.

## Accessing the Dashboard

### Get Dashboard URL

After deployment, retrieve the dashboard URL:

```bash
aws cloudformation describe-stacks \
  --stack-name PullmintWebhookStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DashboardURL`].OutputValue' \
  --output text
```

Or construct manually: `https://<api-gateway-id>.execute-api.<region>.amazonaws.com/prod/dashboard`

## Dashboard Features

### Real-Time Updates
- **Auto-refresh**: Polls API every 10 seconds when tab is active
- **Smart polling**: Pauses when tab is hidden (saves API calls)
- **Manual refresh**: Click the refresh button anytime

### Filtering and Search
- **By repository**: Filter executions for specific repo (`owner/repo`)
- **By status**: Filter by execution status
  - `pending`: Webhook received, waiting for analysis
  - `analyzing`: LLM analysis in progress
  - `completed`: Analysis finished, comment posted
  - `failed`: Error during processing
  - `deploying`: Deployment in progress
  - `deployed`: Successfully deployed
- **Combined filters**: Use repo + status together

### Key Metrics (Top Cards)
- **Total Executions**: Count of all PR analyses
- **Average Risk Score**: Mean risk across all executions
- **Auto-Deployed**: Count of low-risk PRs auto-deployed
- **Success Rate**: Percentage of successful executions

### Execution List
- **Risk score badge**: Color-coded (green < 30, yellow < 60, red ≥ 60)
- **Status badge**: Current execution state
- **Findings preview**: Count of critical/high severity issues
- **Deployment timeline**: Timestamps for approval, start, completion
- **Metadata**: Repository, PR number, SHA, timestamp

### Pagination
- **Default page size**: 50 executions
- **Maximum page size**: 100 executions
- **Load More button**: Seamless pagination without page reloads

## API Endpoints

The dashboard is backed by a REST API accessible at `/dashboard/*`:

### GET /dashboard/executions

List all PR executions with optional filtering.

**Query Parameters:**
- `repo` (optional): Filter by repository (e.g., `owner/repo`)
- `status` (optional): Filter by status (`pending`, `analyzing`, `completed`, `failed`, `deploying`, `deployed`)
- `limit` (optional): Results per page (default: 50, max: 100)
- `nextToken` (optional): Pagination token from previous response

**Example Request:**
```bash
curl "https://<api-url>/dashboard/executions?repo=owner/repo&status=completed&limit=20"
```

**Example Response:**
```json
{
  "executions": [
    {
      "executionId": "abc-123-def-456",
      "repoFullName": "owner/repo",
      "prNumber": 42,
      "headSha": "abc123def456...",
      "status": "completed",
      "timestamp": 1707523200000,
      "riskScore": 25,
      "findings": [
        {
          "type": "architecture",
          "severity": "medium",
          "title": "Large function detected",
          "description": "Function exceeds 50 lines",
          "file": "src/handler.ts",
          "line": 42,
          "suggestion": "Consider breaking into smaller functions"
        }
      ],
      "deploymentStatus": "deployed",
      "deploymentEnvironment": "staging",
      "deploymentApprovedAt": 1707523210000,
      "deploymentStartedAt": 1707523220000,
      "deploymentCompletedAt": 1707523280000
    }
  ],
  "count": 1,
  "nextToken": "eyJleGVjdXRpb25JZCI6ImFiYy0xMjMifQ=="
}
```

**Status Codes:**
- `200 OK`: Success
- `400 Bad Request`: Invalid query parameters
- `500 Internal Server Error`: Server error

### GET /dashboard/executions/:executionId

Get detailed information about a specific execution.

**Path Parameters:**
- `executionId`: Unique execution identifier (UUID)

**Example Request:**
```bash
curl "https://<api-url>/dashboard/executions/abc-123-def-456"
```

**Example Response:**
```json
{
  "executionId": "abc-123-def-456",
  "repoFullName": "owner/repo",
  "prNumber": 42,
  "headSha": "abc123def456...",
  "status": "completed",
  "timestamp": 1707523200000,
  "riskScore": 25,
  "findings": [
    {
      "type": "architecture",
      "severity": "medium",
      "title": "Large function detected",
      "description": "Function exceeds 50 lines",
      "file": "src/handler.ts",
      "line": 42,
      "suggestion": "Consider breaking into smaller functions"
    }
  ],
  "deploymentStatus": "deployed",
  "deploymentEnvironment": "staging",
  "deploymentApprovedAt": 1707523210000,
  "deploymentStartedAt": 1707523220000,
  "deploymentCompletedAt": 1707523280000
}
```

**Status Codes:**
- `200 OK`: Success
- `404 Not Found`: Execution not found
- `500 Internal Server Error`: Server error

### GET /dashboard/repos/:owner/:repo/prs/:number

Get all executions for a specific pull request (useful for tracking analysis across multiple commits).

**Path Parameters:**
- `owner`: Repository owner
- `repo`: Repository name
- `number`: Pull request number

**Query Parameters:**
- `limit` (optional): Results per page (default: 50, max: 100)
- `nextToken` (optional): Pagination token

**Example Request:**
```bash
curl "https://<api-url>/dashboard/repos/owner/repo/prs/42?limit=10"
```

**Example Response:**
```json
{
  "executions": [
    {
      "executionId": "exec-1",
      "repoFullName": "owner/repo",
      "prNumber": 42,
      "headSha": "abc123...",
      "status": "completed",
      "timestamp": 1707523200000,
      "riskScore": 25
    },
    {
      "executionId": "exec-2",
      "repoFullName": "owner/repo",
      "prNumber": 42,
      "headSha": "def456...",
      "status": "completed",
      "timestamp": 1707523100000,
      "riskScore": 30
    }
  ],
  "count": 2,
  "nextToken": null
}
```

**Status Codes:**
- `200 OK`: Success
- `404 Not Found`: No executions found for PR
- `500 Internal Server Error`: Server error

## Dashboard Architecture

### Frontend
- **Technology**: Single-page HTML/CSS/JavaScript application
- **Dependencies**: None (vanilla JavaScript)
- **Responsive**: Mobile-friendly design with CSS Grid/Flexbox
- **Hosting**: Served via Lambda function (dashboard-ui)

### Backend
- **API Function**: dashboard-api Lambda
- **Database**: DynamoDB with GSI for efficient queries
- **CORS**: Enabled for browser access (`Access-Control-Allow-Origin: *`)
- **Pagination**: Base64-encoded tokens for stateless pagination

### Performance
- **Client-side polling**: 10-second intervals (configurable)
- **Automatic pause**: Stops polling when tab hidden
- **Query optimization**: DynamoDB GSI (`ByRepo` index)
- **Response compression**: API Gateway compression enabled

### Security
- **CORS**: Configured for browser access (internal tool)
- **No authentication**: Currently open (add auth for public deployments)
- **Rate limiting**: API Gateway throttling (100 req/sec)
- **IAM permissions**: Lambda has least-privilege DynamoDB read access

## Using the Dashboard

### View All Executions

Navigate to the dashboard URL. The main view shows:
- Total executions count
- Average risk score
- Auto-deployed count
- Success rate
- List of recent executions (sorted by timestamp, descending)

### Filter by Repository

1. Enter repository in format `owner/repo` in the filter input
2. Click "Apply Filters"
3. Dashboard shows only executions for that repository

**Example:** `facebook/react`, `vercel/next.js`

### Filter by Status

1. Select status from dropdown:
   - All
   - Pending
   - Analyzing
   - Completed
   - Failed
   - Deploying
   - Deployed
2. Click "Apply Filters"

### Combine Filters

Filter by both repository and status to narrow results:
1. Enter repository: `owner/repo`
2. Select status: `completed`
3. Click "Apply Filters"

**Use case:** See all completed executions for a specific repository

### View Execution Details

Click on any execution row to expand and see:
- Full list of findings with severity, file, line number, suggestions
- Deployment timeline with timestamps
- Risk score calculation details
- Error messages (if failed)

### Load More Executions

Scroll to the bottom and click "Load More" to fetch the next page of results. Pagination maintains current filters.

### Manual Refresh

Click the "Refresh" button in the top-right to manually fetch latest data. Useful when auto-refresh is paused or you want immediate updates.

## API Integration

### Programmatic Access

Use the API endpoints to build custom integrations:

```javascript
// Fetch recent executions
const response = await fetch(
  'https://<api-url>/dashboard/executions?limit=10'
);
const data = await response.json();

console.log(`Total: ${data.count}`);
data.executions.forEach(exec => {
  console.log(`PR #${exec.prNumber}: Risk ${exec.riskScore}`);
});
```

### Webhook Integration

Build alerts or notifications based on execution data:

```javascript
// Poll for new failed executions
setInterval(async () => {
  const response = await fetch(
    'https://<api-url>/dashboard/executions?status=failed&limit=5'
  );
  const { executions } = await response.json();
  
  if (executions.length > 0) {
    // Send Slack notification
    await sendSlackAlert(executions);
  }
}, 60000); // Check every minute
```

### Metrics Export

Export data for analysis or visualization:

```bash
# Export all executions to JSON
curl "https://<api-url>/dashboard/executions?limit=100" > executions.json

# Filter by repo and export
curl "https://<api-url>/dashboard/executions?repo=owner/repo&limit=100" \
  > repo-executions.json
```

## Troubleshooting

### Dashboard Not Loading

1. Verify API Gateway endpoint is accessible
2. Check CORS headers in browser console
3. Review dashboard-ui Lambda logs in CloudWatch
4. Ensure DynamoDB table exists and has data

### No Data Showing

1. Confirm webhook is configured and receiving events
2. Check that PRs have been created/updated
3. Verify executions exist in DynamoDB table
4. Review architecture-agent Lambda logs for errors

### Slow Performance

1. Reduce polling interval (or disable auto-refresh)
2. Use more specific filters to reduce result size
3. Check DynamoDB read capacity metrics
4. Consider caching API responses (CloudFront)

### Pagination Not Working

1. Verify `nextToken` is included in subsequent requests
2. Check that filters remain consistent across pages
3. Review dashboard-api Lambda logs for errors
4. Ensure DynamoDB queries support pagination

## Future Enhancements

- **WebSocket support**: Real-time updates without polling
- **Authentication**: Add Cognito or API key authentication
- **Custom dashboards**: Per-team or per-repo views
- **Metrics visualization**: Charts for risk trends, deploy frequency
- **Alerting**: Email/Slack notifications for failures
- **Export**: CSV/PDF export of execution history
