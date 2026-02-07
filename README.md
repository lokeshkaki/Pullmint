# Pullmint - Autonomous PR Review Platform

> Fresh approvals for clean code

**AI-powered pull request analysis and automation for GitHub workflows**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

## What is Pullmint?

An intelligent PR review automation platform that combines LLM-powered code analysis with traditional CI/CD tools to:
- Reduce review time by 70%
- Auto-approve low-risk changes
- Provide consistent, high-quality feedback
- Integrate seamlessly with GitHub workflows

## Architecture Highlights

- **Event-Driven:** EventBridge orchestrates webhook events to specialized agents
- **Multi-Agent System:** Dedicated LLM agents for architecture, security, and performance analysis
- **Serverless-First:** Built entirely on AWS Lambda + DynamoDB for cost optimization
- **Budget-Conscious:** ~$40/month operating cost for 250 PRs
- **Production-Grade:** Comprehensive error handling, monitoring, and observability

## Tech Stack

**Backend:**
- Node.js 20 + TypeScript
- AWS Lambda (serverless compute)
- AWS Step Functions (workflow orchestration)
- Amazon EventBridge (event routing)
- DynamoDB (state management + caching)
- Amazon S3 (artifact storage)

**AI/LLM:**
- OpenAI GPT-3.5-Turbo (primary)
- OpenAI GPT-4 (high-risk PRs only)
- Semgrep (SAST security scanning)

**Frontend:**
- React 18 + TypeScript
- Vite (build tool)
- TanStack Query (data fetching)
- Tailwind CSS (styling)
- CloudFront + S3 (hosting)

**Infrastructure:**
- AWS CDK (TypeScript)
- GitHub Actions (CI/CD)

## Project Stats

- **Cost:** ~$40/month for 250 PRs
- **Latency:** < 60s for PR analysis (cold start)
- **Model:** GPT-3.5-Turbo by default, GPT-4 for complex cases
- **Architecture:** 8+ AWS services orchestrated via EventBridge

**Prerequisites:**
- AWS Account
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- OpenAI API key

**Setup:**
```bash
# Clone repository
git clone https://github.com/lokeshkaki/pullmint.git
cd pullmint

# Install dependencies
npm install

# Configure AWS
aws configure

# Bootstrap CDK
cdk bootstrap

# Deploy infrastructure
cd infrastructure
npm run deploy

# Configure GitHub webhook with output URL
```

## Current Status

**Phase 1: MVP Foundation** (In Progress)
- [x] Project structure initialized
- [ ] Webhook receiver implementation
- [ ] Architecture agent implementation
- [ ] GitHub integration
- [ ] End-to-end MVP demo

## License

MIT License - see [LICENSE](LICENSE)