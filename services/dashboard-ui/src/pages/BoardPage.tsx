import { useQuery } from '@tanstack/react-query';
import { KanbanColumn } from '@/components/board/KanbanColumn';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchBoard } from '@/lib/api';
import { useSSE } from '@/lib/sse';

const BOARD_COLUMNS = [
  { key: 'analyzing', label: 'Analyzing' },
  { key: 'completed', label: 'Pre-Deploy Hold', highlight: true },
  { key: 'deploying', label: 'Deploying' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'rolled-back', label: 'Rolled Back' },
];

export function BoardPage() {
  useSSE();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['board'],
    queryFn: fetchBoard,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-64" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className="p-8 text-center text-destructive">
        Failed to load the risk board. Please try again.
      </Card>
    );
  }

  const board = data.board;
  const active = (board.deploying?.length ?? 0) + (board.monitoring?.length ?? 0);
  const held = board.completed?.length ?? 0;
  const rolledBack = board['rolled-back']?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex gap-6 text-sm text-muted-foreground">
        <span>
          <strong className="text-foreground">{active}</strong> active
        </span>
        <span>
          <strong className="text-foreground">{held}</strong> held
        </span>
        <span>
          <strong className="text-foreground">{rolledBack}</strong> rollbacks
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {BOARD_COLUMNS.map((column) => (
          <KanbanColumn
            key={column.key}
            title={column.label}
            cards={board[column.key] ?? []}
            highlight={column.highlight}
          />
        ))}
      </div>
    </div>
  );
}
