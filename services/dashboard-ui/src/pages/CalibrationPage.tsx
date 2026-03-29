import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchCalibration, triggerReindex } from '@/lib/api';
import type { CalibrationRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

export function CalibrationPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['calibration'],
    queryFn: fetchCalibration,
  });

  const reindexMutation = useMutation({
    mutationFn: ({ owner, repo }: { owner: string; repo: string }) => triggerReindex(owner, repo),
    onSuccess: () => {
      toast.success('Reindexing triggered');
      void queryClient.invalidateQueries({ queryKey: ['calibration'] });
    },
    onError: () => toast.error('Failed to trigger reindexing'),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
    );
  }

  if (!data?.repos || data.repos.length === 0) {
    return (
      <Card className="p-12 text-center text-muted-foreground">
        No calibration data yet. Calibration begins after 10 deployments per repo.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {data.repos.map((repo) => (
        <CalibrationRow
          key={repo.repoFullName}
          repo={repo}
          onReindex={() => {
            const [owner, name] = repo.repoFullName.split('/');
            reindexMutation.mutate({ owner, repo: name });
          }}
        />
      ))}
    </div>
  );
}

function CalibrationRow({ repo, onReindex }: { repo: CalibrationRecord; onReindex: () => void }) {
  const [open, setOpen] = useState(false);
  const isActive = (repo.observationsCount ?? 0) >= 10;
  const successRate =
    repo.totalDeployments > 0
      ? ((repo.successCount / repo.totalDeployments) * 100).toFixed(1)
      : 'N/A';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="p-0">
        <CollapsibleTrigger className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50">
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
          />
          <span className="flex-1 text-sm font-medium">{repo.repoFullName}</span>
          <span className="text-xs text-muted-foreground">{repo.totalDeployments} deployments</span>
          <span className="text-xs text-muted-foreground">{successRate}%</span>
          <span
            className={cn(
              'text-xs font-semibold',
              !isActive && 'text-muted-foreground italic',
              isActive && repo.calibrationFactor > 1.1 && 'text-red-500',
              isActive && repo.calibrationFactor < 0.9 && 'text-emerald-500',
              isActive &&
                repo.calibrationFactor >= 0.9 &&
                repo.calibrationFactor <= 1.1 &&
                'text-foreground'
            )}
          >
            {isActive
              ? `${repo.calibrationFactor.toFixed(2)}x`
              : `Pending (${repo.observationsCount ?? 0}/10)`}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-4 border-t px-6 py-4">
            {repo.signalWeights && Object.keys(repo.signalWeights).length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  Signal Weights
                </h4>
                <div className="space-y-2">
                  {Object.entries(repo.signalWeights).map(([signal, weight]) => (
                    <div key={signal} className="flex items-center gap-3">
                      <span className="w-40 truncate text-xs">{signal}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.min((weight / 3) * 100, 100)}%` }}
                        />
                      </div>
                      <span className="w-12 text-right font-mono text-xs">{weight.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {repo.outcomeLog && repo.outcomeLog.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  Recent Outcomes
                </h4>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {repo.outcomeLog
                    .slice(-10)
                    .reverse()
                    .map((entry, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 border-b py-1 text-xs last:border-0"
                      >
                        <div
                          className={cn(
                            'h-2 w-2 rounded-full',
                            entry.rollback ? 'bg-red-500' : 'bg-emerald-500'
                          )}
                        />
                        <span>{entry.rollback ? 'Rollback' : 'Success'}</span>
                        <span className="text-muted-foreground">{entry.analysisDecision}</span>
                        <span className="ml-auto text-muted-foreground">
                          {new Date(entry.timestamp).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <Button size="sm" variant="outline" onClick={onReindex}>
              <RefreshCw className="mr-1 h-3 w-3" /> Reindex
            </Button>
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
