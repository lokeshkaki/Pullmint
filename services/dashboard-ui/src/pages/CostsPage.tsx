import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchBudgetStatus, fetchCosts } from '@/lib/api';

export function CostsPage() {
  const { data: costs, isLoading } = useQuery({
    queryKey: ['costs'],
    queryFn: () => fetchCosts(),
  });

  useQuery({
    queryKey: ['budget-status'],
    queryFn: fetchBudgetStatus,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!costs) {
    return <Card className="p-8 text-center text-muted-foreground">No cost data available.</Card>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: 'Spend MTD', value: `$${costs.totalSpendMTD.toFixed(2)}` },
          {
            label: 'Tokens Used',
            value:
              costs.totalTokens >= 1_000_000
                ? `${(costs.totalTokens / 1_000_000).toFixed(1)}M`
                : `${(costs.totalTokens / 1_000).toFixed(0)}K`,
          },
          { label: 'Avg Cost/PR', value: `$${costs.avgCostPerPR.toFixed(3)}` },
          { label: 'Projected Monthly', value: `$${costs.projectedMonthly.toFixed(2)}` },
        ].map((stat) => (
          <Card key={stat.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {stat.label}
            </p>
            <p className="mt-1 text-2xl font-bold">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Daily Spend</h3>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={costs.dailySpend}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <defs>
              <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="cost"
              stroke="#3b82f6"
              fill="url(#costGradient)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Cost by Repo</h3>
          <div className="space-y-3">
            {costs.byRepo.map((repo) => (
              <div key={repo.repoFullName}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{repo.repoFullName}</span>
                  <span>${repo.cost.toFixed(2)}</span>
                </div>
                {repo.budget && (
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.min((repo.cost / repo.budget) * 100, 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Cost by Agent</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={costs.byAgent} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis dataKey="agent" type="category" width={100} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="cost" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Cost by Model</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                  Model
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                  Cost
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                  Tokens
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                  Calls
                </th>
              </tr>
            </thead>
            <tbody>
              {costs.byModel.map((model) => (
                <tr key={model.model} className="border-b">
                  <td className="px-3 py-2 font-mono text-xs">{model.model}</td>
                  <td className="px-3 py-2">${model.cost.toFixed(3)}</td>
                  <td className="px-3 py-2">{(model.tokens / 1000).toFixed(0)}K</td>
                  <td className="px-3 py-2">{model.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
