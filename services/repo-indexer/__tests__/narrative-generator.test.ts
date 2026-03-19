import { generateModuleNarrative } from '../narrative-generator';

const mockAnthropicClient = {
  messages: {
    create: jest.fn(),
  },
};

beforeEach(() => jest.resetAllMocks());

describe('generateModuleNarrative', () => {
  it('returns narrative text from Haiku response', async () => {
    mockAnthropicClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'This module handles authentication.' }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateModuleNarrative(mockAnthropicClient as any, {
      modulePath: 'src/auth',
      entryPoint: 'src/auth/index.ts',
      files: ['src/auth/index.ts', 'src/auth/middleware.ts'],
      entryPointContent: 'export function authenticate() {}',
    });

    expect(result).toBe('This module handles authentication.');
    expect(mockAnthropicClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.stringContaining('haiku'),
        max_tokens: 400,
      })
    );
  });

  it('returns a fallback string on LLM error', async () => {
    mockAnthropicClient.messages.create.mockRejectedValue(new Error('API error'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateModuleNarrative(mockAnthropicClient as any, {
      modulePath: 'src/auth',
      entryPoint: 'src/auth/index.ts',
      files: ['src/auth/index.ts'],
      entryPointContent: '',
    });

    expect(result).toContain('src/auth');
    expect(result.length).toBeGreaterThan(0);
  });
});
