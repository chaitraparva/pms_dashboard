// Formatting helpers. Currency and locale come from Settings (edited by the Super Admin).
import type { Investment, Settings } from './types';

let CUR = 'INR';
let LOC = 'en-IN';
let TZ = 'Asia/Kolkata';
export function configureFormat(s: Pick<Settings, 'currency' | 'locale' | 'timezone'> | null) {
  if (!s) return;
  CUR = s.currency || 'INR'; LOC = s.locale || 'en-IN'; TZ = s.timezone || 'UTC';
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function money(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  try {
    return new Intl.NumberFormat(LOC, { style: 'currency', currency: CUR, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n).replace('-', '−');
  } catch {
    return n.toFixed(2);
  }
}

/** Compact money for KPI tiles: ₹12.4L / ₹1.2Cr for INR, 1.2M elsewhere. */
export function moneyShort(v: number | string | null | undefined): string {
  const n = Number(v ?? 0), a = Math.abs(n), sign = n < 0 ? '−' : '';
  const sym = currencySymbol();
  if (CUR === 'INR') {
    if (a >= 1e7) return sign + sym + (a / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return sign + sym + (a / 1e5).toFixed(2) + 'L';
    return money(n);
  }
  if (a >= 1e9) return sign + sym + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return sign + sym + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return sign + sym + (a / 1e3).toFixed(1) + 'K';
  return money(n);
}

export function currencySymbol(): string {
  try {
    const p = new Intl.NumberFormat(LOC, { style: 'currency', currency: CUR }).formatToParts(0).find(x => x.type === 'currency');
    return p ? p.value : '';
  } catch { return ''; }
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export function dateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(LOC, { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return iso; }
}
export const rate = (r: number | string) => Number(r).toFixed(2) + '% / month';
export const pct = (r: number | string) => Number(r).toFixed(2) + '%';

/** Today's date (YYYY-MM-DD) in the company time zone. */
export function today(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

/** Calendar-month arithmetic, clamped to month end (matches the database). */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const tm = m - 1 + n, ty = y + Math.floor(tm / 12), mm = ((tm % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, mm + 1, 0)).getUTCDate();
  return `${ty}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
/** Simple interest per month on the original principal, rounded half away from zero to 2 decimals. */
export function monthlyReturn(principal: number, ratePct: number): number {
  const x = (principal * ratePct) / 100;
  return Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9) / 100;
}

export const initials = (name: string) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]!.toUpperCase()).join('') || '?';
export const ordinal = (d: number) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');

/** True once the lock-in end date has been reached. Unlocking is a status only; it never moves money. */
export function isUnlocked(i: Pick<Investment, 'status' | 'lockin_end_date'>, t = today()): boolean {
  return ['active', 'matured', 'redemption_requested', 'redemption_processing'].includes(i.status) && !!i.lockin_end_date && i.lockin_end_date <= t;
}

/** The state label of an investment, derived from status and dates. */
export function investmentLabel(i: Investment, approachingDays: number, t = today()): string {
  switch (i.status) {
    case 'pending_funding': return 'Pending funding';
    case 'redeemed': return 'Closed';
    case 'cancelled': return 'Cancelled';
  }
  if (isUnlocked(i, t)) return 'Unlocked';
  if (i.maturity_date && daysBetween(t, i.maturity_date) <= approachingDays) return 'Unlocking soon';
  return 'Locked';
}
export const INV_BADGE: Record<string, string> = {
  'Locked': 'b-violet sq', 'Unlocking soon': 'b-amber', 'Unlocked': 'b-green', 'Closed': 'b-grey', 'Cancelled': 'b-grey', 'Pending funding': 'b-grey'
};
/** Lock-in period in words: 6 months, 1 year (12 months). */
export const lockinText = (m: number) => (!m ? 'No lock-in' : m === 12 ? '1 year (12 months)' : m % 12 === 0 ? `${m / 12} years (${m} months)` : `${m} months`);
/** Monthly rate as a short label: 2%, 3.3%, 4%, 5%, 6%. */
export const rateShort = (r: number | string) => String(Number(Number(r).toFixed(4))) + '%';
export const PAY_BADGE: Record<string, [string, string]> = {
  accrued: ['Accrued', 'b-grey'], approved: ['Approved', 'b-blue'], processing: ['Processing', 'b-amber'], paid: ['Paid', 'b-green'], failed: ['Failed', 'b-red'], cancelled: ['Reversed', 'b-grey']
};
export const LEDGER_BADGE: Record<string, [string, string]> = {
  confirmed: ['Confirmed', 'b-green'], pending: ['Pending', 'b-amber'], posted: ['Posted', 'b-grey'], failed: ['Failed', 'b-red'], reversed: ['Reversed', 'b-grey']
};
export const LEDGER_TYPE: Record<string, string> = {
  deposit: 'Deposit', allocation: 'Investment allocation', return_accrual: 'Return accrued', return_payout: 'Return payout',
  redemption_request: 'Principal request (closed)', principal_redemption: 'Principal repaid', refund: 'Refund', adjustment: 'Adjustment', fee: 'Fee', reversal: 'Reversal'
};

/* ---------- introducer bonus split ----------
   The Super Admin sets the bonus % on each plan. That part of the monthly rate goes to whoever introduced the investor
   instead of the investor; the total paid out stays the plan rate. */
/** Starting bonus for the standard plans (only used to fill in new plans and older data; the Super Admin can change it). */
export const DEFAULT_BONUS: Record<string, number> = { '2': 0.5, '3.3': 1, '4': 1, '5': 1.5, '6': 2 };
export const defaultBonus = (planRate: number | string) => DEFAULT_BONUS[String(Number(planRate))] || 0;
/** The standard plans: [code, name, monthly rate]. */
export const STANDARD_PLANS: [string, string, number][] = [
  ['P2', '2% Monthly Plan', 2], ['P33', '3.3% Monthly Plan', 3.3], ['P4', '4% Monthly Plan', 4], ['P5', '5% Monthly Plan', 5], ['P6', '6% Monthly Plan', 6]
];
export const STANDARD_RATES = STANDARD_PLANS.map(p => p[2]);
/** The investor's share and the introducer's bonus share of a plan's monthly rate. */
export function splitRate(planRate: number | string, bonusRate: number | string | null | undefined): { investor: number; bonus: number } {
  const r = Number(planRate), bonus = Math.max(0, Math.min(r, Number(bonusRate || 0)));
  return { investor: Math.round((r - bonus) * 10000) / 10000, bonus };
}
/** Monthly amounts of the split. Investor + bonus always equals the full plan return. */
export function splitReturn(principal: number, planRate: number | string, bonusRate: number | string | null | undefined): { total: number; investor: number; bonus: number } {
  const { investor } = splitRate(planRate, bonusRate);
  const total = monthlyReturn(principal, Number(planRate)), mine = monthlyReturn(principal, investor);
  return { total, investor: mine, bonus: Math.round((total - mine) * 100) / 100 };
}
/** The plan name an investor sees, e.g. "6% Monthly Plan" with a 2% bonus becomes "4% Monthly Plan". */
export function investorPlanName(name: string, planRate: number | string, bonusRate: number | string | null | undefined): string {
  const { investor, bonus } = splitRate(planRate, bonusRate);
  if (!bonus || !name) return name;
  const esc = String(Number(planRate)).replace('.', '\\.');
  return name.replace(new RegExp('(^|[^\\d.])' + esc + '(?:\\.0+)?\\s*%', 'g'), '$1' + investor + '%');
}
