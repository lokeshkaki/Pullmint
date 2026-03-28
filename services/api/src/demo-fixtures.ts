import type { Finding } from '@pullmint/shared/types';

export interface DemoAnalysisResult {
  riskScore: number;
  findings: Finding[];
  agentResults: Record<string, { findingsCount: number; riskScore: number; status: string }>;
  summary: string;
  processingTimeMs: number;
}

export interface DemoSample {
  name: string;
  description: string;
  diff: string;
  result: DemoAnalysisResult;
}

const EXPRESS_API_DIFF = `diff --git a/src/routes/users.js b/src/routes/users.js
index 0000000..abc1234 100644
--- /dev/null
+++ b/src/routes/users.js
@@ -0,0 +1,62 @@
+const express = require('express');
+const router = express.Router();
+const db = require('../db');
+const logger = require('../logger');
+
+// GET /users/:id - fetch user profile
+router.get('/:id', async (req, res) => {
+  const userId = req.params.id;
+  logger.info('Fetching user ' + userId + ', headers: ' + JSON.stringify(req.headers));
+
+  try {
+    // Direct string interpolation into SQL query
+    const query = 'SELECT * FROM users WHERE id = ' + userId;
+    const result = await db.query(query);
+
+    if (result.rows.length === 0) {
+      return res.status(404).json({ error: 'User not found' });
+    }
+
+    const user = result.rows[0];
+    // Returns full DB row including password_hash, salt, mfa_secret
+    return res.json(user);
+  } catch (err) {
+    logger.error('DB error', err);
+    return res.status(500).json({ error: err.message });
+  }
+});
+
+// POST /users - create new user
+router.post('/', async (req, res) => {
+  const { username, email, password, role } = req.body;
+
+  // No input validation, no sanitization
+  // Caller can set role='admin' directly
+  const query = "INSERT INTO users (username, email, password_hash, role) " +
+                 "VALUES ('" + username + "', '" + email + "', '" + password + "', '" + role + "')";
+
+  try {
+    await db.query(query);
+    return res.status(201).json({ message: 'User created' });
+  } catch (err) {
+    // Leaks full SQL error to caller (may expose schema details)
+    return res.status(500).json({ error: err.message, query });
+  }
+});
+
+// DELETE /users/:id - admin only
+router.delete('/:id', async (req, res) => {
+  const adminToken = req.headers['x-admin-token'];
+
+  // Compares token using == (type coercion), not constant-time comparison
+  if (adminToken == process.env.ADMIN_TOKEN) {
+    const query = 'DELETE FROM users WHERE id = ' + req.params.id;
+    await db.query(query);
+    return res.json({ deleted: true });
+  }
+
+  return res.status(403).json({ error: 'Forbidden' });
+});
+
+module.exports = router;`;

const REACT_REFACTOR_DIFF = `diff --git a/src/components/UserDashboard.tsx b/src/components/UserDashboard.tsx
index abc1234..def5678 100644
--- a/src/components/UserDashboard.tsx
+++ b/src/components/UserDashboard.tsx
@@ -1,120 +1,15 @@
-import React, { useState, useEffect } from 'react';
-import axios from 'axios';
-// ... [420 lines removed - full monolith]
+import React from 'react';
+import { UserHeader } from './UserHeader';
+import { ActivityFeed } from './ActivityFeed';
+import { StatsPanel } from './StatsPanel';
+import { useUserData } from '../hooks/useUserData';
+
+export function UserDashboard({ userId }: { userId: string }) {
+  const { user, activity, stats, isLoading, error } = useUserData(userId);
+
+  if (isLoading) return <div className="skeleton" aria-busy="true" />;
+  if (error) return <div role="alert">{error.message}</div>;
+
+  return (
+    <div className="dashboard">
+      <UserHeader user={user} />
+      <StatsPanel stats={stats} />
+      <ActivityFeed items={activity} />
+    </div>
+  );
+}
+diff --git a/src/hooks/useUserData.ts b/src/hooks/useUserData.ts
+new file mode 100644
+index 0000000..11223344
+--- /dev/null
++ b/src/hooks/useUserData.ts
@@ -0,0 +1,38 @@
++import { useState, useEffect } from 'react';
++import axios from 'axios';
++import type { User, Activity, Stats } from '../types';
++
++export function useUserData(userId: string) {
++  const [user, setUser] = useState<User | null>(null);
++  const [activity, setActivity] = useState<Activity[]>([]);
++  const [stats, setStats] = useState<Stats | null>(null);
++  const [isLoading, setIsLoading] = useState(true);
++  const [error, setError] = useState<Error | null>(null);
++
++  useEffect(() => {
++    let cancelled = false;
++
++    async function load() {
++      try {
++        setIsLoading(true);
++        // Three sequential requests - could be parallelized
++        const userRes = await axios.get('/api/users/' + userId);
++        const activityRes = await axios.get('/api/users/' + userId + '/activity');
++        const statsRes = await axios.get('/api/users/' + userId + '/stats');
++
++        if (!cancelled) {
++          setUser(userRes.data);
++          setActivity(activityRes.data);
++          setStats(statsRes.data);
++        }
++      } catch (err) {
++        if (!cancelled) setError(err instanceof Error ? err : new Error('Failed to load'));
++      } finally {
++        if (!cancelled) setIsLoading(false);
++      }
++    }
++
++    void load();
++    return () => { cancelled = true; };
++  }, [userId]);
++
++  return { user, activity, stats, isLoading, error };
++}
+diff --git a/src/components/StatsPanel.tsx b/src/components/StatsPanel.tsx
+new file mode 100644
+index 0000000..aabbccdd
+--- /dev/null
++ b/src/components/StatsPanel.tsx
@@ -0,0 +1,18 @@
++import React from 'react';
++import type { Stats } from '../types';
++
++interface Props {
++  stats: Stats | null;
++}
++
++// TODO: add proper null state design
++export function StatsPanel({ stats }: Props) {
++  if (!stats) return null;
++
++  return (
++    <div className="stats-panel">
++      {Object.entries(stats).map(([key, value]) => (
++        <div key={key} className="stat-item">
++          <span className="label">{key}</span>
++          <span className="value">{String(value)}</span>
++        </div>
++      ))}
++    </div>
++  );
++}`;

const DB_MIGRATION_DIFF = `diff --git a/migrations/0012_add_audit_log.sql b/migrations/0012_add_audit_log.sql
new file mode 100644
index 0000000..99aabbcc
--- /dev/null
+++ b/migrations/0012_add_audit_log.sql
@@ -0,0 +1,42 @@
+-- Migration: add audit_log table and link to users + resources
+-- Ticket: ENG-412
+
+BEGIN;
+
+CREATE TABLE audit_log (
+  id          BIGSERIAL PRIMARY KEY,
+  user_id     BIGINT NOT NULL,
+  resource_id BIGINT,
+  action      VARCHAR(64) NOT NULL,
+  payload     JSONB,
+  ip_address  INET,
+  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
+);
+
+-- Foreign key to users table
+ALTER TABLE audit_log
+  ADD CONSTRAINT fk_audit_log_user
+  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
+
+-- Foreign key to resources table (optional)
+ALTER TABLE audit_log
+  ADD CONSTRAINT fk_audit_log_resource
+  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE SET NULL;
+
+-- Drop the old activity_log table (contains same data, migration to be done by app)
+-- WARNING: data not migrated before this runs
+DROP TABLE activity_log;
+
+-- Remove rarely-used column from users
+ALTER TABLE users DROP COLUMN last_login_ip;
+
+-- Recreate sessions index with longer retention window
+DROP INDEX idx_sessions_expires_at;
+CREATE INDEX idx_sessions_expires_at ON sessions(expires_at)
+  WHERE expires_at > NOW() - INTERVAL '90 days';
+
+COMMIT;
+diff --git a/src/models/AuditLog.ts b/src/models/AuditLog.ts
+new file mode 100644
+index 0000000..55667788
+--- /dev/null
++ b/src/models/AuditLog.ts
@@ -0,0 +1,28 @@
++import { db } from '../db';
++
++export interface AuditLogEntry {
++  userId: bigint;
++  resourceId?: bigint;
++  action: string;
++  payload?: Record<string, unknown>;
++  ipAddress?: string;
++}
++
++export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
++  // Inserts directly - no batching, called on every request
++  await db.query(
++    'INSERT INTO audit_log (user_id, resource_id, action, payload, ip_address)\n' +
++     'VALUES ($1, $2, $3, $4, $5)',
++    [entry.userId, entry.resourceId ?? null, entry.action, JSON.stringify(entry.payload ?? {}), entry.ipAddress ?? null]
++  );
++}
++
++export async function getAuditLog(userId: bigint, limit = 100): Promise<unknown[]> {
++  const result = await db.query(
++    // Full table scan - no index on user_id
++    'SELECT * FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
++    [userId, limit]
++  );
++  return result.rows;
++}`;

const SAMPLE_EXPRESS_API: DemoSample = {
  name: 'express-api-endpoint',
  description:
    'A Node.js route handler with SQL injection, credential exposure, and missing authorization',
  diff: EXPRESS_API_DIFF,
  result: {
    riskScore: 82,
    findings: [
      {
        type: 'security',
        severity: 'critical',
        title: 'SQL injection via string interpolation',
        description:
          'User-supplied `req.params.id` is interpolated directly into SQL queries on lines 14 and 52 without parameterization. An attacker can pass `1 OR 1=1` or `1; DROP TABLE users--` to read or destroy arbitrary data.',
        file: 'src/routes/users.js',
        line: 14,
        suggestion:
          'Use parameterized queries: `db.query("SELECT * FROM users WHERE id = $1", [userId])`. Never concatenate user input into SQL strings.',
        fingerprint: 'sec-sqli-users-js-14',
      },
      {
        type: 'security',
        severity: 'high',
        title: 'Sensitive fields returned in API response',
        description:
          'The GET handler returns the full DB row (`result.rows[0]`), which includes `password_hash`, `salt`, and `mfa_secret`. Any caller can read these fields.',
        file: 'src/routes/users.js',
        line: 21,
        suggestion:
          'Explicitly project only safe fields: `SELECT id, username, email, role, created_at FROM users WHERE id = $1`.',
        fingerprint: 'sec-data-exposure-users-js-21',
      },
      {
        type: 'security',
        severity: 'high',
        title: 'Missing input validation allows role escalation',
        description:
          'The POST handler accepts `role` directly from `req.body` without validation, letting any caller create an admin account by sending `{ "role": "admin" }`.',
        file: 'src/routes/users.js',
        line: 36,
        suggestion:
          'Remove `role` from the accepted body fields and hardcode it to `"user"` for self-registration. Admin role assignment must go through a separate privileged endpoint.',
        fingerprint: 'sec-priv-esc-users-js-36',
      },
      {
        type: 'security',
        severity: 'high',
        title: 'Error handler leaks SQL query to caller',
        description:
          'The catch block returns `err.message` and the raw `query` string in the HTTP response. This exposes the database schema, table names, and partial data to potential attackers.',
        file: 'src/routes/users.js',
        line: 44,
        suggestion:
          'Return a generic error message to callers: `res.status(500).json({ error: "Internal server error" })`. Log the full error server-side only.',
        fingerprint: 'sec-info-leak-users-js-44',
      },
      {
        type: 'security',
        severity: 'medium',
        title: 'Non-constant-time token comparison',
        description:
          'The DELETE endpoint uses `==` for admin token comparison, which is vulnerable to type coercion (e.g., `0 == "false"` is true). Even with `===`, string comparison is not constant-time and is vulnerable to timing attacks.',
        file: 'src/routes/users.js',
        line: 51,
        suggestion:
          'Use `crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(process.env.ADMIN_TOKEN))` for secret comparison.',
        fingerprint: 'sec-timing-users-js-51',
      },
      {
        type: 'security',
        severity: 'medium',
        title: 'Authorization headers logged in plaintext',
        description:
          'Line 10 logs the full request headers including `Authorization`, `Cookie`, and `X-Admin-Token`. This writes credentials to log storage accessible by any operator.',
        file: 'src/routes/users.js',
        line: 10,
        suggestion:
          'Redact sensitive headers before logging: omit `authorization`, `cookie`, and any `x-*-token` headers. Log only the request path and method.',
        fingerprint: 'sec-header-log-users-js-10',
      },
      {
        type: 'architecture',
        severity: 'medium',
        title: 'No rate limiting on authentication-adjacent endpoints',
        description:
          'The POST /users route has no rate limiting, enabling brute-force account creation. The DELETE route has no rate limiting on the admin token endpoint.',
        file: 'src/routes/users.js',
        suggestion:
          'Apply express-rate-limit middleware to these routes. Example: `rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })`.',
        fingerprint: 'arch-rate-limit-users-js',
      },
      {
        type: 'style',
        severity: 'low',
        title: 'Raw password stored without hashing',
        description:
          'The POST handler stores `password` directly in `password_hash` column. The field name implies hashing should occur before storage.',
        file: 'src/routes/users.js',
        line: 38,
        suggestion:
          'Hash the password with bcrypt before storage: `const hash = await bcrypt.hash(password, 12)`.',
        fingerprint: 'style-password-hash-users-js-38',
      },
    ],
    agentResults: {
      architecture: { findingsCount: 1, riskScore: 45, status: 'completed' },
      security: { findingsCount: 6, riskScore: 90, status: 'completed' },
      performance: { findingsCount: 0, riskScore: 5, status: 'completed' },
      style: { findingsCount: 1, riskScore: 20, status: 'completed' },
    },
    summary:
      'This PR introduces multiple critical and high-severity security vulnerabilities: SQL injection on every database call, full credential exposure in API responses, and unauthenticated privilege escalation via the role field. These must be fixed before merge.',
    processingTimeMs: 8340,
  },
};

const SAMPLE_REACT_REFACTOR: DemoSample = {
  name: 'react-component-refactor',
  description:
    'Large React component split into focused hooks and sub-components - mostly positive, minor improvements suggested',
  diff: REACT_REFACTOR_DIFF,
  result: {
    riskScore: 18,
    findings: [
      {
        type: 'performance',
        severity: 'medium',
        title: 'Three sequential API requests should be parallelized',
        description:
          'In `useUserData.ts`, the three `axios.get` calls for user, activity, and stats are awaited sequentially. Each waits for the previous to complete before starting, adding unnecessary latency proportional to the slowest endpoint.',
        file: 'src/hooks/useUserData.ts',
        line: 19,
        suggestion:
          'Use `Promise.all` to run all three requests concurrently: `const [userRes, activityRes, statsRes] = await Promise.all([axios.get(...), axios.get(...), axios.get(...)])`.',
        fingerprint: 'perf-sequential-requests-useUserData-19',
      },
      {
        type: 'architecture',
        severity: 'low',
        title: 'Positive: good separation of concerns via custom hook',
        description:
          'Extracting data-fetching into `useUserData` is an excellent architectural decision. The component is now purely presentational and the hook can be tested in isolation or reused by other components.',
        file: 'src/hooks/useUserData.ts',
        fingerprint: 'arch-positive-hook-extraction',
      },
      {
        type: 'style',
        severity: 'low',
        title: 'TODO comment left in production code',
        description:
          '`StatsPanel.tsx` line 9 has `// TODO: add proper null state design`. TODOs in committed code become permanent unless tracked in a backlog.',
        file: 'src/components/StatsPanel.tsx',
        line: 9,
        suggestion:
          'Convert to a GitHub issue and reference it: `// See: #123`. Or implement the null state now if it is a one-line skeleton placeholder.',
        fingerprint: 'style-todo-StatsPanel-9',
      },
      {
        type: 'style',
        severity: 'info',
        title: 'StatsPanel uses Object.entries on untyped stats shape',
        description:
          '`Object.entries(stats).map(...)` iterates over every key on the `Stats` type. If the `Stats` type adds internal or computed fields in the future, they will appear as stat items unexpectedly.',
        file: 'src/components/StatsPanel.tsx',
        line: 15,
        suggestion:
          'Explicitly enumerate the stat keys you want to display rather than iterating all entries: `const DISPLAY_KEYS: (keyof Stats)[] = [...]`.',
        fingerprint: 'style-stats-object-entries-15',
      },
    ],
    agentResults: {
      architecture: { findingsCount: 1, riskScore: 10, status: 'completed' },
      security: { findingsCount: 0, riskScore: 5, status: 'completed' },
      performance: { findingsCount: 1, riskScore: 35, status: 'completed' },
      style: { findingsCount: 2, riskScore: 15, status: 'completed' },
    },
    summary:
      'This refactor is a strong architectural improvement - the new hook/component split is clean and testable. The main actionable issue is parallelizing the three sequential API requests in useUserData, which will reduce page load latency.',
    processingTimeMs: 6120,
  },
};

const SAMPLE_DB_MIGRATION: DemoSample = {
  name: 'db-migration',
  description:
    'Schema migration adding an audit log table - includes a dangerous DROP TABLE and missing indexes',
  diff: DB_MIGRATION_DIFF,
  result: {
    riskScore: 67,
    findings: [
      {
        type: 'architecture',
        severity: 'critical',
        title: 'DROP TABLE activity_log without data migration',
        description:
          'Line 27 of the migration drops `activity_log` with a comment that "data not migrated before this runs". This is a destructive, irreversible operation that will permanently delete all historical activity records.',
        file: 'migrations/0012_add_audit_log.sql',
        line: 27,
        suggestion:
          'Do not drop the old table in this migration. Ship a separate migration after the application has migrated all data to the new table, and only after verifying row counts match. Use `RENAME TABLE activity_log TO activity_log_deprecated` as an intermediate step.',
        fingerprint: 'arch-drop-table-activity-log-27',
      },
      {
        type: 'performance',
        severity: 'high',
        title: 'Missing index on audit_log.user_id causes full table scans',
        description:
          '`getAuditLog` queries `WHERE user_id = $1` but no index is created on `audit_log.user_id`. With frequent writes, this table will grow rapidly and every per-user query will become a sequential scan.',
        file: 'src/models/AuditLog.ts',
        line: 22,
        suggestion:
          'Add `CREATE INDEX idx_audit_log_user_id ON audit_log(user_id)` to the migration. Also consider a composite index `(user_id, created_at DESC)` to support the ORDER BY without a sort step.',
        fingerprint: 'perf-missing-index-audit-user-id',
      },
      {
        type: 'performance',
        severity: 'high',
        title: 'Audit log writes are unbatched - one INSERT per request',
        description:
          '`writeAuditLog` issues a synchronous INSERT on every call. If called on every HTTP request at scale, this adds a database round-trip to every request latency and creates significant write amplification.',
        file: 'src/models/AuditLog.ts',
        line: 13,
        suggestion:
          'Buffer audit writes and flush them in batches using a queue or periodic flush. Alternatively, use a fire-and-forget pattern (`void writeAuditLog(...)`) if exact durability is not required for audit events.',
        fingerprint: 'perf-unbatched-audit-writes-13',
      },
      {
        type: 'architecture',
        severity: 'high',
        title: 'Breaking change: DROP COLUMN last_login_ip without deprecation window',
        description:
          '`ALTER TABLE users DROP COLUMN last_login_ip` is a hard breaking change. Any running application instances that reference this column will throw errors until redeployed. Zero-downtime deployments require a multi-step column removal process.',
        file: 'migrations/0012_add_audit_log.sql',
        line: 30,
        suggestion:
          'Follow the expand/contract pattern: (1) stop reading from the column in app code, (2) deploy, (3) in a later migration, drop the column. Never drop a column in the same migration as adding a replacement.',
        fingerprint: 'arch-drop-column-users-last-login-ip-30',
      },
      {
        type: 'architecture',
        severity: 'medium',
        title: 'Missing rollback strategy for destructive migration',
        description:
          'This migration has no companion rollback migration. The DROP TABLE and DROP COLUMN operations cannot be automatically reversed if the deploy needs to be rolled back.',
        file: 'migrations/0012_add_audit_log.sql',
        suggestion:
          'Document a rollback procedure. For irreversible migrations, add a README section in the migrations directory with manual rollback steps and estimated recovery time.',
        fingerprint: 'arch-no-rollback-strategy',
      },
      {
        type: 'performance',
        severity: 'low',
        title: 'Partial index on sessions uses runtime function - not immutable',
        description:
          "`WHERE expires_at > NOW() - INTERVAL '90 days'` in the index definition uses `NOW()`, which is not immutable. PostgreSQL will plan around the partial index but it may not be used as expected in all query plans.",
        file: 'migrations/0012_add_audit_log.sql',
        line: 36,
        suggestion:
          "Use a full index without the partial condition, or use a fixed reference date: `WHERE expires_at > '2024-01-01'::timestamptz`. The application should filter stale sessions in the query, not in the index predicate.",
        fingerprint: 'perf-partial-index-now-sessions-36',
      },
    ],
    agentResults: {
      architecture: { findingsCount: 3, riskScore: 75, status: 'completed' },
      security: { findingsCount: 0, riskScore: 10, status: 'completed' },
      performance: { findingsCount: 3, riskScore: 65, status: 'completed' },
      style: { findingsCount: 0, riskScore: 5, status: 'completed' },
    },
    summary:
      'This migration has two critical issues: a DROP TABLE on live data without a migration path, and a breaking DROP COLUMN that will cause errors on running instances. Both require architectural remediation before this can safely ship.',
    processingTimeMs: 9810,
  },
};

export const DEMO_SAMPLES: DemoSample[] = [
  SAMPLE_EXPRESS_API,
  SAMPLE_REACT_REFACTOR,
  SAMPLE_DB_MIGRATION,
];
