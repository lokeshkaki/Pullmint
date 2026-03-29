import { FlowProducer, Job } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import YAML from 'yaml';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES, getRedisConnection } from '@pullmint/shared/queue';
import { getConfig, getConfigOptional } from '@pullmint/shared/config';
import { getObject, putObject } from '@pullmint/shared/storage';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import {
  DEFAULT_CONFIG,
  pullmintConfigSchema,
  type PullmintConfig,
} from '@pullmint/shared/pullmint-config';
import { hashContent } from '@pullmint/shared/utils';
import { createStructuredError, retryWithBackoff } from '@pullmint/shared/error-handling';
import { publishExecutionUpdate } from '@pullmint/shared/execution-events';
import { buildAnalysisCheckpoint } from '../checkpoint';
import { filterDiff, getChangedFiles, getMaxDiffChars, parseDiff } from '../diff-filter';
import type { PREvent, Finding } from '@pullmint/shared/types';
import type { AgentResult } from './agent';
import type { SynthesisJobData } from './synthesis';

let flowProducer: FlowProducer | undefined;
const INCREMENTAL_THRESHOLD = parseFloat(process.env.INCREMENTAL_ANALYSIS_THRESHOLD || '0.5');
type OctokitClient = Awaited<ReturnType<typeof getGitHubInstallationClient>>;
type LogFn = (message: string) => void | Promise<unknown>;

function getAnalysisConfig() {
  return {
    analysisBucket: getConfig('ANALYSIS_RESULTS_BUCKET'),
    llmHourlyLimitPerRepo: parseInt(getConfigOptional('LLM_HOURLY_LIMIT_PER_REPO') ?? '10', 10),
    multiAgentMinDiffLines: parseInt(getConfigOptional('MULTI_AGENT_MIN_DIFF_LINES') ?? '200', 10),
  };
}

function getFlowProducer(): FlowProducer {
  if (!flowProducer) {
    // BullMQ may resolve a different ioredis package instance; bridge types safely.
    const connection = getRedisConnection() as unknown as ConnectionOptions;
    flowProducer = new FlowProducer({ connection });
  }
  return flowProducer;
}

export async function fetchRepoConfig(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  headSha: string,
  logWarning?: LogFn
): Promise<PullmintConfig> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.pullmint.yml',
      ref: headSha,
    });
    const data = response.data as { content?: string } | undefined;

    if (!data || typeof data.content !== 'string') {
      return DEFAULT_CONFIG;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const raw: unknown = YAML.parse(content);
    const result = pullmintConfigSchema.safeParse(raw);

    if (!result.success) {
      const issues = result.error.issues.map((issue) => issue.message).join(', ');
      await Promise.resolve(
        logWarning?.(`Warning: Invalid .pullmint.yml — ${issues}. Using defaults.`)
      );
      return DEFAULT_CONFIG;
    }

    return result.data;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
      return DEFAULT_CONFIG;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    await Promise.resolve(
      logWarning?.(`Warning: Failed to load .pullmint.yml — ${message}. Using defaults.`)
    );
    return DEFAULT_CONFIG;
  }
}

export async function processAnalysisJob(job: Job): Promise<void> {
  const prEvent = job.data as PREvent & { executionId: string };
  const db = getDb();
  const config = getAnalysisConfig();

  console.log(`Dispatching PR #${prEvent.prNumber} in ${prEvent.repoFullName}`);
  addTraceAnnotations({ executionId: prEvent.executionId, prNumber: prEvent.prNumber });

  try {
    // 1. Initialize GitHub client
    const octokitClient = await getGitHubInstallationClient(prEvent.repoFullName);

    const [owner, repo] = prEvent.repoFullName.split('/');
    const repoConfig = await fetchRepoConfig(
      octokitClient,
      owner,
      repo,
      prEvent.headSha,
      (message) => job.log?.(message)
    );

    await publishExecutionUpdate(prEvent.executionId, {
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ repoConfig })}::jsonb`,
    });

    // 2. Update execution status
    await publishExecutionUpdate(prEvent.executionId, { status: 'analyzing' });

    // 3. Fetch PR diff
    const diff = await retryWithBackoff(
      async () => {
        const response = await octokitClient.rest.pulls.get({
          owner,
          repo,
          pull_number: prEvent.prNumber,
          mediaType: { format: 'diff' },
        });
        if (typeof response.data !== 'string') {
          throw new Error('Expected diff response from GitHub');
        }
        return response.data;
      },
      { maxAttempts: 3, baseDelayMs: 1000 }
    );

    // 4. Assemble context (optional)
    let repoKnowledge: string | undefined;
    if (getConfigOptional('REPO_REGISTRY_TABLE_NAME')) {
      const changedFiles = extractChangedFiles(diff);
      if (changedFiles.length > 0) {
        // Context assembly would populate repoKnowledge here
      }
    }

    // 5. Check cache (multi-agent cache key)
    const cacheKey = hashContent(diff + '\n---version---\nmulti-agent-v1');
    const [cachedRow] = await db
      .select()
      .from(schema.llmCache)
      .where(eq(schema.llmCache.cacheKey, cacheKey))
      .limit(1);

    if (
      cachedRow &&
      cachedRow.findings &&
      cachedRow.riskScore !== null &&
      cachedRow.riskScore !== undefined
    ) {
      console.log('Cache hit — skipping multi-agent Flow');
      const findings = cachedRow.findings as Finding[];
      const riskScore = cachedRow.riskScore;

      // Build checkpoint for cached result
      const { checkpoint1, calibrationFactor } = await buildAnalysisCheckpoint(
        prEvent,
        riskScore,
        [owner, repo],
        octokitClient,
        db
      );

      // Update execution with cached results
      await publishExecutionUpdate(prEvent.executionId, {
        status: 'completed',
        findings: findings as unknown[],
        riskScore,
        checkpoints: [checkpoint1] as unknown as Record<string, unknown>,
        metadata: {
          cached: true,
          calibrationApplied: calibrationFactor,
        },
      });

      // Forward to github-integration
      await addJob(QUEUE_NAMES.GITHUB_INTEGRATION, 'analysis.complete', {
        ...prEvent,
        executionId: prEvent.executionId,
        riskScore,
        findingsCount: findings.length,
        s3Key: `executions/${prEvent.executionId}/analysis.json`,
      } as Record<string, unknown>);

      console.log(
        `Cache hit for PR #${prEvent.prNumber}: Risk=${riskScore}, Findings=${findings.length}`
      );
      return;
    }

    // 6. Per-repo rate limit check
    const withinLimit = await checkAndIncrementRateLimit(
      prEvent.repoFullName,
      config.llmHourlyLimitPerRepo
    );

    if (!withinLimit) {
      console.warn(
        `LLM rate limit exceeded for ${prEvent.repoFullName} — using placeholder result`
      );

      const { checkpoint1, calibrationFactor } = await buildAnalysisCheckpoint(
        prEvent,
        50,
        [owner, repo],
        octokitClient,
        db
      );

      await publishExecutionUpdate(prEvent.executionId, {
        status: 'completed',
        findings: [] as unknown[],
        riskScore: 50,
        checkpoints: [checkpoint1] as unknown as Record<string, unknown>,
        metadata: {
          cached: false,
          rateLimited: true,
          calibrationApplied: calibrationFactor,
        },
      });

      await addJob(QUEUE_NAMES.GITHUB_INTEGRATION, 'analysis.complete', {
        ...prEvent,
        executionId: prEvent.executionId,
        riskScore: 50,
        findingsCount: 0,
        s3Key: '',
      } as Record<string, unknown>);

      return;
    }

    // 7. Store diff in MinIO for agents to read
    const diffRef = `diffs/${prEvent.executionId}.diff`;
    await putObject(config.analysisBucket, diffRef, diff);

    // 8. Determine which agents to run (small diff optimization)
    const diffLineCount = diff.split('\n').length;
    const isSmallDiff = diffLineCount < config.multiAgentMinDiffLines;

    const agentTypes: Array<keyof PullmintConfig['agents']> = isSmallDiff
      ? ['architecture', 'security']
      : ['architecture', 'security', 'performance', 'style'];

    const configuredAgentTypes = agentTypes.filter((type) => repoConfig.agents[type] !== false);

    if (configuredAgentTypes.length === 0) {
      configuredAgentTypes.push('security');
    }

    const fullAgentTypes: Array<keyof PullmintConfig['agents']> = [...configuredAgentTypes];
    let priorAgentResults: Record<string, AgentResult> | null = null;
    let rerunAgentTypes: Array<keyof PullmintConfig['agents']> = [...configuredAgentTypes];
    let priorExecutionId: string | undefined;
    let isIncremental = false;

    if (job.name === 'pr.synchronize') {
      try {
        const inProgress = await db
          .select({ executionId: schema.executions.executionId })
          .from(schema.executions)
          .where(
            and(
              eq(schema.executions.repoFullName, prEvent.repoFullName),
              eq(schema.executions.prNumber, prEvent.prNumber),
              inArray(schema.executions.status, ['pending', 'analyzing']),
              ne(schema.executions.executionId, prEvent.executionId)
            )
          )
          .limit(1);

        if (inProgress.length === 0) {
          const priorRows = await db
            .select({
              executionId: schema.executions.executionId,
              s3Key: schema.executions.s3Key,
            })
            .from(schema.executions)
            .where(
              and(
                eq(schema.executions.repoFullName, prEvent.repoFullName),
                eq(schema.executions.prNumber, prEvent.prNumber),
                eq(schema.executions.status, 'completed'),
                ne(schema.executions.executionId, prEvent.executionId)
              )
            )
            .orderBy(desc(schema.executions.createdAt))
            .limit(1);

          const prior = priorRows[0];
          if (prior?.s3Key) {
            const analysisBucket =
              getConfigOptional('ANALYSIS_RESULTS_BUCKET') ?? 'pullmint-analysis';
            const priorResultsRaw = await getObject(analysisBucket, prior.s3Key);

            if (priorResultsRaw) {
              const priorData = JSON.parse(priorResultsRaw) as {
                findings?: Finding[];
                agentMeta?: Record<string, Record<string, unknown>>;
                agentResults?: Record<string, Record<string, unknown>>;
              };

              const priorDiffKey = `diffs/${prior.executionId}.diff`;
              const priorDiffRaw = await getObject(analysisBucket, priorDiffKey);

              if (priorDiffRaw) {
                const priorParsed = parseDiff(priorDiffRaw);
                const newParsed = parseDiff(diff);

                const delta = getChangedFiles(priorParsed, newParsed);
                const totalFiles = new Set([
                  ...priorParsed.files.map((file) => file.path),
                  ...newParsed.files.map((file) => file.path),
                ]).size;

                const changedCount =
                  delta.added.length + delta.removed.length + delta.modified.length;
                const deltaRatio = totalFiles > 0 ? changedCount / totalFiles : 1;

                if (deltaRatio <= INCREMENTAL_THRESHOLD && changedCount > 0) {
                  const changedFileSet = new Set([
                    ...delta.added,
                    ...delta.modified,
                    ...delta.removed,
                  ]);

                  const priorMeta = priorData.agentMeta ?? priorData.agentResults ?? {};
                  const priorFindings = Array.isArray(priorData.findings) ? priorData.findings : [];
                  const storedPriorResults: Record<string, AgentResult> = {};

                  for (const agentType of fullAgentTypes) {
                    const meta = priorMeta[agentType];
                    if (!meta) {
                      continue;
                    }

                    storedPriorResults[agentType] = {
                      agentType,
                      findings: priorFindings.filter((finding) => finding.type === agentType),
                      riskScore: typeof meta.riskScore === 'number' ? meta.riskScore : 50,
                      summary: typeof meta.summary === 'string' ? meta.summary : '',
                      model: typeof meta.model === 'string' ? meta.model : 'unknown',
                      tokens: typeof meta.tokens === 'number' ? meta.tokens : 0,
                      latencyMs: typeof meta.latencyMs === 'number' ? meta.latencyMs : 0,
                      status: meta.status === 'failed' ? 'failed' : 'completed',
                    };
                  }

                  const agentsToRerun: Array<keyof PullmintConfig['agents']> = [];
                  const carriedForward: Record<string, AgentResult> = {};

                  for (const agentType of fullAgentTypes) {
                    const maxChars = getMaxDiffChars(agentType);
                    const filtered = filterDiff(newParsed, agentType, maxChars);
                    const excludedSet = new Set(filtered.excludedFilePaths);
                    const agentFiles = newParsed.files
                      .map((file) => file.path)
                      .filter((path) => !excludedSet.has(path));

                    const hasChanges = agentFiles.some((filePath) => changedFileSet.has(filePath));
                    const priorResult = storedPriorResults[agentType];

                    if (hasChanges || !priorResult || priorResult.status === 'failed') {
                      agentsToRerun.push(agentType);
                    } else {
                      carriedForward[agentType] = priorResult;
                    }
                  }

                  if (agentsToRerun.length < fullAgentTypes.length) {
                    isIncremental = true;
                    priorAgentResults = carriedForward;
                    rerunAgentTypes = agentsToRerun;
                    priorExecutionId = prior.executionId;

                    await publishExecutionUpdate(prEvent.executionId, {
                      metadata: {
                        incremental: true,
                        rerunAgents: agentsToRerun,
                        carriedForwardAgents: Object.keys(carriedForward),
                        changedFiles: [...changedFileSet],
                        priorExecutionId: prior.executionId,
                      },
                    });

                    configuredAgentTypes.length = 0;
                    configuredAgentTypes.push(...agentsToRerun);
                  }
                }
              }
            }
          }
        }
      } catch {
        isIncremental = false;
        priorAgentResults = null;
        rerunAgentTypes = [...configuredAgentTypes];
      }
    }

    if (!isIncremental && job.name === 'pr.synchronize' && !priorExecutionId) {
      try {
        const priorRows = await db
          .select({ executionId: schema.executions.executionId })
          .from(schema.executions)
          .where(
            and(
              eq(schema.executions.repoFullName, prEvent.repoFullName),
              eq(schema.executions.prNumber, prEvent.prNumber),
              eq(schema.executions.status, 'completed'),
              ne(schema.executions.executionId, prEvent.executionId)
            )
          )
          .orderBy(desc(schema.executions.createdAt))
          .limit(1);
        priorExecutionId = priorRows[0]?.executionId;
      } catch {
        // Non-critical — lifecycle analysis will treat all findings as new.
      }
    }

    // 9. Create BullMQ Flow
    const childJobData = {
      executionId: prEvent.executionId,
      prEvent: {
        prNumber: prEvent.prNumber,
        repoFullName: prEvent.repoFullName,
        headSha: prEvent.headSha,
        baseSha: prEvent.baseSha,
        author: prEvent.author,
        title: prEvent.title,
        orgId: prEvent.orgId,
      },
      diffRef,
      repoKnowledge,
      userIgnorePaths: repoConfig.ignore_paths,
    };

    const builtInChildren = configuredAgentTypes.map((agentType) => ({
      name: agentType,
      queueName: QUEUE_NAMES.AGENT,
      data: { ...childJobData, agentType },
      opts: { failParentOnFailure: false },
    }));

    // Collect custom agents and build their children
    const customAgents = repoConfig.custom_agents ?? [];
    const customAgentChildren = customAgents.map((customAgent) => ({
      name: customAgent.name,
      queueName: QUEUE_NAMES.AGENT,
      data: {
        ...childJobData,
        agentType: customAgent.type,
        customAgentConfig: {
          prompt: customAgent.prompt,
          model: customAgent.model,
          includePaths: customAgent.include_paths,
          excludePaths: customAgent.exclude_paths,
          maxDiffChars: customAgent.max_diff_chars,
          severityFilter: customAgent.severity_filter,
        },
      },
      opts: { failParentOnFailure: false },
    }));

    const children = [...builtInChildren, ...customAgentChildren];

    // Collect custom agent weights for synthesizer
    const customAgentWeights: Record<string, number> = {};
    for (const customAgent of customAgents) {
      customAgentWeights[customAgent.type] = customAgent.weight;
    }
    const synthesizerData: SynthesisJobData = {
      executionId: prEvent.executionId,
      prEvent: childJobData.prEvent,
      diffRef,
      agentTypes: isIncremental
        ? [
            ...rerunAgentTypes,
            ...Object.keys(priorAgentResults ?? {}),
            ...customAgents.map((a) => a.type),
          ]
        : [...(fullAgentTypes as string[]), ...customAgents.map((a) => a.type)],
      cacheKey,
      customAgentWeights,
      priorExecutionId,
      ...(isIncremental && priorAgentResults
        ? {
            priorAgentResults,
            rerunAgentTypes,
          }
        : {}),
    };

    const producer = getFlowProducer();
    await producer.add({
      name: 'synthesize',
      queueName: QUEUE_NAMES.SYNTHESIS,
      data: synthesizerData,
      children,
    });

    console.log(
      `Dispatched ${configuredAgentTypes.length} built-in + ${customAgentChildren.length} custom agents ` +
        `for PR #${prEvent.prNumber} (${isSmallDiff ? 'small' : 'full'} diff, ${diffLineCount} lines)`
    );
  } catch (error) {
    const structuredError = createStructuredError(error, {
      context: 'analysis-dispatcher',
      prNumber: prEvent.prNumber,
      executionId: prEvent.executionId,
    });

    console.error('Error processing PR:', JSON.stringify(structuredError));

    try {
      await publishExecutionUpdate(prEvent.executionId, {
        status: 'failed',
        metadata: { error: structuredError.message },
      });
    } catch (updateError) {
      console.error('Failed to update execution status to failed:', {
        updateError,
        executionId: prEvent.executionId,
      });
    }

    throw error;
  }
}

async function checkAndIncrementRateLimit(
  repoFullName: string,
  hourlyLimit: number
): Promise<boolean> {
  const db = getDb();
  const hourBucket = Math.floor(Date.now() / 3600000).toString();
  const rateLimitKey = `${repoFullName}#${hourBucket}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

  const result = await db
    .insert(schema.llmRateLimits)
    .values({ id: rateLimitKey, counter: 1, expiresAt })
    .onConflictDoUpdate({
      target: schema.llmRateLimits.id,
      set: { counter: sql`${schema.llmRateLimits.counter} + 1` },
    })
    .returning({ counter: schema.llmRateLimits.counter });

  const currentCount = result[0]?.counter ?? 1;
  return currentCount <= hourlyLimit;
}

function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git a/')) {
      const match = /diff --git a\/.+ b\/(.+)/.exec(line);
      if (match) {
        files.push(match[1]);
      }
    }
  }
  return files;
}

export async function closeAnalysisFlowProducer(): Promise<void> {
  if (flowProducer) {
    await flowProducer.close();
    flowProducer = undefined;
  }
}
