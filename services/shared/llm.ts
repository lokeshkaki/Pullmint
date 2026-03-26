import { getConfig, getConfigOptional } from './config';

// ─── Interfaces ───────────────────────────────────────────────────────────────

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

// ─── LLMProviderError ─────────────────────────────────────────────────────────

export class LLMProviderError extends Error {
  readonly provider: string;
  readonly statusCode: number | undefined;
  readonly isRetryable: boolean;

  constructor(options: {
    message: string;
    provider: string;
    statusCode?: number;
    isRetryable: boolean;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'LLMProviderError';
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.isRetryable = options.isRetryable;
    if (options.cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }
}

// ─── normalizeLLMError() ──────────────────────────────────────────────────────

function normalizeLLMError(provider: string, err: unknown): LLMProviderError {
  const message = err instanceof Error ? err.message : String(err);

  let statusCode: number | undefined;
  if (err != null && typeof err === 'object') {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj['status'] === 'number') {
      statusCode = errObj['status'];
    } else if (typeof errObj['statusCode'] === 'number') {
      statusCode = errObj['statusCode'];
    } else if (typeof errObj['code'] === 'number') {
      statusCode = errObj['code'];
    }
  }

  const retryableStatusCodes = new Set([429, 500, 502, 503, 504]);
  const nonRetryableStatusCodes = new Set([400, 401, 403, 404]);

  let isRetryable: boolean;
  if (statusCode !== undefined) {
    if (retryableStatusCodes.has(statusCode)) {
      isRetryable = true;
    } else if (nonRetryableStatusCodes.has(statusCode)) {
      isRetryable = false;
    } else {
      isRetryable = true;
    }
  } else {
    const lower = message.toLowerCase();
    isRetryable =
      lower.includes('rate limit') ||
      lower.includes('too many requests') ||
      lower.includes('econnreset') ||
      lower.includes('etimedout') ||
      lower.includes('socket hang up') ||
      lower.includes('unavailable') ||
      lower.includes('overloaded');
  }

  return new LLMProviderError({ message, provider, statusCode, isRetryable, cause: err });
}

// ─── Anthropic local type shims ───────────────────────────────────────────────

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

// ─── AnthropicProvider ────────────────────────────────────────────────────────

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

    let response: AnthropicMessageResponse;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      throw normalizeLLMError('anthropic', err);
    }

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

// ─── OpenAI local type shims ──────────────────────────────────────────────────

type OpenAIMessageParam = { role: 'system' | 'user'; content: string };

type OpenAICreateParams = {
  model: string;
  messages: OpenAIMessageParam[];
  max_tokens: number;
  temperature?: number;
};

type OpenAIMessageResponse = {
  choices: Array<{ message: { content: string | null } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
};

type OpenAIChatCompletions = {
  create(params: OpenAICreateParams): Promise<OpenAIMessageResponse>;
};

type OpenAIClient = { chat: { completions: OpenAIChatCompletions } };

type OpenAIConstructor = new (options: { apiKey: string; baseURL?: string }) => OpenAIClient;

// ─── OpenAIProvider ───────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAIClient;

  constructor(apiKey: string, baseURL?: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const openaiModule = require('openai') as { default: OpenAIConstructor };
    const OpenAI = openaiModule.default;
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages: OpenAIMessageParam[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userMessage },
    ];

    const params: OpenAICreateParams = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    let response: OpenAIMessageResponse;
    try {
      response = await this.client.chat.completions.create(params);
    } catch (err) {
      throw normalizeLLMError('openai', err);
    }

    return {
      text: response.choices[0]?.message.content ?? '',
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    };
  }
}

// ─── Google local type shims ──────────────────────────────────────────────────

type GoogleGenerationConfig = { maxOutputTokens: number; temperature?: number };

type GoogleContent = { role: 'user'; parts: Array<{ text: string }> };

type GoogleGenerateContentParams = {
  systemInstruction?: string;
  contents: GoogleContent[];
  generationConfig: GoogleGenerationConfig;
};

type GoogleUsageMetadata = { promptTokenCount: number; candidatesTokenCount: number };

type GoogleGenerateContentResponse = {
  candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  usageMetadata: GoogleUsageMetadata;
};

type GoogleGenerativeModel = {
  generateContent(params: GoogleGenerateContentParams): Promise<{
    response: GoogleGenerateContentResponse;
  }>;
};

type GoogleGenerativeAIConstructor = new (apiKey: string) => {
  getGenerativeModel(params: { model: string }): GoogleGenerativeModel;
};

// ─── GoogleProvider ───────────────────────────────────────────────────────────

export class GoogleProvider implements LLMProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GoogleGenerativeAI } = require('@google/generative-ai') as {
      GoogleGenerativeAI: GoogleGenerativeAIConstructor;
    };

    const genAI = new GoogleGenerativeAI(this.apiKey);
    const model = genAI.getGenerativeModel({ model: request.model });

    const generationConfig: GoogleGenerationConfig = { maxOutputTokens: request.maxTokens };
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }

    let result: { response: GoogleGenerateContentResponse };
    try {
      result = await model.generateContent({
        systemInstruction: request.systemPrompt,
        contents: [{ role: 'user', parts: [{ text: request.userMessage }] }],
        generationConfig,
      });
    } catch (err) {
      throw normalizeLLMError('google', err);
    }

    return {
      text: result.response.candidates[0]?.content.parts[0]?.text ?? '',
      inputTokens: result.response.usageMetadata.promptTokenCount,
      outputTokens: result.response.usageMetadata.candidatesTokenCount,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLLMProvider(): LLMProvider {
  const provider = getConfigOptional('LLM_PROVIDER') ?? 'anthropic';

  switch (provider) {
    case 'anthropic': {
      const apiKey = getConfig('ANTHROPIC_API_KEY');
      return new AnthropicProvider(apiKey);
    }
    case 'openai': {
      const apiKey = getConfig('OPENAI_API_KEY');
      const baseURL = getConfigOptional('OPENAI_BASE_URL');
      return new OpenAIProvider(apiKey, baseURL);
    }
    case 'google': {
      const apiKey = getConfig('GOOGLE_API_KEY');
      return new GoogleProvider(apiKey);
    }
    default:
      throw new Error(
        `Unsupported LLM provider: ${provider}. Supported: anthropic, openai, google`
      );
  }
}
