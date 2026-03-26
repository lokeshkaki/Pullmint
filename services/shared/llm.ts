import { getConfig, getConfigOptional } from './config';

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

type AnthropicMessageInput = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  temperature?: number;
};

type AnthropicMessageResponse = {
  content: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type AnthropicClient = {
  messages: {
    create: (input: AnthropicMessageInput) => Promise<AnthropicMessageResponse>;
  };
};

type AnthropicConstructor = new (options: { apiKey: string }) => AnthropicClient;

export class AnthropicProvider implements LLMProvider {
  private readonly client: AnthropicClient;

  constructor(apiKey: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const anthropicModule = require('@anthropic-ai/sdk') as { default: AnthropicConstructor };
    const Anthropic = anthropicModule.default;
    this.client = new Anthropic({ apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const params: AnthropicMessageInput = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userMessage }],
    };

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    const response = await this.client.messages.create(params);

    const text = response.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    return {
      text,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }
}

export function createLLMProvider(): LLMProvider {
  const provider = getConfigOptional('LLM_PROVIDER') ?? 'anthropic';

  switch (provider) {
    case 'anthropic': {
      const apiKey = getConfig('ANTHROPIC_API_KEY');
      return new AnthropicProvider(apiKey);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${provider}. Supported: anthropic`);
  }
}
