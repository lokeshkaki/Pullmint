import { SQSHandler, SQSEvent } from 'aws-lambda';
import { getSecret } from '../../shared/secrets';
import { publishEvent } from '../../shared/eventbridge';
import { getItem, updateItem, putItem } from '../../shared/dynamodb';
import { hashContent } from '../../shared/utils';
import { getGitHubInstallationClient } from '../../shared/github-app';
import { createStructuredError, retryWithBackoff } from '../../shared/error-handling';
import { PREvent, Finding, AnalysisResult } from '../../shared/types';

type AnthropicMessageInput = {
  model: string;
  max_tokens: number;
  messages: { role: 'user'; content: string }[];
  temperature?: number;
};

type AnthropicClient = {
  messages: {
    create: (input: AnthropicMessageInput) => Promise<AnthropicMessageResponse>;
  };
};

type AnthropicConstructor = new (options: { apiKey: string }) => AnthropicClient;

// Dynamic import for Anthropic to avoid deployment issues
let Anthropic: AnthropicConstructor | undefined;
let anthropicClient: AnthropicClient | undefined;
let octokitClient: Awaited<ReturnType<typeof getGitHubInstallationClient>> | undefined;

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicMessageResponse = {
  content: AnthropicContentBlock[];
  usage?: AnthropicUsage;
};

const ANTHROPIC_API_KEY_ARN = process.env.ANTHROPIC_API_KEY_ARN!;
const CACHE_TABLE_NAME = process.env.CACHE_TABLE_NAME!;
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

type PREventEnvelope = { detail: PREvent & { executionId: string } };

/**
 * Architecture Agent - Analyzes PR for architecture quality
 *
 * Features:
 * - LLM-powered code analysis with Claude Sonnet 4.5
 * - Automatic retry with exponential backoff for transient failures
 * - Structured error logging and DLQ support via SQS configuration
 * - Intelligent caching to reduce API costs
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const eventData = parseEvent(record.body);
      const prEvent = eventData.detail;

      console.log(`Processing PR #${prEvent.prNumber} in ${prEvent.repoFullName}`);

      // 1. Initialize clients
      if (!anthropicClient) {
        if (!Anthropic) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const anthropicModule = require('@anthropic-ai/sdk') as { default: AnthropicConstructor };
          Anthropic = anthropicModule.default;
        }
        const anthropicApiKey = await getSecret(ANTHROPIC_API_KEY_ARN);
        anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
      }

      if (!octokitClient) {
        octokitClient = await getGitHubInstallationClient(prEvent.repoFullName);
      }

      // 2. Update execution status
      await updateItem(
        EXECUTIONS_TABLE_NAME,
        { executionId: prEvent.executionId },
        {
          status: 'analyzing',
          updatedAt: Date.now(),
        }
      );

      // 3. Fetch PR diff with retry logic for transient failures
      const [owner, repo] = prEvent.repoFullName.split('/');
      const diff = await retryWithBackoff(
        async () => {
          const response = await octokitClient!.rest.pulls.get({
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

      // 4. Check cache
      const cacheKey = hashContent(diff);
      const cached = await getItem<{ findings: Finding[]; riskScore: number }>(CACHE_TABLE_NAME, {
        cacheKey,
      });

      let findings: Finding[];
      let riskScore: number;
      let tokensUsed = 0;
      const processingStartTime = Date.now();

      if (cached) {
        console.log('Cache hit!');
        findings = cached.findings;
        riskScore = cached.riskScore;
      } else {
        // 5. Analyze with LLM with retry logic for transient failures
        const analysisPrompt = buildAnalysisPrompt(prEvent.title, diff);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const completion = await retryWithBackoff(
          async () => {
            return await anthropicClient!.messages.create({
              model: 'claude-sonnet-4-5-20250929',
              max_tokens: 2000,
              messages: [
                {
                  role: 'user',
                  content: `You are an expert software architect reviewing code changes.\n\n${analysisPrompt}`,
                },
              ],
              temperature: 0.3,
            });
          },
          { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000 }
        );

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        tokensUsed = (completion.usage?.input_tokens || 0) + (completion.usage?.output_tokens || 0);
        const analysisText = completion.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('');

        // 6. Parse findings
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const analysis = parseAnalysis(analysisText);
        findings = analysis.findings;
        riskScore = analysis.riskScore;

        // 7. Cache results
        await putItem(CACHE_TABLE_NAME, {
          cacheKey,
          findings,
          riskScore,
          ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
        });
      }

      const processingTime = Date.now() - processingStartTime;

      // 8. Create analysis result
      const result: AnalysisResult = {
        executionId: prEvent.executionId,
        agentType: 'architecture',
        findings,
        riskScore,
        metadata: {
          processingTime,
          tokensUsed,
          cached: !!cached,
        },
      };

      // 9. Update execution with findings
      await updateItem(
        EXECUTIONS_TABLE_NAME,
        { executionId: prEvent.executionId },
        {
          status: 'completed',
          findings,
          riskScore,
          updatedAt: Date.now(),
        }
      );

      // 10. Publish completion event
      await publishEvent(EVENT_BUS_NAME, 'pullmint.agent', 'analysis.complete', {
        ...prEvent,
        ...result,
      });

      console.log(
        `Analysis complete for PR #${prEvent.prNumber}: Risk=${riskScore}, Findings=${findings.length}`
      );
    } catch (error) {
      // Structured error logging for CloudWatch
      let prNumber: number | undefined;
      let executionId: string | undefined;

      try {
        const eventData = parseEvent(record.body);
        prNumber = eventData.detail.prNumber;
        executionId = eventData.detail.executionId;
      } catch {
        // Unable to parse event data, continue without context
      }

      const structuredError = createStructuredError(
        error instanceof Error ? error : new Error('Unknown error'),
        {
          context: 'architecture-agent',
          prNumber,
          executionId,
        }
      );

      console.error('Error processing PR:', JSON.stringify(structuredError));

      // Update execution with error
      const eventData = parseEvent(record.body);
      await updateItem(
        EXECUTIONS_TABLE_NAME,
        { executionId: eventData.detail.executionId },
        {
          status: 'failed',
          error: structuredError.message,
          updatedAt: Date.now(),
        }
      );

      // Always throw to let SQS handle retry logic and DLQ
      throw error;
    }
  }
};

function parseEvent(body: string): PREventEnvelope {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || !('detail' in parsed)) {
    throw new Error('Invalid PR event payload');
  }

  return parsed as PREventEnvelope;
}

/**
 * Build the analysis prompt for the LLM
 */
function buildAnalysisPrompt(title: string, diff: string): string {
  // Truncate diff if too large (to stay within token limits)
  const maxDiffLength = 8000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? diff.substring(0, maxDiffLength) + '\n\n[... diff truncated ...]'
      : diff;

  return `Analyze this pull request for architecture quality and potential issues.

PR Title: ${title}

Code Changes:
\`\`\`diff
${truncatedDiff}
\`\`\`

Provide your analysis in the following JSON format:
{
  "findings": [
    {
      "type": "architecture|security|performance|style",
      "severity": "critical|high|medium|low|info",
      "title": "Brief title",
      "description": "Detailed description",
      "suggestion": "How to fix it"
    }
  ],
  "riskScore": 0-100,
  "summary": "Brief summary of overall quality"
}

Focus on:
1. Architecture patterns and design principles
2. Code organization and modularity
3. Potential design issues or anti-patterns
4. Scalability concerns
5. Maintainability issues

Respond ONLY with the JSON, no additional text.`;
}

/**
 * Parse LLM response into structured findings
 */
function parseAnalysis(analysisText: string): { findings: Finding[]; riskScore: number } {
  try {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = analysisText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const jsonText = jsonMatch ? jsonMatch[1] : analysisText;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed = JSON.parse(jsonText);

    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      findings: parsed.findings || [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      riskScore: parsed.riskScore || 0,
    };
  } catch (error) {
    console.error('Failed to parse LLM response:', error);
    console.error('Response text:', analysisText);

    // Return safe defaults
    return {
      findings: [
        {
          type: 'architecture',
          severity: 'info',
          title: 'Analysis parsing failed',
          description: 'Could not parse LLM response. Manual review recommended.',
          suggestion: 'Review the changes manually',
        },
      ],
      riskScore: 50,
    };
  }
}
