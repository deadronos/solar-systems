import { describe, expect, it } from 'vitest';
import { formatRate, formatRateValue } from './format.ts';

describe('formatRateValue', () => {
  it('shows the measured rate instead of snapping to a preset', () => {
    const year = 31_557_600;
    expect(formatRate(0.73 * year)).toBe('1 year/s'); // the preset label hides the shortfall
    expect(formatRateValue(0.73 * year)).toBe('0.73 yr/s');
    expect(formatRateValue(year)).toBe('1 yr/s');
    expect(formatRateValue(0.29 * year)).toBe('3.5 mo/s');
    expect(formatRateValue(86_400)).toBe('1 d/s');
    expect(formatRateValue(12 * 3_600)).toBe('12 h/s');
    expect(formatRateValue(-60)).toBe('−1 min/s');
    expect(formatRateValue(0.2)).toBe('0.20 s/s');
  });
});
