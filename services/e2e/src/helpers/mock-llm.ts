// services/e2e/src/helpers/mock-llm.ts
import nock from 'nock';
import { CANNED_FINDINGS_BY_AGENT, CANNED_RISK_SCORES, CANNED_SUMMARY } from './fixtures';

/**
 * Intercepts all Anthropic API calls made during a test.
 * The agent processor reads `agentType` from job data and sends it as part of the system prompt.
 * We parse the request body to detect which agent is calling, then return the matching canned response.
 *
 * nock intercept is consumed once per call. For 4-agent tests, we register 4 interceptors.
 * For synthesis, we register 1 more (Haiku summary call).
 */
export function mockLLMForAgents(agentTypes: string[]): nock.Scope {
  const scope = nock('https://api.anthropic.com');

  for (const agentType of agentTypes) {
    const findings = CANNED_FINDINGS_BY_AGENT[agentType] ?? [];
    const riskScore = CANNED_RISK_SCORES[agentType] ?? 20;
    const responseText = JSON.stringify({
      findings,
      riskScore,
      summary: `${agentType} analysis complete`,
    });

    scope
      .post('/v1/messages', (body: Record<string, unknown>) => {
        // Match by checking the system prompt contains the agent type keyword
        // Each agent prompt includes its type name as context
        const system = (body.system as string) ?? '';
        return system.toLowerCase().includes(agentType);
      })
      .reply(200, {
        id: `msg_test_${agentType}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        model: 'claude-sonnet-4-6-20251001',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 100 },
      });
  }

  // Synthesis Haiku call — matches by model name (haiku) and does not match any agent keyword
  scope
    .post('/v1/messages', (body: Record<string, unknown>) => {
      return typeof body.model === 'string' && body.model.includes('haiku');
    })
    .reply(200, {
      id: 'msg_test_synthesis',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: CANNED_SUMMARY }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 50 },
    });

  return scope;
}

export function cleanupLLMMocks(): void {
  nock.cleanAll();
}
