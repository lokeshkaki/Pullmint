/**
 * Verify GitHub webhook signature
 */
export declare function verifyGitHubSignature(payload: string, signature: string | undefined, secret: string): boolean;
/**
 * Generate a unique execution ID
 */
export declare function generateExecutionId(repoFullName: string, prNumber: number, sha: string): string;
/**
 * Calculate TTL timestamp (current time + duration in seconds)
 */
export declare function calculateTTL(durationSeconds: number): number;
/**
 * Hash content for caching
 */
export declare function hashContent(content: string): string;
//# sourceMappingURL=utils.d.ts.map