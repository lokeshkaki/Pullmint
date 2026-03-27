// services/e2e/src/helpers/fixtures.ts
import crypto from 'crypto';

/** A realistic 30-line diff that triggers 4-agent analysis */
export const SAMPLE_DIFF_LARGE = `diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
index abc1234..def5678 100644
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -10,6 +10,20 @@ import { Request, Response, NextFunction } from 'express';
 import { getDb } from '../db';
 import { users } from '../schema';

+export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
+  const token = req.headers.authorization?.replace('Bearer ', '');
+  if (!token) {
+    res.status(401).json({ error: 'No token' });
+    return;
+  }
+  const user = await getDb().query.users.findFirst({ where: eq(users.token, token) });
+  if (!user || user.role !== 'admin') {
+    res.status(403).json({ error: 'Forbidden' });
+    return;
+  }
+  next();
+}
+
 export function logRequest(req: Request, _res: Response, next: NextFunction): void {
   console.log(\`\${req.method} \${req.path}\`);
   next();
`;

/** A tiny 3-line diff that triggers 2-agent analysis (architecture + security only) */
export const SAMPLE_DIFF_SMALL = `diff --git a/README.md b/README.md
index 000..111 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # My Project
+A short description.
`;

export function buildWebhookPayload(
  overrides: {
    repoFullName?: string;
    prNumber?: number;
    headSha?: string;
    baseSha?: string;
    action?: 'opened' | 'synchronize' | 'reopened';
    deliveryId?: string;
  } = {}
): { payload: string; signature: string; deliveryId: string } {
  const repoFullName = overrides.repoFullName ?? 'test-org/test-repo';
  const prNumber = overrides.prNumber ?? Math.floor(Math.random() * 90000) + 10000;
  const headSha = overrides.headSha ?? crypto.randomBytes(20).toString('hex');
  const baseSha = overrides.baseSha ?? crypto.randomBytes(20).toString('hex');
  const action = overrides.action ?? 'opened';
  const deliveryId =
    overrides.deliveryId ?? `e2e-delivery-${crypto.randomBytes(8).toString('hex')}`;

  const body = JSON.stringify({
    action,
    number: prNumber,
    pull_request: {
      head: { sha: headSha },
      base: { sha: baseSha },
      user: { login: 'test-author' },
      title: `E2E Test PR #${prNumber}`,
    },
    repository: { full_name: repoFullName },
    installation: { id: 88888 },
  });

  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? 'e2e-webhook-secret';
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  return { payload: body, signature, deliveryId };
}

/** Canned agent findings returned by the mock LLM */
export const CANNED_FINDINGS_BY_AGENT: Record<string, object[]> = {
  architecture: [
    {
      type: 'architecture',
      severity: 'medium',
      title: 'Missing dependency injection',
      description: 'Direct instantiation couples module to concrete implementation.',
      file: 'src/auth/middleware.ts',
      line: 12,
    },
  ],
  security: [
    {
      type: 'security',
      severity: 'high',
      title: 'SQL injection risk',
      description: 'User-controlled input used in query without parameterization.',
      file: 'src/auth/middleware.ts',
      line: 19,
    },
  ],
  performance: [
    {
      type: 'performance',
      severity: 'low',
      title: 'Unnecessary await in hot path',
      description: 'Promise can be resolved lazily.',
      file: 'src/auth/middleware.ts',
      line: 15,
    },
  ],
  style: [
    {
      type: 'style',
      severity: 'info',
      title: 'Missing JSDoc',
      description: 'Public functions should have JSDoc comments.',
      file: 'src/auth/middleware.ts',
      line: 11,
    },
  ],
};

export const CANNED_RISK_SCORES: Record<string, number> = {
  architecture: 45,
  security: 72,
  performance: 20,
  style: 10,
};

export const CANNED_SUMMARY =
  'This PR introduces an admin middleware with potential security concerns.';
