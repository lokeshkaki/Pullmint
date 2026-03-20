# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IMPORTANT: Branching Rules

- **Always create a new branch from the latest `main` before starting any task.** Pull the latest main first (`git checkout main && git pull`), then branch: `git checkout -b <branch-name>`. Never work directly on `main`.
- **Branch names must be clean and descriptive of the feature, not implementation details.** Use `feat/persistent-knowledge-base`, not `feat/persistent-knowledge-base-chunk1`. No chunk numbers, step numbers, or internal plan references in branch names.
- **Always give the PR title once the task is done.**

## IMPORTANT: Commit Rules

- **NEVER add "Co-Authored-By: Claude" or any AI authorship attribution to commit messages.** No co-author lines, no AI credit lines, nothing that attributes a commit to Claude or any AI model. Commit messages must be clean — title and body only, no trailers referencing AI.
- **Always verify ALL checks pass before committing.** Before every commit, run: (1) TypeScript type check (`npx tsc --noEmit` in the affected service), (2) tests (`npm test` in the affected service), (3) lint (`npm run lint` from repo root), (4) Prettier (`npx prettier --check` from repo root on changed files). Do not commit if any check fails. This is the default — no need for the user to ask.

## IMPORTANT: Internal Documents Location

- **Always place plans, design docs, critique docs, and other internal/working documents in the `.local/` folder** — never in `docs/` or other tracked directories. The `.local/` folder is gitignored and keeps working documents separate from shipped code.

## Documentation Lookups

Always use context7 (`mcp__plugin_context7_context7__resolve-library-id` then `mcp__plugin_context7_context7__query-docs`) when referencing external library documentation, APIs, or framework usage — without needing to be asked.

## Commands

```bash
# Install dependencies (root + all workspaces)
npm install

# Build all services (TypeScript → dist/)
npm run build

# Run all tests
npm test

# Run tests for a single service
cd services/<service-name> && npm test
cd services/<service-name> && npm run test:coverage

# Lint and format
npm run lint
npm run lint -- --fix
npm run format

# Infrastructure (from repo root or infrastructure/)
cd infrastructure && npm run synth     # Generate CloudFormation templates
cd infrastructure && npm run diff      # Preview changes
cd infrastructure && npm run deploy    # Deploy PullmintWebhookStack
cd infrastructure && npm run deploy:all # Deploy all stacks
```

## Architecture

Pullmint is a serverless, event-driven PR analysis platform on AWS. The core flow:

```
GitHub PR → API Gateway → webhook-receiver → EventBridge (pullmint-bus)
                                                        ↓
                                          SQS → architecture-agent (LLM analysis)
                                                        ↓
                                          EventBridge (analysis.completed)
                                                        ↓
                                          github-integration (post comment + gate check)
                                                        ↓ (if risk < threshold)
                                          EventBridge (deployment.approved)
                                                        ↓
                                          deployment-orchestrator (webhook POST)
```

### Knowledge Base Flow

```
GitHub App install → webhook-receiver → EventBridge (repo.onboarding.requested)
                                                   ↓
                                       SQS → repo-indexer (git history + LLM narratives)
                                                   ↓
                                       DynamoDB (file-knowledge, author-profiles,
                                                 repo-registry, module-narratives)
                                       OpenSearch Serverless (module-narrative-index)

PR merged → webhook-receiver → EventBridge (pr.merged)
                                           ↓
                              SQS → repo-indexer (incremental update)

PR review → architecture-agent → context-assembly
                                  (assembles file metrics, author profile,
                                   module narratives from DDB/OpenSearch)
```

### Service Map

All Lambda functions live under `services/`. Each is an independent npm workspace:

| Service                         | Trigger                                                     | Purpose                                                                                                      |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `webhook-receiver`              | API Gateway POST /webhook                                   | Validate HMAC, deduplicate via DynamoDB, publish to EventBridge                                              |
| `llm-agents/architecture-agent` | SQS                                                         | Fetch PR diff, route to Haiku (<500 lines) or Sonnet (≥500 lines), compute risk score                        |
| `github-integration`            | EventBridge `analysis.completed`                            | Post PR comment, evaluate deployment gate                                                                    |
| `deployment-orchestrator`       | EventBridge `deployment.approved`                           | POST to deployment webhook, track status                                                                     |
| `deployment-monitor`            | EventBridge `deployment.status` (deployed)                  | Schedules post-deploy-5 and post-deploy-30 checkpoint evaluations via SQS delay                              |
| `signal-ingestion`              | API Gateway POST /signals/{executionId}                     | Accept inbound webhooks from external tools (Datadog, CloudWatch, Sentry); store signals on execution record |
| `calibration-service`           | EventBridge `execution.confirmed` / `execution.rolled-back` | Update per-repo calibration factor based on outcome history                                                  |
| `dependency-scanner`            | EventBridge Scheduler (nightly 02:00 UTC)                   | Scan org repos for shared-dependency relationships; populate dependency graph table                          |
| `repo-indexer`                  | SQS (onboarding + knowledge-update queues)                  | Bootstrap persistent knowledge base: git history, file churn, author profiles, module narratives + embeddings |
| `dashboard-api`                 | API Gateway GET /dashboard/\*                               | Query DynamoDB execution history, board, checkpoints, calibration, re-evaluate                               |
| `dashboard-ui`                  | API Gateway GET /dashboard                                  | Serve SPA dashboard                                                                                          |

### Shared Utilities (`services/shared/`)

- `types.ts` — All shared TypeScript interfaces (`PRExecution`, `Finding`, `Signal`, `CheckpointRecord`, `RepoContext`, `RiskEvaluation`, `FileMetrics`, `AuthorProfile`, `ModuleNarrative`, `RepoRegistryRecord`, `PRMergedEvent`, `ContextPackage`, etc.)
- `risk-evaluator.ts` — Pure scoring function: `evaluateRisk(input)` → `{ score, confidence, missingSignals, reason }`. Score = `min(100, round((llmBaseScore + signalDelta) × blastRadiusMultiplier × calibrationFactor))`. Signal deltas: CI fail +15, coverage drop >10% +10, error rate >10% +20, latency >20% +10, Friday-after-3pm +5.
- `dynamodb.ts` — DynamoDB client helpers; `updateItem` does SET only; use `atomicIncrementCounter` for ADD-based atomic counters (rate limiting).
- `eventbridge.ts` — EventBridge publish helpers
- `secrets.ts` — Secrets Manager client
- `github-app.ts` — GitHub App JWT auth
- `error-handling.ts` — Standardized error handling (`retryWithBackoff` only retries errors classified as transient by `isTransientError` — network errors, AWS throttles, 502/503. HTTP 500 webhook errors are NOT transient; implement manual retry loops for unconditional retry behavior.)
- `utils.ts` — Miscellaneous utilities
- `tracer.ts` — X-Ray distributed tracing via `addTraceAnnotations({ executionId, prNumber })`. No-ops outside Lambda context (safe in tests).

### Context Assembly (`services/llm-agents/architecture-agent/context-assembly.ts`)

`assembleContext()` fetches file metrics, author profiles, module narratives (OpenSearch with DynamoDB fallback), and PR description in parallel via `Promise.allSettled`. Returns `contextQuality: 'full' | 'partial' | 'none'` based on degradation. Uses Bedrock Titan embeddings for semantic narrative search with 3s timeout.

### Infrastructure (`infrastructure/lib/webhook-stack.ts`)

Single CDK stack (`PullmintWebhookStack`) defines all AWS resources. Uses `esbuild` to bundle Lambda functions from `services/` source directly.

### DynamoDB Tables

- **Executions table**: `executionId` (PK) + GSI on `repoFullName`/`prNumber`. Holds full PR lifecycle state (status, riskScore, findings, deployment status, checkpoints, signalsReceived, repoContext, calibrationApplied, overrideHistory). 90-day TTL.
- **Deduplication table**: `deliveryId` (PK). Prevents double-processing of webhooks. 24-hour TTL.
- **Cache table**: `cacheKey` (PK, diff/prompt hash). Stores LLM responses. 7-day TTL.
- **LLM Rate Limit table**: `counterKey` (PK, format `repoFullName:llm:hourKey`). Per-repo hourly LLM call counters. 2-hour TTL.
- **Calibration table**: `repoFullName` (PK). Stores per-repo calibration factor (0.5–2.0, default 1.0) and observation history. No TTL — permanent record. Active only after ≥10 observations.
- **Dependency Graph table**: `repoFullName` (PK). Stores downstream dependent repos and blast radius metadata. 48-hour TTL, refreshed nightly by `dependency-scanner`.
- **File Knowledge table**: `pk` (PK, format `repoFullName#filePath`). Stores per-file churn rates, bug-fix counts, ownership. No TTL — `RETAIN` removal policy.
- **Author Profiles table**: `pk` (PK, format `repoFullName#authorLogin`). Stores author rollback rates, merge counts, avg risk scores, frequent files. No TTL — `RETAIN`.
- **Repo Registry table**: `repoFullName` (PK). Tracks indexing status, context version, pending batches, queued execution IDs. No TTL — `RETAIN`.
- **Module Narratives table**: `pk` (PK, format `repoFullName#modulePath`). Stores LLM-generated module descriptions for context enrichment. No TTL — `RETAIN`.

### Execution Status Lifecycle

`pending → analyzing → completed → [deploying → deployed → monitoring → confirmed | rolled-back | failed] | deployment-blocked | failed`

- `deployment-blocked`: written by `github-integration` when risk score ≥ threshold or `testsPassed !== true`
- `monitoring`: written by `deployment-monitor` after deploy; awaiting post-deploy checkpoint evaluations
- `confirmed`: written when post-deploy-30 checkpoint evaluates to approved (stable deployment)
- `rolled-back`: written when a post-deploy checkpoint triggers rollback, or via manual override
- `deploying → failed` recovery: `deployment-orchestrator` uses try-finally to guarantee a terminal status write even on unhandled exceptions
- Execution records are idempotent: `ConditionExpression: 'attribute_not_exists(executionId)'` prevents silent overwrites on Lambda retry

### Dashboard API Routes

`dashboard-api` handles all routes under `/dashboard/`. Auth via `Authorization: Bearer <DASHBOARD_AUTH_TOKEN>` header (missing token → 503 deny-all).

| Method | Path                                        | Handler                                                |
| ------ | ------------------------------------------- | ------------------------------------------------------ |
| GET    | `/dashboard/executions`                     | List executions (paginated, filterable by repo/status) |
| GET    | `/dashboard/executions/:id`                 | Get single execution by executionId                    |
| GET    | `/dashboard/executions/:id/checkpoints`     | Get checkpoints, signals, repoContext for an execution |
| POST   | `/dashboard/executions/:id/re-evaluate`     | Trigger manual risk re-evaluation with justification   |
| GET    | `/dashboard/board`                          | Kanban board view — executions grouped by status       |
| GET    | `/dashboard/repos/:owner/:repo/prs/:number` | Look up execution by repo + PR number                  |
| GET    | `/dashboard/calibration`                    | List all per-repo calibration records                  |
| GET    | `/dashboard/calibration/:owner/:repo`       | Get calibration detail for a specific repo             |
| GET    | `/dashboard/repos/:owner/:repo`              | Get repo registry record (indexing status, context version) |
| POST   | `/dashboard/repos/:owner/:repo/reindex`      | Trigger repo re-indexing via EventBridge               |

### S3 — Analysis Results

Full LLM analysis stored at `executions/{executionId}/analysis.json` in `pullmint-analysis-results` bucket (SSE-S3, 90-day lifecycle, no public access).

EventBridge `analysis.complete` event is **lightweight** — payload is `{ riskScore, findingsCount, s3Key }`. `github-integration` fetches full findings from S3 using `s3Key`. Never put full findings arrays in EventBridge events (256KB hard limit enforced by size guard in `shared/eventbridge.ts`).

### Security Patterns

- **Prompt injection**: System prompt = instructions only; user message = PR data wrapped in `<pr_title>` / `<code_diff>` XML delimiters. Never mix LLM instructions with user-controlled content.
- **Auth fail-safe**: Missing `DASHBOARD_AUTH_TOKEN` → 503 deny-all (not 200 allow-all). Missing `DEPLOYMENT_WEBHOOK_AUTH_TOKEN` → Lambda startup throw. Auth misconfigurations must fail closed.
- **Response sanitization**: Deployment webhook response bodies truncated to 200 chars and credentials redacted before logging or storing in DynamoDB.

### Risk Scoring

LLM findings are scored: critical=30, high=15, medium=7, low=3, info=1 points each. Score is capped at 100.

- `< 30`: Auto-approve
- `< 40`: Auto-deploy to staging
- `≥ 40`: Manual review required

#### Risk Evaluator (`shared/risk-evaluator.ts`)

The `evaluateRisk` function computes a final score from four inputs: `llmBaseScore`, `signals[]`, `calibrationFactor`, `blastRadiusMultiplier`.

Formula: `score = min(100, round((llmBaseScore + signalDelta) × blastRadiusMultiplier × calibrationFactor))`

Signal deltas (additive): CI failed +15, coverage drop >10% +10, error rate >10% +20, latency spike >20% +10, Friday after 3pm +5.

Confidence = fraction of 6 expected signal types received (`ci.result`, `ci.coverage`, `author_history`, `production.error_rate`, `production.latency`, `time_of_day`).

#### Checkpoints

Four checkpoint types exist per execution: `analysis` (at PR review time), `pre-deploy` (before merge), `post-deploy-5` (5 min after deploy), `post-deploy-30` (30 min after deploy). Each checkpoint record stores score, confidence, missing signals, decision (`approved`/`held`/`rollback`), and reason.

#### Calibration

Per-repo calibration factor adjusts for repo-specific deployment history. Starts at 1.0, activates after ≥10 observations. Range: 0.5–2.0. Updated by `calibration-service` on `execution.confirmed` and `execution.rolled-back` events.

#### Blast Radius

`dependency-scanner` computes `blastRadiusMultiplier = min(3.0, Math.log(1 + downstreamCount))` based on how many org repos depend on the changed repo. Stored in the dependency graph table and on the execution record as `repoContext`.

## Testing

Tests use Jest + `aws-sdk-client-mock`. Mock DynamoDB/EventBridge/Secrets Manager clients in tests — never call real AWS in unit tests.

```typescript
const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());
```

Target: **≥ 80% code coverage** per service. Coverage thresholds vary — always check `jest.config.js` in the target service before adding code:

- `github-integration`: 100% branches/functions/lines/statements
- `deployment-orchestrator`: 91% branches, 100% functions/lines/statements
- `webhook-receiver`: 73% branches, 75% functions/lines/statements
- `shared`, `dashboard-api`, `architecture-agent`, `signal-ingestion`, `deployment-monitor`, `calibration-service`, `dependency-scanner`: 80% all metrics

Istanbul counts ternary operators as branch points — both sides must be covered when threshold is 100%.

Use `jest.resetAllMocks()` (not `jest.clearAllMocks()`) in `beforeEach` when any test in the suite calls `mockImplementation` — `clearAllMocks` only resets call history, not implementations, causing mock behavior to bleed into subsequent tests.

**Module-level constant isolation**: Lambda module-level constants (e.g. `LLM_RATE_LIMIT_TABLE`) are captured at `import()` time and cannot change after. Pattern: `process.env.VAR = 'value'` → `jest.resetModules()` → dynamic `await import('./handler')` → `delete process.env.VAR` immediately after. Each test needing a different value must re-import via a helper like `loadHandler()`.

## Code Conventions

- **Files**: kebab-case (`webhook-handler.ts`)
- **Classes/Interfaces**: PascalCase
- **Functions**: camelCase, async/await preferred over raw Promises
- **Constants**: UPPER_SNAKE_CASE
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`)

## Workflow Gotchas

- **Bash `cd` doesn't persist** between tool calls — always use absolute paths: `cd /Users/lokeshkaki/Desktop/Pullmint/services/<name> && npm run test:coverage`
- **Always run Prettier after edits from repo root**: `cd /Users/lokeshkaki/Desktop/Pullmint && npx prettier --check "services/file.ts"` — running from a subdirectory silently finds no files and reports success; CI format-check will still fail
- **CI test matrix**: All services under `services/` are in `.github/workflows/ci.yml` matrix — tests run on every PR. **Note:** `services/repo-indexer` is not yet in the CI matrix and should be added when its tests stabilize.
- **DynamoDB `result.Item` type safety**: `result.Item` from `GetCommand` is `Record<string, NativeAttributeValue>` where `NativeAttributeValue` is `any`. Always cast: `const item = result.Item as PRExecution` before accessing properties. Same pattern used throughout `dashboard-api/index.ts`. Never access `result.Item.fieldName` directly — triggers `@typescript-eslint/no-unsafe-assignment`.

## Public-Facing Content Guidelines

When editing `README.md` or any file in `docs/`:

- Focus on what the product does and its value to users
- Do not use language implying this is a portfolio/learning project
- No emojis in headings or bullet points
- Write as a production tool, not a resume item

See `.local/AI-INSTRUCTIONS.md` for full details.
