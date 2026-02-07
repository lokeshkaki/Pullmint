# Pullmint

**Automated code review and deployment orchestration powered by AI**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

Pullmint automates pull request reviews using specialized AI agents that analyze architecture, security, and performance. It integrates with your existing GitHub workflow to provide intelligent feedback and can automatically deploy low-risk changes.

## Features

- **Multi-Agent Analysis** - Specialized agents review architecture patterns, security vulnerabilities, and performance implications
- **Risk-Based Automation** - Automatically approve and deploy low-risk PRs, flag high-risk changes for human review
- **Real-Time Feedback** - Get comprehensive review feedback in under 30 seconds
- **Cost-Effective** - Designed to run at ~$0.10 per PR analyzed on AWS serverless infrastructure

## Architecture

Pullmint uses an event-driven architecture built on AWS serverless services:

```
GitHub Webhook → API Gateway → EventBridge → Step Functions
                                                     ↓
                                    ┌─────────────────────────────────┐
                                    │     Parallel Agent Execution    │
                                    ├────────────┬────────┬───────────┤
                                    │Architecture│Security│Performance│
                                    │   Agent    │ Agent  │  Agent    │
                                    └────────────┴────────┴───────────┘
                                                     ↓
                                         Risk Scoring & Decision
                                                     ↓
                                     Auto-Deploy or Request Human Review
```

**Core Components:**
- **Event Bus** (EventBridge) - Decoupled event routing
- **Orchestration** (Step Functions) - Coordinates multi-agent workflows  
- **Analysis Agents** (Lambda + LLM) - Specialized code review agents
- **State Management** (DynamoDB) - Tracks execution status and results
- **Artifact Storage** (S3) - Code diffs and analysis outputs

## Tech Stack

- **Backend:** Node.js, TypeScript, AWS Lambda
- **AI/LLM:** ChatGPT, Claude, etc.
- **Infrastructure:** AWS CDK, Step Functions, EventBridge, DynamoDB, S3
- **Frontend:** React, TypeScript, Vite
- **CI/CD:** GitHub Actions

## Getting Started

### Prerequisites
- AWS Account
- Node.js 20+
- OpenAI API key
- GitHub account

### Installation

```bash
git clone https://github.com/lokeshkaki/Pullmint.git
cd Pullmint

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Add your AWS credentials, GitHub token, and OpenAI API key to .env

# Deploy infrastructure
cd infrastructure
npm run deploy

# Configure GitHub webhook
npm run setup-webhook --repo=yourorg/yourrepo
```

## How It Works

1. **PR Created** - Developer creates a pull request on GitHub
2. **Webhook Trigger** - GitHub sends webhook to Pullmint API Gateway
3. **Event Routing** - EventBridge routes event to Step Functions orchestrator
4. **Parallel Analysis** - Multiple AI agents analyze the code simultaneously:
   - **Architecture Agent** - Reviews design patterns, code structure, maintainability
   - **Security Agent** - Scans for vulnerabilities, validates input sanitization
   - **Performance Agent** - Identifies N+1 queries, algorithmic inefficiencies
5. **Risk Scoring** - Aggregates findings and calculates risk score (0-100)
6. **Automated Decision**:
   - Low risk (< 30): Auto-approve and deploy to staging
   - Medium risk (30-70): Post review comments for developer
   - High risk (> 70): Request human review 
7. **GitHub Feedback** - Results posted as PR comments with actionable recommendations

## Configuration

See [`.env.example`](.env.example) for required environment variables:

- `AWS_REGION` - AWS region for deployment
- `GITHUB_WEBHOOK_SECRET` - Secret for validating GitHub webhooks
- `OPENAI_API_KEY` - OpenAI API key for LLM agents
- `MONTHLY_BUDGET_USD` - Optional cost limit for LLM API usage

## Contributing

No contributions at this time.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Author

**Lokesh Kaki**  
GitHub: [@lokeshkaki](https://github.com/lokeshkaki)

---

*Built with serverless architecture and AI-powered code analysis*
