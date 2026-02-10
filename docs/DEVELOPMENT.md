# Development Guide

## Prerequisites

- **Node.js**: 20.x or later
- **npm**: 9.x or later
- **AWS CLI**: 2.x configured with credentials
- **AWS CDK**: `npm install -g aws-cdk`
- **Git**: For version control
- **VS Code**: Recommended IDE (optional)

## Project Structure

```
pullmint/
├── infrastructure/          # AWS CDK infrastructure code
│   ├── bin/                # CDK app entry point
│   ├── lib/                # CDK stacks
│   │   └── webhook-stack.ts
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── services/               # Lambda functions
│   ├── webhook-receiver/   # GitHub webhook handler
│   ├── llm-agents/
│   │   └── architecture-agent/  # LLM-based code analysis
│   ├── github-integration/ # Post results to GitHub
│   ├── deployment-orchestrator/ # Deployment automation
│   ├── dashboard-api/      # Dashboard REST API
│   ├── dashboard-ui/       # Dashboard web interface
│   └── shared/            # Shared utilities
│       ├── types.ts       # TypeScript interfaces
│       ├── secrets.ts     # Secrets Manager client
│       ├── dynamodb.ts    # DynamoDB client
│       ├── eventbridge.ts # EventBridge client
│       └── utils.ts       # Utility functions
├── docs/                   # Documentation
├── .serena/                # Serena MCP memories
├── .local/                 # Local development guides
├── package.json           # Root package.json (workspaces)
├── tsconfig.json         # Root TypeScript config
├── jest.config.js        # Root Jest config
└── README.md
```

## Local Development Setup

### 1. Clone Repository

```bash
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint
```

### 2. Install Dependencies

```bash
# Install root dependencies
npm install

# Install all workspace dependencies
npm install --workspaces
```

### 3. Build All Services

```bash
npm run build
```

This compiles TypeScript to JavaScript for all services.

### 4. Run Tests

```bash
# Run all tests
npm test

# Run tests for specific service
cd services/dashboard-api
npm test

# Run tests with coverage
npm test -- --coverage
```

### 5. Lint and Format

```bash
# Lint all code
npm run lint

# Format code
npm run format

# Type check
npm run type-check
```

## Testing

### Unit Tests

All services have comprehensive unit tests using Jest and aws-sdk-client-mock.

**Example test (dashboard-api):**

```typescript
import { handler } from '../index';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Dashboard API', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('should return execution details', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: 'test-123',
        status: 'completed',
        riskScore: 25,
      },
    });

    const event = {
      path: '/dashboard/executions/test-123',
      httpMethod: 'GET',
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });
});
```

### Integration Tests (Future)

Integration tests would test end-to-end flows:

```typescript
describe('PR Analysis Flow', () => {
  it('should process webhook → analyze → comment', async () => {
    // 1. Send mock webhook
    // 2. Wait for EventBridge processing
    // 3. Verify DynamoDB execution record
    // 4. Verify GitHub comment posted
  });
});
```

### Test Coverage

All services maintain **80%+ code coverage**:

```bash
# Generate coverage report
npm test -- --coverage

# View HTML report
open coverage/lcov-report/index.html
```

## Building Services

### TypeScript Compilation

```bash
# Build all services
npm run build

# Build specific service
cd services/webhook-receiver
npm run build

# Watch mode for development
npm run build -- --watch
```

### Output

Compiled JavaScript is written to `dist/` directories:

```
services/
└── webhook-receiver/
    ├── dist/
    │   └── index.js     # Compiled output
    ├── index.ts         # Source
    └── tsconfig.json
```

## Local Testing

### Test Lambda Functions Locally

```bash
# Install SAM CLI
brew install aws-sam-cli

# Invoke function locally
sam local invoke WebhookReceiver \
  --event events/webhook-event.json \
  --docker-network lambda-local
```

**Sample event (events/webhook-event.json):**

```json
{
  "body": "{\"action\":\"opened\",\"pull_request\":{...}}",
  "headers": {
    "X-Hub-Signature-256": "sha256=...",
    "X-GitHub-Delivery": "12345-67890"
  },
  "httpMethod": "POST",
  "path": "/webhook"
}
```

### Test with LocalStack

```bash
# Start LocalStack
docker run -p 4566:4566 localstack/localstack

# Deploy to LocalStack
cdklocal deploy

# Test locally
curl http://localhost:4566/restapis/<api-id>/prod/_user_request_/webhook
```

## CDK Development

### Synthesize CloudFormation

```bash
cd infrastructure
npm run synth
```

This generates CloudFormation templates in `cdk.out/`.

### Diff Changes

```bash
npm run diff
```

Shows changes that will be deployed.

### Deploy

```bash
# Deploy to AWS
npm run deploy

# Deploy with context
npm run deploy -- -c environment=staging

# Deploy specific stack
npm run deploy PullmintWebhookStack
```

### Destroy

```bash
npm run destroy
```

**Warning:** This deletes all resources. Use with caution.

## Debugging

### CloudWatch Logs

```bash
# Tail logs in real-time
aws logs tail /aws/lambda/pullmint-webhook-receiver --follow

# Filter logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/pullmint-architecture-agent \
  --filter-pattern "ERROR"
```

### VS Code Debugging

**launch.json:**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Webhook Handler",
      "program": "${workspaceFolder}/services/webhook-receiver/dist/index.js",
      "env": {
        "EXECUTIONS_TABLE_NAME": "pullmint-executions",
        "EVENT_BUS_NAME": "pullmint-bus"
      }
    }
  ]
}
```

### Remote Debugging (Lambda)

Use [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) for debugging:

```bash
sam local start-api --debug-port 5858
```

## Environment Variables

### Development

Create `.env` file in each service:

```bash
# services/architecture-agent/.env
ANTHROPIC_API_KEY=sk-ant-local-test-key
EXECUTIONS_TABLE_NAME=pullmint-executions-dev
CACHE_TABLE_NAME=pullmint-cache-dev
EVENT_BUS_NAME=pullmint-bus-dev
```

**Load with dotenv:**

```typescript
import 'dotenv/config';

const apiKey = process.env.ANTHROPIC_API_KEY;
```

### Production

Use AWS Secrets Manager (see [Security Guide](SECURITY.md)).

## Code Style

### TypeScript

```typescript
// Use strict mode
"use strict";

// Prefer const over let
const value = 42;

// Use async/await over promises
async function fetchData() {
  const result = await dynamodb.get({...});
  return result.Item;
}

// Type everything
interface PRExecution {
  executionId: string;
  status: string;
  riskScore?: number;
}

// Use optional chaining
const score = execution?.riskScore ?? 0;
```

### Naming Conventions

- **Files**: kebab-case (`webhook-handler.ts`)
- **Classes**: PascalCase (`WebhookStack`)
- **Functions**: camelCase (`handleWebhook`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRIES`)
- **Interfaces**: PascalCase (`PRExecution`)

### Linting

```bash
# Run ESLint
npm run lint

# Auto-fix issues
npm run lint -- --fix
```

**ESLint config (.eslintrc.json):**

```json
{
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "rules": {
    "@typescript-eslint/no-unused-vars": "error",
    "@typescript-eslint/explicit-function-return-type": "warn"
  }
}
```

### Formatting

Use Prettier for consistent formatting:

```bash
npm run format
```

**.prettierrc:**

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
```

## Git Workflow

### Branching Strategy

- `main`: Production-ready code
- `develop`: Integration branch
- `feature/*`: Feature branches
- `fix/*`: Bug fix branches

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(dashboard): add filtering by status
fix(webhook): handle missing signature header
docs(readme): update deployment instructions
chore(deps): upgrade aws-cdk to 2.120.0
```

### Pull Request Process

1. Create feature branch: `git checkout -b feature/add-security-agent`
2. Make changes and commit
3. Push branch: `git push origin feature/add-security-agent`
4. Create PR on GitHub
5. Wait for CI checks to pass
6. Request review from maintainers
7. Address feedback
8. Merge when approved

## CI/CD

### GitHub Actions

**.github/workflows/ci.yml:**

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
      - run: npm test
      - run: npm run lint

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v3
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - run: npm install
      - run: npm run build
      - run: cd infrastructure && npm run deploy
```

### Pre-commit Hooks

Use Husky for pre-commit checks:

```bash
npm install --save-dev husky

# Initialize Husky
npx husky install

# Add pre-commit hook
npx husky add .husky/pre-commit "npm test && npm run lint"
```

## Troubleshooting

### TypeScript Errors

**Issue:** `Cannot find module '../shared/types'`

**Solution:**

```bash
# Rebuild shared module
cd services/shared
npm run build

# Ensure tsconfig includes paths
# services/dashboard-api/tsconfig.json
{
  "compilerOptions": {
    "rootDir": "..",
    "paths": {
      "@shared/*": ["../shared/*"]
    }
  }
}
```

### Test Failures

**Issue:** AWS SDK mock not working

**Solution:**

```typescript
// Reset mock before each test
beforeEach(() => {
  ddbMock.reset();
});

// Mock specific commands
ddbMock.on(GetCommand).resolves({ Item: {...} });
```

### CDK Synthesis Errors

**Issue:** `Cannot find name 'dashboardResource'`

**Solution:**

```bash
# Check for syntax errors in webhook-stack.ts
cd infrastructure
npm run build

# Review error messages
npx tsc --noEmit
```

### Lambda Timeout

**Issue:** Lambda times out during local testing

**Solution:**

```typescript
// Increase timeout in CDK
new lambda.Function(this, 'ArchitectureAgent', {
  timeout: cdk.Duration.minutes(5), // Was 3 minutes
});
```

## Contributing

### Code Review Checklist

- [ ] Tests pass locally (`npm test`)
- [ ] Code coverage ≥ 80%
- [ ] Linting passes (`npm run lint`)
- [ ] TypeScript compiles without errors
- [ ] Documentation updated
- [ ] Commit messages follow Conventional Commits
- [ ] No secrets committed
- [ ] Error handling implemented
- [ ] Logging added for observability

### Submitting PRs

1. Fork the repository
2. Create feature branch
3. Make changes with tests
4. Run full CI locally
5. Push and create PR
6. Fill out PR template
7. Wait for review

## Resources

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [AWS Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Anthropic API Reference](https://docs.anthropic.com/en/api/getting-started)
- [GitHub Apps Documentation](https://docs.github.com/en/apps)
