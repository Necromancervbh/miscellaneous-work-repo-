import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import Dashboard from './dashboard';

afterEach(() => {
  cleanup();
});

const generateData = (overrides = []) => {
  const base = [
    { id: 1, name: 'Anomaly A', correlation: 0.75 },
    { id: 2, name: 'Anomaly B', correlation: 0.45 },
    { id: 3, name: 'Anomaly C', correlation: 0.92 },
  ];
  return base.map((item, idx) => ({ ...item, ...overrides[idx] }));
};

describe('Dashboard Component - Normal Input', () => {
  it('renders a list of anomalies with correct correlation values', () => {
    const data = generateData();
    render(<Dashboard data={data} />);

    data.forEach((item) => {
      expect(screen.getByText(item.name)).toBeInTheDocument();
      // correlation displayed with two decimal places
      const formatted = item.correlation.toFixed(2);
      expect(screen.getByText(formatted)).toBeInTheDocument();
    });
  });

  it('calculates and displays the average correlation correctly', () => {
    const data = generateData();
    const avg =
      data.reduce((sum, cur) => sum + cur.correlation, 0) / data.length;
    render(<Dashboard data={data} />);

    const avgFormatted = avg.toFixed(2);
    expect(screen.getByText(`Average: ${avgFormatted}`)).toBeInTheDocument();
  });
});

describe('Dashboard Component - Edge Cases', () => {
  it('shows a placeholder when data array is empty', () => {
    render(<Dashboard data={[]} />);
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });

  it('handles zero correlation values gracefully', () => {
    const data = [{ id: 1, name: 'Zero Correlation', correlation: 0 }];
    render(<Dashboard data={data} />);
    expect(screen.getByText('Zero Correlation')).toBeInTheDocument();
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('ignores null correlation entries and still renders others', () => {
    const data = [
      { id: 1, name: 'Valid Anomaly', correlation: 0.6 },
      { id: 2, name: 'Null Correlation', correlation: null },
    ];
    render(<Dashboard data={data} />);
    expect(screen.getByText('Valid Anomaly')).toBeInTheDocument();
    expect(screen.getByText('0.60')).toBeInTheDocument();
    // Null entry should not render a numeric value
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    // It may still render the name, depending on implementation
    expect(screen.getByText('Null Correlation')).toBeInTheDocument();
  });

  it('displays negative correlation values with a warning style', () => {
    const data = [{ id: 1, name: 'Negative Anomaly', correlation: -0.3 }];
    render(<Dashboard data={data} />);
    const row = screen.getByText('Negative Anomaly').closest('tr') || screen.getByText('Negative Anomaly');
    expect(row