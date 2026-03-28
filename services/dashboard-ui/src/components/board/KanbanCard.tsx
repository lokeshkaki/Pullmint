import { useNavigate } from 'react-router-dom';
import type { BoardCard } from '@/lib/types';
import { formatRelativeTime } from '@/lib/utils';
import { RiskScore } from '@/components/RiskScore';

interface Props {
  card: BoardCard;
}

export function KanbanCard({ card }: Props) {
  const navigate = useNavigate();

  return (
    <div
      className="cursor-pointer rounded-lg border bg-card p-3 transition-shadow hover:shadow-md"
      onClick={() => navigate(`/execution/${card.executionId}`)}
    >
      <p className="truncate text-sm font-semibold">
        {card.repoFullName}{' '}
        <span className="font-normal text-muted-foreground">#{card.prNumber}</span>
      </p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{card.author ?? ''}</span>
        <RiskScore score={card.riskScore} size="sm" />
      </div>
      {card.timestamp && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {formatRelativeTime(card.timestamp)}
        </p>
      )}
      {card.confidenceScore !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.round(card.confidenceScore * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
