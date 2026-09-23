import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import HeatmapDashboard from './HeatmapDashboard.jsx';

describe('HeatmapDashboard Component', () => {
  afterEach(() => {
    cleanup();
  });

  const generateData = (rows, cols, valueFn) => {
    const data = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push(valueFn(r, c));
      }
      data.push(row);
    }
    return data;
  };

  it('renders correctly with normal input data', () => {
    const normalData = generateData(3, 3, (r, c) => r * 3 + c + 1); // 1..9
    render(<HeatmapDashboard data={normalData} />);
    // Expect a cell for each data point
    normalData.flat().forEach((value) => {
      expect(screen.getByText(String(value))).toBeInTheDocument();
    });
    // Expect the heatmap container to be present
    expect(screen.getByTestId('heatmap-container')).toBeInTheDocument();
  });

  it('handles empty data array gracefully', () => {
    render(<HeatmapDashboard data={[]} />);
    // Should show a fallback message
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    // No heatmap cells should be rendered
    expect(screen.queryAllByTestId('heatmap-cell')).toHaveLength(0);
  });

  it('handles data with zero values', () => {
    const zeroData = [
      [0, 0],
      [0, 0],
    ];
    render(<HeatmapDashboard data={zeroData} />);
    // Zero values should still render as cells
    const cells = screen.getAllByTestId('heatmap-cell');
    expect(cells).toHaveLength(4);
    cells.forEach((cell) => {
      expect(cell).toHaveTextContent('0');
    });
  });

  it('handles null values within the data matrix', () => {
    const nullData = [
      [null, 5],
      [10, null],
    ];
    render(<HeatmapDashboard data={nullData} />);
    // Assuming null values are rendered as empty cells or a placeholder
    const cells = screen.getAllByTestId('heatmap-cell');
    expect(cells).toHaveLength(4);
    // Cells with numbers should display the number
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    // Null cells might be empty strings or a dash
    const nullCells = cells.filter((c) => c.textContent === '' || c.textContent === '-');
    expect(nullCells).toHaveLength(2);
  });

  it('handles negative numbers correctly', () => {
    const negativeData = [
      [-1, -5],
      [-10, -0.5],
    ];
    render(<HeatmapDashboard data={negativeData} />);
    // All negative values should be rendered
    negativeData.flat().forEach((value) => {
      expect(screen.getByText(String(value))).toBeInTheDocument();
    });
    // Optionally, check that a CSS class for negative values is applied
    const negativeCells = screen.getAllByTestId('heatmap-cell').filter((cell) =>
      negativeData.flat().some((val) => String(val) === cell.text