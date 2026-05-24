# Pullmint MCP

Local stdio MCP server for inspecting and operating a self-hosted Pullmint instance from Codex CLI
or Claude Code.

## Requirements

- A running self-hosted Pullmint API.
- `DASHBOARD_AUTH_TOKEN` configured on the API.
- The same token available locally as `PULLMINT_AUTH_TOKEN`.
- Node.js 20 or later.

## Build

```bash
npm install
npm --workspace @pullmint/mcp run build
```

## Environment

| Variable                      | Required | Purpose                                                    |
| ----------------------------- | -------- | ---------------------------------------------------------- |
| `PULLMINT_API_URL`            | Yes      | Self-hosted API base URL, such as `http://localhost:3000`. |
| `PULLMINT_AUTH_TOKEN`         | Yes      | Bearer token matching `DASHBOARD_AUTH_TOKEN`.              |
| `PULLMINT_REQUEST_TIMEOUT_MS` | No       | HTTP timeout in milliseconds; defaults to `10000`.         |

Do not commit token values or include them in repository documentation.

## Codex CLI

```bash
codex mcp add pullmint \
  --env PULLMINT_API_URL=http://localhost:3000 \
  --env PULLMINT_AUTH_TOKEN="$DASHBOARD_AUTH_TOKEN" \
  -- node "$PWD/packages/pullmint-mcp/dist/index.js"
```

## Claude Code

```bash
claude mcp add --scope local \
  -e PULLMINT_API_URL=http://localhost:3000 \
  -e PULLMINT_AUTH_TOKEN="$DASHBOARD_AUTH_TOKEN" \
  pullmint -- node "$PWD/packages/pullmint-mcp/dist/index.js"
```

## Tools

The read-only tools are `pullmint_list_pr_analyses`, `pullmint_get_analysis`,
`pullmint_get_analysis_evidence`, and `pullmint_get_repo_calibration`.

`pullmint_record_re_evaluation` records a justification note on an existing execution. It does not
run analysis or create new findings.

`pullmint_trigger_analysis` queues a new full analysis run. It can incur provider cost, post a
GitHub review, and proceed through configured deployment gating. Invoke it only when those effects
are intended.

## Smoke Check

1. Start the API and workers with a repository installed for the GitHub App.
2. Call `pullmint_list_pr_analyses` for a known pull request.
3. Call `pullmint_get_analysis` and `pullmint_get_analysis_evidence` for a returned execution.
4. Call `pullmint_record_re_evaluation` only when recording a note is intended.
5. Call `pullmint_trigger_analysis` only for an open pull request where cost, review output, and
   deployment-gating effects are acceptable.
