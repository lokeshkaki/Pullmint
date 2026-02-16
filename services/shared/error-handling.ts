/**
 * Error Handling Utilities
 * 
 * Provides standardized error handling patterns for Lambda functions:
 * - Structured error logging
 * - Retry logic with exponential backoff
 * - Error classification (transient vs permanent)
 * - Consistent error responses
 */

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface StructuredError {
  message: string;
  severity: ErrorSeverity;
  errorType: string;
  context?: Record<string, unknown>;
  stack?: string;
  timestamp: string;
  retryable: boolean;
}

/**
 * Classify error as transient (retryable) or permanent
 */
export function isTransientError(error: unknown): boolean {
  const errorMessage = getErrorMessage(error);
  const errorName = getErrorName(error);

  // Network and timeout errors
  if (
    errorMessage.includes('ECONNRESET') ||
    errorMessage.includes('ETIMEDOUT') ||
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('socket hang up') ||
    errorMessage.includes('RequestTimeout') ||
    errorName === 'TimeoutError'
  ) {
    return true;
  }

  // AWS throttling errors
  if (
    errorName === 'ThrottlingException' ||
    errorName === 'ProvisionedThroughputExceededException' ||
    errorName === 'RequestLimitExceeded' ||
    errorName === 'TooManyRequestsException' ||
    errorMessage.includes('Rate exceeded')
  ) {
    return true;
  }

  // Service unavailability
  if (
    errorName === 'ServiceUnavailable' ||
    errorName === 'InternalServerError' ||
    errorMessage.includes('503') ||
    errorMessage.includes('502')
  ) {
    return true;
  }

  // Lock/conflict errors
  if (
    errorName === 'OptimisticLockException' ||
    errorName === 'ConditionalCheckFailedException' ||
    errorMessage.includes('Conflict')
  ) {
    return true;
  }

  return false;
}

/**
 * Get error message from various error types
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Unknown error';
}

/**
 * Get error name/type from various error types
 */
export function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  if (error && typeof error === 'object' && 'name' in error) {
    return String(error.name);
  }
  if (error && typeof error === 'object' && '__type' in error) {
    return String(error.__type);
  }
  return 'Error';
}

/**
 * Get error stack trace
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  return undefined;
}

/**
 * Create structured error log
 */
export function createStructuredError(
  error: unknown,
  context?: Record<string, unknown>
): StructuredError {
  const message = getErrorMessage(error);
  const errorType = getErrorName(error);
  const stack = getErrorStack(error);
  const retryable = isTransientError(error);

  // Determine severity based on error type
  let severity: ErrorSeverity = 'error';
  if (retryable) {
    severity = 'warning';
  } else if (
    errorType.includes('Fatal') ||
    errorType.includes('Critical') ||
    message.includes('FATAL')
  ) {
    severity = 'critical';
  }

  return {
    message,
    severity,
    errorType,
    context,
    stack,
    timestamp: new Date().toISOString(),
    retryable,
  };
}

/**
 * Log structured error to CloudWatch
 */
export function logError(error: unknown, context?: Record<string, unknown>): void {
  const structuredError = createStructuredError(error, context);
  console.error(JSON.stringify(structuredError));
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Calculate delay for exponential backoff
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  let delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);

  // Cap at max delay
  delay = Math.min(delay, config.maxDelayMs);

  // Add jitter to prevent thundering herd
  if (config.jitter) {
    delay = delay * (0.5 + Math.random() * 0.5);
  }

  return Math.floor(delay);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 * 
 * @param fn Function to retry
 * @param config Retry configuration
 * @returns Result of function or throws last error
 * 
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   async () => {
 *     return await anthropicClient.messages.create({ ... });
 *   },
 *   { maxAttempts: 3, baseDelayMs: 1000 }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if error is not transient
      if (!isTransientError(error)) {
        console.error('Non-transient error, not retrying:', getErrorMessage(error));
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === retryConfig.maxAttempts) {
        console.error(
          `Max retry attempts (${retryConfig.maxAttempts}) reached, giving up`
        );
        break;
      }

      const delay = calculateDelay(attempt, retryConfig);
      console.log(
        `Transient error on attempt ${attempt}/${retryConfig.maxAttempts}, retrying in ${delay}ms:`,
        getErrorMessage(error)
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Wrap async function with error handling and retry logic
 * 
 * @example
 * ```typescript
 * const safeFetchPR = withErrorHandling(
 *   async () => octokit.rest.pulls.get(...),
 *   { context: { prNumber: 123 }, retryConfig: { maxAttempts: 3 } }
 * );
 * const result = await safeFetchPR();
 * ```
 */
export function withErrorHandling<T>(
  fn: () => Promise<T>,
  options: {
    context?: Record<string, unknown>;
    retryConfig?: Partial<RetryConfig>;
    throwOnError?: boolean;
  } = {}
): () => Promise<T> {
  return async () => {
    try {
      if (options.retryConfig) {
        return await retryWithBackoff(fn, options.retryConfig);
      }
      return await fn();
    } catch (error) {
      logError(error, options.context);
      if (options.throwOnError !== false) {
        throw error;
      }
      throw error;
    }
  };
}
