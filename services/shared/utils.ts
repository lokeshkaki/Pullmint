import * as crypto from 'crypto';

/**
 * Verify GitHub webhook signature
 */
export function verifyGitHubSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const calculatedSignature = 'sha256=' + hmac.digest('hex');

  // Ensure buffers are same length for timingSafeEqual
  if (signature.length !== calculatedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(calculatedSignature));
}

/**
 * Generate a unique execution ID
 */
export function generateExecutionId(repoFullName: string, prNumber: number, sha: string): string {
  return `${repoFullName}#${prNumber}#${sha.substring(0, 7)}`;
}

/**
 * Calculate TTL timestamp (current time + duration in seconds)
 */
export function calculateTTL(durationSeconds: number): number {
  return Math.floor(Date.now() / 1000) + durationSeconds;
}

/**
 * Hash content for caching
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
