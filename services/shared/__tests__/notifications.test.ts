import * as crypto from 'crypto';
import {
  formatSlackMessage,
  formatDiscordMessage,
  formatTeamsMessage,
  formatGenericWebhook,
  sendNotification,
  type NotificationPayload,
  type NotificationChannel,
} from '../notifications';

const basePayload: NotificationPayload = {
  event: 'analysis.completed',
  executionId: 'exec-123',
  repoFullName: 'org/repo',
  prNumber: 42,
  prTitle: 'Add feature X',
  author: 'alice',
  riskScore: 35,
  findingsCount: 3,
  status: 'completed',
  summary: 'Medium-risk changes detected in auth module.',
  dashboardUrl: 'http://localhost/executions/exec-123',
  prUrl: 'https://github.com/org/repo/pull/42',
  timestamp: 1711324800000,
};

const baseChannel: NotificationChannel = {
  id: 1,
  name: 'Test Channel',
  channelType: 'webhook',
  webhookUrl: 'http://localhost:9999/hook',
  repoFilter: null,
  events: ['analysis.completed'],
  minRiskScore: null,
  enabled: true,
  secret: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('formatSlackMessage', () => {
  it('returns blocks array with header, sections, and actions', () => {
    const msg = formatSlackMessage(basePayload) as { blocks: unknown[] };
    expect(msg.blocks).toBeDefined();
    expect(Array.isArray(msg.blocks)).toBe(true);

    const header = msg.blocks.find((b: unknown) => (b as { type: string }).type === 'header');
    expect(header).toBeDefined();
    const headerText = (header as { text: { text: string } }).text.text;
    expect(headerText).toContain('Analysis Complete');

    const sections = msg.blocks.filter((b: unknown) => (b as { type: string }).type === 'section');
    const sectionText = JSON.stringify(sections);
    expect(sectionText).toContain('35.0');
    expect(sectionText).toContain('Medium');

    const actions = msg.blocks.find((b: unknown) => (b as { type: string }).type === 'actions');
    expect(actions).toBeDefined();
    const elements = (actions as { elements: unknown[] }).elements;
    expect(elements.length).toBeGreaterThanOrEqual(2);
  });

  it('uses green emoji for low risk', () => {
    const msg = formatSlackMessage({ ...basePayload, riskScore: 10 }) as {
      blocks: { text?: { text: string } }[];
    };
    const header = msg.blocks.find((b) => b.text?.text?.includes('🟢'));
    expect(header).toBeDefined();
  });

  it('uses red emoji for high risk', () => {
    const msg = formatSlackMessage({ ...basePayload, riskScore: 80 }) as {
      blocks: { text?: { text: string } }[];
    };
    const header = msg.blocks.find((b) => b.text?.text?.includes('🔴'));
    expect(header).toBeDefined();
  });

  it('omits actions block when no URLs provided', () => {
    const msg = formatSlackMessage({
      ...basePayload,
      dashboardUrl: undefined,
      prUrl: undefined,
    }) as { blocks: unknown[] };
    const actions = msg.blocks.find((b: unknown) => (b as { type: string }).type === 'actions');
    expect(actions).toBeUndefined();
  });
});

describe('formatDiscordMessage', () => {
  it('returns embeds array with correct color for medium risk', () => {
    const msg = formatDiscordMessage(basePayload) as {
      embeds: { color: number; fields: unknown[] }[];
    };
    expect(msg.embeds).toHaveLength(1);
    const embed = msg.embeds[0];
    expect(embed.color).toBe(0xeab308);
    expect(embed.fields.length).toBeGreaterThan(3);
  });

  it('uses green color for low risk', () => {
    const msg = formatDiscordMessage({ ...basePayload, riskScore: 10 }) as {
      embeds: { color: number }[];
    };
    expect(msg.embeds[0].color).toBe(0x22c55e);
  });

  it('uses red color for high risk', () => {
    const msg = formatDiscordMessage({ ...basePayload, riskScore: 75 }) as {
      embeds: { color: number }[];
    };
    expect(msg.embeds[0].color).toBe(0xef4444);
  });

  it('includes summary field when provided', () => {
    const msg = formatDiscordMessage(basePayload) as { embeds: { fields: { name: string }[] }[] };
    const summaryField = msg.embeds[0].fields.find((f) => f.name === 'Summary');
    expect(summaryField).toBeDefined();
  });
});

describe('formatTeamsMessage', () => {
  it('returns MessageCard with facts and actions', () => {
    const msg = formatTeamsMessage(basePayload) as {
      '@type': string;
      sections: { facts: unknown[] }[];
      potentialAction: unknown[];
    };
    expect(msg['@type']).toBe('MessageCard');
    expect(msg.sections[0].facts.length).toBeGreaterThan(3);
    expect(msg.potentialAction.length).toBeGreaterThanOrEqual(2);
  });

  it('sets yellow themeColor for medium risk', () => {
    const msg = formatTeamsMessage(basePayload) as { themeColor: string };
    expect(msg.themeColor).toBe('FFC107');
  });
});

describe('formatGenericWebhook', () => {
  it('returns raw payload body with no extra headers when no secret', () => {
    const { body, headers } = formatGenericWebhook(basePayload);
    expect((body as NotificationPayload).executionId).toBe('exec-123');
    expect(headers['X-Pullmint-Signature']).toBeUndefined();
    expect(headers['X-Pullmint-Event']).toBe('analysis.completed');
  });

  it('adds HMAC-SHA256 signature header when secret provided', () => {
    const secret = 'my-secret';
    const { body, headers } = formatGenericWebhook(basePayload, secret);
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(body))
      .digest('hex');
    expect(headers['X-Pullmint-Signature']).toBe(`sha256=${expectedSig}`);
  });
});

describe('sendNotification', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('POSTs to webhook URL and resolves on 200', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    await expect(sendNotification(baseChannel, basePayload)).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      baseChannel.webhookUrl,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('retries once on 5xx and resolves after second success', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 }) as unknown as typeof fetch;
    await expect(sendNotification(baseChannel, basePayload)).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not throw after two 5xx responses', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(sendNotification(baseChannel, basePayload)).resolves.toBeUndefined();
  });

  it('retries once on timeout and resolves after second success', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce({ ok: true, status: 200 }) as unknown as typeof fetch;
    await expect(sendNotification(baseChannel, basePayload)).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not throw after two timeouts', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    global.fetch = jest.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;
    await expect(sendNotification(baseChannel, basePayload)).resolves.toBeUndefined();
  });
});
