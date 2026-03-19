// Keep in sync with SMALL_DIFF_MODEL in architecture-agent/index.ts
const NARRATIVE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_ENTRY_POINT_CHARS = 3000;

interface AnthropicClient {
  messages: {
    create: (input: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
    }) => Promise<{ content: Array<{ type?: string; text?: string }> }>;
  };
}

export interface NarrativeInput {
  modulePath: string;
  entryPoint: string;
  files: string[];
  entryPointContent: string;
}

/**
 * Generate a 150-200 word architecture narrative for a module using Claude Haiku.
 * Falls back to a minimal description on LLM error.
 */
export async function generateModuleNarrative(
  client: AnthropicClient,
  input: NarrativeInput
): Promise<string> {
  const truncatedContent =
    input.entryPointContent.length > MAX_ENTRY_POINT_CHARS
      ? input.entryPointContent.substring(0, MAX_ENTRY_POINT_CHARS) + '\n// [truncated]'
      : input.entryPointContent;

  const userMessage = `Module path: ${input.modulePath}
Files: ${input.files.join(', ')}

Entry point content:
\`\`\`
${truncatedContent}
\`\`\`

Write a concise architecture narrative (150-200 words) covering: purpose, key responsibilities, known risk areas, and what breaks when this module changes.`;

  try {
    const response = await client.messages.create({
      model: NARRATIVE_MODEL,
      max_tokens: 400,
      system:
        'You are a senior software architect writing codebase documentation. Write concise, factual architecture narratives. Do not use bullet points. Write in prose.',
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join('');

    return text.trim() || `Module at ${input.modulePath} containing ${input.files.length} files.`;
  } catch {
    return `Module at ${input.modulePath} containing ${input.files.length} files: ${input.files.join(', ')}.`;
  }
}
