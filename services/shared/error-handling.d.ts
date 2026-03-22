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
export declare function isTransientError(error: unknown): boolean;
/**
 * Get error message from various error types
 */
export declare function getErrorMessage(error: unknown): string;
/**
 * Get error name/type from various error types
 */
export declare function getErrorName(error: unknown): string;
/**
 * Get error stack trace
 */
export declare function getErrorStack(error: unknown): string | undefined;
/**
 * Create structured error log
 */
export declare function createStructuredError(error: unknown, context?: Record<string, unknown>): StructuredError;
/**
 * Log structured error to CloudWatch
 */
export declare function logError(error: unknown, context?: Record<string, unknown>): void;
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
export declare function retryWithBackoff<T>(fn: () => Promise<T>, config?: Partial<RetryConfig>): Promise<T>;
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
type WithErrorHandlingOptions = {
    context?: Record<string, unknown>;
    retryConfig?: Partial<RetryConfig>;
    throwOnError?: boolean;
};
export declare function withErrorHandling<T>(fn: () => Promise<T>, options: WithErrorHandlingOptions & {
    throwOnError: true;
}): () => Promise<T>;
export declare function withErrorHandling<T>(fn: () => Promise<T>, options: WithErrorHandlingOptions & {
    throwOnError: false;
}): () => Promise<T | undefined>;
export declare function withErrorHandling<T>(fn: () => Promise<T>, options?: WithErrorHandlingOptions): () => Promise<T | undefined>;
export {};
//# sourceMappingURL=error-handling.d.ts.map