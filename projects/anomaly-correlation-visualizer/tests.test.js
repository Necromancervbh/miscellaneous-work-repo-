import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import VisualizerComponent from './visualizer_component.jsx';

// Helper to suppress console errors during expected failure cases
const suppressConsoleError = (fn) => {
  const originalError = console.error;
  console.error = () => {};
  try {
    fn();
  } finally {
    console.error = originalError;
  }
};

describe('Anomaly Correlation Visualizer - VisualizerComponent', () => {
  afterEach(() => {
    cleanup();
  });

  // Normal input test
  it('renders correctly with a typical data set', () => {
    const sampleData = [0.1, 0.5, 0.9, 0.3, 0.7];
    render(<VisualizerComponent data={sampleData} title="Test Chart" />);
    // Expect the title to be rendered
    expect(screen.getByText('Test Chart')).toBeInTheDocument();
    // Expect a chart container (assuming it has role="img" or a canvas)
    const chart = screen.getByTestId('anomaly-correlation-chart');
    expect(chart).toBeInTheDocument();
    // Verify that the chart received the correct number of data points
    expect(chart.dataset.points).toBe(String(sampleData.length));
  });

  // Edge case: empty array
  it('handles empty data array gracefully', () => {
    const emptyData = [];
    render(<VisualizerComponent data={emptyData} title="Empty Data" />);
    expect(screen.getByText('Empty Data')).toBeInTheDocument();
    // Should render a placeholder or message indicating no data
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    // Chart element should not be rendered
    expect(screen.queryByTestId('anomaly-correlation-chart')).toBeNull();
  });

  // Edge case: array containing zero values
  it('renders correctly when data contains zeros', () => {
    const zeroData = [0, 0, 0, 0];
    render(<VisualizerComponent data={zeroData} title="Zero Data" />);
    expect(screen.getByText('Zero Data')).toBeInTheDocument();
    const chart = screen.getByTestId('anomaly-correlation-chart');
    expect(chart).toBeInTheDocument();
    // Ensure the component treats zeros as valid points
    expect(chart.dataset.points).toBe(String(zeroData.length));
  });

  // Edge case: null data prop
  it('does not crash when data prop is null', () => {
    suppressConsoleError(() => {
      render(<VisualizerComponent data={null} title="Null Data" />);
    });
    // Should fallback to empty state message
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('anomaly-correlation-chart')).toBeNull();
  });

  // Edge case: undefined data prop
  it('does not crash when data prop is undefined', () => {
    suppressConsoleError(() => {
      render(<VisualizerComponent title="Undefined Data" />);
    });
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('anomaly-correlation-chart')).toBe