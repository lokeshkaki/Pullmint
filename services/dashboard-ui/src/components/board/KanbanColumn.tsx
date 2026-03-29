import type { BoardCard } from '@/lib/types';
import { cn } from '@/lib/utils';
import { KanbanCard } from './KanbanCard';

interface Props {
  title: string;
  cards: BoardCard[];
  highlight?: boolean;
}

export function KanbanColumn({ title, cards, highlight }: Props) {
  return (
    <div className={cn('rounded-xl border bg-card', highlight && 'border-t-4 border-t-amber-400')}>
      <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
          {cards.length}
        </span>
      </div>
      <div className="max-h-[500px] space-y-2 overflow-y-auto p-3">
        {cards.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No deployments</p>
        ) : (
          cards.map((card) => <KanbanCard key={card.executionId} card={card} />)
        )}
      </div>
    </div>
  );
}
