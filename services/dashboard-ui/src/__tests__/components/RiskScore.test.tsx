import { render, screen } from '@testing-library/react';
import { RiskScore } from '@/components/RiskScore';

describe('RiskScore', () => {
  it('renders "--" for undefined score', () => {
    render(<RiskScore score={undefined} />);
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('renders the numeric score', () => {
    render(<RiskScore score={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('applies green color for low risk (< 20)', () => {
    const { container } = render(<RiskScore score={15} />);
    expect(container.firstChild).toHaveClass('text-emerald-600');
  });

  it('applies amber color for medium risk (20-39)', () => {
    const { container } = render(<RiskScore score={30} />);
    expect(container.firstChild).toHaveClass('text-amber-600');
  });

  it('applies orange color for elevated risk (40-59)', () => {
    const { container } = render(<RiskScore score={50} />);
    expect(container.firstChild).toHaveClass('text-orange-600');
  });

  it('applies red color for high risk (>= 60)', () => {
    const { container } = render(<RiskScore score={75} />);
    expect(container.firstChild).toHaveClass('text-red-600');
  });

  it('supports size variants', () => {
    const { container } = render(<RiskScore score={42} size="lg" />);
    expect(container.firstChild).toHaveClass('text-2xl');
  });
});
