import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  createNotification,
  deleteNotification,
  fetchNotifications,
  updateNotification,
} from '@/lib/api';
import type {
  NotificationChannel,
  NotificationChannelType,
  NotificationEventType,
} from '@/lib/types';

const CHANNEL_TYPES: NotificationChannelType[] = ['slack', 'discord', 'teams', 'webhook'];

const EVENT_TYPES: { value: NotificationEventType; label: string }[] = [
  { value: 'analysis_complete', label: 'Analysis Complete' },
  { value: 'deployment_approved', label: 'Deployment Approved' },
  { value: 'rollback_triggered', label: 'Rollback Triggered' },
  { value: 'high_risk_detected', label: 'High Risk Detected' },
  { value: 'budget_exceeded', label: 'Budget Exceeded' },
];

interface FormState {
  name: string;
  type: NotificationChannelType;
  url: string;
  repoFilter: string;
  events: NotificationEventType[];
  minRiskScore: string;
  enabled: boolean;
}

const emptyForm: FormState = {
  name: '',
  type: 'slack',
  url: '',
  repoFilter: '',
  events: [],
  minRiskScore: '',
  enabled: true,
};

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
  });

  const createMutation = useMutation({
    mutationFn: createNotification,
    onSuccess: () => {
      toast.success('Channel created');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      closeDialog();
    },
    onError: () => toast.error('Failed to create channel'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<NotificationChannel> & { id: string }) =>
      updateNotification(id, data),
    onSuccess: () => {
      toast.success('Channel updated');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      closeDialog();
    },
    onError: () => toast.error('Failed to update channel'),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteNotification,
    onSuccess: () => {
      toast.success('Channel deleted');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => toast.error('Failed to delete channel'),
  });

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(channel: NotificationChannel) {
    setEditingId(channel.id);
    setForm({
      name: channel.name,
      type: channel.type,
      url: channel.url,
      repoFilter: channel.repoFilter ?? '',
      events: channel.events,
      minRiskScore: channel.minRiskScore?.toString() ?? '',
      enabled: channel.enabled,
    });
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  function handleSubmit() {
    const payload = {
      name: form.name,
      type: form.type,
      url: form.url,
      repoFilter: form.repoFilter || undefined,
      events: form.events,
      minRiskScore: form.minRiskScore ? Number(form.minRiskScore) : undefined,
      enabled: form.enabled,
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  function toggleEvent(event: NotificationEventType) {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((entry) => entry !== event)
        : [...prev.events, event],
    }));
  }

  function handleToggleEnabled(channel: NotificationChannel) {
    updateMutation.mutate({ id: channel.id, enabled: !channel.enabled });
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" /> Add Channel
        </Button>
      </div>

      {(!data?.channels || data.channels.length === 0) && (
        <Card className="p-12 text-center text-muted-foreground">
          No notification channels configured. Add one to get started.
        </Card>
      )}

      {data?.channels.map((channel) => (
        <Card key={channel.id} className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{channel.name}</h3>
                <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-medium uppercase">
                  {channel.type}
                </span>
              </div>
              <p className="mt-1 max-w-md truncate font-mono text-xs text-muted-foreground">
                {channel.url}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {channel.events.map((event) => (
                  <span
                    key={event}
                    className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                  >
                    {event.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
              {channel.repoFilter && (
                <p className="mt-1 text-xs text-muted-foreground">Repo: {channel.repoFilter}</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={channel.enabled}
                onCheckedChange={() => handleToggleEnabled(channel)}
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => openEdit(channel)}
                aria-label="Edit channel"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  if (confirm(`Delete channel "${channel.name}"?`)) {
                    deleteMutation.mutate(channel.id);
                  }
                }}
                aria-label="Delete channel"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      ))}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Channel' : 'Add Notification Channel'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="My Slack Channel"
              />
            </div>

            <div>
              <label className="text-sm font-medium">Type</label>
              <select
                value={form.type}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    type: event.target.value as NotificationChannelType,
                  }))
                }
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {CHANNEL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Webhook URL</label>
              <Input
                value={form.url}
                onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="https://hooks.slack.com/..."
              />
            </div>

            <div>
              <label className="text-sm font-medium">Repo Filter (optional)</label>
              <Input
                value={form.repoFilter}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, repoFilter: event.target.value }))
                }
                placeholder="owner/repo"
              />
            </div>

            <div>
              <label className="text-sm font-medium">Min Risk Score (optional)</label>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.minRiskScore}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, minRiskScore: event.target.value }))
                }
                placeholder="0"
              />
            </div>

            <div>
              <label className="text-sm font-medium">Events</label>
              <div className="mt-2 space-y-2">
                {EVENT_TYPES.map((eventType) => (
                  <label key={eventType.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.events.includes(eventType.value)}
                      onChange={() => toggleEvent(eventType.value)}
                      className="rounded"
                    />
                    {eventType.label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>{editingId ? 'Save Changes' : 'Create Channel'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
