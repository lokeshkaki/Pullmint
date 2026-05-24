export interface PullmintMcpConfig {
  apiUrl: string;
  authToken: string;
  requestTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PullmintMcpConfig {
  const apiUrlValue = env.PULLMINT_API_URL?.trim();
  if (!apiUrlValue) {
    throw new Error('PULLMINT_API_URL is required');
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(apiUrlValue);
  } catch {
    throw new Error('PULLMINT_API_URL must be an http or https URL');
  }
  if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
    throw new Error('PULLMINT_API_URL must be an http or https URL');
  }

  const authToken = env.PULLMINT_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error('PULLMINT_AUTH_TOKEN is required');
  }

  const timeoutRaw = env.PULLMINT_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('PULLMINT_REQUEST_TIMEOUT_MS must be a positive integer');
  }

  return {
    apiUrl: apiUrl.toString().replace(/\/$/, ''),
    authToken,
    requestTimeoutMs,
  };
}
