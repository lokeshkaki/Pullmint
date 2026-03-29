import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { FindingType } from '@/lib/types';

const COLORS: Record<FindingType, string> = {
  architecture: '#3b82f6',
  security: '#ef4444',
  performance: '#f59e0b',
  style: '#8b5cf6',
};

interface Props {
  data: Record<FindingType, number>;
}

export function FindingsPieChart({ data }: Props) {
  const chartData = Object.entries(data)
    .filter(([, value]) => value > 0)
    .map(([type, count]) => ({
      name: type.charAt(0).toUpperCase() + type.slice(1),
      value: count,
      color: COLORS[type as FindingType] ?? '#6b7280',
    }));

  if (chartData.length === 0) {
    return (
      <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No finding data available.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          dataKey="value"
          paddingAngle={2}
        >
          {chartData.map((entry, index) => (
            <Cell key={index} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            borderColor: 'hsl(var(--border))',
            borderRadius: '0.5rem',
            fontSize: 12,
          }}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
