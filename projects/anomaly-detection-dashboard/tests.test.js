import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import Dashboard from './dashboard';

describe('Dashboard Component', () => {
  afterEach(() => {
    cleanup();
  });

  const renderDashboard = (data) => {
    return render(<Dashboard data={data} />);
  };

  it('renders correctly with normal input', () => {
    const normalData = [
      { id: 1, value: 10, timestamp: 1620000000000 },
      { id: 2, value: 15, timestamp: 1620000060000 },
      { id: 3, value: 8, timestamp: 1620000120000 },
    ];
    renderDashboard(normalData);

    // Expect each data point to be rendered
    normalData.forEach((point) => {
      expect(screen.getByText(`Value: ${point.value}`)).toBeInTheDocument();
      expect(screen.getByText(new Date(point.timestamp).toLocaleString())).toBeInTheDocument();
    });

    // Expect no anomaly warning for normal values
    expect(screen.queryByText(/anomaly detected/i)).not.toBeInTheDocument();
  });

  it('handles empty data array gracefully', () => {
    renderDashboard([]);

    // Should show a placeholder or empty state message
    expect(screen.getByText(/no data available/i)).toBeInTheDocument();

    // No data rows should be rendered
    const rows = screen.queryAllByTestId('data-row');
    expect(rows.length).toBe(0);
  });

  it('handles zero values correctly', () => {
    const zeroData = [
      { id: 1, value: 0, timestamp: 1620000000000 },
      { id: 2, value: 0, timestamp: 1620000060000 },
    ];
    renderDashboard(zeroData);

    zeroData.forEach((point) => {
      expect(screen.getByText(`Value: ${point.value}`)).toBeInTheDocument();
    });

    // Zero should not be flagged as an anomaly unless threshold is zero
    expect(screen.queryByText(/anomaly detected/i)).not.toBeInTheDocument();
  });

  it('handles null values in data', () => {
    const nullData = [
      { id: 1, value: null, timestamp: 1620000000000 },
      { id: 2, value: 12, timestamp: 1620000060000 },
    ];
    renderDashboard(nullData);

    // Null values should be displayed as a placeholder
    expect(screen.getByText('Value: N/A')).toBeInTheDocument();

    // Valid value should be displayed normally
    expect(screen.getByText('Value: 12')).toBeInTheDocument();
  });

  it('handles negative numbers correctly', () => {
    const negativeData = [
      { id: 1, value: -5, timestamp: 1620000000000 },
      { id: 2, value: -20, timestamp: 1620000060000 },
    ];
    renderDashboard(negativeData);

    negativeData.forEach((point) => {
      expect(screen.getByText(`Value: ${point.value}`)).toBeInTheDocument();
    });

    // Assuming negative values are considered anomalies
    const anomalyWarnings = screen.getAllByText(/anomaly detected/i);
    expect(anomalyWarnings.length).toBeGreaterThanOrEqual(negativeData.length);
  });

  it