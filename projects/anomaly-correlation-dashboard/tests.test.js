import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AnomalyCorrelationDashboard } from './dashboard';

describe('AnomalyCorrelationDashboard', () => {
  afterEach(() => {
    cleanup();
  });

  // Normal input
  it('renders correctly with typical data set', () => {
    const data = [0.1, 0.5, 0.9, 0.3, 0.7];
    render(<AnomalyCorrelationDashboard data={data} />);
    // Assuming the component displays a title
    expect(screen.getByText(/anomaly correlation/i)).toBeInTheDocument();
    // Assuming it renders a chart container
    expect(screen.getByTestId('correlation-chart')).toBeInTheDocument();
    // Verify that the number of data points rendered matches input length
    const points = screen.getAllByTestId('chart-point');
    expect(points).toHaveLength(data.length);
  });

  // Edge case: empty array
  it('handles empty data array gracefully', () => {
    const data: number[] = [];
    render(<AnomalyCorrelationDashboard data={data} />);
    expect(screen.getByText(/no data available/i)).toBeInTheDocument();
    // Chart should not be rendered
    expect(screen.queryByTestId('correlation-chart')).not.toBeInTheDocument();
  });

  // Edge case: zero values
  it('renders correctly when data contains zeros', () => {
    const data = [0, 0, 0, 0];
    render(<AnomalyCorrelationDashboard data={data} />);
    const points = screen.getAllByTestId('chart-point');
    expect(points).toHaveLength(data.length);
    // All points should be positioned at the baseline (e.g., y=0)
    points.forEach((point) => {
      expect(point).toHaveAttribute('data-y', '0');
    });
  });

  // Edge case: null data prop
  it('displays error message when data prop is null', () => {
    // @ts-ignore – intentionally passing null to test robustness
    render(<AnomalyCorrelationDashboard data={null} />);
    expect(screen.getByText(/invalid data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('correlation-chart')).not.toBeInTheDocument();
  });

  // Edge case: negative numbers
  it('handles negative values correctly', () => {
    const data = [-0.8, -0.3, -0.5];
    render(<AnomalyCorrelationDashboard data={data} />);
    const points = screen.getAllByTestId('chart-point');
    expect(points).toHaveLength(data.length);
    // Verify that points are rendered below the baseline (e.g., y < 0)
    points.forEach((point, idx) => {
      const yValue = parseFloat(point.getAttribute('data-y') ?? '0');
      expect(yValue).toBeLessThan(0);
      expect(yValue).toBeCloseTo(data[idx], 5);
    });
  });