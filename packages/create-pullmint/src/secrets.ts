import { randomBytes } from 'crypto';

export function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString('hex');
}

export function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

export function isValidAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

export function isValidOpenAIKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

export function isValidGoogleKey(key: string): boolean {
  return /^AIza[A-Za-z0-9_-]{35,}$/.test(key.trim());
}

export function validateApiKey(provider: string, key: string): string | true {
  const trimmed = key.trim();
  if (!trimmed) return 'API key cannot be empty.';

  if (provider === 'anthropic' && !isValidAnthropicKey(trimmed)) {
    return 'Anthropic API keys start with "sk-ant-". Check your key at https://console.anthropic.com';
  }

  if (provider === 'openai' && !isValidOpenAIKey(trimmed)) {
    return 'OpenAI API keys start with "sk-". Check your key at https://platform.openai.com';
  }

  if (provider === 'google' && !isValidGoogleKey(trimmed)) {
    return 'Google API keys start with "AIza". Check your key at https://aistudio.google.com';
  }

  return true;
}
