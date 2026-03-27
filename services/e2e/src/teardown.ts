// services/e2e/src/teardown.ts
export default function globalTeardown(): void {
  // Nothing to stop — workers are started/stopped per test file using beforeAll/afterAll
  // Docker containers are left running (the operator stops them with docker compose down)
  console.log('[e2e teardown] Done.');
}
