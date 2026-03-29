import { AlertTriangle, Check, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Checkpoint, CheckpointType } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHECKPOINT_ORDER: CheckpointType[] = [
  'analysis',
  'pre-deploy',
  'post-deploy-5',
  'post-deploy-30',
];

const CHECKPOINT_LABELS: Record<CheckpointType, string> = {
  analysis: 'Analysis',
  'pre-deploy': 'Pre-Deploy',
  'post-deploy-5': 'T+5min',
  'post-deploy-30': 'T+30min',
};

interface Props {
  checkpoints: Checkpoint[];
}

export function CheckpointTimeline({ checkpoints }: Props) {
  const [selected, setSelected] = useState<Checkpoint | null>(null);
  const checkpointByType = useMemo(
    () => new Map(checkpoints.map((checkpoint) => [checkpoint.type, checkpoint])),
    [checkpoints]
  );

  const activeIndex = CHECKPOINT_ORDER.findIndex((type) => !checkpointByType.has(type));

  return (
    <div>
      <div className="flex items-center justify-center gap-0">
        {CHECKPOINT_ORDER.map((type, index) => {
          const checkpoint = checkpointByType.get(type);
          const isActive =
            !checkpoint && index === (activeIndex === -1 ? CHECKPOINT_ORDER.length : activeIndex);

          return (
            <div key={type} className="flex items-center">
              {index > 0 && (
                <div
                  className={cn(
                    'h-0.5 w-12 sm:w-20',
                    checkpointByType.get(CHECKPOINT_ORDER[index - 1]) ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
              <button
                onClick={() => setSelected(checkpoint ?? null)}
                className="flex flex-col items-center gap-1"
              >
                <div
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white transition-all',
                    checkpoint?.decision === 'approved' && 'bg-emerald-500',
                    checkpoint?.decision === 'held' && 'bg-amber-500',
                    checkpoint?.decision === 'rollback' && 'bg-red-500',
                    !checkpoint && !isActive && 'bg-muted text-muted-foreground',
                    isActive && 'animate-pulse-dot bg-primary'
                  )}
                >
                  {checkpoint?.decision === 'approved' && <Check className="h-4 w-4" />}
                  {checkpoint?.decision === 'rollback' && <X className="h-4 w-4" />}
                  {checkpoint?.decision === 'held' && <AlertTriangle className="h-4 w-4" />}
                  {!checkpoint && <span>{index + 1}</span>}
                </div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {CHECKPOINT_LABELS[type]}
                </span>
                {checkpoint && (
                  <span className="text-[10px] text-muted-foreground">
                    Score: {checkpoint.score}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="mt-4 rounded-lg bg-muted p-4 text-sm">
          <p className="font-semibold">{CHECKPOINT_LABELS[selected.type]}</p>
          <p className="mt-1 text-muted-foreground">{selected.reason || 'No reason provided.'}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Score: {selected.score} | Confidence: {Math.round(selected.confidence * 100)}% |
            Decision: <strong>{selected.decision}</strong>
          </p>
        </div>
      )}
    </div>
  );
}
