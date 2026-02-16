import {
  isTransientError,
  getErrorMessage,
  getErrorName,
  createStructuredError,
  retryWithBackoff,
} from '../error-handling';

describe('Error Handling Utilities', () => {
  describe('isTransientError', () => {
    it('should identify network errors as transient', () => {
      const networkError = new Error('ECONNRESET');
      expect(isTransientError(networkError)).toBe(true);

      const timeoutError = new Error('ETIMEDOUT');
      expect(isTransientError(timeoutError)).toBe(true);

      const socketError = new Error('socket hang up');
      expect(isTransientError(socketError)).toBe(true);
    });

    it('should identify throttling errors as transient', () => {
      const throttleError = {
        name: 'ThrottlingException',
        message: 'Rate exceeded',
      };
      expect(isTransientError(throttleError)).toBe(true);

      const limitError = {
        name: 'TooManyRequestsException',
        message: 'Too many requests',
      };
      expect(isTransientError(limitError)).toBe(true);
    });

    it('should identify service unavailability as transient', () => {
      const serviceError = {
        name: 'ServiceUnavailable',
        message: 'Service temporarily unavailable',
      };
      expect(isTransientError(serviceError)).toBe(true);

      const httpError = new Error('503 Service Unavailable');
      expect(isTransientError(httpError)).toBe(true);
    });

    it('should identify lock conflicts as transient', () => {
      const lockError = {
        name: 'OptimisticLockException',
        message: 'Lock conflict',
      };
      expect(isTransientError(lockError)).toBe(true);

      const conditionalError = {
        name: 'ConditionalCheckFailedException',
        message: 'Conditional check failed',
      };
      expect(isTransientError(conditionalError)).toBe(true);
    });

    it('should identify permanent errors correctly', () => {
      const validationError = new Error('Invalid input');
      expect(isTransientError(validationError)).toBe(false);

      const notFoundError = {
        name: 'NotFound',
        message: 'Resource not found',
      };
      expect(isTransientError(notFoundError)).toBe(false);

      const authError = {
        name: 'Unauthorized',
        message: 'Invalid credentials',
      };
      expect(isTransientError(authError)).toBe(false);
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error instances', () => {
      const error = new Error('Test error');
      expect(getErrorMessage(error)).toBe('Test error');
    });

    it('should extract message from error objects', () => {
      const error = { message: 'Custom error' };
      expect(getErrorMessage(error)).toBe('Custom error');
    });

    it('should handle string errors', () => {
      expect(getErrorMessage('String error')).toBe('String error');
    });

    it('should handle unknown error types', () => {
      expect(getErrorMessage(undefined)).toBe('Unknown error');
      expect(getErrorMessage(null)).toBe('Unknown error');
      expect(getErrorMessage(123)).toBe('Unknown error');
    });
  });

  describe('getErrorName', () => {
    it('should extract name from Error instances', () => {
      const error = new TypeError('Type error');
      expect(getErrorName(error)).toBe('TypeError');
    });

    it('should extract name from error objects', () => {
      const error = { name: 'CustomError', message: 'Test' };
      expect(getErrorName(error)).toBe('CustomError');
    });

    it('should handle AWS-style error types', () => {
      const awsError = { __type: 'ValidationException', message: 'Invalid' };
      expect(getErrorName(awsError)).toBe('ValidationException');
    });

    it('should default to "Error" for unknown types', () => {
      expect(getErrorName({})).toBe('Error');
      expect(getErrorName('string')).toBe('Error');
    });
  });

  describe('createStructuredError', () => {
    it('should create structured error with all fields', () => {
      const error = new Error('Test error');
      const context = { userId: '123', action: 'test' };

      const structured = createStructuredError(error, context);

      expect(structured.message).toBe('Test error');
      expect(structured.errorType).toBe('Error');
      expect(structured.context).toEqual(context);
      expect(structured.retryable).toBe(false);
      expect(structured.severity).toBe('error');
      expect(structured.timestamp).toBeDefined();
      expect(typeof structured.timestamp).toBe('string');
    });

    it('should mark transient errors as retryable with warning severity', () => {
      const error = new Error('ECONNRESET');

      const structured = createStructuredError(error);

      expect(structured.retryable).toBe(true);
      expect(structured.severity).toBe('warning');
    });

    it('should mark fatal errors as critical', () => {
      const error = new Error('FATAL: System failure');

      const structured = createStructuredError(error);

      expect(structured.severity).toBe('critical');
    });

    it('should include stack trace when available', () => {
      const error = new Error('Test error');

      const structured = createStructuredError(error);

      expect(structured.stack).toBeDefined();
      expect(structured.stack).toContain('Test error');
    });
  });

  describe('retryWithBackoff', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useRealTimers();
    });

    it('should succeed on first attempt', async () => {
      const successFn = jest.fn().mockResolvedValue('success');

      const result = await retryWithBackoff(successFn);

      expect(result).toBe('success');
      expect(successFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient errors', async () => {
      const failThenSucceed = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue('success');

      const result = await retryWithBackoff(failThenSucceed, {
        maxAttempts: 3,
        baseDelayMs: 10,
      });

      expect(result).toBe('success');
      expect(failThenSucceed).toHaveBeenCalledTimes(3);
    });

    it('should not retry on permanent errors', async () => {
      const permanentError = new Error('Invalid input');
      const failFn = jest.fn().mockRejectedValue(permanentError);

      await expect(
        retryWithBackoff(failFn, { maxAttempts: 3, baseDelayMs: 10 })
      ).rejects.toThrow('Invalid input');

      expect(failFn).toHaveBeenCalledTimes(1);
    });

    it('should throw after max attempts on transient errors', async () => {
      const transientError = new Error('ECONNRESET');
      const failFn = jest.fn().mockRejectedValue(transientError);

      await expect(
        retryWithBackoff(failFn, { maxAttempts: 3, baseDelayMs: 10 })
      ).rejects.toThrow('ECONNRESET');

      expect(failFn).toHaveBeenCalledTimes(3);
    });

    it('should apply exponential backoff', async () => {
      jest.useFakeTimers();

      const failThenSucceed = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(failThenSucceed, {
        maxAttempts: 3,
        baseDelayMs: 100,
        backoffMultiplier: 2,
        jitter: false,
      });

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);

      // Second attempt after 100ms delay
      await jest.advanceTimersByTimeAsync(100);

      // Third attempt after 200ms delay (100 * 2^1)
      await jest.advanceTimersByTimeAsync(200);

      const result = await promise;
      expect(result).toBe('success');
      expect(failThenSucceed).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });

    it('should respect max delay', async () => {
      jest.useFakeTimers();

      const failThenSucceed = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(failThenSucceed, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 1500,
        backoffMultiplier: 2,
        jitter: false,
      });

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);

      // Second attempt after 1000ms delay
      await jest.advanceTimersByTimeAsync(1000);

      // Third attempt should be capped at 1500ms (not 2000ms)
      await jest.advanceTimersByTimeAsync(1500);

      const result = await promise;
      expect(result).toBe('success');
      expect(failThenSucceed).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });

    it('should apply jitter when enabled', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.75); // 75% of the range

      const failOnce = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const result = await retryWithBackoff(failOnce, {
        maxAttempts: 2,
        baseDelayMs: 100,
        jitter: true,
      });

      expect(result).toBe('success');
      expect(failOnce).toHaveBeenCalledTimes(2);

      (Math.random as jest.Mock).mockRestore();
    });

    it('should return typed results', async () => {
      type TestResult = { data: string; count: number };

      const successFn = async (): Promise<TestResult> => ({
        data: 'test',
        count: 42,
      });

      const result = await retryWithBackoff(successFn);

      expect(result.data).toBe('test');
      expect(result.count).toBe(42);
    });
  });
});
