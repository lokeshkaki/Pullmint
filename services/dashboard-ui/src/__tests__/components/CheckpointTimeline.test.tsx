import { render, screen } from '@testing-library/react';
import { CheckpointTimeline } from '@/components/CheckpointTimeline';
import type { Checkpoint } from '@/lib/types';

const checkpoints: Checkpoint[] = [
  {
    type: 'analysis',
    score: 42,
    confidence: 0.85,
    missingSignals: [],
    decision: 'approved',
    reason: 'Low risk score',
    evaluatedAt: Date.now(),
  },
  {
    type: 'pre-deploy',
    score: 38,
    confidence: 0.9,
    missingSignals: [],
    decision: 'approved',
    reason: 'CI passed',
    evaluatedAt: Date.now(),
  },
];

describe('CheckpointTimeline', () => {
  it('renders all 4 checkpoint labels', () => {
    render(<CheckpointTimeline checkpoints={checkpoints} />);
    expect(screen.getByText('Analysis')).toBeInTheDocument();
    expect(screen.getByText('Pre-Deploy')).toBeInTheDocument();
    expect(screen.getByText('T+5min')).toBeInTheDocument();
    expect(screen.getByText('T+30min')).toBeInTheDocument();
  });

  it('shows scores for completed checkpoints', () => {
    render(<CheckpointTimeline checkpoints={checkpoints} />);
    expect(screen.getByText('Score: 42')).toBeInTheDocument();
    expect(screen.getByText('Score: 38')).toBeInTheDocument();
  });

  it('renders step numbers for pending checkpoints', () => {
    render(<CheckpointTimeline checkpoints={checkpoints} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});
