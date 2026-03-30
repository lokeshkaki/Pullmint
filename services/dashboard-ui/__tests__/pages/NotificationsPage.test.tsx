import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { NotificationsPage } from '@/pages/NotificationsPage';
import type { NotificationChannel } from '@/lib/types';

const mockChannels: NotificationChannel[] = [
  {
    id: 'ch-1',
    name: 'Team Slack',
    type: 'slack',
    url: 'https://hooks.slack.com/services/T000/B000/xxxx',
    events: ['analysis_complete', 'rollback_triggered'],
    enabled: true,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 86_400_000,
  },
  {
    id: 'ch-2',
    name: 'Discord Alerts',
    type: 'discord',
    url: 'https://discord.com/api/webhooks/123/abc',
    events: ['high_risk_detected'],
    enabled: false,
    minRiskScore: 70,
    createdAt: Date.now() - 7 * 86_400_000,
    updatedAt: Date.now() - 7 * 86_400_000,
  },
];

function setupFetch(channels: NotificationChannel[] = mockChannels) {
  localStorage.setItem('pullmint_token', 'test-token');
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ channels }),
  });
}

beforeEach(() => {
  setupFetch();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('NotificationsPage', () => {
  it('shows loading skeletons before data arrives', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<NotificationsPage />);
    expect(screen.queryByText('Team Slack')).not.toBeInTheDocument();
  });

  it('shows empty state when no channels', async () => {
    setupFetch([]);
    renderWithProviders(<NotificationsPage />);
    expect(await screen.findByText(/No notification channels configured/i)).toBeInTheDocument();
  });

  it('renders notification channel names', async () => {
    renderWithProviders(<NotificationsPage />);
    expect(await screen.findByText('Team Slack')).toBeInTheDocument();
    expect(screen.getByText('Discord Alerts')).toBeInTheDocument();
  });

  it('renders channel types as badges', async () => {
    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');
    expect(screen.getByText('slack')).toBeInTheDocument();
    expect(screen.getByText('discord')).toBeInTheDocument();
  });

  it('renders event type badges for each channel', async () => {
    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');
    expect(screen.getByText('analysis complete')).toBeInTheDocument();
    expect(screen.getByText('rollback triggered')).toBeInTheDocument();
    expect(screen.getByText('high risk detected')).toBeInTheDocument();
  });

  it('renders Add Channel button', async () => {
    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');
    expect(screen.getByRole('button', { name: /Add Channel/i })).toBeInTheDocument();
  });

  it('opens the create dialog when Add Channel is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    await user.click(screen.getByRole('button', { name: /Add Channel/i }));

    expect(await screen.findByText('Add Notification Channel')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('My Slack Channel')).toBeInTheDocument();
  });

  it('submits create channel form with correct payload', async () => {
    const user = userEvent.setup();
    const createdChannel: NotificationChannel = {
      id: 'ch-new',
      name: 'New Webhook',
      type: 'webhook',
      url: 'https://example.com/hook',
      events: ['analysis_complete'],
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/notifications')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(createdChannel),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ channels: mockChannels }),
      });
    });

    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    await user.click(screen.getByRole('button', { name: /Add Channel/i }));
    await screen.findByText('Add Notification Channel');

    const nameInput = screen.getByPlaceholderText('My Slack Channel');
    await user.clear(nameInput);
    await user.type(nameInput, 'New Webhook');

    const urlInput = screen.getByPlaceholderText('https://hooks.slack.com/...');
    await user.clear(urlInput);
    await user.type(urlInput, 'https://example.com/hook');

    const saveButton = screen.getByRole('button', { name: /Create Channel/i });
    await user.click(saveButton);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const postCall = calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
      expect(postCall).toBeTruthy();
    });
  });

  it('renders edit buttons for each channel', async () => {
    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    const editButtons = screen.getAllByRole('button', { name: /Edit channel/i });
    expect(editButtons.length).toBe(2);
  });

  it('opens edit dialog with existing values when Edit is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    const editButtons = screen.getAllByRole('button', { name: /Edit channel/i });
    await user.click(editButtons[0]);

    expect(await screen.findByText('Edit Channel')).toBeInTheDocument();
    const nameInput = screen.getByDisplayValue('Team Slack');
    expect(nameInput).toHaveValue('Team Slack');
  });

  it('calls DELETE when delete is confirmed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ channels: mockChannels }),
      });
    });

    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    const deleteButtons = screen.getAllByRole('button', { name: /Delete channel/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const deleteCall = calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE');
      expect(deleteCall).toBeTruthy();
    });
  });

  it('does not call DELETE when delete confirmation is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ channels: mockChannels }),
    });
    globalThis.fetch = fetchMock;

    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    const deleteButtons = screen.getAllByRole('button', { name: /Delete channel/i });
    await user.click(deleteButtons[0]);

    const calls = fetchMock.mock.calls;
    const deleteCalls = calls.filter(([, init]) => (init as RequestInit)?.method === 'DELETE');
    expect(deleteCalls.length).toBe(0);
  });

  it('calls PUT to toggle channel enabled status', async () => {
    const user = userEvent.setup();

    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ...mockChannels[0], enabled: false }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ channels: mockChannels }),
      });
    });

    renderWithProviders(<NotificationsPage />);
    await screen.findByText('Team Slack');

    // Toggle the Switch for ch-1 (currently enabled)
    const switches = screen.getAllByRole('switch');
    await user.click(switches[0]);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const putCall = calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall as [string, RequestInit])[1].body as string) as {
        enabled: boolean;
      };
      expect(body.enabled).toBe(false);
    });
  });
});
