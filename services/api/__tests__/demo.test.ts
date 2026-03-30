import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerDemoRoutes } from '../src/routes/demo';

jest.mock('@pullmint/shared/llm', () => ({
  createLLMProvider: jest.fn(() => ({
    chat: jest.fn().mockResolvedValue({
      text: JSON.stringify({
        findings: [
          {
            type: 'security',
            severity: 'high',
            title: 'Test finding',
            description: 'Test description',
          },
        ],
        riskScore: 65,
        summary: 'Test summary',
      }),
      inputTokens: 100,
      outputTokens: 50,
    }),
  })),
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfigOptional: jest.fn((key: string) => {
    if (key === 'DEMO_ENABLED') return 'true';
    return undefined;
  }),
}));

jest.mock('@pullmint/shared/diff-filter', () => ({
  parseDiff: jest.fn(() => ({
    files: [],
    totalFiles: 0,
    totalAddedLines: 5,
    totalRemovedLines: 0,
  })),
  filterDiff: jest.fn(() => ({
    diff: 'mock diff',
    includedFiles: 1,
    excludedFiles: 0,
    excludedFilePaths: [],
    wasTruncated: false,
    originalCharCount: 100,
  })),
  getMaxDiffChars: jest.fn(() => 100000),
}));

jest.mock('@pullmint/shared/dedup', () => ({
  deduplicateFindings: jest.fn((findings) => findings),
}));

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 000000..abcdef 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
 export function foo() {
+  const x = eval(userInput);
   return x;
 }`;

describe('Demo routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    const demoApp = Fastify({ logger: false, trustProxy: true });
    await demoApp.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
    });
    registerDemoRoutes(demoApp);
    return demoApp;
  }

  beforeEach(async () => {
    process.env.DEMO_RATE_LIMIT_PER_HOUR = '5';
    process.env.DEMO_MAX_DIFF_BYTES = '51200';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.DEMO_RATE_LIMIT_PER_HOUR;
    delete process.env.DEMO_MAX_DIFF_BYTES;
  });

  describe('GET /demo/samples', () => {
    it('returns sample list with name and description', async () => {
      const res = await app.inject({ method: 'GET', url: '/demo/samples' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(3);
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('description');
      expect(body[0]).toHaveProperty('diffLineCount');
    });
  });

  describe('GET /demo/samples/:name', () => {
    it('returns pre-computed fixture result instantly', async () => {
      const res = await app.inject({ method: 'GET', url: '/demo/samples/express-api-endpoint' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('riskScore');
      expect(body).toHaveProperty('findings');
      expect(body).toHaveProperty('agentResults');
      expect(body).toHaveProperty('diff');
      expect(typeof body.riskScore).toBe('number');
      expect(Array.isArray(body.findings)).toBe(true);
    });

    it('returns 404 for unknown sample name', async () => {
      const res = await app.inject({ method: 'GET', url: '/demo/samples/nonexistent-sample' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /demo/analyze', () => {
    it('returns analysis result with expected shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/demo/analyze',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.10' },
        payload: { diff: SAMPLE_DIFF },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('riskScore');
      expect(body).toHaveProperty('findings');
      expect(body).toHaveProperty('agentResults');
      expect(body).toHaveProperty('summary');
      expect(body).toHaveProperty('processingTimeMs');
      expect(typeof body.riskScore).toBe('number');
      expect(body.riskScore).toBeGreaterThanOrEqual(0);
      expect(body.riskScore).toBeLessThanOrEqual(100);
    });

    it('returns 400 for missing diff field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/demo/analyze',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.11' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 413 when diff exceeds 50KB', async () => {
      const largeDiff = 'x'.repeat(52000);
      const res = await app.inject({
        method: 'POST',
        url: '/demo/analyze',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.12' },
        payload: { diff: largeDiff },
      });
      expect(res.statusCode).toBe(413);
      const body = res.json();
      expect(body.error).toMatch(/too large/i);
    });

    it('returns 429 after exceeding rate limit', async () => {
      const requests = Array.from({ length: 6 }, () =>
        app.inject({
          method: 'POST',
          url: '/demo/analyze',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
          payload: { diff: SAMPLE_DIFF },
        })
      );
      const results = await Promise.all(requests);
      const statusCodes = results.map((response) => response.statusCode);
      expect(statusCodes).toContain(429);
      const rateLimitedResponse = results.find((response) => response.statusCode === 429);
      expect(rateLimitedResponse?.headers['retry-after']).toBeDefined();
    });

    it('agentResults contains all 4 agent types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/demo/analyze',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.13' },
        payload: { diff: SAMPLE_DIFF },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.agentResults).toHaveProperty('architecture');
      expect(body.agentResults).toHaveProperty('security');
      expect(body.agentResults).toHaveProperty('performance');
      expect(body.agentResults).toHaveProperty('style');
    });
  });

  describe('when DEMO_ENABLED is not true', () => {
    let disabledApp: ReturnType<typeof Fastify>;

    beforeEach(() => {
      const { getConfigOptional } = jest.requireMock('@pullmint/shared/config') as {
        getConfigOptional: jest.Mock;
      };
      getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEMO_ENABLED') return undefined;
        return undefined;
      });

      disabledApp = Fastify({ logger: false, trustProxy: true });
      registerDemoRoutes(disabledApp);
    });

    afterEach(async () => {
      const { getConfigOptional } = jest.requireMock('@pullmint/shared/config') as {
        getConfigOptional: jest.Mock;
      };
      getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEMO_ENABLED') return 'true';
        return undefined;
      });
      await disabledApp.close();
    });

    it('GET /demo/samples returns 404', async () => {
      const res = await disabledApp.inject({ method: 'GET', url: '/demo/samples' });
      expect(res.statusCode).toBe(404);
    });

    it('POST /demo/analyze returns 404', async () => {
      const res = await disabledApp.inject({
        method: 'POST',
        url: '/demo/analyze',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.14' },
        payload: { diff: SAMPLE_DIFF },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
