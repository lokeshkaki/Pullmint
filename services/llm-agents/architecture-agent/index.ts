import { SQSHandler, SQSEvent } from 'aws-lambda';
import { Octokit } from '@octokit/rest';
import { getSecret } from '../../shared/secrets';
import { publishEvent } from '../../shared/eventbridge';
import { getItem, updateItem, putItem } from '../../shared/dynamodb';
import { hashContent } from '../../shared/utils';
import { PREvent, Finding, AnalysisResult } from '../../shared/types';

// Dynamic import for Anthropic to avoid deployment issues
// Using any for the constructor to avoid type-checking issues with dynamic imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Anthropic: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let anthropicClient: any;
let octokitClient: Octokit | undefined;

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
const GITHUB_APP_PRIVATE_KEY_ARN = process.env.GITHUB_APP_PRIVATE_KEY_ARN!;
const CACHE_TABLE_NAME = process.env.CACHE_TABLE_NAME!;
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

/**
 * Architecture Agent - Analyzes PR for architecture quality
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const eventData: { detail: PREvent & { executionId: string } } = JSON.parse(record.body);
      const prEvent = eventData.detail;

      console.log(`Processing PR #${prEvent.prNumber} in ${prEvent.repoFullName}`);

      // 1. Initialize clients
      if (!anthropicClient) {
        if (!Anthropic) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          Anthropic = require('@anthropic-ai/sdk').default;
        }
        const anthropicApiKey = await getSecret(ANTHROPIC_API_KEY_ARN);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
      }

      if (!octokitClient) {
        const githubToken = await getSecret(GITHUB_APP_PRIVATE_KEY_ARN);
        octokitClient = new Octokit({ auth: githubToken });
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

      // 3. Fetch PR diff
      const [owner, repo] = prEvent.repoFullName.split('/');
      const response = await octokitClient.rest.pulls.get({
        owner,
        repo,
        pull_number: prEvent.prNumber,
        mediaType: { format: 'diff' },
      });
      const diff = response.data as unknown as string;

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
        // 5. Analyze with LLM
        const analysisPrompt = buildAnalysisPrompt(prEvent.title, diff);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const completion = (await anthropicClient.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2000,
          messages: [
            {
              role: 'user',
              content: `You are an expert software architect reviewing code changes.\n\n${analysisPrompt}`,
            },
          ],
          temperature: 0.3,
        })) as AnthropicMessageResponse;

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
      console.error('Error processing PR:', error);

      // Update execution with error
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const eventData: { detail: PREvent & { executionId: string } } = JSON.parse(record.body);
      await updateItem(
        EXECUTIONS_TABLE_NAME,
        { executionId: eventData.detail.executionId },
        {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
          updatedAt: Date.now(),
        }
      );

      throw error; // Let SQS retry
    }
  }
};

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
