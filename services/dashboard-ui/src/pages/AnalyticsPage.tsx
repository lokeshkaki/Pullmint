import { useQuery } from '@tanstack/react-query';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { FindingsPieChart } from '@/components/charts/FindingsPieChart';
import { RiskTrendChart } from '@/components/charts/RiskTrendChart';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchAnalyticsAuthors,
  fetchAnalyticsRepos,
  fetchAnalyticsSummary,
  fetchAnalyticsTrends,
} from '@/lib/api';
import type { AuthorStats, RepoStats } from '@/lib/types';

export function AnalyticsPage() {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['analytics-summary', dateFrom, dateTo],
    queryFn: () => fetchAnalyticsSummary(params),
  });

  const { data: trendsData } = useQuery({
    queryKey: ['analytics-trends', dateFrom, dateTo],
    queryFn: () => fetchAnalyticsTrends(params),
  });

  const { data: authorsData } = useQuery({
    queryKey: ['analytics-authors', dateFrom, dateTo],
    queryFn: () => fetchAnalyticsAuthors(params),
  });

  const { data: reposData } = useQuery({
    queryKey: ['analytics-repos', dateFrom, dateTo],
    queryFn: () => fetchAnalyticsRepos(params),
  });

  return (
    <div className="space-y-6">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <span className="text-sm text-muted-foreground">From:</span>
        <Input
          type="date"
          value={dateFrom}
          onChange={(event) => setDateFrom(event.target.value)}
          className="w-40"
        />
        <span className="text-sm text-muted-foreground">To:</span>
        <Input
          type="date"
          value={dateTo}
          onChange={(event) => setDateTo(event.target.value)}
          className="w-40"
        />
      </Card>

      {summaryLoading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: 'Total PRs', value: summary.totalPRs },
            { label: 'Avg Risk', value: summary.avgRiskScore.toFixed(1) },
            { label: 'Approval Rate', value: `${(summary.approvalRate * 100).toFixed(1)}%` },
            { label: 'Rollback Rate', value: `${(summary.rollbackRate * 100).toFixed(1)}%` },
          ].map((stat) => (
            <Card key={stat.label} className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </p>
              <p className="mt-1 text-2xl font-bold">{stat.value}</p>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Risk Trend</h3>
          {trendsData?.trends ? (
            <RiskTrendChart
              data={trendsData.trends.map((trend) => ({
                label: trend.date,
                riskScore: trend.avgRisk,
                prCount: trend.prCount,
              }))}
              showPRCount
            />
          ) : (
            <Skeleton className="h-48" />
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Findings by Type</h3>
          {summary?.findingsByType ? (
            <FindingsPieChart data={summary.findingsByType} />
          ) : (
            <Skeleton className="h-48" />
          )}
        </Card>
      </div>

      {authorsData?.authors && authorsData.authors.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Author Leaderboard</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Author
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    PRs
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Avg Risk
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Rollback Rate
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Trend
                  </th>
                </tr>
              </thead>
              <tbody>
                {authorsData.authors.map((author: AuthorStats) => (
                  <tr key={author.author} className="border-b">
                    <td className="px-3 py-2 font-medium">{author.author}</td>
                    <td className="px-3 py-2">{author.prCount}</td>
                    <td className="px-3 py-2">{author.avgRisk.toFixed(1)}</td>
                    <td className="px-3 py-2">{(author.rollbackRate * 100).toFixed(1)}%</td>
                    <td className="px-3 py-2">
                      {author.trend === 'improving' && (
                        <TrendingDown className="h-4 w-4 text-emerald-500" />
                      )}
                      {author.trend === 'declining' && (
                        <TrendingUp className="h-4 w-4 text-red-500" />
                      )}
                      {author.trend === 'stable' && (
                        <Minus className="h-4 w-4 text-muted-foreground" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {reposData?.repos && reposData.repos.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Repo Comparison</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Repo
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    PRs
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Avg Risk
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Rollback Rate
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    Calibration
                  </th>
                </tr>
              </thead>
              <tbody>
                {reposData.repos.map((repo: RepoStats) => (
                  <tr key={repo.repoFullName} className="border-b">
                    <td className="px-3 py-2 font-medium">{repo.repoFullName}</td>
                    <td className="px-3 py-2">{repo.prCount}</td>
                    <td className="px-3 py-2">{repo.avgRisk.toFixed(1)}</td>
                    <td className="px-3 py-2">{(repo.rollbackRate * 100).toFixed(1)}%</td>
                    <td className="px-3 py-2">{repo.calibrationFactor.toFixed(2)}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
