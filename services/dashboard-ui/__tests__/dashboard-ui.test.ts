import { handler } from '../index';

describe('Dashboard UI', () => {
  it('returns HTML content with dashboard markup', async () => {
    const result = await handler();

    expect(result.statusCode).toBe(200);
    expect(result.headers).toMatchObject({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(result.body).toContain('Pullmint Dashboard');
    expect(result.body).toContain("executions?repoFullName");
  });
});
