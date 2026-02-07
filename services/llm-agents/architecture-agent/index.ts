import { SQSHandler, SQSEvent } from 'aws-lambda';
import { Octokit } from '@octokit/rest';
import { getSecret } from '../../shared/secrets';
import { publishEvent } from '../../shared/eventbridge';
import { getItem, updateItem, putItem } from '../../shared/dynamodb';
import { hashContent } from '../../shared/utils';
import { PREvent, Finding, AnalysisResult } from '../../shared/types';

// Define OpenAI types since package may not be installed yet
type OpenAI = {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
      }) => Promise<{
        usage?: { total_tokens: number };
        choices: Array<{ message?: { content?: string } }>;
      }>;
    };
  };
};

const OpenAI = require('openai').default as new (config: { apiKey: string }) => OpenAI;

const OPENAI_API_KEY_ARN = process.env.OPENAI_API_KEY_ARN!;
const GITHUB_APP_PRIVATE_KEY_ARN = process.env.GITHUB_APP_PRIVATE_KEY_ARN!;
const CACHE_TABLE_NAME = process.env.CACHE_TABLE_NAME!;
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

let openaiClient: OpenAI;
let octokitClient: Octokit;

/**
 * Architecture Agent - Analyzes PR for architecture quality
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const eventData: { detail: PREvent & { executionId: string } } = JSON.parse(record.body);
      const prEvent = eventData.detail;

      console.log(`Processing PR #${prEvent.prNumber} in ${prEvent.repoFullName}`);

      // 1. Initialize clients
      if (!openaiClient) {
        const openaiApiKey = await getSecret(OPENAI_API_KEY_ARN);
        openaiClient = new OpenAI({ apiKey: openaiApiKey });
      }

      if (!octokitClient) {
        const githubToken = await getSecret(GITHUB_APP_PRIVATE_KEY_ARN);
        octokitClient = new Octokit({ auth: githubToken });
      }

      // 2. Update execution status
      await updateItem(EXECUTIONS_TABLE_NAME, { executionId: prEvent.executionId }, {
        status: 'analyzing',
        updatedAt: Date.now(),
      });

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
      const cached = await getItem<{ findings: Finding[]; riskScore: number }>(
        CACHE_TABLE_NAME,
        { cacheKey }
      );

      let findings: Finding[];
      let riskScore: number;
      let tokensUsed = 0;
      let processingStartTime = Date.now();

      if (cached) {
        console.log('Cache hit!');
        findings = cached.findings;
        riskScore = cached.riskScore;
      } else {
        // 5. Analyze with LLM
        const analysisPrompt = buildAnalysisPrompt(prEvent.title, diff);
        
        const completion = await openaiClient.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'You are an expert software architect reviewing code changes.',
            },
            {
              role: 'user',
              content: analysisPrompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        });

        tokensUsed = completion.usage?.total_tokens || 0;
        const analysisText = completion.choices[0]?.message?.content || '';

        // 6. Parse findings
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
      await updateItem(EXECUTIONS_TABLE_NAME, { executionId: prEvent.executionId }, {
        status: 'completed',
        findings,
        riskScore,
        updatedAt: Date.now(),
      });

      // 10. Publish completion event
      await publishEvent(
        EVENT_BUS_NAME,
        'pullmint.agent',
        'analysis.complete',
        {
          ...prEvent,
          ...result,
        }
      );

      console.log(
        `Analysis complete for PR #${prEvent.prNumber}: Risk=${riskScore}, Findings=${findings.length}`
      );
    } catch (error) {
      console.error('Error processing PR:', error);
      
      // Update execution with error
      const eventData: { detail: PREvent & { executionId: string } } = JSON.parse(record.body);
      await updateItem(EXECUTIONS_TABLE_NAME, { executionId: eventData.detail.executionId }, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        updatedAt: Date.now(),
      });

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
  const truncatedDiff = diff.length > maxDiffLength ? diff.substring(0, maxDiffLength) + '\n\n[... diff truncated ...]' : diff;

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
    const jsonMatch = analysisText.match(/\`\`\`(?:json)?\s*(\{[\s\S]*?\})\s*\`\`\`/);
    const jsonText = jsonMatch ? jsonMatch[1] : analysisText;
    
    const parsed = JSON.parse(jsonText);
    
    return {
      findings: parsed.findings || [],
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
