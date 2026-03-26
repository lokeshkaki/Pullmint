// Mocks must be declared before jest.mock() hoisting
let mockAnthropicCreate: jest.Mock;
let mockOpenAICreate: jest.Mock;
let mockGoogleGenerateContent: jest.Mock;

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: (...args: unknown[]) => mockAnthropicCreate(...args),
    },
  })),
}));

jest.mock('openai', () => ({
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockOpenAICreate(...args),
      },
    },
  })),
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: (...args: unknown[]) => mockGoogleGenerateContent(...args),
    }),
  })),
}));

jest.mock('../config', () => ({
  getConfig: jest.fn((key: string) => {
    const secrets: Record<string, string> = {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      OPENAI_API_KEY: 'test-openai-key',
      GOOGLE_API_KEY: 'test-google-key',
    };
    if (key in secrets) return secrets[key];
    throw new Error(`Missing config: ${key}`);
  }),
  getConfigOptional: jest.fn((key: string) => {
    if (key === 'LLM_PROVIDER') return undefined;
    if (key === 'OPENAI_BASE_URL') return undefined;
    return undefined;
  }),
}));

import {
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
  LLMProviderError,
  createLLMProvider,
} from '../llm';
import type { ChatRequest } from '../llm';
import { getConfigOptional } from '../config';

const BASE_REQUEST: ChatRequest = {
  model: 'test-model',
  systemPrompt: 'You are a helpful assistant.',
  userMessage: 'Analyze this diff.',
  maxTokens: 1000,
};

describe('createLLMProvider()', () => {
  const mockGetConfigOptional = getConfigOptional as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns AnthropicProvider when LLM_PROVIDER is unset (default)', () => {
    mockGetConfigOptional.mockReturnValue(undefined);
    const provider = createLLMProvider();
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('returns AnthropicProvider when LLM_PROVIDER=anthropic', () => {
    mockGetConfigOptional.mockImplementation((key: string) =>
      key === 'LLM_PROVIDER' ? 'anthropic' : undefined
    );
    const provider = createLLMProvider();
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('returns OpenAIProvider when LLM_PROVIDER=openai', () => {
    mockGetConfigOptional.mockImplementation((key: string) =>
      key === 'LLM_PROVIDER' ? 'openai' : undefined
    );
    const provider = createLLMProvider();
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('returns GoogleProvider when LLM_PROVIDER=google', () => {
    mockGetConfigOptional.mockImplementation((key: string) =>
      key === 'LLM_PROVIDER' ? 'google' : undefined
    );
    const provider = createLLMProvider();
    expect(provider).toBeInstanceOf(GoogleProvider);
  });

  it('throws for an unsupported LLM_PROVIDER value', () => {
    mockGetConfigOptional.mockImplementation((key: string) =>
      key === 'LLM_PROVIDER' ? 'cohere' : undefined
    );
    expect(() => createLLMProvider()).toThrow(/unsupported llm provider/i);
  });
});

describe('AnthropicProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnthropicCreate = jest.fn();
  });

  it('maps ChatRequest to Anthropic Messages API format', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Result text' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const provider = new AnthropicProvider('test-key');
    const response = await provider.chat({ ...BASE_REQUEST, temperature: 0.5 });

    expect(mockAnthropicCreate).toHaveBeenCalledWith({
      model: 'test-model',
      max_tokens: 1000,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Analyze this diff.' }],
      temperature: 0.5,
    });
    expect(response.text).toBe('Result text');
    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(50);
  });

  it('omits temperature when not provided', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider('test-key');
    await provider.chat(BASE_REQUEST);

    const callArg = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('temperature');
  });

  it('concatenates multiple text content blocks', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'text', text: 'Part two.' },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    });

    const provider = new AnthropicProvider('test-key');
    const response = await provider.chat(BASE_REQUEST);
    expect(response.text).toBe('Part one. Part two.');
  });

  it('defaults token counts to 0 when usage is missing', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: undefined,
    });

    const provider = new AnthropicProvider('test-key');
    const response = await provider.chat(BASE_REQUEST);
    expect(response.inputTokens).toBe(0);
    expect(response.outputTokens).toBe(0);
  });

  it('wraps SDK errors in LLMProviderError', async () => {
    const sdkError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    mockAnthropicCreate.mockRejectedValue(sdkError);

    const provider = new AnthropicProvider('test-key');
    await expect(provider.chat(BASE_REQUEST)).rejects.toBeInstanceOf(LLMProviderError);

    let caughtError: LLMProviderError | undefined;
    try {
      await provider.chat(BASE_REQUEST);
    } catch (err) {
      caughtError = err as LLMProviderError;
    }
    expect(caughtError?.provider).toBe('anthropic');
    expect(caughtError?.statusCode).toBe(429);
    expect(caughtError?.isRetryable).toBe(true);
  });
});

describe('OpenAIProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenAICreate = jest.fn();
  });

  it('maps ChatRequest to OpenAI Chat Completions format', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'OpenAI result' } }],
      usage: { prompt_tokens: 80, completion_tokens: 40 },
    });

    const provider = new OpenAIProvider('test-key');
    const response = await provider.chat({ ...BASE_REQUEST, temperature: 0.3 });

    expect(mockOpenAICreate).toHaveBeenCalledWith({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Analyze this diff.' },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });
    expect(response.text).toBe('OpenAI result');
    expect(response.inputTokens).toBe(80);
    expect(response.outputTokens).toBe(40);
  });

  it('omits temperature when not provided', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const provider = new OpenAIProvider('test-key');
    await provider.chat(BASE_REQUEST);

    const callArg = mockOpenAICreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('temperature');
  });

  it('returns empty string when choices[0] content is null', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });

    const provider = new OpenAIProvider('test-key');
    const response = await provider.chat(BASE_REQUEST);
    expect(response.text).toBe('');
  });

  it('passes baseURL to the OpenAI constructor when provided', () => {
    const OpenAI = (jest.requireMock('openai') as { default: jest.Mock }).default;
    new OpenAIProvider('test-key', 'http://localhost:11434/v1');
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'http://localhost:11434/v1',
    });
  });

  it('does not pass baseURL when undefined', () => {
    const OpenAI = (jest.requireMock('openai') as { default: jest.Mock }).default;
    OpenAI.mockClear();
    new OpenAIProvider('test-key');
    const callArg = OpenAI.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('baseURL');
  });

  it('wraps SDK errors in LLMProviderError with isRetryable=true for 429', async () => {
    const sdkError = Object.assign(new Error('Rate limit'), { status: 429 });
    mockOpenAICreate.mockRejectedValue(sdkError);

    const provider = new OpenAIProvider('test-key');
    let caughtError: LLMProviderError | undefined;
    try {
      await provider.chat(BASE_REQUEST);
    } catch (err) {
      caughtError = err as LLMProviderError;
    }
    expect(caughtError).toBeInstanceOf(LLMProviderError);
    expect(caughtError?.provider).toBe('openai');
    expect(caughtError?.statusCode).toBe(429);
    expect(caughtError?.isRetryable).toBe(true);
  });

  it('wraps SDK errors in LLMProviderError with isRetryable=false for 401', async () => {
    const sdkError = Object.assign(new Error('Invalid API key'), { status: 401 });
    mockOpenAICreate.mockRejectedValue(sdkError);

    const provider = new OpenAIProvider('test-key');
    let caughtError: LLMProviderError | undefined;
    try {
      await provider.chat(BASE_REQUEST);
    } catch (err) {
      caughtError = err as LLMProviderError;
    }
    expect(caughtError?.isRetryable).toBe(false);
    expect(caughtError?.statusCode).toBe(401);
  });
});

describe('GoogleProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGoogleGenerateContent = jest.fn();
  });

  it('maps ChatRequest to Gemini generateContent format', async () => {
    mockGoogleGenerateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: 'Gemini result' }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 },
      },
    });

    const provider = new GoogleProvider('test-key');
    const response = await provider.chat({ ...BASE_REQUEST, temperature: 0.4 });

    expect(mockGoogleGenerateContent).toHaveBeenCalledWith({
      systemInstruction: 'You are a helpful assistant.',
      contents: [{ role: 'user', parts: [{ text: 'Analyze this diff.' }] }],
      generationConfig: { maxOutputTokens: 1000, temperature: 0.4 },
    });
    expect(response.text).toBe('Gemini result');
    expect(response.inputTokens).toBe(120);
    expect(response.outputTokens).toBe(60);
  });

  it('omits temperature in generationConfig when not provided', async () => {
    mockGoogleGenerateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: '' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    const provider = new GoogleProvider('test-key');
    await provider.chat(BASE_REQUEST);

    const callArg = mockGoogleGenerateContent.mock.calls[0][0] as {
      generationConfig: Record<string, unknown>;
    };
    expect(callArg.generationConfig).not.toHaveProperty('temperature');
  });

  it('returns empty string when candidates is empty', async () => {
    mockGoogleGenerateContent.mockResolvedValue({
      response: {
        candidates: [],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
      },
    });

    const provider = new GoogleProvider('test-key');
    const response = await provider.chat(BASE_REQUEST);
    expect(response.text).toBe('');
  });

  it('wraps SDK errors in LLMProviderError', async () => {
    const sdkError = Object.assign(new Error('Model not found'), { status: 404 });
    mockGoogleGenerateContent.mockRejectedValue(sdkError);

    const provider = new GoogleProvider('test-key');
    let caughtError: LLMProviderError | undefined;
    try {
      await provider.chat(BASE_REQUEST);
    } catch (err) {
      caughtError = err as LLMProviderError;
    }
    expect(caughtError).toBeInstanceOf(LLMProviderError);
    expect(caughtError?.provider).toBe('google');
    expect(caughtError?.statusCode).toBe(404);
    expect(caughtError?.isRetryable).toBe(false);
  });
});

describe('LLMProviderError', () => {
  it('exposes provider, statusCode, and isRetryable', () => {
    const err = new LLMProviderError({
      message: 'test error',
      provider: 'openai',
      statusCode: 503,
      isRetryable: true,
    });
    expect(err.name).toBe('LLMProviderError');
    expect(err.message).toBe('test error');
    expect(err.provider).toBe('openai');
    expect(err.statusCode).toBe(503);
    expect(err.isRetryable).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });

  it('works without optional statusCode', () => {
    const err = new LLMProviderError({
      message: 'no status',
      provider: 'google',
      isRetryable: false,
    });
    expect(err.statusCode).toBeUndefined();
  });

  it('appends cause stack when cause is an Error', () => {
    const cause = new Error('original cause');
    const err = new LLMProviderError({
      message: 'wrapped',
      provider: 'anthropic',
      isRetryable: true,
      cause,
    });
    expect(err.stack).toContain('Caused by:');
    expect(err.stack).toContain('original cause');
  });
});
