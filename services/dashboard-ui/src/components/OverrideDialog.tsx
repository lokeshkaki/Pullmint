import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, reEvaluate } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RiskScore } from './RiskScore';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  executionId: string;
  currentRiskScore?: number;
  currentDecision?: string;
}

export function OverrideDialog({
  open,
  onOpenChange,
  executionId,
  currentRiskScore,
  currentDecision,
}: Props) {
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await reEvaluate(executionId, justification);
      toast.success('Override logged successfully');
      onOpenChange(false);
      setJustification('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        toast.error('Rate limit: please wait 2 minutes before re-evaluating again.');
      } else {
        toast.error('Override failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Override Decision</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Current Risk Score</p>
              <RiskScore score={currentRiskScore} />
            </div>
            {currentDecision && (
              <div>
                <p className="text-sm text-muted-foreground">Current Decision</p>
                <p className="text-sm font-medium capitalize">{currentDecision}</p>
              </div>
            )}
          </div>

          <div>
            <label className="text-sm font-medium">Justification</label>
            <textarea
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder="Explain why you are overriding the deployment gate..."
              className="mt-1 min-h-[100px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void handleSubmit();
            }}
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Submit Override'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
