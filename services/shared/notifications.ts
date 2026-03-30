import * as crypto from 'crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export interface NotificationPayload {
  event: string;
  executionId: string;
  repoFullName: string;
  prNumber: number;
  prTitle?: string;
  author?: string;
  riskScore?: number;
  findingsCount?: number;
  status: string;
  dashboardUrl?: string;
  prUrl?: string;
  summary?: string;
  timestamp: number;
}

export interface NotificationChannel {
  id: number;
  name: string;
  channelType: string;
  webhookUrl: string;
  repoFilter: string | null;
  events: string[];
  minRiskScore: number | null;
  enabled: boolean;
  secret: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.internal',
  '169.254.169.254',
]);

function parseIPv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function isPrivateIPv4(ip: string): boolean {
  const octets = parseIPv4Octets(ip);
  if (!octets) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('fe80:')) {
    return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  const mappedIPv4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4Match) {
    return isPrivateIPv4(mappedIPv4Match[1]);
  }

  return false;
}

function isPrivateIP(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateIPv4(ip);
  }
  if (family === 6) {
    return isPrivateIPv6(ip);
  }
  return false;
}

export async function validateWebhookUrl(
  urlStr: string
): Promise<{ valid: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal')
  ) {
    return { valid: false, reason: 'Blocked hostname' };
  }

  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return { valid: false, reason: 'Private IP address not allowed' };
    }
    return { valid: true };
  }

  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      return { valid: false, reason: 'DNS resolution failed' };
    }

    for (const entry of addresses) {
      if (isPrivateIP(entry.address)) {
        return {
          valid: false,
          reason: `Hostname resolves to private IP: ${entry.address}`,
        };
      }
    }
  } catch {
    return { valid: false, reason: 'DNS resolution failed' };
  }

  return { valid: true };
}

function riskEmoji(riskScore?: number): string {
  if (riskScore === undefined || riskScore === null) return '⚪';
  if (riskScore < 20) return '🟢';
  if (riskScore < 40) return '🟡';
  return '🔴';
}

function riskColor(riskScore?: number): number {
  if (riskScore === undefined || riskScore === null) return 0x808080;
  if (riskScore < 20) return 0x22c55e;
  if (riskScore < 40) return 0xeab308;
  return 0xef4444;
}

function riskLabel(riskScore?: number): string {
  if (riskScore === undefined || riskScore === null) return 'N/A';
  if (riskScore < 20) return 'Low';
  if (riskScore < 40) return 'Medium';
  if (riskScore < 70) return 'High';
  return 'Critical';
}

function eventLabel(event: string): string {
  switch (event) {
    case 'analysis.completed':
      return 'Analysis Complete';
    case 'analysis.failed':
      return 'Analysis Failed';
    case 'deployment.rolled-back':
      return 'Deployment Rolled Back';
    default:
      return event;
  }
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatSlackMessage(payload: NotificationPayload): object {
  const emoji = riskEmoji(payload.riskScore);
  const score = payload.riskScore !== undefined ? payload.riskScore.toFixed(1) : 'N/A';
  const label = riskLabel(payload.riskScore);
  const title = payload.prTitle ?? `PR #${payload.prNumber}`;
  const eventText = eventLabel(payload.event);

  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Pullmint - ${eventText}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*PR*\n<${payload.prUrl ?? '#'}|${escapeSlack(title)}>`,
        },
        {
          type: 'mrkdwn',
          text: `*Repo*\n${escapeSlack(payload.repoFullName)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Author*\n${escapeSlack(payload.author ?? 'unknown')}`,
        },
        {
          type: 'mrkdwn',
          text: `*Status*\n${escapeSlack(payload.status)}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Risk Score*\n${emoji} ${score} (${label})`,
        },
        {
          type: 'mrkdwn',
          text: `*Findings*\n${payload.findingsCount ?? 0}`,
        },
      ],
    },
  ];

  if (payload.summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Summary*\n${escapeSlack(payload.summary)}`,
      },
    });
  }

  const actions: object[] = [];
  if (payload.dashboardUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View Dashboard', emoji: true },
      url: payload.dashboardUrl,
      action_id: 'view_dashboard',
    });
  }
  if (payload.prUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View PR', emoji: true },
      url: payload.prUrl,
      action_id: 'view_pr',
    });
  }

  if (actions.length > 0) {
    blocks.push({ type: 'actions', elements: actions });
  }

  blocks.push({ type: 'divider' });

  return { blocks };
}

export function formatDiscordMessage(payload: NotificationPayload): object {
  const emoji = riskEmoji(payload.riskScore);
  const score = payload.riskScore !== undefined ? payload.riskScore.toFixed(1) : 'N/A';
  const label = riskLabel(payload.riskScore);
  const title = payload.prTitle ?? `PR #${payload.prNumber}`;
  const eventText = eventLabel(payload.event);

  const fields: object[] = [
    { name: 'Repo', value: payload.repoFullName, inline: true },
    { name: 'Author', value: payload.author ?? 'unknown', inline: true },
    { name: 'Status', value: payload.status, inline: true },
    { name: 'Risk Score', value: `${emoji} ${score} (${label})`, inline: true },
    { name: 'Findings', value: String(payload.findingsCount ?? 0), inline: true },
  ];

  if (payload.prUrl) {
    fields.push({ name: 'Pull Request', value: payload.prUrl, inline: false });
  }

  if (payload.summary) {
    fields.push({ name: 'Summary', value: payload.summary, inline: false });
  }

  const embed: Record<string, unknown> = {
    title: `${emoji} ${eventText} - ${title}`,
    color: riskColor(payload.riskScore),
    fields,
    timestamp: new Date(payload.timestamp).toISOString(),
    footer: { text: 'Pullmint' },
  };

  if (payload.dashboardUrl) {
    embed.url = payload.dashboardUrl;
  }

  return { embeds: [embed] };
}

export function formatTeamsMessage(payload: NotificationPayload): object {
  const emoji = riskEmoji(payload.riskScore);
  const score = payload.riskScore !== undefined ? payload.riskScore.toFixed(1) : 'N/A';
  const label = riskLabel(payload.riskScore);
  const title = payload.prTitle ?? `PR #${payload.prNumber}`;
  const eventText = eventLabel(payload.event);

  const facts: object[] = [
    { title: 'Repo', value: payload.repoFullName },
    { title: 'Author', value: payload.author ?? 'unknown' },
    { title: 'Status', value: payload.status },
    { title: 'Risk Score', value: `${emoji} ${score} (${label})` },
    { title: 'Findings', value: String(payload.findingsCount ?? 0) },
  ];

  if (payload.summary) {
    facts.push({ title: 'Summary', value: payload.summary });
  }

  const actions: object[] = [];
  if (payload.dashboardUrl) {
    actions.push({
      '@type': 'OpenUri',
      name: 'View Dashboard',
      targets: [{ os: 'default', uri: payload.dashboardUrl }],
    });
  }
  if (payload.prUrl) {
    actions.push({
      '@type': 'OpenUri',
      name: 'View PR',
      targets: [{ os: 'default', uri: payload.prUrl }],
    });
  }

  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor:
      payload.riskScore !== undefined && payload.riskScore >= 40
        ? 'FF0000'
        : payload.riskScore !== undefined && payload.riskScore >= 20
          ? 'FFC107'
          : '22C55E',
    summary: `${eventText} - ${payload.repoFullName} PR #${payload.prNumber}`,
    sections: [
      {
        activityTitle: `${emoji} **${eventText}**`,
        activitySubtitle: title,
        facts,
        markdown: true,
      },
    ],
    potentialAction: actions,
  };
}

export function formatGenericWebhook(
  payload: NotificationPayload,
  secret?: string
): { body: object; headers: Record<string, string> } {
  const body = { ...payload };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Pullmint-Event': payload.event,
    'X-Pullmint-Delivery': payload.executionId,
  };

  if (secret) {
    const bodyStr = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
    headers['X-Pullmint-Signature'] = `sha256=${sig}`;
  }

  return { body, headers };
}

const REQUEST_TIMEOUT_MS = 5000;

export async function sendNotification(
  channel: NotificationChannel,
  payload: NotificationPayload
): Promise<void> {
  let body: object;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  try {
    const validation = await validateWebhookUrl(channel.webhookUrl);
    if (!validation.valid) {
      console.error(
        JSON.stringify({
          error: 'notification_url_blocked',
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.channelType,
          webhookUrl: channel.webhookUrl,
          reason: validation.reason,
        })
      );
      return;
    }

    switch (channel.channelType) {
      case 'slack':
        body = formatSlackMessage(payload);
        break;
      case 'discord':
        body = formatDiscordMessage(payload);
        break;
      case 'teams':
        body = formatTeamsMessage(payload);
        break;
      case 'webhook':
      default: {
        const result = formatGenericWebhook(payload, channel.secret ?? undefined);
        body = result.body;
        headers = result.headers;
        break;
      }
    }

    await dispatchWithRetry(channel.webhookUrl, body, headers, channel.name);
  } catch (err) {
    console.error(
      JSON.stringify({
        error: 'notification_send_failed',
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.channelType,
        event: payload.event,
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

async function dispatchWithRetry(
  url: string,
  body: object,
  headers: Record<string, string>,
  channelName: string,
  attempt = 1
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.ok) {
      return;
    }

    if (response.status >= 500 && attempt === 1) {
      console.warn(`[notifications] ${channelName} returned ${response.status}, retrying once...`);
      await dispatchWithRetry(url, body, headers, channelName, 2);
      return;
    }

    console.error(
      JSON.stringify({
        error: 'notification_http_error',
        channelName,
        status: response.status,
        attempt,
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (attempt === 1) {
        console.warn(`[notifications] ${channelName} timed out, retrying once...`);
        await dispatchWithRetry(url, body, headers, channelName, 2);
        return;
      }
      console.error(JSON.stringify({ error: 'notification_timeout', channelName, attempt }));
      return;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
