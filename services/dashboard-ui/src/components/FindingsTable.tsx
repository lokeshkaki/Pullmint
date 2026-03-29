import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { Finding, FindingSeverity, FindingType } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Props {
  findings: Finding[];
}

type SortKey = 'severity' | 'type' | 'title' | 'file';
type SortDir = 'asc' | 'desc';

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const severityColors: Record<FindingSeverity, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  high: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  medium: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  low: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  info: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

export function FindingsTable({ findings }: Props) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<FindingSeverity | ''>('');
  const [filterType, setFilterType] = useState<FindingType | ''>('');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const filtered = useMemo(() => {
    let result = [...findings];
    if (filterSeverity) result = result.filter((finding) => finding.severity === filterSeverity);
    if (filterType) result = result.filter((finding) => finding.type === filterType);

    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'severity') cmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sortKey === 'type') cmp = a.type.localeCompare(b.type);
      if (sortKey === 'title') cmp = a.title.localeCompare(b.title);
      if (sortKey === 'file') cmp = (a.file ?? '').localeCompare(b.file ?? '');
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return result;
  }, [filterSeverity, filterType, findings, sortDir, sortKey]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <select
          value={filterSeverity}
          onChange={(event) => setFilterSeverity(event.target.value as FindingSeverity | '')}
          className="h-8 rounded border border-input bg-background px-2 text-xs"
        >
          <option value="">All severities</option>
          {(['critical', 'high', 'medium', 'low', 'info'] as FindingSeverity[]).map((severity) => (
            <option key={severity} value={severity}>
              {severity}
            </option>
          ))}
        </select>
        <select
          value={filterType}
          onChange={(event) => setFilterType(event.target.value as FindingType | '')}
          className="h-8 rounded border border-input bg-background px-2 text-xs"
        >
          <option value="">All types</option>
          {(['architecture', 'security', 'performance', 'style'] as FindingType[]).map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="w-8" />
              {[
                { key: 'severity' as const, label: 'Severity' },
                { key: 'type' as const, label: 'Type' },
                { key: 'title' as const, label: 'Title' },
                { key: 'file' as const, label: 'File' },
              ].map((column) => (
                <th
                  key={column.key}
                  className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  onClick={() => toggleSort(column.key)}
                >
                  {column.label}
                  {sortKey === column.key && (sortDir === 'asc' ? ' ^' : ' v')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((finding, index) => (
              <Fragment key={`${finding.title}-${index}`}>
                <tr
                  className="cursor-pointer border-b transition-colors hover:bg-muted/50"
                  onClick={() => setExpandedIdx(expandedIdx === index ? null : index)}
                >
                  <td className="px-2 py-2 text-muted-foreground">
                    {expandedIdx === index ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase',
                        severityColors[finding.severity]
                      )}
                    >
                      {finding.severity}
                    </span>
                  </td>
                  <td className="px-3 py-2 capitalize">{finding.type}</td>
                  <td className="px-3 py-2">{finding.title}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {finding.file
                      ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
                      : '--'}
                  </td>
                </tr>
                {expandedIdx === index && (
                  <tr className="border-b">
                    <td colSpan={5} className="bg-muted/30 px-6 py-3">
                      <p className="text-sm">{finding.description}</p>
                      {finding.suggestion && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          <strong>Suggestion:</strong> {finding.suggestion}
                        </p>
                      )}
                      {finding.lifecycle && (
                        <span
                          className={cn(
                            'mt-2 inline-block rounded px-2 py-0.5 text-[10px] font-medium',
                            finding.lifecycle === 'new' &&
                              'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
                            finding.lifecycle === 'recurring' &&
                              'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
                            finding.lifecycle === 'resolved' &&
                              'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                          )}
                        >
                          {finding.lifecycle}
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No findings match the current filters.
        </p>
      )}
    </div>
  );
}
