import { handler } from '../index';
import type { APIGatewayProxyEvent } from 'aws-lambda';

describe('Dashboard UI Handler', () => {
  const createMockEvent = (method: string = 'GET'): APIGatewayProxyEvent => ({
    path: '/dashboard',
    httpMethod: method,
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    body: null,
    isBase64Encoded: false,
  });

  describe('GET requests', () => {
    it('should return HTML content', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Content-Type', 'text/html');
      expect(result.body).toContain('<!DOCTYPE html>');
      expect(result.body).toContain('<title>Pullmint Dashboard</title>');
    });

    it('should include cache-control headers', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.headers).toHaveProperty(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );
    });

    it('should contain dashboard application', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      // Verify key elements exist
      expect(result.body).toContain('Pullmint Dashboard');
      expect(result.body).toContain('loadExecutions');
      expect(result.body).toContain('applyFilters');
      expect(result.body).toContain('class="executions"');
    });

    it('should include JavaScript for interactivity', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.body).toContain('<script>');
      expect(result.body).toContain('fetch');
      expect(result.body).toContain('apiBase');
    });

    it('should include CSS styling', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.body).toContain('<style>');
      expect(result.body).toContain('.container');
      expect(result.body).toContain('.execution-item');
    });

    it('should include filter controls', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.body).toContain('repoFilter');
      expect(result.body).toContain('statusFilter');
      expect(result.body).toContain('applyFilters');
      expect(result.body).toContain('clearFilters');
    });

    it('should include stats display', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.body).toContain('totalCount');
      expect(result.body).toContain('avgRisk');
      expect(result.body).toContain('deployedCount');
      expect(result.body).toContain('successRate');
    });

    it('should include auto-refresh functionality', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.body).toContain('startPolling');
      expect(result.body).toContain('stopPolling');
      expect(result.body).toContain('setInterval');
    });

    it('should configure API base URL correctly', async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);

      expect(result.body).toContain('window.location.origin + "/dashboard"');
    });
  });

  describe('Non-GET requests', () => {
    it('should reject POST requests', async () => {
      const event = createMockEvent('POST');
      const result = await handler(event);

      expect(result.statusCode).toBe(405);
      expect(result.headers).toHaveProperty('Content-Type', 'text/plain');
      expect(result.body).toBe('Method not allowed');
    });

    it('should reject PUT requests', async () => {
      const event = createMockEvent('PUT');
      const result = await handler(event);

      expect(result.statusCode).toBe(405);
    });

    it('should reject DELETE requests', async () => {
      const event = createMockEvent('DELETE');
      const result = await handler(event);

      expect(result.statusCode).toBe(405);
    });
  });

  describe('HTML structure validation', () => {
    let htmlContent: string;

    beforeAll(async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);
      htmlContent = result.body;
    });

    it('should have proper HTML5 doctype', () => {
      expect(htmlContent).toMatch(/^<!DOCTYPE html>/);
    });

    it('should have viewport meta tag for responsiveness', () => {
      expect(htmlContent).toContain('name="viewport"');
      expect(htmlContent).toContain('width=device-width');
    });

    it('should have UTF-8 charset', () => {
      expect(htmlContent).toContain('charset="UTF-8"');
    });

    it('should have properly structured sections', () => {
      expect(htmlContent).toContain('<header>');
      expect(htmlContent).toContain('class="filters"');
      expect(htmlContent).toContain('class="stats"');
      expect(htmlContent).toContain('class="executions"');
    });

    it('should include risk score visualization', () => {
      expect(htmlContent).toContain('getRiskClass');
      expect(htmlContent).toContain('risk-low');
      expect(htmlContent).toContain('risk-medium');
      expect(htmlContent).toContain('risk-high');
    });

    it('should include finding severity levels', () => {
      expect(htmlContent).toContain('finding-severity');
      expect(htmlContent).toContain('critical');
      expect(htmlContent).toContain('high');
      expect(htmlContent).toContain('medium');
      expect(htmlContent).toContain('low');
    });

    it('should include deployment timeline', () => {
      expect(htmlContent).toContain('deployment-timeline');
      expect(htmlContent).toContain('renderDeployment');
    });

    it('should include pagination support', () => {
      expect(htmlContent).toContain('nextToken');
      expect(htmlContent).toContain('load-more');
      expect(htmlContent).toContain('loadExecutions(true)');
    });

    it('should include error handling UI', () => {
      expect(htmlContent).toContain('class="error"');
      expect(htmlContent).toContain('class="loading"');
      expect(htmlContent).toContain('class="empty"');
    });

    it('should include status badges', () => {
      expect(htmlContent).toContain('badge.pending');
      expect(htmlContent).toContain('badge.analyzing');
      expect(htmlContent).toContain('badge.completed');
      expect(htmlContent).toContain('badge.failed');
      expect(htmlContent).toContain('badge.deploying');
      expect(htmlContent).toContain('badge.deployed');
    });
  });

  describe('Responsive design', () => {
    let htmlContent: string;

    beforeAll(async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);
      htmlContent = result.body;
    });

    it('should use grid layout for stats', () => {
      expect(htmlContent).toContain('display: grid');
      expect(htmlContent).toContain('grid-template-columns');
    });

    it('should use flexbox for filters', () => {
      expect(htmlContent).toContain('display: flex');
      expect(htmlContent).toContain('flex-wrap: wrap');
    });

    it('should have box-sizing border-box', () => {
      expect(htmlContent).toContain('box-sizing: border-box');
    });
  });

  describe('Browser compatibility', () => {
    let htmlContent: string;

    beforeAll(async () => {
      const event = createMockEvent('GET');
      const result = await handler(event);
      htmlContent = result.body;
    });

    it('should use modern JavaScript features with fallbacks', () => {
      expect(htmlContent).toContain('async function');
      expect(htmlContent).toContain('await fetch');
    });

    it('should handle visibility change for tab switching', () => {
      expect(htmlContent).toContain('visibilitychange');
      expect(htmlContent).toContain('document.hidden');
    });

    it('should use standard DOM APIs', () => {
      expect(htmlContent).toContain('getElementById');
      expect(htmlContent).toContain('querySelector');
      expect(htmlContent).toContain('addEventListener');
    });
  });
});
