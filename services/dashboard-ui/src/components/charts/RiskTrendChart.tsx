import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface DataPoint {
  label: string;
  riskScore: number;
  prCount?: number;
}

interface Props {
  data: DataPoint[];
  showPRCount?: boolean;
}

export function RiskTrendChart({ data, showPRCount }: Props) {
  if (showPRCount) {
    return (
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" />
          <YAxis
            yAxisId="risk"
            domain={[0, 100]}
            tick={{ fontSize: 10 }}
            className="fill-muted-foreground"
          />
          <YAxis
            yAxisId="count"
            orientation="right"
            tick={{ fontSize: 10 }}
            className="fill-muted-foreground"
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              borderColor: 'hsl(var(--border))',
              borderRadius: '0.5rem',
              fontSize: 12,
            }}
          />
          <Bar
            yAxisId="count"
            dataKey="prCount"
            fill="hsl(var(--primary) / 0.2)"
            radius={[4, 4, 0, 0]}
            name="PR Count"
          />
          <Area
            yAxisId="risk"
            type="monotone"
            dataKey="riskScore"
            stroke="hsl(var(--primary))"
            fill="hsl(var(--primary) / 0.1)"
            strokeWidth={2}
            name="Avg Risk"
          />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" />
        <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="fill-muted-foreground" />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            borderColor: 'hsl(var(--border))',
            borderRadius: '0.5rem',
            fontSize: 12,
          }}
        />
        <defs>
          <linearGradient id="riskGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="riskScore"
          stroke="hsl(var(--primary))"
          fill="url(#riskGradient)"
          strokeWidth={2}
          name="Risk Score"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
