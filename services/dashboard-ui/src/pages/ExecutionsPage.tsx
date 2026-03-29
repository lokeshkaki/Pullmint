import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Filter, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ExecutionCard } from '@/components/ExecutionCard';
import { RiskTrendChart } from '@/components/charts/RiskTrendChart';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchExecutions, fetchStats } from '@/lib/api';
import { useSSE } from '@/lib/sse';
import type { ExecutionListResponse } from '@/lib/types';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'analyzing', label: 'Analyzing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'deploying', label: 'Deploying' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'rolled-back', label: 'Rolled Back' },
];

const FINDING_TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'security', label: 'Security' },
  { value: 'performance', label: 'Performance' },
  { value: 'style', label: 'Style' },
];

interface Filters {
  search: string;
  repo: string;
  status: string;
  author: string;
  dateFrom: string;
  dateTo: string;
  riskMin: string;
  riskMax: string;
  findingType: string;
}

const emptyFilters: Filters = {
  search: '',
  repo: '',
  status: '',
  author: '',
  dateFrom: '',
  dateTo: '',
  riskMin: '',
  riskMax: '',
  findingType: '',
};

export function ExecutionsPage() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(emptyFilters);

  useSSE(appliedFilters.repo || undefined);

  const buildParams = (pageParam: number) => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(pageParam));
    (Object.entries(appliedFilters) as Array<[keyof Filters, string]>).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return params;
  };

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError } =
    useInfiniteQuery<ExecutionListResponse>({
      queryKey: ['executions', appliedFilters],
      queryFn: ({ pageParam }) => fetchExecutions(buildParams(pageParam as number)),
      initialPageParam: 0,
      getNextPageParam: (lastPage, _allPages, lastPageParam) => {
        if (lastPage.executions.length < PAGE_SIZE) return undefined;
        return (lastPageParam as number) + PAGE_SIZE;
      },
    });

  const repoParts = appliedFilters.repo ? appliedFilters.repo.split('/') : null;
  const { data: statsData } = useQuery({
    queryKey: ['stats', appliedFilters.repo],
    queryFn: () => {
      if (!repoParts || repoParts.length !== 2) {
        throw new Error('Invalid repo filter');
      }
      return fetchStats(repoParts[0], repoParts[1]);
    },
    enabled: !!repoParts && repoParts.length === 2,
  });

  const allExecutions = useMemo(() => data?.pages.flatMap((page) => page.executions) ?? [], [data]);

  const stats = useMemo(() => {
    const total = allExecutions.length;
    const scored = allExecutions.filter((execution) => execution.riskScore !== undefined);
    const avg =
      scored.length > 0
        ? scored.reduce((sum, execution) => sum + (execution.riskScore ?? 0), 0) / scored.length
        : 0;
    const completed = allExecutions.filter(
      (execution) => execution.status === 'confirmed' || execution.status === 'completed'
    ).length;
    const rolledBack = allExecutions.filter(
      (execution) => execution.status === 'rolled-back'
    ).length;

    return {
      total,
      avgRisk: avg.toFixed(1),
      approvalRate: total > 0 ? ((completed / total) * 100).toFixed(1) : '0',
      rollbackRate: total > 0 ? ((rolledBack / total) * 100).toFixed(1) : '0',
    };
  }, [allExecutions]);

  function applyFilters() {
    setAppliedFilters({ ...filters });
  }

  function clearFilters() {
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
  }

  function updateFilter(key: keyof Filters, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search repo or PR #..."
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
                className="pl-9"
                onKeyDown={(event) => event.key === 'Enter' && applyFilters()}
              />
            </div>
            <Input
              placeholder="owner/repo"
              value={filters.repo}
              onChange={(event) => updateFilter('repo', event.target.value)}
              className="w-40"
            />
            <select
              value={filters.status}
              onChange={(event) => updateFilter('status', event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Input
              placeholder="Author..."
              value={filters.author}
              onChange={(event) => updateFilter('author', event.target.value)}
              className="w-32"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">From:</span>
            <Input
              type="date"
              value={filters.dateFrom}
              onChange={(event) => updateFilter('dateFrom', event.target.value)}
              className="w-36"
            />
            <span className="text-xs text-muted-foreground">To:</span>
            <Input
              type="date"
              value={filters.dateTo}
              onChange={(event) => updateFilter('dateTo', event.target.value)}
              className="w-36"
            />
            <span className="text-xs text-muted-foreground">Risk:</span>
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="0"
              value={filters.riskMin}
              onChange={(event) => updateFilter('riskMin', event.target.value)}
              className="w-20"
            />
            <span className="text-xs text-muted-foreground">-</span>
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="100"
              value={filters.riskMax}
              onChange={(event) => updateFilter('riskMax', event.target.value)}
              className="w-20"
            />
            <select
              value={filters.findingType}
              onChange={(event) => updateFilter('findingType', event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {FINDING_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={applyFilters}>
                <Filter className="mr-1 h-3 w-3" /> Apply
              </Button>
              <Button size="sm" variant="outline" onClick={clearFilters}>
                <X className="mr-1 h-3 w-3" /> Clear
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: 'Total PRs', value: stats.total },
          { label: 'Avg Risk Score', value: stats.avgRisk },
          { label: 'Approval Rate', value: `${stats.approvalRate}%` },
          { label: 'Rollback Rate', value: `${stats.rollbackRate}%` },
        ].map((stat) => (
          <Card key={stat.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {stat.label}
            </p>
            <p className="mt-1 text-2xl font-bold">{stat.value}</p>
          </Card>
        ))}
      </div>

      {statsData?.trends?.riskScores && statsData.trends.riskScores.length >= 2 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Risk Score Trend</h3>
          <RiskTrendChart
            data={statsData.trends.riskScores.map((score) => ({
              label: `PR #${score.prNumber}`,
              riskScore: score.riskScore,
            }))}
          />
        </Card>
      )}

      <div className="space-y-3">
        {isLoading &&
          Array.from({ length: 5 }).map((_, index) => (
            <Card key={index} className="p-4">
              <div className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            </Card>
          ))}

        {isError && (
          <Card className="p-8 text-center text-destructive">
            Failed to load executions. Please try again.
          </Card>
        )}

        {!isLoading && allExecutions.length === 0 && (
          <Card className="p-12 text-center text-muted-foreground">
            No executions found. Adjust your filters or wait for PR activity.
          </Card>
        )}

        {allExecutions.map((execution) => (
          <ExecutionCard key={execution.executionId} execution={execution} />
        ))}

        {hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              onClick={() => {
                void fetchNextPage();
              }}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading...' : 'Load More'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
