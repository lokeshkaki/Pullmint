import { cn } from '@/lib/utils';

interface Props {
  score: number | undefined;
  size?: 'sm' | 'md' | 'lg';
}

export function RiskScore({ score, size = 'md' }: Props) {
  if (score === undefined) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-muted px-3 py-1">
        <span className="text-sm text-muted-foreground">--</span>
      </div>
    );
  }

  const colorClass =
    score < 20
      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
      : score < 40
        ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
        : score < 60
          ? 'bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400'
          : 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400';

  const sizeClass = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
    lg: 'px-4 py-2 text-2xl font-bold',
  }[size];

  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-semibold tabular-nums',
        colorClass,
        sizeClass
      )}
    >
      {score}
    </div>
  );
}
