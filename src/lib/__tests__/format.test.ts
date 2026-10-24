import { describe, expect, it } from 'vitest';
import { addMonths, calendarPeriods, daysBetween, investmentLabel, isUnlocked, monthlyReturn, periodAmount, rateShort } from '../format';
import { toCsv } from '../csv';
import type { Investment } from '../types';

describe('calendar months (must match the database)', () => {
  it('clamps to month end', () => {
    expect(addMonths('2026-05-31', 6)).toBe('2026-11-30');
    expect(addMonths('2027-08-31', 6)).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 12)).toBe('2027-01-31');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('counts days', () => {
    expect(daysBetween('2026-09-30', '2026-10-16')).toBe(16);
  });
});

describe('simple monthly return', () => {
  it('uses the original principal and rounds to 2 decimals', () => {
    expect(monthlyReturn(100000, 2)).toBe(2000);
    expect(monthlyReturn(250000, 4)).toBe(10000);
    expect(monthlyReturn(123456.78, 6)).toBe(7407.41);
    expect(monthlyReturn(1000.5, 1)).toBe(10.01); // 10.005 rounds half up
    expect(monthlyReturn(100000, 3.3)).toBe(3300);
    expect(monthlyReturn(123457, 3.3)).toBe(4074.08);
    expect(rateShort(3.3)).toBe('3.3%');
    expect(rateShort('2.0000')).toBe('2%');
  });
});

describe('investment label', () => {
  const base = { status: 'active', lockin_end_date: '2027-01-31', maturity_date: '2027-01-31' } as Investment;
  it('derives the state from dates', () => {
    expect(investmentLabel(base, 60, '2026-10-16')).toBe('Locked');
    expect(investmentLabel(base, 60, '2026-12-10')).toBe('Unlocking soon');
    expect(investmentLabel(base, 60, '2027-01-30')).toBe('Unlocking soon');
    expect(investmentLabel(base, 60, '2027-01-31')).toBe('Unlocked');
    expect(investmentLabel({ ...base, status: 'matured' }, 60, '2027-02-10')).toBe('Unlocked');
    expect(isUnlocked(base, '2027-01-30')).toBe(false);
    expect(isUnlocked(base, '2027-01-31')).toBe(true);
    expect(isUnlocked({ ...base, status: 'redeemed' }, '2027-03-01')).toBe(false);
    expect(investmentLabel({ ...base, status: 'pending_funding' }, 60, '2026-10-16')).toBe('Pending funding');
  });
});

describe('csv export', () => {
  it('quotes and neutralises formulas', () => {
    expect(toCsv(['a', 'b'], [['x,y', '=HYPERLINK("bad")'], [-5, 2.5]])).toBe('a,b\r\n"x,y","\'=HYPERLINK(""bad"")"\r\n-5,2.5');
  });
});

describe('calendar-month return periods', () => {
  it('starts the day after the start date and follows calendar months to maturity', () => {
    const p = calendarPeriods('2026-10-10', '2027-04-10');
    expect(p.map(x => [x.start, x.end, x.days, x.daysInMonth])).toEqual([
      ['2026-10-11', '2026-10-31', 21, 31], ['2026-11-01', '2026-11-30', 30, 30], ['2026-12-01', '2026-12-31', 31, 31],
      ['2027-01-01', '2027-01-31', 31, 31], ['2027-02-01', '2027-02-28', 28, 28], ['2027-03-01', '2027-03-31', 31, 31], ['2027-04-01', '2027-04-10', 10, 30]]);
  });
  it('skips the start month when the investment starts on its last day', () => {
    expect(calendarPeriods('2026-10-31', null, '2026-11-15')[0].start).toBe('2026-11-01');
  });
  it('pays a part month by days', () => {
    expect(periodAmount(100000, 6, { days: 21, daysInMonth: 31 })).toBe(4064.52);
    expect(periodAmount(100000, 6, { days: 30, daysInMonth: 30 })).toBe(6000);
  });
});
