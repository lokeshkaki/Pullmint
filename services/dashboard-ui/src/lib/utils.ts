import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(date: Date | number | string): string {
  const now = Date.now();
  const timestamp = typeof date === 'number' ? date : new Date(date).getTime();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function getRiskColor(score: number | undefined): string {
  if (score === undefined) return 'text-muted-foreground';
  if (score < 20) return 'text-risk-low';
  if (score < 40) return 'text-brand-amber';
  if (score < 60) return 'text-orange-500';
  return 'text-risk-high';
}

export function getRiskBgColor(score: number | undefined): string {
  if (score === undefined) return 'bg-muted';
  if (score < 20) return 'bg-emerald-100 dark:bg-emerald-900/30';
  if (score < 40) return 'bg-amber-100 dark:bg-amber-900/30';
  if (score < 60) return 'bg-orange-100 dark:bg-orange-900/30';
  return 'bg-red-100 dark:bg-red-900/30';
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}
