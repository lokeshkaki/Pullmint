import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import type { Execution } from '@/lib/types';
import { formatRelativeTime, truncate } from '@/lib/utils';
import { RiskScore } from './RiskScore';
import { StatusBadge } from './StatusBadge';

interface Props {
  execution: Execution;
}

export function ExecutionCard({ execution }: Props) {
  const navigate = useNavigate();
  const criticalAndHigh = (execution.findings ?? []).filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high'
  );

  return (
    <Card
      className="cursor-pointer p-4 transition-colors hover:bg-accent/50"
      onClick={() => navigate(`/execution/${execution.executionId}`)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="font-semibold">
              {execution.repoFullName}{' '}
              <span className="font-normal text-muted-foreground">#{execution.prNumber}</span>
            </span>
            <StatusBadge status={execution.status} />
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {execution.timestamp && <span>{formatRelativeTime(execution.timestamp)}</span>}
            {execution.headSha && (
              <span className="font-mono">{execution.headSha.slice(0, 7)}</span>
            )}
            {execution.author && <span>{execution.author}</span>}
          </div>

          {criticalAndHigh.length > 0 && (
            <div className="mt-2 space-y-1">
              {criticalAndHigh.slice(0, 3).map((finding, index) => (
                <div key={`${finding.title}-${index}`} className="flex items-center gap-2 text-xs">
                  <span
                    className={
                      finding.severity === 'critical'
                        ? 'font-semibold uppercase text-risk-critical'
                        : 'font-semibold uppercase text-brand-amber'
                    }
                  >
                    {finding.severity}
                  </span>
                  <span className="text-muted-foreground">{truncate(finding.title, 80)}</span>
                </div>
              ))}
              {(execution.findings?.length ?? 0) > 3 && (
                <p className="text-xs text-muted-foreground">
                  +{(execution.findings?.length ?? 0) - 3} more findings
                </p>
              )}
            </div>
          )}
        </div>

        <RiskScore score={execution.riskScore} />
      </div>
    </Card>
  );
}
