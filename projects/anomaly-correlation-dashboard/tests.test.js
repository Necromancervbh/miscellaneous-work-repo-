import { describe, it, expect } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import Dashboard from './dashboard';

describe('Anomaly Correlation Real-Time Dashboard', () => {
  it('renders correctly with normal input', () => {
    const data = [
      { id: 1, value: 10, correlation: 0.8 },
      { id: 2, value: 20, correlation: 0.6 },
    ];