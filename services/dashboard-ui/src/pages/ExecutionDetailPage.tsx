import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckpointTimeline } from '@/components/CheckpointTimeline';
import { FindingsTable } from '@/components/FindingsTable';
import { OverrideDialog } from '@/components/OverrideDialog';
import { RiskScore } from '@/components/RiskScore';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchCheckpoints, fetchExecution, rerunAnalysis } from '@/lib/api';

export function ExecutionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  const { data: execution, isLoading: executionLoading } = useQuery({
    queryKey: ['execution', id],
    queryFn: () => fetchExecution(id!),
    enabled: !!id,
  });

  const { data: checkpointData } = useQuery({
    queryKey: ['checkpoints', id],
    queryFn: () => fetchCheckpoints(id!),
    enabled: !!id,
  });

  async function handleRerun() {
    if (!id) return;
    setRerunning(true);
    try {
      await rerunAnalysis(id);
      toast.success('Analysis re-run triggered');
    } catch {
      toast.error('Failed to trigger re-run');
    } finally {
      setRerunning(false);
    }
  }

  if (executionLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!execution) {
    return <Card className="p-8 text-center text-muted-foreground">Execution not found.</Card>;
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-4" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>

        <Card className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-xl font-bold">
                {execution.repoFullName}{' '}
                <span className="font-normal text-muted-foreground">#{execution.prNumber}</span>
              </h1>
              {execution.title && (
                <p className="mt-1 text-sm text-muted-foreground">{execution.title}</p>
              )}
              <div className="mt-2 flex items-center gap-3">
                <StatusBadge status={execution.status} />
                {execution.author && (
                  <span className="text-sm text-muted-foreground">by {execution.author}</span>
                )}
                {execution.headSha && (
                  <span className="text-xs font-mono text-muted-foreground">
                    {execution.headSha.slice(0, 7)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <RiskScore score={execution.riskScore} size="lg" />
              <div className="flex flex-col gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void handleRerun();
                  }}
                  disabled={rerunning}
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  {rerunning ? 'Running...' : 'Re-run'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOverrideOpen(true)}>
                  <ShieldAlert className="mr-1 h-3 w-3" />
                  Override
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {checkpointData && (
        <Card className="p-6">
          <CheckpointTimeline checkpoints={checkpointData.checkpoints} />
        </Card>
      )}

      <Tabs defaultValue="findings" className="space-y-4">
        <TabsList>
          <TabsTrigger value="findings">Findings ({execution.findings?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="signals">Signals</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>

        <TabsContent value="findings">
          <Card className="p-4">
            {execution.findings && execution.findings.length > 0 ? (
              <FindingsTable findings={execution.findings} />
            ) : (
              <p className="py-8 text-center text-muted-foreground">
                No findings for this execution.
              </p>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="signals">
          <Card className="p-4">
            {checkpointData?.signalsReceived &&
            Object.keys(checkpointData.signalsReceived).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(checkpointData.signalsReceived).map(([key, signal]) => (
                  <div key={key} className="flex items-center gap-3 border-b py-2 last:border-0">
                    <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    <span className="text-sm font-medium">{key}</span>
                    <span className="text-xs text-muted-foreground">
                      {signal.source} -- {new Date(signal.receivedAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-muted-foreground">No signals received yet.</p>
            )}

            {checkpointData?.repoContext && (
              <div className="mt-4 rounded-lg border p-4">
                <h4 className="mb-2 text-sm font-semibold">Repo Context</h4>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    Blast radius multiplier:{' '}
                    <strong className="text-foreground">
                      {checkpointData.repoContext.blastRadiusMultiplier.toFixed(2)}x
                    </strong>
                  </p>
                  <p>
                    Downstream dependents:{' '}
                    <strong className="text-foreground">
                      {checkpointData.repoContext.downstreamDependentCount}
                    </strong>
                  </p>
                  <p>
                    30-day rollback rate:{' '}
                    <strong className="text-foreground">
                      {(checkpointData.repoContext.repoRollbackRate30d * 100).toFixed(1)}%
                    </strong>
                  </p>
                </div>
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="metadata">
          <Card className="p-4">
            <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs font-mono">
              {JSON.stringify(execution.metadata ?? {}, null, 2)}
            </pre>
          </Card>
        </TabsContent>
      </Tabs>

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        executionId={execution.executionId}
        currentRiskScore={execution.riskScore}
        currentDecision={execution.status}
      />
    </div>
  );
}
