// Data loading and small date helpers shared by the investor portal pages.
// Every figure shown comes from rows the signed-in investor can read (RLS).
import { api, must, fetchAll, rpc } from '../lib/api';
import { addMonths, calendarPeriods, daysBetween, today, type CalPeriod } from '../lib/format';
import type { Accrual, Balance, Investment, LedgerEntry, MyAccount, Payout } from '../lib/types';

/** The signed-in investor: whether they are an IB, their IB (if any), their sub-investors and bank details. */
export const loadAccount = () => rpc<MyAccount | null>('my_account');

/** Investments that are funded and not yet settled. */
export const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
export const isLive = (i: Investment) => LIVE.includes(i.status);

export interface Portfolio {
  investments: Investment[];
  balances: Record<string, Balance>;
  accruals: Accrual[];
  payouts: Payout[];
}

const ZERO = (id: string): Balance => ({ investment_id: id, accrued: 0, paid: 0, processing: 0, approved: 0, unapproved: 0, periods_accrued: 0 });
export const bal = (p: Portfolio, id: string) => p.balances[id] || ZERO(id);
/** Returns earned but not yet confirmed as paid (sums of payout rows by status, from the balances view). */
export const unpaid = (b: Balance) => Number(b.unapproved) + Number(b.approved) + Number(b.processing);

export async function loadInvestments(investorId: string): Promise<Investment[]> {
  return must(await api.from('investments').select('*').eq('investor_id', investorId).order('created_at', { ascending: false })) as Investment[];
}

export async function loadPortfolio(investorId: string): Promise<Portfolio> {
  const investments = await loadInvestments(investorId);
  const ids = investments.map(i => i.id);
  if (!ids.length) return { investments, balances: {}, accruals: [], payouts: [] };
  const [bs, accruals, payouts] = await Promise.all([
    api.from('investment_balances').select('*').in('investment_id', ids),
    fetchAll<Accrual>((a, b) => api.from('accruals').select('*').in('investment_id', ids).order('accrual_date', { ascending: false }).order('period_no', { ascending: false }).range(a, b)),
    fetchAll<Payout>((a, b) => api.from('payouts').select('*').eq('investor_id', investorId).order('due_date', { ascending: false }).range(a, b))
  ]);
  const balances: Record<string, Balance> = {};
  (must(bs) as Balance[]).forEach(b => { balances[b.investment_id] = b; });
  return { investments, balances, accruals, payouts };
}

export async function loadLedger(investorId: string): Promise<LedgerEntry[]> {
  return fetchAll<LedgerEntry>((a, b) => api.from('ledger_entries').select('*').eq('investor_id', investorId)
    .order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).range(a, b));
}

/** Map investment id → code for labelling rows. */
export const codeMap = (inv: Investment[]) => Object.fromEntries(inv.map(i => [i.id, i.code])) as Record<string, string>;

export function addDays(iso: string, n: number): string {
  const d = new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Return periods follow calendar months: started 10 Oct → 11–31 Oct (pro-rata), then 1–30 Nov, 1–31 Dec …
 *  With a lock-in they run to the maturity date; without one, up to next month. */
export function periodsFor(i: Pick<Investment, 'start_date' | 'lockin_months' | 'maturity_date'>, t = today()): CalPeriod[] {
  if (!i.start_date) return [];
  return calendarPeriods(i.start_date, i.lockin_months > 0 ? i.maturity_date || addMonths(i.start_date, i.lockin_months) : null, addMonths(t.slice(0, 7) + '-01', 1));
}
/** The monthly return for a period: whole for a full month, by days for a part month. */
export const periodReturn = (monthly: number, p: Pick<CalPeriod, 'days' | 'daysInMonth'>) => Math.round(monthly * p.days / p.daysInMonth * 100) / 100;

/** The next return period not yet accrued (credited once the period ends), for an investment that is still earning. */
export function nextAccrual(i: Investment, b: Balance): { period: number; date: string; start: string } | null {
  if (!i.start_date || i.status !== 'active') return null;
  const p = periodsFor(i).find(x => x.k === Number(b.periods_accrued) + 1);
  return p ? { period: p.k, date: p.end, start: p.start } : null;
}

/** Projected (not guaranteed) returns for the lock-in periods not yet accrued, at the contract's monthly return. */
export function projectedRemaining(i: Investment, b: Balance): number {
  if (!i.start_date || i.status !== 'active' || !(i.lockin_months > 0)) return 0;
  return Math.round(periodsFor(i).filter(p => p.k > Number(b.periods_accrued)).reduce((s, p) => s + periodReturn(Number(i.monthly_return), p), 0) * 100) / 100;
}

/** Share of the time from start to maturity that has elapsed (0–100). */
export function elapsedPct(i: Investment, t = today()): number {
  if (!i.start_date || !i.maturity_date) return 0;
  const total = daysBetween(i.start_date, i.maturity_date);
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((daysBetween(i.start_date, t) / total) * 100)));
}
export const daysLeft = (i: Investment, t = today()) => (i.maturity_date ? Math.max(0, daysBetween(t, i.maturity_date)) : 0);

/** Start of the current financial year: 1 April for INR, otherwise 1 January. */
export function financialYearStart(currency: string, t = today()): string {
  const y = +t.slice(0, 4), m = +t.slice(5, 7);
  if (currency === 'INR') return (m >= 4 ? y : y - 1) + '-04-01';
  return y + '-01-01';
}

/** Last n calendar months as YYYY-MM, oldest first. */
export function lastMonths(n: number, t = today()): string[] {
  const out: string[] = [];
  for (let k = n - 1; k >= 0; k--) out.push(addMonths(t.slice(0, 7) + '-01', -k).slice(0, 7));
  return out;
}
