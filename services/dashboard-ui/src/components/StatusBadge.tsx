import { Badge } from '@/components/ui/badge';
import type { ExecutionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const statusStyles: Record<ExecutionStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  analyzing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  deploying: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  deployed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'deployment-blocked': 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  monitoring: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  confirmed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'rolled-back': 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};

interface Props {
  status: ExecutionStatus;
}

export function StatusBadge({ status }: Props) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        'border-0 text-[10px] font-semibold uppercase tracking-wider',
        statusStyles[status] ?? 'bg-muted text-muted-foreground'
      )}
    >
      {status}
    </Badge>
  );
}
