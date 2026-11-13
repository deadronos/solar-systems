import { describe, expect, it } from 'vitest';
import { describeEvent, fmtDays, fmtMoney, fmtTonnes } from './format.ts';

describe('formatting', () => {
  it('formats money compactly with the credit sign', () => {
    expect(fmtMoney(0)).toBe('₡0');
    expect(fmtMoney(950)).toBe('₡950');
    expect(fmtMoney(12_500)).toBe('₡12.5k');
    expect(fmtMoney(1_234_567)).toBe('₡1.23M');
    expect(fmtMoney(-2_500_000_000)).toBe('−₡2.50B');
  });

  it('formats tonnes', () => {
    expect(fmtTonnes(0.4)).toBe('0.4 t');
    expect(fmtTonnes(12.34)).toBe('12 t');
    expect(fmtTonnes(1_500)).toBe('1,500 t');
    expect(fmtTonnes(2_500_000)).toBe('2.50 Mt');
  });

  it('formats durations', () => {
    expect(fmtDays(0.2)).toBe('5 h');
    expect(fmtDays(3.5)).toBe('3.5 d');
    expect(fmtDays(45)).toBe('45 d');
    expect(fmtDays(800)).toBe('2.2 yr');
  });

  it('describes events in plain language', () => {
    const names = (id: string) => ({ s1: 'Hauler 7', c1: 'Helix', mars: 'Mars Colony' })[id] ?? id;
    expect(
      describeEvent(
        {
          type: 'CargoSold',
          shipId: 's1',
          companyId: 'c1',
          settlementId: 'mars',
          good: 'steel',
          qty: 400,
          price: 410,
          seq: 1,
          jd: 0,
        },
        names,
      ),
    ).toBe('Hauler 7 sold 400 t steel at Mars Colony (₡410/t)');
    expect(describeEvent({ type: 'CompanyBankrupt', companyId: 'c1', seq: 2, jd: 0 }, names)).toBe(
      'Helix went bankrupt',
    );
  });
});
