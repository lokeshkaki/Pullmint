import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cn, formatRelativeTime, getRiskColor, getRiskBgColor, truncate } from '@/lib/utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional class names via clsx', () => {
    expect(cn('base', { active: true, inactive: false })).toBe('base active');
  });

  it('merges tailwind conflicting classes (last wins)', () => {
    // tailwind-merge: last padding class wins
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('handles undefined and falsy values gracefully', () => {
    expect(cn('foo', undefined, null, false, 'bar')).toBe('foo bar');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-05-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for timestamps less than 60 seconds ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 30_000)).toBe('just now');
    expect(formatRelativeTime(now - 0)).toBe('just now');
  });

  it('returns minutes ago for timestamps less than 1 hour', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5 * 60_000)).toBe('5m ago');
    expect(formatRelativeTime(now - 59 * 60_000)).toBe('59m ago');
  });

  it('returns hours ago for timestamps less than 1 day', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3 * 3_600_000)).toBe('3h ago');
    expect(formatRelativeTime(now - 23 * 3_600_000)).toBe('23h ago');
  });

  it('returns days ago for timestamps less than 30 days', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5 * 86_400_000)).toBe('5d ago');
    expect(formatRelativeTime(now - 29 * 86_400_000)).toBe('29d ago');
  });

  it('returns localized date string for timestamps older than 30 days', () => {
    const old = new Date('2024-03-01T00:00:00Z');
    const result = formatRelativeTime(old);
    expect(result).toBe(old.toLocaleDateString());
  });

  it('accepts string date inputs', () => {
    const now = Date.now();
    const dateStr = new Date(now - 2 * 60_000).toISOString();
    expect(formatRelativeTime(dateStr)).toBe('2m ago');
  });

  it('accepts Date object inputs', () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 90_000))).toBe('1m ago');
  });
});

describe('getRiskColor', () => {
  it('returns muted class for undefined score', () => {
    expect(getRiskColor(undefined)).toBe('text-muted-foreground');
  });

  it('returns low risk color for scores below 20', () => {
    expect(getRiskColor(0)).toBe('text-risk-low');
    expect(getRiskColor(19)).toBe('text-risk-low');
  });

  it('returns amber color for scores 20–39', () => {
    expect(getRiskColor(20)).toBe('text-brand-amber');
    expect(getRiskColor(39)).toBe('text-brand-amber');
  });

  it('returns orange color for scores 40–59', () => {
    expect(getRiskColor(40)).toBe('text-orange-500');
    expect(getRiskColor(59)).toBe('text-orange-500');
  });

  it('returns high risk color for scores 60+', () => {
    expect(getRiskColor(60)).toBe('text-risk-high');
    expect(getRiskColor(100)).toBe('text-risk-high');
  });
});

describe('getRiskBgColor', () => {
  it('returns muted bg for undefined score', () => {
    expect(getRiskBgColor(undefined)).toBe('bg-muted');
  });

  it('returns emerald bg for scores below 20', () => {
    expect(getRiskBgColor(10)).toContain('emerald');
  });

  it('returns amber bg for scores 20–39', () => {
    expect(getRiskBgColor(30)).toContain('amber');
  });

  it('returns orange bg for scores 40–59', () => {
    expect(getRiskBgColor(50)).toContain('orange');
  });

  it('returns red bg for scores 60+', () => {
    expect(getRiskBgColor(75)).toContain('red');
  });
});

describe('truncate', () => {
  it('returns the original string when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends ellipsis when string exceeds limit', () => {
    const result = truncate('hello world', 6);
    expect(result).toHaveLength(6);
    expect(result).toMatch(/…$/);
  });

  it('handles maxLen of 1', () => {
    const result = truncate('abcdef', 1);
    expect(result).toHaveLength(1);
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});
