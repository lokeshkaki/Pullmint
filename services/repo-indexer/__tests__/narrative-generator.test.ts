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

  it('truncates entry point content exceeding 3000 chars', async () => {
    const longContent = 'x'.repeat(4000);
    mockAnthropicClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Summary' }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateModuleNarrative(mockAnthropicClient as any, {
      modulePath: 'src/big',
      entryPoint: 'src/big/index.ts',
      files: ['src/big/index.ts'],
      entryPointContent: longContent,
    });

    const callArg = mockAnthropicClient.messages.create.mock.calls[0][0] as {
      messages: { content: string }[];
    };
    expect(callArg.messages[0].content).toContain('// [truncated]');
    expect(callArg.messages[0].content).not.toContain('x'.repeat(4000));
  });

  it('returns fallback on empty LLM response', async () => {
    mockAnthropicClient.messages.create.mockResolvedValue({ content: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateModuleNarrative(mockAnthropicClient as any, {
      modulePath: 'src/empty',
      entryPoint: 'src/empty/index.ts',
      files: ['src/empty/index.ts', 'src/empty/util.ts'],
      entryPointContent: '',
    });

    expect(result).toBe('Module at src/empty containing 2 files.');
  });
});
