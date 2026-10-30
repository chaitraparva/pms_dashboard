/* eslint-disable @typescript-eslint/no-explicit-any */
// The PMS data engine. It runs on the server (api/db.ts): every request loads the company's data from Neon,
// runs one query or action here with the signed-in user's rights, and saves what changed.
// Every money-moving action below follows the original database rules.
import { splitRate, investorPlanName, defaultBonus, STANDARD_PLANS, calendarPeriods, type CalPeriod } from './format.js';

type Row = Record<string, any>;
export interface Store { v: number; tables: Record<string, Row[]>; seq: Record<string, number>; users: { id: string; email: string; pw: string }[] }

/** Phone numbers are compared on their last 10 digits (so +91 98450 10000 and 9845010000 match). */
export const phoneKey = (s: unknown) => String(s ?? '').replace(/\D/g, '').slice(-10);

/* ---------- state ---------- */
let S: Store;
export const TABLES = ['settings', 'profiles', 'branches', 'plans', 'plan_versions', 'investments', 'contract_amendments', 'accruals', 'payouts', 'ledger_entries',
  'announcements', 'notifications', 'documents', 'audit_logs', 'brochures', 'brochure_views', 'properties', 'admin_bonuses', 'withdrawals', 'queries', 'investment_requests', 'password_requests'];
const listeners = new Set<(table: string) => void>();
export const onChange = (f: (table: string) => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
/** Marks tables as changed (the server saves every table whose contents changed after the request). */
export function persist(...changed: string[]) { changed.forEach(t => listeners.forEach(f => f(t))); }
export const T = (name: string): Row[] => (S.tables[name] ||= []);

/* ---------- helpers ---------- */
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const nowIso = () => new Date().toISOString();
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function today(): string { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
const parse = (s: string) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d: Date) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
/** Calendar months from the original date, clamped to month end (31 May + 6 months = 30 Nov). */
export function addMonths(s: string, n: number): string {
  const d = parse(s); const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12, last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return ty + '-' + pad(tm + 1) + '-' + pad(Math.min(day, last));
}
export const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const diffDays = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const monthlyReturn = (principal: number, rate: number) => round2(principal * rate / 100);
/** Splits the plan rate between the investor and the admin who introduced them (6% = 4% investor + 2% admin bonus).
 *  monthly_rate stays the plan rate; monthly_return is the investor's share; the total paid out never changes. */
function applySplit(i: Row, bonusRate?: number): Row {
  if (i.bonus_on_top) {
    // the IB bonus is paid on top: the investor keeps the whole ROI, the IB gets the bonus rate in addition
    const b = Math.max(0, Number(bonusRate ?? i.admin_bonus_rate ?? 0));
    return Object.assign(i, { investor_rate: Number(i.monthly_rate), admin_bonus_rate: b, monthly_return: monthlyReturn(Number(i.principal), Number(i.monthly_rate)), admin_bonus: monthlyReturn(Number(i.principal), b) });
  }
  const { investor, bonus } = splitRate(i.monthly_rate, bonusRate ?? i.admin_bonus_rate ?? 0);
  const total = monthlyReturn(Number(i.principal), Number(i.monthly_rate)), mine = monthlyReturn(Number(i.principal), investor);
  return Object.assign(i, { investor_rate: investor, admin_bonus_rate: bonus, monthly_return: mine, admin_bonus: round2(total - mine) });
}
const investorRate = (i: Row) => Number(i.investor_rate ?? i.monthly_rate);
/** The plan name the investor sees (with a bonus taken from the ROI, the rate shown is their own share). */
const shownPlanName = (i: Row) => (i.bonus_on_top ? i.plan_name : investorPlanName(i.plan_name, i.monthly_rate, i.admin_bonus_rate));
/** Principal on a date: the original principal, minus withdrawals that took effect on or before that date. */
function principalOn(i: Row, d: string): number {
  let p = Number(i.original_principal ?? i.principal);
  [...(i.principal_changes || [])].sort((x: Row, y: Row) => String(x.date).localeCompare(String(y.date))).forEach((c: Row) => { if (c.date <= d) p = Number(c.principal); });
  return p;
}
/** Return for a period [start, end) at a monthly rate. A withdrawal inside the period splits it by days:
 *  the old principal earns until the request date, the new principal from that date. */
/** Return for one calendar-month period at a monthly rate: each earning day gets 1/(days in that month) of the monthly
 *  return on that day's principal. A full month with no withdrawal is exactly principal × rate. */
function periodReturn(i: Row, p: CalPeriod, rate: number): number {
  const cuts = (i.principal_changes || []).some((c: Row) => String(c.date) > p.start && String(c.date) <= p.end);
  if (!cuts) return round2(principalOn(i, p.start) * rate / 100 * p.days / p.daysInMonth);
  let amt = 0;
  for (let d = p.start; d <= p.end; d = addDays(d, 1)) amt += principalOn(i, d) * rate / 100 / p.daysInMonth;
  return round2(amt);
}
/** The calendar-month periods of an investment (to maturity, or with no lock-in up to `upTo`). */
// returns continue every month after the lock-in ends, for as long as the money stays invested (the lock-in only says when it may be taken out)
const periodsOf = (i: Row, upTo: string) => calendarPeriods(i.start_date, null, upTo);
/** The running (not yet ended) month of an investment: its return and IB bonus so far, day by day up to `asOf`.
 *  Nothing is stored; once the month ends the regular monthly accrual takes over, so it is never counted twice. */
export function runningMonth(i: Row, asOf = today()): { from: string; to: string; days: number; days_in_month: number; roi: number; bonus: number } | null {
  if (!i.start_date || !LIVE.includes(i.status) || i.accrual_mode === 'anniversary_review') return null;
  const p = periodsOf(i, asOf).find(x => x.start <= asOf && x.end >= asOf);
  if (!p) return null;
  const sub: CalPeriod = { ...p, end: asOf, days: diffDays(p.start, asOf) + 1, full: false };
  const roi = periodReturn(i, sub, investorRate(i));
  const bonus = i.bonus_on_top ? periodReturn(i, sub, Number(i.admin_bonus_rate || 0)) : round2(periodReturn(i, sub, Number(i.monthly_rate)) - roi);
  return { from: p.start, to: asOf, days: sub.days, days_in_month: p.daysInMonth, roi, bonus: Math.max(0, bonus) };
}
const nextSeq = (k: string, start: number) => { S.seq[k] = (S.seq[k] ?? start - 1) + 1; return S.seq[k]; };
const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const str = (v: unknown, d = '') => (blank(v) ? d : String(v));
export class DbError extends Error {}
const fail = (m: string): never => { throw new DbError(m); };

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
/** PBKDF2-SHA256 with a random salt per password. */
export async function hash(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return 'pbkdf2$120000$' + hex(salt) + '$' + await derive(pw, salt, 120000);
}
async function derive(pw: string, salt: Uint8Array, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
export async function verify(pw: string, stored: string): Promise<boolean> {
  const [kind, iter, salt, want] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !salt || !want) return false;
  const got = await derive(pw, new Uint8Array((salt.match(/../g) || []).map(h => parseInt(h, 16))), Number(iter));
  let diff = got.length ^ want.length; for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/* ---------- current user ---------- */
let currentUid: string | null = null;
export const setCurrentUser = (id: string | null) => { currentUid = id; };
export const uid = () => currentUid;
export const me = () => T('profiles').find(p => p.id === currentUid) || null;
export const isAdmin = () => { const p = me(); return !!p && p.role === 'super_admin' && p.account_status === 'active'; };
/** A view-only Super Admin login: sees everything, changes nothing (the server refuses any change it would make). */
export const isReadOnly = (id: string) => !!T('profiles').find(p => p.id === id)?.read_only;
/** Who can be "Introduced by" and receive the bonus: a Super Admin, or an investor the Super Admin allowed to add investors. */
const canBeIntroducer = (id: string) => T('profiles').some(x => x.id === id && (x.role === 'super_admin' || x.role === 'investor'));
const requireAdmin = () => { if (!isAdmin()) fail('Only an active Super Admin can do this.'); return currentUid!; };
/** A sub-investor of the signed-in user: an investor placed directly under them (they are that person's IB). */
const isMySub = (id: unknown) => !!id && !!currentUid && T('profiles').some(p => p.id === String(id) && p.role === 'investor' && p.introduced_by === currentUid);
/** An IB (introducing broker): registered as an IB, allowed to add investors, or has sub-investors under them. */
const isIbProfile = (p: Row | null | undefined) => !!p && p.role === 'investor' && (!!p.is_ib || !!p.can_introduce || T('profiles').some(x => x.role === 'investor' && x.introduced_by === p.id));
/** Files an investor may attach to their own requests: images, PDF and office documents, 3 MB each, at most 5. */
export const ATTACH_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
function cleanAttachments(list: unknown): Row[] {
  if (list == null) return [];
  if (!Array.isArray(list)) fail('Attachments are not valid. Upload them again.');
  const arr = list as Row[];
  if (arr.length > 5) fail('Attach at most 5 files.');
  return arr.map(f => {
    const path = str(f?.path);
    if (!path || path.includes('..')) fail('An attachment is not valid. Upload it again.');
    if (!isAdmin() && !path.startsWith(currentUid + '/')) fail('An attachment is not valid. Upload it again.');
    if (Number(f.size || 0) > 3 * 1024 * 1024) fail('Each attachment must be 3 MB or smaller.');
    if (!blank(f.mime) && !ATTACH_MIME.includes(String(f.mime))) fail('Attach an image, PDF, Word or Excel file.');
    return { path, name: str(f.name, 'Attachment').slice(0, 160), mime: str(f.mime), size: Number(f.size || 0) };
  });
}
/** True when the signed-in user can read a request or withdrawal that has this file attached. */
export function attachmentVisible(path: string): boolean {
  return ['withdrawals', 'investment_requests'].some(t => T(t).some(r => (r.attachments || []).some((f: Row) => f.path === path) && canRead(t, r)));
}
const actorName = (id: string | null) => { const p = T('profiles').find(x => x.id === id); return p ? (p.full_name || p.email) : 'System'; };
const settings = () => T('settings')[0];

function fmtMoney(v: number): string {
  const c = ({ INR: '₹', AED: 'AED ', USD: '$', EUR: '€', GBP: '£' } as Record<string, string>)[settings()?.currency] ?? '';
  return c + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (s: string) => { const d = parse(s); return pad(d.getUTCDate()) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };

function audit(action: string, entity: string, id: string | null, label: string, reason: string, before: unknown, after: unknown) {
  const id2 = nextSeq('audit', 1);
  T('audit_logs').push({ id: id2, at: nowIso(), actor_id: currentUid, actor_name: currentUid ? actorName(currentUid) : 'System', action, entity_type: entity, entity_id: id, entity_label: label || '', reason: reason || '', before: before ?? null, after: after ?? null });
}
function notify(user: string, kind: string, title: string, body: string, link: string, srcTable: string | null, srcId: string | null): boolean {
  if (srcId && T('notifications').some(n => n.user_id === user && n.kind === kind && n.source_id === srcId)) return false;
  T('notifications').push({ id: uuid(), user_id: user, kind, title, body: body || '', link: link || '', source_table: srcTable, source_id: srcId, read_at: null, created_at: nowIso() });
  return true;
}
function ledger(e: Row) {
  if (e.source_id && T('ledger_entries').some(l => l.source_table === e.source_table && l.source_id === e.source_id && l.type === e.type)) return null;
  const row = { id: uuid(), code: 'TXN-' + pad(nextSeq('ledger', 1), 7), investment_id: null, investor_id: null, reference: '', note: '', source_table: null, source_id: null, created_by: currentUid, created_at: nowIso(), updated_at: nowIso(), ...e };
  T('ledger_entries').push(row); return row;
}
const ledgerFor = (table: string, id: string, type?: string) => T('ledger_entries').filter(l => l.source_table === table && l.source_id === id && (!type || l.type === type));
/** True while the first-run sample data is being written (the four-eyes rule does not apply to it). */
let seeding = false;
const fourEyes = (prev: string | null, what: string) => {
  if (seeding) return;
  const admins = T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active' && !p.read_only).length;
  if (settings().four_eyes && admins > 1 && prev && prev === currentUid) fail(`A different Super Admin must ${what}. You performed the previous step.`);
};
const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const isUnlocked = (i: Row) => !!i.lockin_end_date && i.lockin_end_date <= today() && LIVE.includes(i.status);

/* ---------- views ---------- */
export function view(name: string): Row[] | null {
  if (name === 'investment_balances') {
    return T('investments').map(i => {
      const acc = T('accruals').filter(a => a.investment_id === i.id), pay = T('payouts').filter(p => p.investment_id === i.id);
      const sum = (rows: Row[]) => round2(rows.reduce((s, r) => s + Number(r.amount), 0));
      return { investment_id: i.id, accrued: sum(acc), paid: sum(pay.filter(p => p.status === 'paid')), processing: sum(pay.filter(p => p.status === 'processing')),
        approved: sum(pay.filter(p => p.status === 'approved')), unapproved: sum(pay.filter(p => p.status === 'accrued' || p.status === 'failed')),
        periods_accrued: acc.filter(a => a.kind === 'regular').length };
    });
  }
  return null;
}

/* ---------- who may read what (the row-level security rules, for investors) ---------- */
export function canRead(table: string, r: Row): boolean {
  if (isAdmin()) return true;
  const u = currentUid; if (!u) return false;
  const myInv = (id: string) => T('investments').some(i => i.id === id && i.investor_id === u);
  switch (table) {
    case 'settings': return true;
    case 'profiles': return r.id === u;
    case 'branches': return r.id === me()?.branch_id;
    case 'investments': return r.investor_id === u;
    case 'investment_balances': case 'accruals': case 'contract_amendments': return myInv(r.investment_id);
    case 'payouts': case 'ledger_entries': return r.investor_id === u;
    case 'notifications': return r.user_id === u;
    case 'queries': return r.investor_id === u;
    // an IB also sees the withdrawals and investment requests of the sub-investors under them
    case 'withdrawals': case 'investment_requests': return r.investor_id === u || r.requested_by === u || isMySub(r.investor_id);
    case 'documents': return r.owner_id === u && r.visible_to_investor;
    case 'announcements': return r.status === 'published' && audienceOf(r).includes(u);
    case 'brochures': return brochureVisible(r.id, u);
    case 'brochure_views': return r.user_id === u;
    case 'properties': return r.status === 'published';
    default: return false;
  }
}
/** What an investor sees of a row: the admin bonus split and who introduced them stay with the admins. */
export function redact(table: string, r: Row): Row {
  if (!isAdmin() && table === 'withdrawals') return { ...r, allocations: (r.allocations || []).map((p: Row) => ({ ...p, plan_rate: undefined })) };
  if (isAdmin() || (table !== 'investments' && table !== 'profiles')) return r;
  const c: Row = { ...r };
  if (table === 'investments') {
    c.monthly_rate = investorRate(r); c.plan_name = shownPlanName(r);
    delete c.investor_rate; delete c.admin_bonus_rate; delete c.admin_bonus;
  } else delete c.introduced_by;
  return c;
}
/** Only these tables accept direct inserts/deletes from the browser (as before). */
export function canWrite(table: string): boolean { return isAdmin() && ['documents'].includes(table); }

/* ---------- accrual engine ---------- */
function runAccrualsFor(i: Row, asOf: string): number {
  if (!i.start_date || !LIVE.includes(i.status)) return 0;
  if (i.accrual_mode === 'anniversary_review') return 0; // recorded before calendar months with returns already paid: flagged for the Super Admin
  let n = 0;
  // calendar months: started 10 Oct → 11–31 Oct (pro-rata), then 1–30 Nov, 1–31 Dec …; a month is accrued once it has ended
  for (const full of periodsOf(i, asOf)) {
    if (full.end >= asOf) break;
    const k = full.k, end = full.end;
    // a month already accrued only in part (it used to stop at the lock-in end) gets the rest of the month as a top-up
    const have = T('accruals').filter(a => a.investment_id === i.id && a.period_no === k && (a.kind === 'regular' || a.kind === 'stub'));
    const covered = have.map(a => String(a.period_end)).sort().pop();
    if (covered && covered >= end) continue;
    const p: CalPeriod = covered ? { ...full, start: addDays(covered, 1), days: diffDays(addDays(covered, 1), end) + 1, full: false } : full;
    const kind = covered ? 'stub' : 'regular';
    // the investor's share and the bonus for this period, on the principal of each day (withdrawals lower it from their date)
    const mineAmt = periodReturn(i, p, investorRate(i));
    const bonusAmt = i.bonus_on_top ? periodReturn(i, p, Number(i.admin_bonus_rate || 0)) : round2(periodReturn(i, p, Number(i.monthly_rate)) - mineAmt);
    if (mineAmt <= 0 && principalOn(i, p.start) <= 0) { closeIfEmpty(i); break; }
    const acc = { id: uuid(), investment_id: i.id, period_no: k, kind, period_start: p.start, period_end: end, accrual_date: end, days: p.days, days_in_period: p.daysInMonth, amount: mineAmt, reverses_id: null, reason: null, created_by: null, created_at: nowIso() };
    T('accruals').push(acc); n++;
    // months up to the closing date (everything already given) are recorded as paid straight away
    const cl = settings().paid_until as Row | undefined, closed = !!cl && end <= String(cl.end);
    const pay = { id: uuid(), code: 'PAY-' + pad(nextSeq('payout', 1), 6), accrual_id: acc.id, investment_id: i.id, investor_id: i.investor_id, amount: mineAmt, due_date: addDays(end, i.payout_lag_days), status: closed ? 'paid' : 'accrued',
      batch_ref: null, payment_ref: closed ? cl!.ref : null, failure_reason: null, approved_by: null, approved_at: null, sent_by: null, sent_at: null, confirmed_by: null, confirmed_at: null, paid_on: closed ? cl!.on : null, closed, updated_at: nowIso() };
    T('payouts').push(pay);
    if (closed) ledger({ investment_id: i.id, investor_id: i.investor_id, type: 'return_payout', amount: mineAmt, status: 'confirmed', occurred_on: cl!.on, reference: cl!.ref, note: pay.code, source_table: 'payouts', source_id: pay.id });
    const span = fmtDate(p.start) + ' – ' + fmtDate(end) + (p.full ? '' : ' (' + p.days + ' of ' + p.daysInMonth + ' days)');
    ledger({ investment_id: i.id, investor_id: i.investor_id, type: 'return_accrual', amount: mineAmt, status: 'posted', occurred_on: end, reference: i.code + ' · ' + MONTH_NAMES[+end.slice(5, 7) - 1] + ' ' + end.slice(0, 4),
      note: 'Monthly return ' + investorRate(i).toFixed(2) + '% on ' + fmtMoney(principalOn(i, p.start)) + ' · ' + span, source_table: 'accruals', source_id: acc.id, created_by: null });
    if (!closed) notify(i.investor_id, 'accrual', 'Return accrued on ' + i.code + ': ' + fmtMoney(mineAmt), span + ' · not yet paid', '/portal/investments/' + i.code, 'accruals', acc.id);
    if (bonusAmt > 0) T('admin_bonuses').push({ id: uuid(), code: 'BON-' + pad(nextSeq('bonus', 1), 6), investment_id: i.id, investor_id: i.investor_id,
      admin_id: T('profiles').find(p2 => p2.id === i.investor_id)?.introduced_by ?? null, accrual_id: acc.id, period_no: k, accrual_date: end, rate: Number(i.admin_bonus_rate),
      amount: bonusAmt, status: closed ? 'paid' : 'accrued', payment_ref: closed ? cl!.ref : null, paid_on: closed ? cl!.on : null, paid_by: null, closed, created_at: nowIso(), updated_at: nowIso() });
  }
  closeIfEmpty(i);
  if (!i.maturity_date || !LIVE.includes(i.status)) { /* no lock-in (nothing to unlock) or closed */ }
  else if (i.status === 'active' && i.maturity_date <= asOf) {
    i.status = 'matured'; i.updated_at = nowIso();
    notify(i.investor_id, 'unlocked', 'Principal unlocked on ' + i.code, fmtMoney(i.principal) + ' has completed its ' + i.lockin_months + '-month lock-in.', '/portal/investments?view=unlocked', 'investments', i.id);
  } else if (i.status === 'active' && diffDays(asOf, i.maturity_date) <= settings().approaching_days) {
    notify(i.investor_id, 'maturity_reminder', i.code + ' unlocks on ' + fmtDate(i.maturity_date), 'Lock-in ends in ' + diffDays(asOf, i.maturity_date) + ' days.', '/portal/lock-in', 'investments', i.id);
  }
  return n;
}
/** An investment fully withdrawn closes once its last part-month (up to the request date) has been accrued. */
function closeIfEmpty(i: Row) {
  if (Number(i.principal) > 0 || !LIVE.includes(i.status) || !i.start_date) return;
  const d = [...(i.principal_changes || [])].map((c: Row) => String(c.date)).sort().pop();
  if (!d) return;
  // principal is 0 from the request date, so the last earning day is the day before it; close once that month is accrued
  const last = addDays(d, -1);
  const owed = last >= i.start_date ? periodsOf(i, last).filter(p => p.start <= last).pop() : undefined;
  if (owed && !T('accruals').some(ac => ac.investment_id === i.id && ac.period_no === owed.k && ac.kind === 'regular')) return;
  i.status = 'redeemed'; i.updated_at = nowIso();
}
/** The hourly job of the old server: run on load and every hour while the app is open. */
export function runAllAccruals(asOf = today()): number {
  let n = 0; T('investments').forEach(i => { n += runAccrualsFor(i, asOf); });
  if (n) persist('accruals', 'payouts', 'ledger_entries', 'notifications', 'investments', 'admin_bonuses');
  return n;
}

/* ---------- plans ---------- */
function insertPlanVersion(plan: string, version: number, v: Row, reason: string) {
  const row = { id: uuid(), plan_id: plan, version, monthly_rate: Number(v.monthly_rate), min_amount: Number(v.min_amount), max_amount: Number(v.max_amount),
    lockin_options: (v.lockin_options || []).map(Number).sort((a: number, b: number) => a - b), allow_custom_lockin: !!v.allow_custom_lockin,
    eligible_from: str(v.eligible_from, today()), eligible_to: blank(v.eligible_to) ? null : v.eligible_to, early_redemption: str(v.early_redemption, 'not_permitted'),
    early_fee_pct: Number(v.early_fee_pct || 0), payout_lag_days: blank(v.payout_lag_days) ? settings().default_payout_lag_days : Number(v.payout_lag_days),
    terms: str(v.terms), risk_disclosure: str(v.risk_disclosure), effective_from: str(v.effective_from, today()), change_reason: reason, created_by: currentUid, created_at: nowIso(),
    bonus_rate: blank(v.bonus_rate) ? 0 : Number(v.bonus_rate) };
  if (!(row.monthly_rate > 0 && row.monthly_rate <= 100)) fail('Monthly rate must be above 0 and at most 100%.');
  if (!(row.bonus_rate >= 0) || row.bonus_rate >= row.monthly_rate) fail('The introducer bonus must be 0 or more and less than the monthly rate.');
  if (!(row.min_amount > 0)) fail('Minimum amount must be above 0.');
  if (row.max_amount < row.min_amount) fail('Maximum amount must be at least the minimum.');
  if (!row.lockin_options.length) fail('Choose at least one lock-in option.');
  if (row.eligible_to && row.eligible_to < row.eligible_from) fail('Eligibility end must be after its start.');
  T('plan_versions').push(row); return row.id;
}
function createPlan(code: string, name: string, desc: string, version: Row) {
  requireAdmin();
  const c = (blank(code) ? 'PLN-' + pad(nextSeq('plan', 1), 3) : code.trim()).toUpperCase();
  if (T('plans').some(p => p.code === c)) fail('A plan with code ' + c + ' already exists.');
  if (blank(name)) fail('Enter a plan name.');
  const id = uuid();
  T('plans').push({ id, code: c, name: name.trim(), description: desc || '', status: 'draft', current_version: 1, created_by: currentUid, created_at: nowIso(), updated_by: currentUid, updated_at: nowIso() });
  insertPlanVersion(id, 1, version, 'Plan created');
  audit('plan.create', 'plan', id, c, 'Plan created', null, version);
  return id;
}
function setPlanStatus(id: string, status: string, reason: string) {
  requireAdmin();
  const p = T('plans').find(x => x.id === id) || fail('Plan not found.');
  const old = p.status; p.status = status; p.updated_by = currentUid; p.updated_at = nowIso();
  audit('plan.status', 'plan', id, p.code, reason, { status: old }, { status });
}

/* ---------- investments ---------- */
function recordInvestment(a: Row, byIntroducer = false) {
  if (!byIntroducer) requireAdmin();
  const s = settings();
  const inv = T('profiles').find(p => p.id === a.p_investor);
  if (!inv || inv.role !== 'investor') fail('Choose a valid investor.');
  // an investment added by an introducing investor waits for the Super Admin to verify KYC and confirm the deposit
  if (!byIntroducer && inv!.kyc_status !== 'verified') fail(`${inv!.full_name} is not verified yet. Verify KYC before recording an investment.`);
  if (inv!.account_status !== 'active') fail(`${inv!.full_name} has a suspended account.`);
  const plan = T('plans').find(p => p.id === a.p_plan) || fail('Plan not found.');
  if (plan.status !== 'active') fail(`Plan ${plan.name} is not active.`);
  const pv = T('plan_versions').filter(v => v.plan_id === plan.id && v.effective_from <= today()).sort((x, y) => y.version - x.version)[0];
  if (!pv) fail(`Plan ${plan.name} has no version in effect yet.`);
  if (today() < pv.eligible_from || (pv.eligible_to && today() > pv.eligible_to)) fail(`Plan ${plan.name} is not open for new investments today.`);
  const principal = Number(a.p_principal);
  if (!(principal >= pv.min_amount && principal <= pv.max_amount)) fail(`Principal must be between ${fmtMoney(pv.min_amount)} and ${fmtMoney(pv.max_amount)}.`);
  if (round2(principal) !== principal) fail('Principal can have at most 2 decimals.');
  const lock = Number(a.p_lockin_months);
  if (!pv.lockin_options.includes(lock) && !(pv.allow_custom_lockin && s.allow_custom_lockin && lock >= 1 && lock <= 120)) fail(`Lock-in of ${lock} months is not offered on this plan.`);
  const id = uuid(), code = 'INV-' + nextSeq('investment', 1001);
  T('investments').push(applySplit({ admin_bonus_rate: Number(pv.bonus_rate || 0), id, code, investor_id: inv!.id, plan_id: plan.id, plan_version_id: pv.id, plan_name: plan.name, plan_version: pv.version, monthly_rate: pv.monthly_rate,
    lockin_months: lock, early_redemption: pv.early_redemption, early_fee_pct: pv.early_fee_pct, payout_lag_days: pv.payout_lag_days,
    terms: pv.terms || s.default_terms, risk_disclosure: pv.risk_disclosure || s.default_risk_disclosure, principal, monthly_return: monthlyReturn(principal, pv.monthly_rate),
    accrual_mode: 'calendar', status: 'pending_funding', expected_start: a.p_expected_start || null, start_date: null, lockin_end_date: null, maturity_date: null, request_from_date: null,
    agreement_ref: str(a.p_agreement_ref), deposit_ref: str(a.p_deposit_ref), notes: str(a.p_notes), cancelled_reason: null, created_by: currentUid, created_at: nowIso(),
    activated_by: null, activated_at: null, updated_at: nowIso() }));
  ledger({ investment_id: id, investor_id: inv!.id, type: 'deposit', amount: principal, status: 'pending', occurred_on: a.p_expected_start || today(), reference: str(a.p_deposit_ref), note: 'Awaiting bank confirmation', source_table: 'investments', source_id: id });
  audit('investment.create', 'investment', id, code, byIntroducer ? 'Investment added by the introducing investor' : 'Investment recorded', null, { principal, plan: plan.code, version: pv.version, rate: pv.monthly_rate, lockin_months: lock });
  return id;
}
function activateInvestment(id: string, start: string, ref: string, reason: string) {
  requireAdmin();
  const v = T('investments').find(i => i.id === id) || fail('Investment not found.');
  if (v.status !== 'pending_funding') fail(`${v.code} is already ${v.status}.`);
  const who = T('profiles').find(p => p.id === v.investor_id);
  if (who && who.kyc_status !== 'verified') fail(`Verify ${who.full_name || 'the investor'}’s KYC before confirming this deposit.`);
  fourEyes(v.created_by, 'confirm this deposit');
  if (!start || start > today()) fail('Start date must be today or earlier (the date funds were received).');
  if (blank(ref)) fail('Enter the bank reference for the deposit.');
  const maturity = addMonths(start, v.lockin_months);
  Object.assign(v, { status: 'active', start_date: start, lockin_end_date: maturity, maturity_date: maturity, request_from_date: addDays(maturity, -settings().request_window_days), deposit_ref: ref, activated_by: currentUid, activated_at: nowIso(), updated_at: nowIso() });
  ledgerFor('investments', id, 'deposit').forEach(l => Object.assign(l, { status: 'confirmed', reference: ref, occurred_on: start, note: 'Deposit confirmed', updated_at: nowIso() }));
  ledger({ investment_id: id, investor_id: v.investor_id, type: 'allocation', amount: v.principal, status: 'posted', occurred_on: start, reference: v.agreement_ref, note: v.plan_name + ' v' + v.plan_version, source_table: 'investments', source_id: id });
  notify(v.investor_id, 'investment_active', 'Investment ' + v.code + ' is active', fmtMoney(v.principal) + ' at ' + investorRate(v).toFixed(2) + '% per month · matures ' + fmtDate(maturity), '/portal/investments/' + v.code, 'investments', id);
  audit('investment.activate', 'investment', id, v.code, reason || 'Deposit confirmed ' + ref, { status: 'pending_funding' }, { status: 'active', start_date: start, maturity_date: maturity });
  runAccrualsFor(v, today());
}
function payoutsTransition(ids: string[], to: string, ref: string | null, reason: string | null) {
  requireAdmin();
  if (!ids || !ids.length) fail('Select at least one payout.');
  const from = ({ approved: ['accrued', 'failed'], processing: ['approved'], paid: ['processing'], failed: ['processing'] } as Record<string, string[]>)[to];
  if (!from) fail(`Payouts cannot be moved to ${to}.`);
  let r = blank(ref) ? null : String(ref).trim();
  if (to === 'paid' && !r) fail('Enter the bank reference that confirms these payments.');
  if (to === 'failed' && blank(reason)) fail('Enter why the payment failed.');
  const rows = T('payouts').filter(p => ids.includes(p.id));
  const bad = rows.filter(p => !from.includes(p.status)).length;
  if (bad) fail(`${bad} of the selected payouts cannot move to ${to} from their current status. Refresh and try again.`);
  if (to === 'processing' && !r) { const d = new Date(); r = 'BATCH-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
  if (to === 'paid') rows.forEach(p => fourEyes(p.sent_by, 'confirm these payments'));
  rows.forEach(p => {
    const code = T('investments').find(i => i.id === p.investment_id)?.code || '';
    p.updated_at = nowIso();
    if (to === 'approved') Object.assign(p, { status: 'approved', approved_by: currentUid, approved_at: nowIso(), failure_reason: null });
    else if (to === 'processing') {
      Object.assign(p, { status: 'processing', sent_by: currentUid, sent_at: nowIso(), batch_ref: r });
      const ex = ledgerFor('payouts', p.id, 'return_payout')[0];
      if (ex) Object.assign(ex, { status: 'pending', reference: r, occurred_on: today(), updated_at: nowIso() });
      else ledger({ investment_id: p.investment_id, investor_id: p.investor_id, type: 'return_payout', amount: p.amount, status: 'pending', occurred_on: today(), reference: r, note: p.code, source_table: 'payouts', source_id: p.id });
      notify(p.investor_id, 'payout_processing', 'Payment processed for ' + code, fmtMoney(p.amount), '/portal/investments/' + code, 'payouts', p.id);
    } else if (to === 'paid') {
      Object.assign(p, { status: 'paid', payment_ref: r, confirmed_by: currentUid, confirmed_at: nowIso(), paid_on: today() });
      ledgerFor('payouts', p.id, 'return_payout').forEach(l => Object.assign(l, { status: 'confirmed', reference: r, occurred_on: today(), updated_at: nowIso() }));
      notify(p.investor_id, 'payout_paid', 'Payment fulfilled: ' + fmtMoney(p.amount) + ' for ' + code, 'Reference ' + r, '/portal/investments/' + code, 'payouts', p.id);
    } else {
      Object.assign(p, { status: 'failed', failure_reason: reason });
      ledgerFor('payouts', p.id, 'return_payout').forEach(l => Object.assign(l, { status: 'failed', note: reason, updated_at: nowIso() }));
    }
  });
  audit('payout.' + to, 'payout', null, rows.length + ' payouts', reason || r || '', { ids }, { status: to, reference: r });
  return rows.length;
}

/* ---------- announcements & brochures ---------- */
function audienceOf(a: Row): string[] {
  return T('profiles').filter(pr => pr.role === 'investor' && pr.account_status === 'active' && (
    a.audience === 'all'
    || (a.audience === 'selected' && (a.audience_investor_ids || []).includes(pr.id))
    || (a.audience === 'plan' && T('investments').some(i => i.investor_id === pr.id && i.plan_id === a.audience_plan_id && ['pending_funding', ...LIVE].includes(i.status)))
    || (a.audience === 'maturing' && T('investments').some(i => i.investor_id === pr.id && i.status === 'active' && i.maturity_date && diffDays(today(), i.maturity_date) >= 0 && diffDays(today(), i.maturity_date) <= (a.audience_days || 60)))
  )).map(p => p.id);
}
function brochureVisible(id: string, user: string): boolean {
  const b = T('brochures').find(x => x.id === id), p = T('profiles').find(x => x.id === user);
  if (!b || !p || p.account_status !== 'active' || b.status !== 'published') return false;
  const t = today();
  return b.publish_on <= t && (!b.starts_on || b.starts_on <= t) && (!b.ends_on || b.ends_on >= t) && (!b.branch_id || b.branch_id === p.branch_id);
}

/* ---------- dashboard ---------- */
function dashboard(branch: string | null, pFrom: string | null, pTo: string | null) {
  requireAdmin();
  const t = today(), s = settings();
  const to = pTo || t; const from = pFrom || addMonths(to.slice(0, 7) + '-01', -7);
  if (from > to) fail('The start of the date range must be before its end.');
  const inv = T('profiles').filter(p => p.role === 'investor' && (!branch || p.branch_id === branch));
  const invIds = new Set(inv.map(p => p.id)), branchOf = new Map(inv.map(p => [p.id, p.branch_id]));
  const live: Row[] = T('investments').filter(i => invIds.has(i.investor_id) && LIVE.includes(i.status)).map(i => ({ ...i, unlocked: isUnlocked(i), branch_id: branchOf.get(i.investor_id) }));
  const invById = new Map(T('investments').map(i => [i.id, i]));
  const acc: Row[] = T('accruals').filter(a => invIds.has(invById.get(a.investment_id)?.investor_id)).map(a => ({ ...a, branch_id: branchOf.get(invById.get(a.investment_id)!.investor_id) }));
  const pay: Row[] = T('payouts').filter(p => invIds.has(p.investor_id)).map(p => ({ ...p, branch_id: branchOf.get(p.investor_id) }));
  const sum = (rows: Row[], k = 'principal') => round2(rows.reduce((x, r) => x + Number(r[k]), 0));
  const OUT = ['accrued', 'approved', 'processing', 'failed'];
  const months: string[] = []; for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m + '-01', 1).slice(0, 7)) months.push(m);
  const byRate = (rows: Row[], withUnlocked: boolean) => {
    const g = new Map<number, Row[]>(); rows.forEach(r => { const k = Number(r.monthly_rate); g.set(k, [...(g.get(k) || []), r]); });
    return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([rate, rs]) => ({ rate, investors: new Set(rs.map(r => r.investor_id)).size, principal: sum(rs), count: rs.length, ...(withUnlocked ? { unlocked: sum(rs.filter(r => r.unlocked)) } : {}) }));
  };
  const payStatus: Record<string, { count: number; amount: number }> = {};
  pay.forEach(p => { const x = payStatus[p.status] ||= { count: 0, amount: 0 }; x.count++; x.amount = round2(x.amount + Number(p.amount)); });
  const maturing = live.filter(i => !i.unlocked && i.maturity_date && diffDays(t, i.maturity_date) >= 0 && diffDays(t, i.maturity_date) <= s.approaching_days);
  const lockins = [...new Set(live.map(i => i.lockin_months))].sort((a, b) => a - b);
  return {
    today: t, from, to, branch_id: branch,
    registered_investors: inv.length, total_investors: inv.length, new_investors_month: inv.filter(p => p.created_at.slice(0, 7) >= t.slice(0, 7)).length,
    investors_with_investments: new Set(live.map(i => i.investor_id)).size, live_investments: live.length,
    principal_invested: sum(live), unlocked_principal: sum(live.filter(i => i.unlocked)), unlocked_count: live.filter(i => i.unlocked).length,
    locked_principal: sum(live.filter(i => !i.unlocked)), locked_count: live.filter(i => !i.unlocked).length,
    accrued_total: sum(acc, 'amount'), reversed_total: sum(acc.filter(a => a.kind === 'reversal'), 'amount'), paid_total: sum(pay.filter(p => p.status === 'paid'), 'amount'),
    outstanding_total: sum(pay.filter(p => OUT.includes(p.status)), 'amount'), outstanding_count: pay.filter(p => OUT.includes(p.status)).length,
    maturing_count: maturing.length, maturing_principal: sum(maturing),
    pending_funding: T('investments').filter(i => invIds.has(i.investor_id) && i.status === 'pending_funding').length,
    kyc_pending: inv.filter(p => p.kyc_status === 'pending').length, unassigned_investors: inv.filter(p => !p.branch_id).length, unassigned_principal: sum(live.filter(i => !i.branch_id)),
    payouts_by_status: payStatus,
    monthly: months.map(m => ({ month: m, accrued: sum(acc.filter(a => a.accrual_date.slice(0, 7) === m), 'amount'), paid: sum(pay.filter(p => p.status === 'paid' && (p.paid_on || '').slice(0, 7) === m), 'amount'), invested: sum(live.filter(i => (i.start_date || '').slice(0, 7) === m)) })),
    by_branch: T('branches').filter(b => (!branch && b.status === 'active') || b.id === branch || inv.some(p => p.branch_id === b.id)).sort((a, b) => a.name.localeCompare(b.name)).map(b => {
      const l = live.filter(i => i.branch_id === b.id);
      return { id: b.id, code: b.code, name: b.name, status: b.status, investors: inv.filter(p => p.branch_id === b.id).length, principal: sum(l), unlocked: sum(l.filter(i => i.unlocked)), locked: sum(l.filter(i => !i.unlocked)),
        accrued: sum(acc.filter(a => a.branch_id === b.id), 'amount'), paid: sum(pay.filter(p => p.branch_id === b.id && p.status === 'paid'), 'amount'), by_rate: byRate(l, false) };
    }),
    by_rate: byRate(live, true),
    by_plan: T('plans').map(p => ({ p, pv: T('plan_versions').find(v => v.plan_id === p.id && v.version === p.current_version) })).filter(x => x.pv && (x.p.status !== 'archived' || live.some(i => i.plan_id === x.p.id)))
      .map(({ p, pv }) => { const l = live.filter(i => i.plan_id === p.id); return { plan_id: p.id, plan: p.name, code: p.code, rate: pv!.monthly_rate, status: p.status, investors: new Set(l.map(i => i.investor_id)).size, principal: sum(l), count: l.length }; })
      .sort((a, b) => a.rate - b.rate || a.plan.localeCompare(b.plan)),
    by_lockin: lockins.map(m => { const l = live.filter(i => i.lockin_months === m); return { months: m, count: l.length, principal: sum(l), unlocked: sum(l.filter(i => i.unlocked)) }; })
  };
}


/* ---------- monthly bills: closed months (accrued and billed) and the running month (day by day) ---------- */
/** Running-month figures for the investments the signed-in user may see (Super Admin: all, or one investor). */
function runningList(investorId: string | null) {
  const u = me() || fail('Not signed in.');
  const admin = isAdmin();
  const mine = (i: Row) => admin ? (!investorId || i.investor_id === investorId) : (i.investor_id === u.id || isMySub(i.investor_id)) && (!investorId || i.investor_id === investorId);
  return T('investments').filter(mine).map(i => {
    const r = runningMonth(i); if (!r) return null;
    const ib = T('profiles').find(p => p.id === i.investor_id)?.introduced_by || null;
    // an IB sees the bonus of their sub-investors; the investor sees their own return
    return { investment_id: i.id, code: i.code, investor_id: i.investor_id, ib_id: ib, ...r, roi: admin || i.investor_id === u.id ? r.roi : 0, bonus: admin || ib === u.id ? r.bonus : 0 };
  }).filter(Boolean);
}
const monthEnd = (m: string) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
/** The bill of one month: per investor, the returns of the month and their IB's bonus, with what is paid.
 *  An ended month uses its accrued (stored) figures; the running month is calculated day by day up to today. */
function monthlyBill(m: string) {
  if (!/^\d{4}-\d{2}$/.test(m)) fail('Choose a month.');
  const cur = today().slice(0, 7);
  const running = m >= cur;
  const people = new Map(T('profiles').map(p => [p.id, p]));
  const branches = new Map(T('branches').map(b => [b.id, b.name]));
  const rows = new Map<string, Row>();
  const row = (investorId: string) => {
    let r = rows.get(investorId);
    if (!r) {
      const p = people.get(investorId) || {} as Row, ib = p.introduced_by ? people.get(p.introduced_by) : null;
      r = { investor_id: investorId, code: p.code, name: p.full_name, phone: p.phone || '', branch: branches.get(p.branch_id) || '', ib_id: ib?.id || null, ib_code: ib?.code || '', ib_name: ib?.full_name || '',
        investments: new Set<string>(), roi: 0, roi_paid: 0, bonus: 0, bonus_paid: 0 };
      rows.set(investorId, r);
    }
    return r;
  };
  // months that can be billed: from the first investment's start to the running month, newest first
  const first = T('investments').map(i => String(i.start_date || '')).filter(Boolean).sort()[0]?.slice(0, 7) || cur;
  const months: string[] = [];
  for (let y = +cur.slice(0, 4), mo = +cur.slice(5, 7); `${y}-${String(mo).padStart(2, '0')}` >= first && months.length < 600; mo === 1 ? (mo = 12, y--) : mo--) months.push(`${y}-${String(mo).padStart(2, '0')}`);
  if (m > cur) return { month: m, months, running: true, from: null, to: null, rows: [], totals: { roi: 0, roi_paid: 0, bonus: 0, bonus_paid: 0 } };
  if (running) {
    T('investments').forEach(i => {
      const x = runningMonth(i); if (!x || (x.roi <= 0 && x.bonus <= 0)) return;
      const r = row(i.investor_id); r.investments.add(i.id); r.roi += x.roi; r.bonus += x.bonus;
    });
  } else {
    const accById = new Map(T('accruals').map(a => [a.id, a]));
    T('payouts').forEach(p => {
      const a = accById.get(p.accrual_id); if (!a || String(a.period_end).slice(0, 7) !== m) return;
      const r = row(p.investor_id); r.investments.add(p.investment_id); r.roi += Number(p.amount); if (p.status === 'paid') r.roi_paid += Number(p.amount);
    });
    T('admin_bonuses').forEach(b => {
      if (b.status === 'cancelled' || String(b.accrual_date).slice(0, 7) !== m) return;
      const r = row(b.investor_id); r.investments.add(b.investment_id); r.bonus += Number(b.amount); if (b.status === 'paid') r.bonus_paid += Number(b.amount);
    });
  }
  const list = [...rows.values()].map(r => ({ ...r, investments: r.investments.size, roi: round2(r.roi), roi_paid: round2(r.roi_paid), bonus: round2(r.bonus), bonus_paid: round2(r.bonus_paid) }))
    .sort((a, b) => String((a as Row).name).localeCompare(String((b as Row).name)));
  const tot = (k: string) => round2(list.reduce((x, r) => x + Number((r as Row)[k]), 0));
  return { month: m, months, running, from: m + '-01', to: running ? today() : monthEnd(m), rows: list, totals: { roi: tot('roi'), roi_paid: tot('roi_paid'), bonus: tot('bonus'), bonus_paid: tot('bonus_paid') } };
}
/** Marks every return and IB bonus of the months up to and including `p_month` as paid (only ended months; already paid
 *  ones are left as they are). Used once the money for those months has been given. */
function closeMonth(a: Row) {
  const m = String(a.p_month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) fail('Choose a month.');
  if (m >= today().slice(0, 7)) fail('Only a month that has ended can be marked paid. The running month is still being calculated.');
  const end = monthEnd(m);
  const on = blank(a.p_paid_on) ? end : String(a.p_paid_on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > today()) fail('Enter the paid-on date (today or earlier).');
  const ref = str(a.p_ref, 'Paid up to ' + fmtDate(end)).trim();
  const accById = new Map(T('accruals').map(x => [x.id, x]));
  const pays = T('payouts').filter(p => p.status !== 'paid' && String(accById.get(p.accrual_id)?.period_end || '9999') <= end);
  pays.forEach(p => {
    Object.assign(p, { status: 'paid', closed: true, approved_by: p.approved_by || currentUid, approved_at: p.approved_at || nowIso(), sent_by: p.sent_by || currentUid, sent_at: p.sent_at || nowIso(),
      payment_ref: ref, paid_on: on, confirmed_by: currentUid, confirmed_at: nowIso(), failure_reason: null, updated_at: nowIso() });
    const led = T('ledger_entries').filter(l => l.source_table === 'payouts' && l.source_id === p.id);
    if (led.length) led.forEach(l => Object.assign(l, { status: 'confirmed', reference: ref, occurred_on: on, updated_at: nowIso() }));
    else ledger({ investment_id: p.investment_id, investor_id: p.investor_id, type: 'return_payout', amount: p.amount, status: 'confirmed', occurred_on: on, reference: ref, note: p.code, source_table: 'payouts', source_id: p.id });
  });
  const bons = T('admin_bonuses').filter(b => b.status === 'accrued' && String(b.accrual_date) <= end);
  bons.forEach(b => Object.assign(b, { status: 'paid', closed: true, payment_ref: ref, paid_on: on, paid_by: currentUid, updated_at: nowIso() }));
  // returns of months up to this date that are recorded later (older investments, recalculations) are paid as well
  settings().paid_until = { end, ref, on }; persist('settings');
  const r = { payouts: pays.length, payouts_total: round2(pays.reduce((x, p) => x + Number(p.amount), 0)), bonuses: bons.length, bonuses_total: round2(bons.reduce((x, b) => x + Number(b.amount), 0)) };
  audit('month.close', 'payouts', null, 'Paid up to ' + m, ref, null, { up_to: end, paid_on: on, ...r });
  return r;
}

/* ---------- investor ranking: ROI released compared with principal ---------- */
/** ROI still to be released to an investor: returns earned but not yet paid, plus (with a lock-in) the months still to come
 *  until the lock-in ends, at today's principal. */
function toBeReleased(investorId: string): { pending: number; upcoming: number } {
  const pending = round2(T('payouts').filter(x => x.investor_id === investorId && ['accrued', 'approved', 'processing', 'failed'].includes(x.status)).reduce((s, x) => s + Number(x.amount), 0));
  let upcoming = 0;
  // the running month so far (returns are calculated day by day; the month is billed when it ends)
  T('investments').filter(i => i.investor_id === investorId).forEach(i => { upcoming += runningMonth(i)?.roi || 0; });
  return { pending, upcoming: round2(upcoming) };
}
/** Investor ranking: whoever put money in most recently is rank 1; the earliest investors are last.
 *  The date used is the start date of the investor's most recent live investment (larger principal first on the same day). */
function ranking(branch: string | null, period: string | null = null) {
  const from = period === '6m' ? addMonths(today(), -6) : period === '1y' ? addMonths(today(), -12) : null;
  const rows: Row[] = T('profiles').filter(p => p.role === 'investor' && p.account_status === 'active').map(p => {
    const live = T('investments').filter(i => i.investor_id === p.id && LIVE.includes(i.status));
    const principal = round2(live.reduce((s, i) => s + Number(i.principal), 0));
    const released = round2(T('payouts').filter(x => x.investor_id === p.id && x.status === 'paid').reduce((s, x) => s + Number(x.amount), 0));
    const dates = live.map(i => i.start_date).filter(Boolean).sort();
    const tb = toBeReleased(p.id);
    const plans = [...new Set(live.map(i => investorRate(i)))].sort((x, y) => x - y).map(r => r + '%').join(', ');
    return { id: p.id, code: p.code, name: p.full_name || p.email, email: p.email, phone: p.phone, branch_id: p.branch_id, branch: T('branches').find(b => b.id === p.branch_id)?.name ?? null, principal, released, plans,
      pending: tb.pending, upcoming: tb.upcoming, to_release: round2(tb.pending + tb.upcoming),
      multiple: principal ? Math.round((released / principal) * 1000) / 1000 : 0, since: dates[0] || null, last: dates[dates.length - 1] || null, rank: 0, branch_rank: 0 };
  }).filter(r => r.principal > 0 && r.last && (!from || r.last >= from))
    .sort((a, b) => String(b.last).localeCompare(String(a.last)) || b.principal - a.principal || a.name.localeCompare(b.name));
  rows.forEach((r, k) => { r.rank = k + 1; });
  const perBranch = new Map<string, number>();
  rows.forEach(r => { const k = r.branch_id || '-'; perBranch.set(k, (perBranch.get(k) || 0) + 1); r.branch_rank = perBranch.get(k)!; r.branch_total = 0; });
  rows.forEach(r => { r.branch_total = perBranch.get(r.branch_id || '-'); });
  return { total: rows.length, rows: branch ? rows.filter(r => r.branch_id === branch) : rows };
}

/* ---------- database functions (rpc) ---------- */
export function rpcCall(fn: string, a: Row): unknown {
  const touched = (...t: string[]) => persist(...t, 'audit_logs');
  switch (fn) {
    case 'public_branding': { const s = settings(); return { company_name: s.company_name, tagline: s.tagline, logo_url: s.logo_url, primary_color: s.primary_color, support_email: s.support_email, legal_footer: s.legal_footer }; }
    case 'admin_investor_ranking': requireAdmin(); return ranking(a.p_branch || null, a.p_period || null);
    case 'my_rank': {
      // an investor only learns their own position, never anyone else's name or amounts
      const u = currentUid; if (!u) return null; const r = ranking(null); const me2 = r.rows.find(x => x.id === u);
      return me2 ? { rank: me2.rank, total: r.total, multiple: me2.multiple, branch: me2.branch, branch_rank: me2.branch_rank, branch_total: me2.branch_total,
        last: me2.last, since: me2.since, principal: me2.principal, released: me2.released, pending: me2.pending, upcoming: me2.upcoming, to_release: me2.to_release } : null;
    }
    case 'admin_set_can_introduce': {
      requireAdmin(); const p = T('profiles').find(x => x.id === a.p_id) || fail('Investor not found.');
      if (p.role !== 'investor') fail('Only investors can be given this right. Super Admins can already add investors.');
      const before = !!p.can_introduce; p.can_introduce = !!a.p_value; p.updated_at = nowIso();
      if (p.can_introduce && !before) notify(p.id, 'can_introduce', 'You can now add investors', 'Add investors from your Overview. You earn a bonus on every investment they make.', '/portal/network', 'profiles_introduce', uuid());
      audit('investor.can_introduce', 'profile', p.id, p.code, str(a.p_reason, p.can_introduce ? 'Allowed to add investors' : 'Right to add investors removed'), { can_introduce: before }, { can_introduce: p.can_introduce });
      touched('profiles', 'notifications'); return null;
    }
    case 'admin_set_ib': {
      requireAdmin(); const p = T('profiles').find(x => x.id === a.p_id && x.role === 'investor') || fail('Investor not found.');
      const before = !!p.is_ib; p.is_ib = !!a.p_value; p.updated_at = nowIso();
      if (!p.is_ib && T('profiles').some(x => x.introduced_by === p.id)) fail(`${p.full_name} still has sub-investors. Move them first.`);
      audit('investor.ib', 'profile', p.id, p.code, str(a.p_reason, p.is_ib ? 'Marked as IB' : 'IB status removed'), { is_ib: before }, { is_ib: p.is_ib }); touched('profiles'); return null;
    }
    case 'my_network': return myNetwork();
    case 'admin_lookup_phone': requireAdmin(); return lookupPhone(a.p_phone);
    case 'admin_record_direct': { const r = recordDirect(a); touched('profiles', 'investments', 'ledger_entries', 'accruals', 'payouts', 'notifications', 'admin_bonuses'); return r; }
    case 'withdrawal_preview': {
      // the Super Admin for anyone, an IB for a sub-investor under them, otherwise the signed-in investor
      const u = a.p_investor && (isAdmin() || isMySub(a.p_investor)) ? String(a.p_investor) : currentUid; if (!u) return [];
      return planWithdrawal(u, Number(a.p_amount) || 0, isAdmin() && !blank(a.p_date) ? String(a.p_date) : undefined).map(p => (isAdmin() ? p : { ...p, plan_rate: undefined }));
    }
    case 'my_account': return myAccount();
    case 'running_month': return runningList(a.p_investor ? String(a.p_investor) : null);
    case 'monthly_bill': requireAdmin(); return monthlyBill(String(a.p_month || today().slice(0, 7)));
    case 'my_sub_investor': return mySubInvestor(String(a.p_id || ''));
    case 'request_investment': { const id = requestInvestment(a); touched('investment_requests', 'notifications'); return id; }
    case 'cancel_investment_request': {
      const r = T('investment_requests').find(x => x.id === a.p_id && x.requested_by === currentUid) || fail('Request not found.');
      if (r.status !== 'pending') fail(`${r.code} is already ${r.status}.`);
      Object.assign(r, { status: 'cancelled', decided_at: nowIso(), decision_note: 'Cancelled by the requester', updated_at: nowIso() });
      audit('investment_request.cancel', 'investment_request', r.id, r.code, 'Cancelled by the requester', { status: 'pending' }, { status: 'cancelled' }); touched('investment_requests'); return null;
    }
    case 'admin_reject_investment_request': {
      requireAdmin(); if (blank(a.p_reason)) fail('Enter the reason (the investor sees it).');
      const r = T('investment_requests').find(x => x.id === a.p_id) || fail('Request not found.');
      if (r.status !== 'pending') fail(`${r.code} is already ${r.status}.`);
      Object.assign(r, { status: 'rejected', decided_by: currentUid, decided_at: nowIso(), decision_note: String(a.p_reason).trim(), updated_at: nowIso() });
      [...new Set([r.requested_by, r.investor_id].filter(Boolean))].forEach(u => notify(u, 'investment_request', 'Investment request ' + r.code + ' was not approved', String(a.p_reason).trim(), '/portal/request-investment', 'investment_requests', r.id + ':rej'));
      audit('investment_request.reject', 'investment_request', r.id, r.code, a.p_reason, { status: 'pending' }, { status: 'rejected' }); touched('investment_requests', 'notifications'); return null;
    }
    case 'request_withdrawal': { const id = requestWithdrawal(a); touched('withdrawals', ...RET_TABLES); return id; }
    case 'admin_record_withdrawals': {
      // several withdrawals of one investor at once (past or offline ones), saved in date order; one error and nothing is saved
      requireAdmin();
      const items: Row[] = Array.isArray(a.p_items) ? a.p_items : [];
      if (!items.length) fail('Add at least one withdrawal.');
      const order = items.map((it, k) => ({ it, k })).sort((x, y) => String(x.it.p_date || '').localeCompare(String(y.it.p_date || '')) || x.k - y.k);
      const ids: string[] = [];
      for (const { it, k } of order) {
        try { ids.push(requestWithdrawal({ ...it, p_investor: a.p_investor })); }
        catch (e) { fail(`Withdrawal ${k + 1}: ${(e as Error).message}`); }
      }
      touched('withdrawals', ...RET_TABLES); return ids;
    }
    case 'admin_complete_withdrawal': completeWithdrawal(a); touched('withdrawals', 'ledger_entries', 'notifications'); return null;
    case 'admin_cancel_withdrawal': cancelWithdrawal(a); touched('withdrawals', 'investments', 'ledger_entries', 'notifications'); return null;
    case 'update_withdrawal': if (isAdmin()) adminEditWithdrawal(a); else updateWithdrawal(a); touched('withdrawals', ...RET_TABLES); return null;
    case 'delete_withdrawal': if (isAdmin()) adminDeleteWithdrawal(T('withdrawals').find(x => x.id === a.p_id) || fail('Withdrawal not found.')); else deleteWithdrawal(a); touched('withdrawals', ...RET_TABLES); return null;
    case 'admin_update_investment': updateInvestment(a); touched(...RET_TABLES); return null;
    case 'admin_delete_investment': {
      requireAdmin(); const i = T('investments').find(x => x.id === a.p_id) || fail('Investment not found.');
      removeInvestment(i, str(a.p_reason, 'Deleted by Super Admin')); touched(...RET_TABLES, 'documents', 'contract_amendments', 'investment_requests'); return null;
    }
    case 'admin_delete_investor': deleteInvestor(a); touched('profiles', 'withdrawals', 'investment_requests', 'queries', 'documents', 'contract_amendments', 'brochure_views', 'password_requests', ...RET_TABLES); return null;
    case 'admin_update_investment_request': {
      requireAdmin(); const r = T('investment_requests').find(x => x.id === a.p_id) || fail('Request not found.');
      if (r.status !== 'pending') fail(`${r.code} is already ${r.status}. Only pending requests can be edited.`);
      const before = { amount: r.amount, lockin_months: r.lockin_months, start_date: r.start_date, note: r.note };
      const amount = blank(a.p_amount) ? Number(r.amount) : Number(a.p_amount), lock = blank(a.p_lockin_months) ? Number(r.lockin_months) : Number(a.p_lockin_months), start = str(a.p_start_date, r.start_date);
      if (!(amount > 0) || round2(amount) !== amount) fail('Enter the amount (at most 2 decimals).');
      if (!(Number.isInteger(lock) && lock >= 0 && lock <= 120)) fail('Lock-in must be 0 (no lock-in) to 120 months.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('Enter a valid start date.');
      Object.assign(r, { amount, lockin_months: lock, start_date: start, note: a.p_note != null ? str(a.p_note).trim() : r.note, reference: a.p_reference != null ? str(a.p_reference).trim() : r.reference, updated_at: nowIso() });
      if (r.new_sub && a.p_new_sub) { const n = str(a.p_new_sub.name).trim(), ph = str(a.p_new_sub.phone).trim(); if (!n) fail('Enter the sub-investor’s name.'); if (ph && phoneKey(ph).length !== 10) fail('Enter a 10-digit phone number, or leave it empty.'); r.new_sub = { ...r.new_sub, name: n, phone: ph }; }
      audit('investment_request.update', 'investment_request', r.id, r.code, 'Request edited by Super Admin', before, { amount, lockin_months: lock, start_date: start, note: r.note }); touched('investment_requests'); return null;
    }
    case 'admin_delete_investment_request': {
      requireAdmin(); const r = T('investment_requests').find(x => x.id === a.p_id) || fail('Request not found.');
      S.tables.investment_requests = T('investment_requests').filter(x => x.id !== r.id);
      S.tables.notifications = T('notifications').filter(n => !(n.source_table === 'investment_requests' && String(n.source_id).startsWith(r.id)));
      audit('investment_request.delete', 'investment_request', r.id, r.code, str(a.p_reason, 'Request deleted'), { amount: r.amount, status: r.status }, null); touched('investment_requests', 'notifications'); return null;
    }
    case 'admin_delete_branch': {
      requireAdmin(); const b = T('branches').find(x => x.id === a.p_id) || fail('Branch not found.');
      let n = 0; T('profiles').forEach(p => { if (p.branch_id === b.id) { p.branch_id = null; p.updated_at = nowIso(); n++; } });
      T('brochures').forEach(x => { if (x.branch_id === b.id) x.branch_id = null; });
      S.tables.branches = T('branches').filter(x => x.id !== b.id);
      audit('branch.delete', 'branch', b.id, b.name, str(a.p_reason, 'Branch deleted') + (n ? ` · ${n} investor${n === 1 ? '' : 's'} now without a branch` : ''), { ...b }, null); touched('branches', 'profiles', 'brochures'); return n;
    }
    case 'ask_query': { const id = askQuery(a); touched('queries', 'notifications'); return id; }
    case 'reply_query': replyQuery(a); touched('queries', 'notifications'); return null;
    case 'admin_close_query': { requireAdmin(); const q = T('queries').find(x => x.id === a.p_id) || fail('Query not found.'); q.status = 'closed'; q.updated_at = nowIso(); touched('queries'); return null; }
    case 'mark_popped': { T('notifications').forEach(x => { if (x.user_id === currentUid && x.id === a.p_id) x.popped_at = nowIso(); }); persist('notifications'); return null; }
    case 'admin_dashboard': runAllAccruals(); return dashboard(a.p_branch || null, a.p_from || null, a.p_to || null);
    case 'admin_save_settings': {
      requireAdmin(); const p = a.p || {}; const s = settings(); const before = { ...s };
      if (!blank(p.property_site_url) && !/^https:\/\//i.test(p.property_site_url)) fail('The property website link must start with https://');
      ['company_name', 'tagline', 'primary_color', 'currency', 'locale', 'timezone', 'default_terms', 'default_risk_disclosure', 'support_email', 'support_phone', 'legal_footer', 'show_properties_to'].forEach(k => { if (p[k] != null) s[k] = p[k]; });
      ['approaching_days', 'request_window_days', 'default_payout_lag_days'].forEach(k => { if (!blank(p[k])) s[k] = Number(p[k]); });
      ['four_eyes', 'allow_custom_lockin'].forEach(k => { if (p[k] != null) s[k] = !!p[k]; });
      if ('logo_url' in p) s.logo_url = blank(p.logo_url) ? null : p.logo_url;
      if (Array.isArray(p.lockin_options)) s.lockin_options = p.lockin_options.map(Number).sort((x: number, y: number) => x - y);
      if (!blank(p.property_site_url)) s.property_site_url = String(p.property_site_url).trim();
      s.updated_at = nowIso(); s.updated_by = currentUid;
      audit('settings.update', 'settings', null, 'settings', a.p_reason || 'Settings updated', before, { ...s }); touched('settings'); return null;
    }
    case 'admin_update_investor': {
      requireAdmin();
      const p = T('profiles').find(x => x.id === a.p_id) || fail('Investor not found.'); const before = { ...p };
      if (a.p && 'full_name' in a.p && blank(a.p.full_name)) fail('The name cannot be empty.');
      if (a.p && a.p.phone != null && phoneKey(a.p.phone) !== phoneKey(p.phone)) {
        const key = phoneKey(a.p.phone);
        if (blank(a.p.phone)) { if (hasLogin(p.id)) fail('This person signs in with their phone number, so it cannot be empty.'); }
        else {
          if (key.length !== 10) fail('Enter a 10-digit phone number.');
          const clash = T('profiles').find(x => x.id !== p.id && phoneKey(x.phone) === key);
          if (clash) fail(`This phone number already belongs to ${clash.full_name} (${clash.code}).`);
          // the login follows the new phone number
          const u = S.users.find(x => x.id === p.id); if (u && /@investor\.login$/.test(u.email)) u.email = key + '@investor.login';
        }
      }
      ['full_name', 'phone', 'address', 'city', 'id_number_masked', 'bank_name', 'bank_account_masked', 'bank_ifsc'].forEach(k => { if (a.p?.[k] != null) p[k] = a.p[k]; });
      if (a.p && 'introduced_by' in a.p) {
        const by = blank(a.p.introduced_by) ? null : String(a.p.introduced_by);
        if (by && !canBeIntroducer(by)) fail('Choose a valid person for "Introduced by".');
        if (by && (by === p.id || isUnder(by, p.id))) fail('That would put this person under someone who is under them.');
        p.introduced_by = by;
        // unpaid bonuses follow the admin who introduced the investor
        T('admin_bonuses').forEach(b => { if (b.investor_id === p.id && b.status === 'accrued') { b.admin_id = by; b.updated_at = nowIso(); } });
      }
      p.updated_at = nowIso(); audit('investor.update', 'profile', p.id, p.code, str(a.p_reason, 'Details edited'), before, { ...p }); touched('profiles', 'admin_bonuses'); return null;
    }
    case 'admin_set_investor_status': {
      requireAdmin(); if (blank(a.p_reason)) fail('A reason is required.'); if (a.p_id === currentUid) fail('You cannot change your own account status.');
      const p = T('profiles').find(x => x.id === a.p_id) || fail('Investor not found.'); const old = p.account_status;
      p.account_status = a.p_status; p.updated_at = nowIso(); audit('investor.status', 'profile', p.id, p.code, a.p_reason, { account_status: old }, { account_status: a.p_status }); touched('profiles'); return null;
    }
    case 'admin_set_kyc': {
      requireAdmin(); const p = T('profiles').find(x => x.id === a.p_id) || fail('Investor not found.'); const old = p.kyc_status;
      p.kyc_status = a.p_status; p.updated_at = nowIso();
      notify(p.id, 'kyc_' + a.p_status, a.p_status === 'verified' ? 'Your account is verified' : a.p_status === 'rejected' ? 'Verification needs attention' : 'Verification pending', a.p_reason || '', '/portal/profile', 'profiles_kyc', uuid());
      audit('investor.kyc', 'profile', p.id, p.code, a.p_reason, { kyc_status: old }, { kyc_status: a.p_status }); touched('profiles', 'notifications'); return null;
    }
    case 'admin_set_role': {
      requireAdmin(); if (a.p_id === currentUid) fail('You cannot change your own role.');
      const p = T('profiles').find(x => x.id === a.p_id) || fail('User not found.'); const old = p.role;
      if (a.p_role === 'super_admin' && old !== 'super_admin') p.code = 'ADM-' + nextSeq('admin', 1);
      p.role = a.p_role; if (a.p_role === 'super_admin') p.kyc_status = 'verified'; p.updated_at = nowIso();
      audit('user.role', 'profile', p.id, p.code, a.p_reason, { role: old }, { role: a.p_role }); touched('profiles'); return null;
    }
    case 'update_my_profile': {
      const p = me() || fail('Not signed in.');
      if (a.p_phone != null) p.phone = a.p_phone; if (a.p_address != null) p.address = a.p_address; if (a.p_city != null) p.city = a.p_city; if (a.p_notify_email != null) p.notify_email = !!a.p_notify_email;
      p.updated_at = nowIso(); persist('profiles'); return null;
    }
    case 'admin_create_plan': { const id = createPlan(a.p_code, a.p_name, a.p_description, a.p_version || {}); touched('plans', 'plan_versions'); return id; }
    case 'admin_update_plan': {
      requireAdmin(); if (blank(a.p_reason)) fail('A reason for the change is required.');
      const p = T('plans').find(x => x.id === a.p_plan) || fail('Plan not found.'); if (p.status === 'archived') fail('Archived plans cannot be edited.');
      const prev = T('plan_versions').find(v => v.plan_id === p.id && v.version === p.current_version); const nv = p.current_version + 1;
      insertPlanVersion(p.id, nv, a.p_version || {}, a.p_reason);
      if (!blank(a.p_name)) p.name = a.p_name.trim(); if (a.p_description != null) p.description = a.p_description;
      p.current_version = nv; p.updated_by = currentUid; p.updated_at = nowIso();
      audit('plan.version.create', 'plan', p.id, p.code + ' v' + nv, a.p_reason, prev, a.p_version); touched('plans', 'plan_versions'); return nv;
    }
    case 'admin_set_plan_status': setPlanStatus(a.p_plan, a.p_status, a.p_reason); touched('plans'); return null;
    case 'admin_create_standard_plans': {
      requireAdmin(); let n = 0;
      STANDARD_PLANS.forEach(([code, name, rate]) => {
        const exists = T('plans').some(p => p.code === code) || T('plans').some(p => p.status !== 'archived' && T('plan_versions').some(v => v.plan_id === p.id && v.version === p.current_version && Number(v.monthly_rate) === rate));
        if (exists) return;
        const id = createPlan(code, name, `Simple monthly return of ${rate}% on the original principal, paid monthly.`, { monthly_rate: rate, bonus_rate: defaultBonus(rate), min_amount: 1, max_amount: 999999999999, lockin_options: [6, 12], eligible_from: today(), effective_from: today() });
        if (a.p_activate) setPlanStatus(id, 'active', 'Standard plan published'); n++;
      });
      touched('plans', 'plan_versions'); return n;
    }
    case 'admin_record_investment': { const id = recordInvestment(a); touched('investments', 'ledger_entries'); return id; }
    case 'admin_activate_investment': activateInvestment(a.p_id, a.p_start_date, a.p_deposit_ref, a.p_reason || ''); touched('investments', 'ledger_entries', 'accruals', 'payouts', 'notifications', 'admin_bonuses'); return null;
    case 'admin_cancel_investment': {
      requireAdmin(); if (blank(a.p_reason)) fail('A reason is required.');
      const v = T('investments').find(i => i.id === a.p_id) || fail('Investment not found.'); if (v.status !== 'pending_funding') fail('Only investments awaiting funding can be cancelled.');
      v.status = 'cancelled'; v.cancelled_reason = a.p_reason; v.updated_at = nowIso();
      ledgerFor('investments', v.id, 'deposit').forEach(l => Object.assign(l, { status: 'reversed', note: 'Cancelled: ' + a.p_reason }));
      audit('investment.cancel', 'investment', v.id, v.code, a.p_reason, { status: 'pending_funding' }, { status: 'cancelled' }); touched('investments', 'ledger_entries'); return null;
    }
    case 'admin_record_amendment': {
      requireAdmin(); if (blank(a.p_description)) fail('Describe the amendment.');
      const v = T('investments').find(i => i.id === a.p_id) || fail('Investment not found.'); const id = uuid();
      T('contract_amendments').push({ id, investment_id: v.id, description: a.p_description, effective_date: a.p_effective, document_path: a.p_document_path || null, requested_by: currentUid, approved_by: null, approved_at: null, created_at: nowIso() });
      audit('investment.amendment.request', 'investment', v.id, v.code, a.p_description, null, { effective_date: a.p_effective }); touched('contract_amendments'); return id;
    }
    case 'admin_approve_amendment': {
      requireAdmin(); const am = T('contract_amendments').find(x => x.id === a.p_amendment) || fail('Amendment not found.');
      if (am.approved_at) fail('Already approved.'); fourEyes(am.requested_by, 'approve this amendment');
      am.approved_by = currentUid; am.approved_at = nowIso();
      audit('investment.amendment.approve', 'investment', am.investment_id, T('investments').find(i => i.id === am.investment_id)?.code || '', am.description, null, null); touched('contract_amendments'); return null;
    }
    case 'admin_run_accruals': {
      requireAdmin(); const created = runAllAccruals(); const v = { as_of: today(), created };
      audit('job.accrual.run', 'job', null, 'accruals ' + v.as_of, 'Manual run', null, v); touched('accruals'); return v;
    }
    case 'admin_reverse_accrual': {
      requireAdmin(); if (blank(a.p_reason)) fail('A reason is required.');
      const ac = T('accruals').find(x => x.id === a.p_accrual); if (!ac || ac.kind === 'reversal') fail('Accrual not found.');
      if (T('accruals').some(x => x.reverses_id === ac!.id)) fail('This accrual is already reversed.');
      const p = T('payouts').find(x => x.accrual_id === ac!.id);
      if (p && (p.status === 'paid' || p.status === 'processing')) fail(`This return is ${p.status}. Record an adjustment instead of reversing it.`);
      const rev = { ...ac!, id: uuid(), kind: 'reversal', accrual_date: today(), amount: -ac!.amount, reverses_id: ac!.id, reason: a.p_reason, created_by: currentUid, created_at: nowIso() };
      T('accruals').push(rev);
      if (p) Object.assign(p, { status: 'cancelled', failure_reason: 'Accrual reversed: ' + a.p_reason, updated_at: nowIso() });
      T('admin_bonuses').forEach(b => { if (b.accrual_id === ac!.id && b.status === 'accrued') Object.assign(b, { status: 'cancelled', updated_at: nowIso() }); });
      const code = T('investments').find(i => i.id === ac!.investment_id)?.code || '';
      ledger({ investment_id: ac!.investment_id, investor_id: p?.investor_id ?? null, type: 'reversal', amount: -ac!.amount, status: 'posted', occurred_on: today(), reference: code + ' · period ' + ac!.period_no, note: a.p_reason, source_table: 'accruals', source_id: rev.id });
      audit('accrual.reverse', 'accrual', ac!.id, code + ' period ' + ac!.period_no, a.p_reason, { amount: ac!.amount }, { reversal: -ac!.amount }); touched('accruals', 'payouts', 'ledger_entries', 'admin_bonuses'); return null;
    }
    case 'admin_pay_bonuses': {
      requireAdmin(); const r = str(a.p_ref).trim(); if (!r) fail('Enter the bank reference for this payment.');
      const rows = T('admin_bonuses').filter(b => (a.p_ids || []).includes(b.id));
      if (!rows.length) fail('Select at least one bonus.');
      if (rows.some(b => b.status !== 'accrued')) fail('Only unpaid bonuses can be marked as paid. Refresh and try again.');
      if (rows.some(b => !b.admin_id)) fail('Some selected bonuses have no admin. Set "Introduced by" on the investor first.');
      rows.forEach(b => Object.assign(b, { status: 'paid', payment_ref: r, paid_on: today(), paid_by: currentUid, updated_at: nowIso() }));
      audit('bonus.paid', 'admin_bonus', null, rows.length + ' admin bonuses', r, { ids: a.p_ids }, { status: 'paid', reference: r, total: round2(rows.reduce((x, b) => x + Number(b.amount), 0)) });
      touched('admin_bonuses'); return rows.length;
    }
    case 'admin_update_payout': {
      // Super Admin correction: set any status (accrued, approved, payment processed, payment fulfilled, failed), reference and date
      requireAdmin(); const p = T('payouts').find(x => x.id === a.p_id) || fail('Payout not found.');
      if (p.status === 'cancelled') fail('This payout was reversed and cannot be edited.');
      const to = String(a.p_status), before = { status: p.status, payment_ref: p.payment_ref, batch_ref: p.batch_ref, paid_on: p.paid_on, failure_reason: p.failure_reason };
      if (!['accrued', 'approved', 'processing', 'paid', 'failed'].includes(to)) fail('Choose a status.');
      const ref = str(a.p_ref).trim(), on = str(a.p_paid_on, today());
      if (to === 'paid' && !ref) fail('Enter the bank reference for this payment.');
      if (to === 'failed' && blank(a.p_reason)) fail('Enter why the payment failed.');
      const code = T('investments').find(i => i.id === p.investment_id)?.code || '';
      Object.assign(p, { status: to, updated_at: nowIso(),
        approved_by: to === 'accrued' ? null : p.approved_by || currentUid, approved_at: to === 'accrued' ? null : p.approved_at || nowIso(),
        batch_ref: to === 'processing' ? ref || p.batch_ref : ['accrued', 'approved'].includes(to) ? null : p.batch_ref,
        sent_by: ['processing', 'paid', 'failed'].includes(to) ? p.sent_by || currentUid : null, sent_at: ['processing', 'paid', 'failed'].includes(to) ? p.sent_at || nowIso() : null,
        payment_ref: to === 'paid' ? ref : null, paid_on: to === 'paid' ? on : null, confirmed_by: to === 'paid' ? currentUid : null, confirmed_at: to === 'paid' ? nowIso() : null,
        failure_reason: to === 'failed' ? str(a.p_reason).trim() : null });
      // the ledger line for the payment follows the status
      const led = ledgerFor('payouts', p.id, 'return_payout');
      if (to === 'accrued' || to === 'approved') S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'payouts' && l.source_id === p.id && l.type === 'return_payout'));
      else {
        const st = to === 'paid' ? 'confirmed' : to === 'failed' ? 'failed' : 'pending';
        if (led.length) led.forEach(l => Object.assign(l, { status: st, reference: p.payment_ref || p.batch_ref || l.reference, occurred_on: to === 'paid' ? on : l.occurred_on, note: to === 'failed' ? p.failure_reason : l.note, updated_at: nowIso() }));
        else ledger({ investment_id: p.investment_id, investor_id: p.investor_id, type: 'return_payout', amount: p.amount, status: st, occurred_on: to === 'paid' ? on : today(), reference: p.payment_ref || p.batch_ref || '', note: p.code, source_table: 'payouts', source_id: p.id });
      }
      if (to === 'paid' && before.status !== 'paid') notify(p.investor_id, 'payout_paid', 'Payment fulfilled: ' + fmtMoney(p.amount) + ' for ' + code, 'Reference ' + ref, '/portal/investments/' + code, 'payouts', p.id);
      audit('payout.edit', 'payout', p.id, p.code, str(a.p_reason, 'Payout edited'), before, { status: to, payment_ref: p.payment_ref, batch_ref: p.batch_ref, paid_on: p.paid_on });
      touched('payouts', 'ledger_entries', 'notifications'); return null;
    }
    case 'admin_payouts_transition': { const n = payoutsTransition(a.p_ids, a.p_to, a.p_ref ?? null, a.p_reason ?? null); touched('payouts', 'ledger_entries', 'notifications'); return n; }
    case 'admin_save_announcement': {
      requireAdmin(); const p = a.p || {}; if (blank(p.title)) fail('Enter a title.');
      const fields = { title: p.title, body: str(p.body), category: str(p.category, 'General notice'), audience: str(p.audience, 'all'), audience_plan_id: blank(p.audience_plan_id) ? null : p.audience_plan_id,
        audience_days: blank(p.audience_days) ? null : Number(p.audience_days), audience_investor_ids: p.audience_investor_ids || [], attachment_path: blank(p.attachment_path) ? null : p.attachment_path, send_email: !!p.send_email, updated_at: nowIso() };
      if (!a.p_id) { const id = uuid(); T('announcements').push({ id, code: 'ANN-' + pad(nextSeq('announcement', 1), 4), status: 'draft', recipients: 0, published_at: null, created_by: currentUid, created_at: nowIso(), ...fields }); touched('announcements'); return id; }
      const row = T('announcements').find(x => x.id === a.p_id && x.status === 'draft') || fail('Only drafts can be edited.');
      Object.assign(row, fields); touched('announcements'); return row.id;
    }
    case 'admin_audience_count': { requireAdmin(); return audienceOf({ ...a.p, audience: a.p?.audience || 'all', audience_days: blank(a.p?.audience_days) ? null : Number(a.p.audience_days) }).length; }
    case 'admin_publish_announcement': {
      requireAdmin(); const an = T('announcements').find(x => x.id === a.p_id) || fail('Announcement not found.'); if (an.status === 'published') fail('Already published.');
      let n = 0; audienceOf(an).forEach(u => { if (notify(u, 'announcement', an.title, an.category, '/portal/announcements', 'announcements', an.id)) n++; });
      Object.assign(an, { status: 'published', published_at: nowIso(), recipients: n, updated_at: nowIso() });
      audit('announcement.publish', 'announcement', an.id, an.code, an.title, null, { audience: an.audience, recipients: n }); touched('announcements', 'notifications'); return n;
    }
    case 'mark_notifications_read': {
      let n = 0; T('notifications').forEach(x => { if (x.user_id === currentUid && !x.read_at && (!a.p_ids || a.p_ids.includes(x.id))) { x.read_at = nowIso(); n++; } });
      persist('notifications'); return n;
    }
    case 'admin_save_branch': {
      requireAdmin(); if (blank(a.p_name) || blank(a.p_code)) fail('Branch code and name are required.');
      const code = a.p_code.trim().toUpperCase(), name = a.p_name.trim();
      if (T('branches').some(b => b.id !== a.p_id && (b.code === code || b.name.toLowerCase() === name.toLowerCase()))) fail('Another branch already uses this code or name.');
      let b: Row, before: Row | null = null;
      if (!a.p_id) { b = { id: uuid(), code, name, city: str(a.p_city).trim(), status: a.p_status || 'active', created_by: currentUid, created_at: nowIso(), updated_at: nowIso() }; T('branches').push(b); }
      else { b = T('branches').find(x => x.id === a.p_id) || fail('Branch not found.'); before = { ...b }; Object.assign(b, { code, name, city: str(a.p_city).trim(), status: a.p_status || b.status, updated_at: nowIso() }); }
      audit(a.p_id ? 'branch.update' : 'branch.create', 'branch', b.id, name, a.p_reason || 'Branch saved', before, { ...b }); touched('branches'); return b.id;
    }
    case 'admin_set_investor_branch': {
      requireAdmin(); if (blank(a.p_reason)) fail('A reason is required.');
      const nb = a.p_branch ? (T('branches').find(b => b.id === a.p_branch) || fail('Branch not found.')) : null; let n = 0;
      T('profiles').filter(p => (a.p_ids || []).includes(p.id) && p.role === 'investor').forEach(p => {
        if ((p.branch_id || null) === (a.p_branch || null)) return;
        const old = T('branches').find(b => b.id === p.branch_id)?.name ?? null;
        p.branch_id = a.p_branch || null; p.updated_at = nowIso(); n++;
        audit('investor.branch', 'profile', p.id, p.code || p.email, a.p_reason, { branch: old }, { branch: nb?.name ?? null });
      });
      touched('profiles'); return n;
    }
    case 'admin_review_flags': {
      requireAdmin();
      return T('investments').filter(i => !['cancelled', 'redeemed'].includes(i.status)).map(i => {
        const p = T('profiles').find(x => x.id === i.investor_id) || {} as Row;
        const r = [Number(i.admin_bonus_rate || 0) > 0 && !p.introduced_by ? 'Has an IB bonus but no IB' : '', '',
          !p.branch_id ? 'Investor has no branch' : '', ['active', 'matured'].includes(i.status) && !i.start_date ? 'Missing start date' : '',
          i.accrual_mode === 'anniversary_review' ? 'Returns were approved or paid before the switch to calendar months: check this investment’s returns' : '',
          i.bonus_review ? 'IB bonus was taken out of the ROI and returns were already approved or paid: check this investment' : ''].filter(Boolean);
        return r.length ? { investment_id: i.id, code: i.code, investor: p.full_name || p.email, reason: r.join('; ') } : null;
      }).filter(Boolean).sort((x: any, y: any) => x.code.localeCompare(y.code));
    }
    case 'admin_save_brochure': {
      requireAdmin(); const p = a.p || {};
      if (blank(p.title)) fail('Enter a brochure title.');
      if (!blank(p.mime) && !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(p.mime)) fail('Brochures must be PDF, PNG, JPG or WebP files.');
      if (Number(p.size_bytes || 0) > 3 * 1024 * 1024) fail('Brochures must be 3 MB or smaller.');
      const common = { title: p.title.trim(), description: str(p.description), plan_id: blank(p.plan_id) ? null : p.plan_id, branch_id: blank(p.branch_id) ? null : p.branch_id, starts_on: blank(p.starts_on) ? null : p.starts_on, ends_on: blank(p.ends_on) ? null : p.ends_on, updated_at: nowIso() };
      if (common.starts_on && common.ends_on && common.ends_on < common.starts_on) fail('The end date must be after the start date.');
      if (!a.p_id) {
        const id = uuid(), code = 'BRO-' + pad(nextSeq('brochure', 1), 4);
        T('brochures').push({ id, code, ...common, storage_path: blank(p.storage_path) ? null : p.storage_path, file_name: str(p.file_name), mime: str(p.mime), size_bytes: Number(p.size_bytes || 0), publish_on: str(p.publish_on, today()), status: 'draft', published_at: null, created_by: currentUid, created_at: nowIso() });
        audit('brochure.create', 'brochure', id, code, p.title, null, p); touched('brochures'); return id;
      }
      const b = T('brochures').find(x => x.id === a.p_id) || fail('Brochure not found.'); const before = { ...b };
      Object.assign(b, common); if (!blank(p.publish_on)) b.publish_on = p.publish_on;
      if (!blank(p.storage_path) && p.storage_path !== b.storage_path) {
        Object.assign(b, { storage_path: p.storage_path, file_name: str(p.file_name), mime: str(p.mime), size_bytes: Number(p.size_bytes || 0) });
        S.tables.brochure_views = T('brochure_views').filter(v => v.brochure_id !== b.id);
      }
      audit('brochure.update', 'brochure', b.id, b.code, p.title, before, p); touched('brochures', 'brochure_views'); return b.id;
    }
    case 'admin_set_brochure_status': {
      requireAdmin(); if (!['draft', 'published', 'archived'].includes(a.p_status)) fail('Unknown status ' + a.p_status + '.');
      const b = T('brochures').find(x => x.id === a.p_id) || fail('Brochure not found.');
      if (a.p_status === 'published' && !b.storage_path) fail('Upload the brochure file before publishing.');
      const old = b.status; b.status = a.p_status; b.updated_at = nowIso(); if (a.p_status === 'published' && !b.published_at) b.published_at = nowIso();
      let n = 0;
      if (a.p_status === 'published') T('profiles').filter(p => p.role === 'investor' && brochureVisible(b.id, p.id)).forEach(p => { if (notify(p.id, 'brochure', b.title, 'New investment update', '/portal?brochure=' + b.id, 'brochures', b.id)) n++; });
      audit('brochure.' + a.p_status, 'brochure', b.id, b.code, a.p_reason || b.title, { status: old }, { status: a.p_status, notified: n }); touched('brochures', 'notifications'); return n;
    }
    case 'my_brochures': {
      const u = currentUid; if (!u) return [];
      return T('brochures').filter(b => brochureVisible(b.id, u)).map(b => {
        const v = T('brochure_views').find(x => x.brochure_id === b.id && x.user_id === u);
        return { id: b.id, code: b.code, title: b.title, description: b.description, storage_path: b.storage_path, file_name: b.file_name, mime: b.mime, plan_id: b.plan_id,
          plan_name: planNameForInvestor(b.plan_id), publish_on: b.publish_on, starts_on: b.starts_on, ends_on: b.ends_on, seen: !!v, acknowledged: !!v?.acknowledged_at };
      }).sort((x, y) => y.publish_on.localeCompare(x.publish_on));
    }
    case 'mark_brochure_seen': {
      const u = currentUid; if (!u || !brochureVisible(a.p_id, u)) fail('Brochure not available.');
      let v = T('brochure_views').find(x => x.brochure_id === a.p_id && x.user_id === u);
      if (!v) { v = { brochure_id: a.p_id, user_id: u, first_seen_at: nowIso(), acknowledged_at: null }; T('brochure_views').push(v); }
      if (a.p_acknowledge && !v.acknowledged_at) v.acknowledged_at = nowIso();
      T('notifications').forEach(n => { if (n.user_id === u && n.kind === 'brochure' && n.source_id === a.p_id && !n.read_at) n.read_at = nowIso(); });
      persist('brochure_views', 'notifications'); return null;
    }
    case 'admin_save_property': {
      requireAdmin(); const p = a.p || {};
      if (blank(p.title)) fail('Enter the property name.');
      if (!/^https:\/\//i.test(str(p.url))) fail("Enter the property's https:// link on the official website.");
      if (!blank(p.image_url) && !/^(https:\/\/|data:image\/)/i.test(p.image_url)) fail('Image links must start with https://');
      const fields = { title: p.title.trim(), location: str(p.location), property_type: str(p.property_type), price_text: str(p.price_text), description: str(p.description), image_url: blank(p.image_url) ? null : p.image_url, url: p.url.trim(), updated_at: nowIso() };
      if (!a.p_id) { const id = uuid(); T('properties').push({ id, ...fields, status: str(p.status, 'draft'), sort_order: Number(p.sort_order || 0), created_by: currentUid, created_at: nowIso() }); audit('property.create', 'property', id, fields.title, '', null, p); touched('properties'); return id; }
      const row = T('properties').find(x => x.id === a.p_id) || fail('Property not found.'); const before = { ...row };
      Object.assign(row, fields); if (!blank(p.status)) row.status = p.status; if (!blank(p.sort_order)) row.sort_order = Number(p.sort_order);
      audit('property.update', 'property', row.id, fields.title, '', before, p); touched('properties'); return row.id;
    }
  }
  return fail(`This action (${fn}) is not available.`);
}

function planNameForInvestor(planId: string | null): string | null {
  const p = T('plans').find(x => x.id === planId); if (!p) return null;
  const v = T('plan_versions').find(x => x.plan_id === p.id && x.version === p.current_version);
  return v ? investorPlanName(p.name, v.monthly_rate, v.bonus_rate) : p.name;
}

/* ---------- investors who bring in investors ---------- */
/** What an introducing investor sees: the investors they brought in, those investors' investments and the bonus earned from them.
 *  Nothing else: no bank or ID details, no payouts or ledgers of the other investors. */
function myNetwork(): Row | null {
  const u = currentUid; const mePr = me(); if (!u || !mePr || mePr.role !== 'investor') return null;
  const people = T('profiles').filter(p => p.role === 'investor' && p.introduced_by === u);
  const bonuses = T('admin_bonuses').filter(b => b.admin_id === u && b.status !== 'cancelled');
  const sumB = (f: (b: Row) => boolean) => round2(bonuses.filter(f).reduce((s, b) => s + Number(b.amount), 0));
  const investors = people.map(p => ({
    id: p.id, code: p.code, name: p.full_name, email: p.email, phone: p.phone, city: p.city, kyc_status: p.kyc_status, account_status: p.account_status, created_at: p.created_at,
    investments: T('investments').filter(i => i.investor_id === p.id && i.status !== 'cancelled').sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).map(i => ({
      id: i.id, code: i.code, plan_name: shownPlanName(i), principal: Number(i.principal), investor_rate: investorRate(i), bonus_rate: Number(i.admin_bonus_rate || 0),
      bonus_monthly: Number(i.admin_bonus || 0), status: i.status, start_date: i.start_date, maturity_date: i.maturity_date, lockin_months: i.lockin_months, created_at: i.created_at,
      bonus_earned: sumB(b => b.investment_id === i.id), bonus_paid: sumB(b => b.investment_id === i.id && b.status === 'paid')
    }))
  }));
  const names = new Map(people.map(p => [p.id, p])), codes = new Map(T('investments').map(i => [i.id, i.code]));
  const plans = T('plans').filter(p => p.status === 'active').map(p => {
    const v = T('plan_versions').filter(x => x.plan_id === p.id && x.effective_from <= today()).sort((x, y) => y.version - x.version)[0];
    if (!v) return null;
    const sp = splitRate(v.monthly_rate, v.bonus_rate);
    return { id: p.id, name: p.name, rate: Number(v.monthly_rate), investor_rate: sp.investor, bonus_rate: sp.bonus, min_amount: Number(v.min_amount), max_amount: Number(v.max_amount), lockin_options: v.lockin_options };
  }).filter(Boolean);
  return {
    can_introduce: !!mePr.can_introduce, investors, plans,
    bonuses: bonuses.sort((x, y) => String(y.accrual_date).localeCompare(String(x.accrual_date))).map(b => ({
      id: b.id, code: b.code, investor_name: names.get(b.investor_id)?.full_name || '', investor_code: names.get(b.investor_id)?.code || '', investment_code: codes.get(b.investment_id) || '',
      period_no: b.period_no, accrual_date: b.accrual_date, rate: Number(b.rate), amount: Number(b.amount), status: b.status, paid_on: b.paid_on
    }))
  };
}
/** An investor with the right to add investors creates a new investor and their first investment.
 *  The new investor starts unverified and the investment waits for the Super Admin to confirm the deposit. */
export async function introduceInvestor(u: Row): Promise<{ code: string; investment: string }> {
  const mePr = me();
  if (!isAdmin()) fail('Only the Super Admin can add investors.');
  const email = String(u.email || '').trim().toLowerCase(), name = String(u.full_name || '').trim();
  if (!name) fail('Enter the investor’s full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('Enter a valid email address.');
  if (blank(u.phone)) fail('Enter a phone number.');
  if (String(u.password || '').length < 10) fail('Temporary password must be at least 10 characters.');
  if (S.users.some(x => x.email === email)) fail('Someone with this email is already registered.');
  const plan = T('plans').find(p => p.id === u.plan && p.status === 'active') || fail('Choose a plan.');
  const id = uuid(), code = 'INVR-' + nextSeq('investor', 1001);
  S.users.push({ id, email, pw: await hash(String(u.password)) });
  T('profiles').push(profileRow(id, email, name, code, 'investor', 'pending', { phone: u.phone, city: u.city, branch_id: mePr!.branch_id ?? null, introduced_by: mePr!.id }));
  audit('investor.create', 'profile', id, code, 'Added by ' + (mePr!.full_name || mePr!.email) + ' (introducer)', null, { email, full_name: name, introduced_by: mePr!.code });
  let invId: string;
  try {
    invId = recordInvestment({ p_investor: id, p_plan: plan.id, p_lockin_months: u.lockin_months, p_principal: u.principal, p_expected_start: u.start_date || today(), p_agreement_ref: '', p_deposit_ref: '', p_notes: 'Added by ' + (mePr!.full_name || '') }, true);
  } catch (e) {
    // undo the half-created account so the form can be sent again
    S.users = S.users.filter(x => x.id !== id); S.tables.profiles = T('profiles').filter(x => x.id !== id); throw e;
  }
  const inv = T('investments').find(i => i.id === invId)!;
  T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(a2 =>
    notify(a2.id, 'introducer_new', (mePr!.full_name || 'An investor') + ' added a new investor', name + ' · ' + fmtMoney(inv.principal) + ' on ' + plan.name + '. Verify KYC and confirm the deposit.', '/admin/investors/' + code, 'profiles', id));
  persist('profiles', 'investments', 'ledger_entries', 'notifications', 'audit_logs');
  return { code, investment: inv.code };
}

/* ---------- Super Admin records everything; every investor gets a login (phone number + password) ---------- */
const findByPhone = (phone: unknown) => { const k = phoneKey(phone); return k.length === 10 ? T('profiles').find(p => p.role === 'investor' && phoneKey(p.phone) === k) || null : null; };
const hasLogin = (id: string) => S.users.some(x => x.id === id);
/** True when `upline` is `id` or sits (directly or further up) under `id`; used to stop circles like A under B under A. */
function isUnder(upline: string | null, id: string): boolean {
  for (let cur = upline, n = 0; cur && n < 50; n++) { if (cur === id) return true; cur = T('profiles').find(p => p.id === cur)?.introduced_by || null; }
  return false;
}

/** Who a phone number belongs to (used by the Record investment form). */
function lookupPhone(phone: unknown): Row | null {
  const p = findByPhone(phone); if (!p) return null;
  const up = p.introduced_by ? T('profiles').find(x => x.id === p.introduced_by) : null;
  return { id: p.id, code: p.code, full_name: p.full_name, phone: p.phone, has_login: hasLogin(p.id), ib_id: p.introduced_by || null, ib_name: up ? up.full_name : null,
    people: T('profiles').filter(x => x.introduced_by === p.id).length };
}

/** Records an investment in one step: the person (found or created by phone number), individual or under another investor,
 *  the monthly ROI and bonus typed by the Super Admin, lock-in (0 = no lock-in), principal and start date. */
/** How an investor takes their monthly ROI: cash, UPI (with an optional UPI ID) or bank transfer. */
export const ROI_METHODS = ['cash', 'upi', 'bank'];
function roiMethodOf(a: Row, required: boolean): { roi_method: string | null; roi_upi: string | null } {
  const m = blank(a.p_roi_method) ? null : String(a.p_roi_method);
  if (!m) { if (required) fail('Choose how the investor takes their monthly ROI: cash, UPI or bank transfer.'); return { roi_method: null, roi_upi: null }; }
  if (!ROI_METHODS.includes(m)) fail('Choose cash, UPI or bank transfer for the monthly ROI.');
  const upi = m === 'upi' ? str(a.p_roi_upi).trim() : '';
  if (upi && !/^[\w.\-]{1,64}@[\w.\-]{2,64}$/.test(upi)) fail('Enter a valid UPI ID, e.g. name@okaxis, or leave it empty.');
  return { roi_method: m, roi_upi: upi || null };
}
function recordDirect(a: Row): { id: string; code: string; investor: string; investor_id: string; is_new: boolean } {
  requireAdmin();
  const s = settings();
  const name = str(a.p_name).trim(), key = phoneKey(a.p_phone);
  // an existing person can be passed by id (an IB investing for themselves, or an approved request)
  const byId = blank(a.p_person) ? null : (T('profiles').find(p => p.id === String(a.p_person) && p.role === 'investor') || fail('Investor not found.'));
  // a sub-investor (under an IB) needs only a name; their phone number and login are optional
  const subOnly = !blank(a.p_ib);
  if (!byId && key.length !== 10 && !(subOnly && blank(a.p_phone))) fail(subOnly ? 'Enter a 10-digit phone number, or leave it empty.' : 'Enter a 10-digit phone number.');
  if (byId && byId.account_status !== 'active') fail(`${byId.full_name} has a suspended account.`);
  const rate = Number(a.p_rate), bonusIn = blank(a.p_bonus) ? 0 : Number(a.p_bonus), lock = Number(a.p_lockin_months || 0), principal = Number(a.p_principal);
  if (!(rate > 0 && rate <= 100) || !/^\d+(\.\d{1,4})?$/.test(String(a.p_rate).trim())) fail('Enter the monthly ROI, e.g. 0.25, 2.3 or 6 (at most 4 decimals).');
  if (!(bonusIn >= 0 && bonusIn <= 100) || !/^\d+(\.\d{1,4})?$/.test(String(blank(a.p_bonus) ? '0' : a.p_bonus).trim())) fail('Enter the IB bonus as 0 or more (at most 4 decimals).');
  if (!(Number.isInteger(lock) && lock >= 0 && lock <= 120)) fail('Lock-in must be 0 (no lock-in) to 120 months.');
  if (!(principal > 0) || round2(principal) !== principal) fail('Enter the principal (at most 2 decimals).');
  const start = str(a.p_start_date); if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('Enter the start date.');
  const roiWay = roiMethodOf(a, !!a.p_roi_required);
  let person = byId || (key.length === 10 ? findByPhone(key) : null);
  const upId = blank(a.p_ib) ? null : String(a.p_ib);
  const up = upId ? T('profiles').find(p => p.id === upId && p.role === 'investor') : null;
  if (upId && !up) fail('Choose the investor this person is under.');
  if (up && up.account_status !== 'active') fail(`${up.full_name} (IB) has a suspended account.`);
  const branchId = blank(a.p_branch) ? null : String(a.p_branch);
  if (branchId && !T('branches').some(b => b.id === branchId)) fail('Choose a valid branch.');
  if (person && upId && (upId === person.id || isUnder(upId, person.id))) fail(`${person.full_name} cannot be under ${up!.full_name}: ${up!.full_name} is already under ${person.full_name}.`);
  if (person && person.introduced_by && upId && person.introduced_by !== upId) {
    const cur = T('profiles').find(p => p.id === person!.introduced_by);
    fail(`${person.full_name} (this phone number) is already under ${cur?.full_name || 'another investor'}.`);
  }
  const isNew = !person;
  if (!person) {
    if (!name) fail('Enter the name.');
    const id = uuid(), code = 'INVR-' + nextSeq('investor', 1001);
    person = profileRow(id, '', name, code, 'investor', 'verified', { phone: a.p_phone, city: a.p_city, branch_id: branchId ?? up?.branch_id ?? null, introduced_by: upId });
    T('profiles').push(person);
    audit('investor.create', 'profile', id, code, 'Added with a recorded investment', null, { full_name: name, phone: a.p_phone, under: up?.code || null });
  } else if (upId && !person.introduced_by) { person.introduced_by = upId; person.updated_at = nowIso(); }
  if (up && !up.is_ib) { up.is_ib = true; up.updated_at = nowIso(); }
  // the branch chosen in Record investment moves an existing investor to that branch
  if (!isNew && branchId && person.branch_id !== branchId) {
    const old = T('branches').find(b => b.id === person!.branch_id)?.name ?? null;
    person.branch_id = branchId; person.updated_at = nowIso();
    audit('investor.branch', 'profile', person.id, person.code, 'Branch set while recording an investment', { branch: old }, { branch: T('branches').find(b => b.id === branchId)?.name ?? null });
  }
  const upline = person.introduced_by ? T('profiles').find(p => p.id === person!.introduced_by) : null;
  const bonus = upline ? bonusIn : 0;
  const id = uuid(), code = 'INV-' + nextSeq('investment', 1001);
  const maturity = lock > 0 ? addMonths(start, lock) : null;
  const v = applySplit({ ...roiWay, bonus_on_top: true, admin_bonus_rate: bonus, id, code, investor_id: person.id, plan_id: null, plan_version_id: null, plan_name: rate + '% Monthly', plan_version: 1, monthly_rate: rate,
    lockin_months: lock, early_redemption: 'not_permitted', early_fee_pct: 0, payout_lag_days: s.default_payout_lag_days, terms: s.default_terms, risk_disclosure: s.default_risk_disclosure,
    principal, original_principal: principal, principal_changes: [], monthly_return: monthlyReturn(principal, rate), accrual_mode: 'calendar', status: 'active', expected_start: start, start_date: start, lockin_end_date: maturity || start, maturity_date: maturity,
    request_from_date: maturity ? addDays(maturity, -s.request_window_days) : null, agreement_ref: str(a.p_reference), deposit_ref: str(a.p_reference), notes: str(a.p_notes), cancelled_reason: null,
    created_by: currentUid, created_at: nowIso(), activated_by: currentUid, activated_at: nowIso(), updated_at: nowIso() });
  T('investments').push(v);
  ledger({ investment_id: id, investor_id: person.id, type: 'deposit', amount: principal, status: 'confirmed', occurred_on: start, reference: str(a.p_reference), note: 'Recorded by Super Admin', source_table: 'investments', source_id: id });
  ledger({ investment_id: id, investor_id: person.id, type: 'allocation', amount: principal, status: 'posted', occurred_on: start, reference: str(a.p_reference), note: v.plan_name, source_table: 'investments', source_id: id });
  audit('investment.create', 'investment', id, code, 'Recorded by Super Admin', null, { principal, rate, bonus, under: upline?.code || null, lockin_months: lock, start_date: start });
  if (upline && bonus > 0) notify(upline.id, 'network', person.full_name + ' was added under you', fmtMoney(principal) + ' · your bonus ' + bonus + '% a month (' + fmtMoney(v.admin_bonus) + ')', '/portal/network', 'investments', id);
  runAccrualsFor(v, today());
  return { id, code, investor: person.code, investor_id: person.id, is_new: isNew };
}

/** Gives an investor their login: phone number + a password set by the Super Admin (only a salted hash is stored). */
function addLogin(id: string, phone: unknown, pwHash: string) {
  if (hasLogin(id)) return;
  const key = phoneKey(phone);
  if (key.length !== 10) fail('This person has no 10-digit phone number to sign in with. Edit their details first.');
  const email = key + '@investor.login';
  if (S.users.some(u => u.email === email && u.id !== id)) fail('Another login already uses this phone number.');
  S.users.push({ id, email, pw: pwHash });
  const p = T('profiles').find(x => x.id === id); if (p) p.has_login = true;
}
const PW_MIN = 8;
/** recordDirect, plus a login for a person who has none yet (the Super Admin sets the first password). */
async function recordWithLogin(a: Row): Promise<{ id: string; code: string; investor: string; investor_id: string; is_new: boolean }> {
  const exists = blank(a.p_person) ? (phoneKey(a.p_phone).length === 10 ? findByPhone(a.p_phone) : null) : T('profiles').find(p => p.id === String(a.p_person)) || null;
  let pw: string | null = null;
  // a person without a phone number (allowed for sub-investors) gets no login; one can be created later with Create login
  const phoneOf = exists ? exists.phone : a.p_phone;
  const optionalLogin = !blank(a.p_ib) && blank(a.p_password);
  if (phoneKey(phoneOf).length === 10 && (!exists || !hasLogin(exists.id)) && !optionalLogin) {
    if (String(a.p_password || '').length < PW_MIN) fail(`Set a login password (at least ${PW_MIN} characters) for ${exists?.full_name || str(a.p_name, 'this investor')}.`);
    pw = await hash(String(a.p_password));
  }
  const r = recordDirect(a);
  const pr = T('profiles').find(x => x.id === r.investor_id);
  if (pw && !hasLogin(r.investor_id)) addLogin(r.investor_id, pr?.phone || a.p_phone, pw);
  if (pr) pr.has_login = hasLogin(pr.id);
  return r;
}
/** Registers a new IB (an investor who can have sub-investors) with their login. */
async function registerIB(n: Row): Promise<Row> {
  const name = str(n?.name).trim(), key = phoneKey(n?.phone);
  if (!name) fail('Enter the IB’s name.');
  if (key.length !== 10) fail('Enter the IB’s 10-digit phone number. They sign in with it.');
  const clash = findByPhone(key); if (clash) fail(`This phone number already belongs to ${clash.full_name} (${clash.code}). Choose them from the IB list.`);
  if (String(n.password || '').length < PW_MIN) fail(`Set a login password for the IB (at least ${PW_MIN} characters).`);
  const id = uuid(), code = 'INVR-' + nextSeq('investor', 1001);
  const p = profileRow(id, blank(n.email) ? '' : String(n.email).trim().toLowerCase(), name, code, 'investor', 'verified', { phone: n.phone, city: n.city, branch_id: blank(n.branch_id) ? null : n.branch_id });
  p.is_ib = true;
  T('profiles').push(p);
  addLogin(id, n.phone, await hash(String(n.password)));
  audit('investor.create', 'profile', id, code, 'Registered as IB', null, { full_name: name, phone: n.phone, is_ib: true });
  return p;
}
const PROOF_MIME = ATTACH_MIME;
/** Record investment from the Super Admin form.
 *  Individual: the investor is chosen (or found / added by phone number), with a login if they have none.
 *  IB: the IB is chosen (or registered); with an optional sub-investor the investment is the sub-investor's, under the IB
 *  (the IB earns the bonus); without one it is the IB's own investment. A payment proof can be attached (optional). */
/** IB registered with principal 0: adds the sub-investor (name only is required) under the IB, without an investment. */
async function registerOnly(a: Row, ib: Row): Promise<{ id: string | null; code: string | null; investor: string; investor_id: string; is_new: boolean; ib: string | null; ib_id: string | null }> {
  const branchId = blank(a.p_branch) ? null : String(a.p_branch);
  if (branchId && !T('branches').some(b => b.id === branchId)) fail('Choose a valid branch.');
  if (branchId && !ib.branch_id) ib.branch_id = branchId;
  let person: Row = ib, isNew = false;
  if (!blank(a.p_ib)) {
    const key = phoneKey(a.p_phone);
    if (!blank(a.p_phone) && key.length !== 10) fail('Enter a 10-digit phone number for the sub-investor, or leave it empty.');
    const found = !blank(a.p_person) ? T('profiles').find(p => p.id === String(a.p_person) && p.role === 'investor') || fail('Investor not found.')
      : key.length === 10 ? findByPhone(key) : null;
    if (found) {
      if (found.id === ib.id || isUnder(ib.id, found.id)) fail(`${found.full_name} cannot be under ${ib.full_name}.`);
      if (found.introduced_by && found.introduced_by !== ib.id) fail(`${found.full_name} (this phone number) is already under another investor.`);
      found.introduced_by = ib.id; found.updated_at = nowIso(); person = found;
    } else {
      const name = str(a.p_name).trim(); if (!name) fail('Enter the sub-investor’s name.');
      const id = uuid(), code = 'INVR-' + nextSeq('investor', 1001);
      person = profileRow(id, '', name, code, 'investor', 'verified', { phone: blank(a.p_phone) ? null : a.p_phone, city: a.p_city, branch_id: branchId ?? ib.branch_id ?? null, introduced_by: ib.id });
      T('profiles').push(person); isNew = true;
      audit('investor.create', 'profile', id, code, 'Added under IB ' + ib.code, null, { full_name: name, phone: a.p_phone || null, under: ib.code });
    }
    if (!blank(a.p_password) && !hasLogin(person.id)) {
      if (String(a.p_password).length < PW_MIN) fail(`The password must be at least ${PW_MIN} characters.`);
      addLogin(person.id, person.phone, await hash(String(a.p_password)));
    }
  }
  ib.is_ib = true; ib.updated_at = nowIso();
  persist('profiles', 'audit_logs', 'notifications');
  return { id: null, code: null, investor: person.code, investor_id: person.id, is_new: isNew, ib: ib.full_name, ib_id: ib.id };
}
export async function adminRecordInvestment(a: Row): Promise<{ id: string | null; code: string | null; investor: string; investor_id: string; is_new: boolean; ib: string | null; ib_id: string | null }> {
  requireAdmin();
  const proof = a.p_proof && !blank((a.p_proof as Row).path) ? a.p_proof as Row : null;
  if (proof && !blank(proof.mime) && !PROOF_MIME.includes(String(proof.mime))) fail('The proof must be an image, PDF, Word or Excel file.');
  if (proof && Number(proof.size || 0) > 3 * 1024 * 1024) fail('The proof must be 3 MB or smaller.');
  let args: Row; let ib: Row | null = null;
  if (a.p_type === 'ib') {
    if (a.p_new_ib) ib = await registerIB({ ...a.p_new_ib, branch_id: blank(a.p_new_ib.branch_id) ? a.p_branch : a.p_new_ib.branch_id });
    else {
      ib = T('profiles').find(p => p.id === a.p_ib && p.role === 'investor') || fail('Choose the IB.');
      if (ib!.account_status !== 'active') fail(`${ib!.full_name} has a suspended account.`);
      if (!hasLogin(ib!.id)) {
        if (String(a.p_ib_password || '').length < PW_MIN) fail(`Set a login password for ${ib!.full_name} (at least ${PW_MIN} characters).`);
        addLogin(ib!.id, ib!.phone, await hash(String(a.p_ib_password)));
      }
      if (!ib!.is_ib) { audit('investor.ib', 'profile', ib!.id, ib!.code, 'Marked as IB', { is_ib: false }, { is_ib: true }); }
      ib!.is_ib = true; ib!.updated_at = nowIso();
    }
    const sub = a.p_sub && (!blank(a.p_sub.phone) || !blank(a.p_sub.name) || !blank(a.p_sub.id)) ? a.p_sub as Row : null;
    if (sub) {
      if (blank(sub.name) && blank(sub.id)) fail('Enter the sub-investor’s name.');
      if (blank(sub.id) && !blank(sub.phone) && phoneKey(sub.phone) === phoneKey(ib!.phone)) fail('The sub-investor’s phone number must be different from the IB’s.');
      if (!blank(sub.id) && sub.id === ib!.id) fail('Choose a different person as the sub-investor.');
      args = { ...a, p_person: blank(sub.id) ? null : sub.id, p_name: sub.name, p_phone: sub.phone, p_city: sub.city, p_ib: ib!.id, p_password: sub.password };
    } else args = { ...a, p_person: ib!.id, p_ib: null, p_bonus: '0', p_password: '' };
  } else args = { ...a, p_ib: null, p_bonus: '0' };
  // IB with principal 0 (or empty): only register the IB (and the sub-investor under them); no investment is recorded
  if (a.p_type === 'ib' && (blank(a.p_principal) || Number(a.p_principal) === 0)) return registerOnly(args, ib!);
  // the way the ROI is taken is required, except for a sub-investor (only their name is mandatory)
  args.p_roi_required = !(a.p_type === 'ib' && !blank(args.p_ib));
  const r = await recordWithLogin(args);
  if (proof) {
    T('documents').push({ id: uuid(), owner_id: r.investor_id, investment_id: r.id, kind: 'proof', title: str(proof.name, 'Payment proof') + ' · ' + r.code, storage_path: String(proof.path),
      mime: str(proof.mime), size_bytes: Number(proof.size || 0), visible_to_investor: true, uploaded_by: currentUid, created_at: nowIso() });
    const inv = T('investments').find(i => i.id === r.id); if (inv) inv.proof_path = String(proof.path);
  }
  persist('profiles', 'investments', 'ledger_entries', 'accruals', 'payouts', 'notifications', 'admin_bonuses', 'audit_logs', 'documents');
  return { ...r, ib: ib ? ib.full_name : null, ib_id: ib ? ib.id : null };
}
/** Record investment with several investments for the same person (the + button): the person is set up once with the
 *  first investment, then each further investment is recorded for them. All or nothing: one error and nothing is saved. */
export async function adminRecordInvestments(a: Row) {
  const more: Row[] = Array.isArray(a.p_more) ? a.p_more : [];
  const first = await adminRecordInvestment({ ...a, p_more: undefined });
  if (!more.length) return { ...first, more: [] as { id: string; code: string }[] };
  if (!first.id) fail('Investment 1: enter the principal.');
  const sub = !!first.ib_id && first.investor_id !== first.ib_id;
  const out: { id: string; code: string }[] = [];
  for (let k = 0; k < more.length; k++) {
    const it = more[k] || {};
    const base: Row = { p_type: a.p_type, p_branch: a.p_branch, p_proof: it.p_proof, p_rate: it.p_rate, p_bonus: it.p_bonus, p_lockin_months: it.p_lockin_months,
      p_principal: it.p_principal, p_start_date: it.p_start_date, p_reference: it.p_reference, p_notes: it.p_notes, p_roi_method: it.p_roi_method, p_roi_upi: it.p_roi_upi };
    if (a.p_type === 'ib') { base.p_ib = first.ib_id; base.p_sub = sub ? { id: first.investor_id } : null; }
    else base.p_person = first.investor_id;
    if (blank(base.p_principal) || !(Number(base.p_principal) > 0)) fail(`Investment ${k + 2}: enter the principal.`);
    let r: Row;
    try { r = await adminRecordInvestment(base); } catch (e) { fail(`Investment ${k + 2}: ${(e as Error).message}`); }
    out.push({ id: String(r!.id), code: String(r!.code) });
  }
  return { ...first, more: out };
}

/* ---------- investment requests: an investor (for themselves) or an IB (for a sub-investor) asks; the Super Admin approves ---------- */
function requestInvestment(a: Row): string {
  const mePr = me() || fail('Not signed in.');
  if (mePr.role !== 'investor') fail('Only investors can request an investment.');
  if (mePr.account_status !== 'active') fail('Your account is suspended.');
  const forSub = a.p_for === 'sub';
  let investorId: string | null = mePr.id, newSub: Row | null = null;
  if (forSub) {
    if (!isIbProfile(mePr)) fail('Only an IB can request an investment for a sub-investor.');
    if (!blank(a.p_sub_id)) { if (!isMySub(a.p_sub_id)) fail('Choose one of your sub-investors.'); investorId = String(a.p_sub_id); }
    else {
      const name = str(a.p_new_sub?.name).trim(), key = phoneKey(a.p_new_sub?.phone);
      if (!name) fail('Enter the sub-investor’s name.');
      if (!blank(a.p_new_sub?.phone) && key.length !== 10) fail('Enter a 10-digit phone number, or leave it empty.');
      if (key && key === phoneKey(mePr.phone)) fail('That is your own phone number. Choose “For myself” instead.');
      const ex = key.length === 10 ? findByPhone(key) : null;
      if (ex && ex.introduced_by !== mePr.id) fail('This phone number is already registered with the company. Ask the company to place them under you.');
      if (ex) investorId = ex.id; else { investorId = null; newSub = { name, phone: str(a.p_new_sub?.phone).trim(), city: str(a.p_new_sub?.city).trim() }; }
    }
  }
  const amount = Number(a.p_amount);
  if (!(amount > 0) || round2(amount) !== amount) fail('Enter the amount to invest (at most 2 decimals).');
  const lock = Number(a.p_lockin_months ?? 0);
  if (!(Number.isInteger(lock) && lock >= 0 && lock <= 120)) fail('Lock-in must be 0 (no lock-in) to 120 months.');
  const start = str(a.p_start_date, today()); if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('Enter a valid start date.');
  const attachments = cleanAttachments(a.p_attachments);
  const id = uuid(), code = 'REQ-' + pad(nextSeq('inv_request', 1), 5);
  const subName = investorId && investorId !== mePr.id ? T('profiles').find(p => p.id === investorId)?.full_name : newSub?.name;
  T('investment_requests').push({ id, code, kind: forSub ? 'sub' : 'self', requested_by: mePr.id, investor_id: investorId, new_sub: newSub, amount, lockin_months: lock, start_date: start,
    reference: str(a.p_reference).trim(), note: str(a.p_note).trim(), attachments, status: 'pending', decided_by: null, decided_at: null, decision_note: null, investment_id: null, investment_code: null,
    created_at: nowIso(), updated_at: nowIso() });
  const who = forSub ? `${subName} (sub-investor of ${mePr.full_name})` : mePr.full_name;
  T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(ad =>
    notify(ad.id, 'investment_request', 'Investment request ' + code + ': ' + fmtMoney(amount), who + (attachments.length ? ' · ' + attachments.length + ' attachment' + (attachments.length === 1 ? '' : 's') : ''), '/admin/requests', 'investment_requests', id));
  notify(mePr.id, 'investment_request', 'Investment request ' + code + ' sent', fmtMoney(amount) + (forSub ? ' for ' + subName : '') + ' · waiting for approval', '/portal/request-investment', 'investment_requests', id + ':sent');
  audit('investment_request.create', 'investment_request', id, code, forSub ? 'Requested by IB for a sub-investor' : 'Requested by the investor', null, { amount, lockin_months: lock, start_date: start, for: forSub ? 'sub' : 'self' });
  return id;
}
/** Approves a request: records the investment exactly like Record investment (a new sub-investor is added under the IB, with the login password set here). */
export async function adminApproveInvestmentRequest(a: Row): Promise<{ id: string; code: string; investor: string }> {
  requireAdmin();
  const r = T('investment_requests').find(x => x.id === a.p_id) || fail('Request not found.');
  if (r.status !== 'pending') fail(`${r.code} is already ${r.status}.`);
  const args: Row = { p_rate: a.p_rate, p_bonus: blank(a.p_bonus) ? '0' : a.p_bonus, p_lockin_months: a.p_lockin_months ?? r.lockin_months, p_principal: blank(a.p_principal) ? r.amount : Number(a.p_principal),
    p_start_date: str(a.p_start_date, r.start_date), p_reference: str(a.p_reference, r.reference), p_notes: 'From request ' + r.code + (r.note ? ' · ' + r.note : ''), p_password: a.p_password,
    p_roi_method: a.p_roi_method, p_roi_upi: a.p_roi_upi };
  if (r.investor_id) { args.p_person = r.investor_id; args.p_ib = r.kind === 'sub' ? r.requested_by : null; }
  else { args.p_name = r.new_sub?.name; args.p_phone = r.new_sub?.phone; args.p_city = r.new_sub?.city; args.p_ib = r.requested_by; }
  const res = await recordWithLogin(args);
  (r.attachments || []).forEach((f: Row) => T('documents').push({ id: uuid(), owner_id: res.investor_id, investment_id: res.id, kind: 'proof', title: f.name + ' · ' + res.code, storage_path: f.path,
    mime: f.mime, size_bytes: Number(f.size || 0), visible_to_investor: true, uploaded_by: r.requested_by, created_at: nowIso() }));
  Object.assign(r, { status: 'approved', decided_by: currentUid, decided_at: nowIso(), decision_note: str(a.p_note).trim(), investment_id: res.id, investment_code: res.code, investor_id: res.investor_id, updated_at: nowIso() });
  notify(res.investor_id, 'investment_request', 'Investment ' + res.code + ' approved', fmtMoney(Number(args.p_principal)) + ' · request ' + r.code, '/portal/investments/' + res.code, 'investment_requests', r.id + ':ok');
  if (r.requested_by !== res.investor_id) notify(r.requested_by, 'investment_request', 'Request ' + r.code + ' approved', fmtMoney(Number(args.p_principal)) + ' for ' + (T('profiles').find(p => p.id === res.investor_id)?.full_name || 'your sub-investor') + ' · ' + res.code, '/portal/network/' + res.investor_id, 'investment_requests', r.id + ':ok-ib');
  audit('investment_request.approve', 'investment_request', r.id, r.code, str(a.p_note, 'Approved'), { status: 'pending' }, { status: 'approved', investment: res.code });
  persist('investment_requests', 'profiles', 'investments', 'ledger_entries', 'accruals', 'payouts', 'notifications', 'admin_bonuses', 'audit_logs', 'documents');
  return res;
}

/* ---------- what the portal needs to know about the signed-in investor ---------- */
const livePrincipalOf = (id: string) => round2(T('investments').filter(i => i.investor_id === id && WD_LIVE(i)).reduce((s, i) => s + Number(i.principal), 0));
function myAccount(): Row | null {
  const p = me(); if (!p || p.role !== 'investor') return null;
  const subs = T('profiles').filter(x => x.role === 'investor' && x.introduced_by === p.id).sort((x, y) => String(x.full_name).localeCompare(String(y.full_name)));
  const up = p.introduced_by ? T('profiles').find(x => x.id === p.introduced_by) : null;
  return {
    is_ib: isIbProfile(p), ib: up && up.role === 'investor' ? { name: up.full_name, code: up.code } : null, available: livePrincipalOf(p.id),
    bank: { name: p.bank_name || '', account: p.bank_account_masked || '', ifsc: p.bank_ifsc || '' },
    subs: subs.map(s => ({ id: s.id, code: s.code, full_name: s.full_name, phone: s.phone, account_status: s.account_status, has_login: hasLogin(s.id), available: livePrincipalOf(s.id), bank_name: s.bank_name || '', bank_account: s.bank_account_masked || '' }))
  };
}
/** One sub-investor, as their IB sees them: details, investments, returns and bonus. Never bank or ID details beyond the masked account. */
function mySubInvestor(id: string): Row {
  const u = currentUid;
  const p = T('profiles').find(x => x.id === id && x.role === 'investor' && !!u && x.introduced_by === u) || fail('Sub-investor not found.');
  const invs = T('investments').filter(i => i.investor_id === p.id && i.status !== 'cancelled').sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  const ids = new Set(invs.map(i => i.id));
  const acc = T('accruals').filter(x => ids.has(x.investment_id));
  const pays = T('payouts').filter(x => ids.has(x.investment_id));
  const bon = T('admin_bonuses').filter(b => b.admin_id === u && ids.has(b.investment_id) && b.status !== 'cancelled');
  const sum = (rows: Row[]) => round2(rows.reduce((s, r) => s + Number(r.amount), 0));
  return {
    profile: { id: p.id, code: p.code, full_name: p.full_name, phone: p.phone, email: p.email, city: p.city, kyc_status: p.kyc_status, account_status: p.account_status, created_at: p.created_at, has_login: hasLogin(p.id), bank_name: p.bank_name || '', bank_account: p.bank_account_masked || '' },
    investments: invs.map(i => ({ id: i.id, code: i.code, plan_name: shownPlanName(i), principal: Number(i.principal), original_principal: Number(i.original_principal ?? i.principal),
      investor_rate: investorRate(i), bonus_rate: Number(i.admin_bonus_rate || 0), monthly_return: Number(i.monthly_return), bonus_monthly: Number(i.admin_bonus || 0), status: i.status, start_date: i.start_date,
      maturity_date: i.maturity_date, lockin_months: i.lockin_months, created_at: i.created_at,
      accrued: sum(acc.filter(x => x.investment_id === i.id)), paid: sum(pays.filter(x => x.investment_id === i.id && x.status === 'paid')),
      bonus_earned: sum(bon.filter(b => b.investment_id === i.id)), bonus_paid: sum(bon.filter(b => b.investment_id === i.id && b.status === 'paid')) })),
    accruals: acc.map(x => ({ date: x.accrual_date, amount: Number(x.amount) })),
    paid: pays.filter(x => x.status === 'paid').map(x => ({ date: x.paid_on, amount: Number(x.amount) })),
    bonuses: bon.map(b => ({ date: b.accrual_date, amount: Number(b.amount), status: b.status })),
    withdrawals: T('withdrawals').filter(w => w.investor_id === p.id).sort((x, y) => String(y.requested_at).localeCompare(String(x.requested_at)))
      .map(w => ({ id: w.id, code: w.code, amount: Number(w.amount), method: w.method, mt5_account: w.mt5_account || null, status: w.status, requested_on: w.requested_on, completed_on: w.completed_on, cancelled_reason: w.cancelled_reason })),
    requests: T('investment_requests').filter(r => r.investor_id === p.id).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
      .map(r => ({ id: r.id, code: r.code, amount: Number(r.amount), status: r.status, created_at: r.created_at, investment_code: r.investment_code, decision_note: r.decision_note }))
  };
}

/** Gives a person a login (phone number + password), or creates a new investor with a login and no investment yet. */
export async function createIB(u: Row): Promise<{ id: string; code: string }> {
  requireAdmin();
  const key = phoneKey(u.phone);
  if (key.length !== 10) fail('Enter a 10-digit phone number. The investor signs in with it.');
  if (String(u.password || '').length < 8) fail('Password must be at least 8 characters.');
  let p = u.person_id ? T('profiles').find(x => x.id === u.person_id) || null : findByPhone(key);
  if (p && p.role !== 'investor') fail('This phone number belongs to an administrator.');
  if (p && hasLogin(p.id) && !u.person_id) fail(`${p.full_name} already has a login with this phone number.`);
  const clash = T('profiles').find(x => x.id !== p?.id && x.role === 'investor' && phoneKey(x.phone) === key);
  if (clash) fail(`This phone number already belongs to ${clash.full_name}.`);
  if (!p) {
    if (blank(u.full_name)) fail('Enter the name.');
    const id = uuid(), code = 'INVR-' + nextSeq('investor', 1001);
    p = profileRow(id, blank(u.email) ? '' : String(u.email).trim().toLowerCase(), String(u.full_name).trim(), code, 'investor', 'verified', { phone: u.phone, city: u.city, branch_id: blank(u.branch_id) ? null : u.branch_id, introduced_by: blank(u.introduced_by) ? null : u.introduced_by });
    T('profiles').push(p);
  }
  p.phone = str(u.phone, p.phone); p.kyc_status = 'verified'; p.updated_at = nowIso();
  const pw = await hash(String(u.password));
  const existing = S.users.find(x => x.id === p!.id);
  if (existing) existing.pw = pw; else S.users.push({ id: p.id, email: key + '@investor.login', pw });
  p.has_login = true;
  audit('investor.login', 'profile', p.id, p.code, 'Login created', null, { full_name: p.full_name, phone: p.phone });
  persist('profiles', 'audit_logs');
  return { id: p.id, code: p.code };
}

/* ---------- withdrawals: always taken from the highest monthly ROI first, whatever the lock-in ---------- */
const WD_LIVE = (i: Row) => LIVE.includes(i.status) && Number(i.principal) > 0;
/** How a withdrawal is split: highest monthly ROI first, then the next, oldest first on equal rates. */
function planWithdrawal(investorId: string, amount: number, on?: string): Row[] {
  // on a given date only investments that had started by then can be used
  const invs = T('investments').filter(i => i.investor_id === investorId && WD_LIVE(i) && (!on || !i.start_date || String(i.start_date) <= on))
    .sort((x, y) => Number(y.monthly_rate) - Number(x.monthly_rate) || String(x.start_date).localeCompare(String(y.start_date)));
  let left = round2(amount); const out: Row[] = [];
  for (const i of invs) {
    if (left <= 0) break;
    const take = round2(Math.min(left, Number(i.principal)));
    out.push({ investment_id: i.id, code: i.code, rate: investorRate(i), plan_rate: Number(i.monthly_rate), amount: take, before: Number(i.principal), after: round2(Number(i.principal) - take) });
    left = round2(left - take);
  }
  return out;
}
/** How a withdrawal is paid: to the bank account, to an MT5 trading account, transferred to the investor's IB, or (Super Admin only) in cash. */
export const WD_METHODS = ['bank', 'mt5', 'ib', 'cash'];
function wdHow(w: Row): string {
  if (w.method === 'cash') return 'cash';
  if (w.method === 'mt5') return 'transfer to MT5 account ' + (w.mt5_account || '');
  if (w.method === 'ib') return 'transfer to IB ' + (T('profiles').find(p => p.id === w.ib_id)?.full_name || '');
  return 'bank transfer';
}
/** Withdrawals in the order they happened: by withdrawal date, then by when they were recorded. */
const wdOrder = (x: Row, y: Row) => String(x.requested_on).localeCompare(String(y.requested_on)) || String(x.requested_at).localeCompare(String(y.requested_at));
/** Takes a withdrawal's parts out of the investments (principal change from its date + ledger lines). */
function applyWithdrawalParts(w: Row, parts: Row[]) {
  const how = wdHow(w), done = w.status === 'completed';
  parts.forEach(pt => {
    const i = T('investments').find(x => x.id === pt.investment_id)!;
    if (i.original_principal === undefined) i.original_principal = Number(i.principal);
    i.principal_changes = [...(i.principal_changes || []), { date: w.requested_on, principal: pt.after, withdrawal_id: w.id }];
    i.principal = pt.after; applySplit(i); i.updated_at = nowIso();
    ledger({ investment_id: i.id, investor_id: w.investor_id, type: 'principal_redemption', amount: pt.amount, status: done ? 'confirmed' : 'pending', occurred_on: done ? w.completed_on || w.requested_on : w.requested_on,
      reference: done ? w.payment_ref || w.code : w.code, note: (done ? 'Withdrawal paid · ' : 'Withdrawal requested · ') + how, source_table: 'withdrawals', source_id: w.id + ':' + i.id });
  });
  w.allocations = parts;
}
/** Applies an investor's withdrawals in date order (first in, first out). Every withdrawal dated on or after `from` is taken
 *  out and applied again, oldest first, together with `w` (a new or edited one); `drop` (a deleted one) is left out. Each is
 *  taken from the highest monthly ROI available on its own date. Returns of the investments that change are recalculated
 *  from `from` (refused if those are already approved or paid). */
function applyInOrder(who: Row, from: string, w: Row | null, drop: string | null = null, before?: Map<string, string>): Row[] {
  const invs = T('investments').filter(i => i.investor_id === who.id);
  const snap = before || new Map(invs.map(i => [i.id, JSON.stringify(i.principal_changes || [])]));
  const lifted = T('withdrawals').filter(x => x.investor_id === who.id && x.status !== 'cancelled' && x.id !== w?.id && x.id !== drop && String(x.requested_on) >= from);
  const out = new Set([...lifted.map(x => x.id), ...(w ? [w.id] : []), ...(drop ? [drop] : [])]);
  // 1. take them out
  invs.forEach(i => {
    i.principal_changes = (i.principal_changes || []).filter((c: Row) => !out.has(c.withdrawal_id));
    i.principal = principalOn(i, '9999-12-31'); applySplit(i);
    if (i.status === 'redeemed' && Number(i.principal) > 0) i.status = i.maturity_date && i.maturity_date <= today() ? 'matured' : 'active';
  });
  S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'withdrawals' && out.has(String(l.source_id).split(':')[0])));
  // 2. apply them again, oldest first
  [...lifted, ...(w ? [w] : [])].sort(wdOrder).forEach(x => {
    const plan = planWithdrawal(who.id, Number(x.amount), String(x.requested_on));
    const got = round2(plan.reduce((t, q) => t + Number(q.amount), 0));
    if (got < Number(x.amount)) {
      if (x === w) fail(`${who.full_name} can withdraw up to ${fmtMoney(got)} on ${fmtDate(x.requested_on)}.`);
      fail(`With this, ${x.code} of ${fmtDate(x.requested_on)} (${fmtMoney(x.amount)}) would be more than ${who.full_name} has left. Change or delete ${x.code} first.`);
    }
    applyWithdrawalParts(x, plan); if (x !== w) x.updated_at = nowIso();
  });
  // 3. recalculate returns of the investments that changed
  const changed = invs.filter(i => JSON.stringify(i.principal_changes || []) !== snap.get(i.id));
  if (from < today() || lifted.length || drop) {
    changed.forEach(i => resetReturnsFrom(i, from));
    changed.forEach(i => runAccrualsFor(i, today()));
  }
  changed.forEach(i => closeIfEmpty(i));
  return w ? w.allocations : [];
}
const placeWithdrawal = (w: Row, who: Row) => applyInOrder(who, String(w.requested_on), w);
/** Super Admin: change anything of a withdrawal (amount, date, how, paid or not, paid-on, reference). It is applied again
 *  in date order with the investor's other withdrawals. */
function adminEditWithdrawal(a: Row) {
  requireAdmin();
  const w = T('withdrawals').find(x => x.id === a.p_id) || fail('Withdrawal not found.');
  if (w.status === 'cancelled') fail(`${w.code} is cancelled. Delete it and record it again instead.`);
  const who = T('profiles').find(p => p.id === w.investor_id) || fail('Investor not found.');
  const before = { amount: w.amount, date: w.requested_on, method: w.method, mt5_account: w.mt5_account, status: w.status, completed_on: w.completed_on, payment_ref: w.payment_ref, note: w.note };
  const amount = blank(a.p_amount) ? Number(w.amount) : Number(a.p_amount);
  if (!(amount > 0) || round2(amount) !== amount) fail('Enter the amount (at most 2 decimals).');
  const d = blank(a.p_date) ? String(w.requested_on) : String(a.p_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today()) fail('Enter the withdrawal date (today or earlier).');
  const method = WD_METHODS.includes(String(a.p_method)) ? String(a.p_method) : w.method;
  const mt5 = str(a.p_mt5, w.mt5_account || '').trim();
  if (method === 'mt5' && mt5 && !/^[A-Za-z0-9._-]{3,40}$/.test(mt5)) fail('Enter the MT5 account number (letters and digits only).');
  const ib = who.introduced_by ? T('profiles').find(p => p.id === who.introduced_by && p.role === 'investor') || null : null;
  if (method === 'ib' && !ib) fail(`${who.full_name} is not under an IB, so a transfer to an IB is not possible.`);
  const paid = a.p_paid == null ? w.status === 'completed' : !!a.p_paid;
  const paidOn = paid ? str(a.p_paid_on, w.status === 'completed' && w.completed_on >= d ? w.completed_on : d) : null;
  if (paid && (!/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn)) || String(paidOn) < d || String(paidOn) > today())) fail('The paid-on date must be on or after the withdrawal date, and not after today.');
  const snap = new Map(T('investments').filter(i => i.investor_id === who.id).map(i => [i.id, JSON.stringify(i.principal_changes || [])]));
  const from = d < String(w.requested_on) ? d : String(w.requested_on);
  Object.assign(w, { amount, requested_on: d, method, mt5_account: method === 'mt5' ? mt5 : null, ib_id: method === 'ib' ? ib!.id : null,
    status: paid ? 'completed' : 'pending', completed_on: paidOn, completed_by: paid ? (w.completed_by || currentUid) : null,
    payment_ref: paid ? (a.p_ref != null ? str(a.p_ref).trim() || null : w.payment_ref) : null, note: a.p_note != null ? str(a.p_note).trim() : w.note, updated_at: nowIso() });
  applyInOrder(who, from, w, null, snap);
  audit('withdrawal.update', 'withdrawal', w.id, w.code, str(a.p_reason, 'Withdrawal changed'), before,
    { amount, date: d, method, mt5_account: w.mt5_account, status: w.status, completed_on: w.completed_on, payment_ref: w.payment_ref, note: w.note });
}
/** Super Admin: delete a withdrawal; the investor's later withdrawals are applied again in date order. */
function adminDeleteWithdrawal(w: Row) {
  const who = T('profiles').find(p => p.id === w.investor_id);
  if (who && w.status !== 'cancelled') applyInOrder(who, String(w.requested_on), null, w.id);
  S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'withdrawals' && String(l.source_id).startsWith(w.id + ':')));
  S.tables.withdrawals = T('withdrawals').filter(x => x.id !== w.id);
  S.tables.notifications = T('notifications').filter(n => !(n.source_table === 'withdrawals' && String(n.source_id).startsWith(w.id)));
  audit('withdrawal.delete', 'withdrawal', w.id, w.code, 'Withdrawal deleted', { amount: w.amount, date: w.requested_on, method: w.method, status: w.status }, null);
}
function requestWithdrawal(a: Row): string {
  const mePr = me() || fail('Not signed in.');
  let investorId = mePr.id;
  if (!blank(a.p_investor) && String(a.p_investor) !== mePr.id) {
    // the Super Admin records for anyone; an IB requests for the sub-investors directly under them
    if (isAdmin() || isMySub(a.p_investor)) investorId = String(a.p_investor);
    else fail('You can only request withdrawals for yourself or your sub-investors.');
  }
  const who = T('profiles').find(p => p.id === investorId && p.role === 'investor') || fail('Investor not found.');
  if (!isAdmin() && who.account_status !== 'active') fail(`${who.full_name}’s account is suspended.`);
  const amount = Number(a.p_amount);
  if (!(amount > 0) || round2(amount) !== amount) fail('Enter the amount to withdraw (at most 2 decimals).');
  // the Super Admin can record a withdrawal on an earlier date; withdrawals are applied in date order (first in, first out)
  const d = isAdmin() && !blank(a.p_date) ? String(a.p_date) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today()) fail('Enter the withdrawal date (today or earlier).');
  const paid = isAdmin() && !!a.p_paid;
  if (paid && !blank(a.p_paid_on) && (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.p_paid_on)) || String(a.p_paid_on) < d || String(a.p_paid_on) > today())) fail('The paid-on date must be on or after the withdrawal date, and not after today.');
  const method = WD_METHODS.includes(String(a.p_method)) ? String(a.p_method) : 'bank';
  if (method === 'cash' && !isAdmin()) fail('Choose your bank account, your MT5 account or a transfer to your IB.');
  const mt5 = str(a.p_mt5).trim();
  if (method === 'mt5' && (mt5 || !isAdmin()) && !/^[A-Za-z0-9._-]{3,40}$/.test(mt5)) fail('Enter the MT5 account number (letters and digits only).');
  const ib = who.introduced_by ? T('profiles').find(p => p.id === who.introduced_by && p.role === 'investor') || null : null;
  if (method === 'ib' && !ib) fail(`${who.full_name} is not under an IB, so a transfer to an IB is not possible.`);
  const attachments = cleanAttachments(a.p_attachments);
  const id = uuid(), code = 'WDR-' + pad(nextSeq('withdrawal', 1), 5);
  const row: Row = { id, code, investor_id: who.id, amount, method, mt5_account: method === 'mt5' ? mt5 : null, ib_id: method === 'ib' ? ib!.id : null, note: str(a.p_note), status: paid ? 'completed' : 'pending', requested_on: d, requested_at: nowIso(), requested_by: currentUid,
    allocations: [], attachments, completed_on: paid ? str(a.p_paid_on, d) : null, completed_by: paid ? currentUid : null, payment_ref: paid ? str(a.p_ref) || null : null, admin_note: null, cancelled_reason: null, updated_at: nowIso() };
  const how = wdHow(row);
  const parts = placeWithdrawal(row, who);
  T('withdrawals').push(row);
  const byIb = !isAdmin() && who.id !== mePr.id;
  if (!isAdmin()) T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(ad =>
    notify(ad.id, 'withdrawal', (method === 'ib' ? 'Transfer to IB ' : 'Withdrawal request ') + code + ': ' + fmtMoney(amount), who.full_name + (byIb ? ' (requested by IB ' + mePr.full_name + ')' : '') + ' · ' + how + ' · from ' + parts.map(p => p.code + ' (' + p.plan_rate + '%)').join(', ') + (method === 'ib' ? ' · needs your approval' : ''), '/admin/withdrawals', 'withdrawals', id));
  notify(who.id, 'withdrawal', 'Withdrawal ' + code + (paid ? ' · payment fulfilled' : ' · payment processed'), fmtMoney(amount) + ' · ' + how + ' · returns are calculated on the lower amount from ' + fmtDate(d), '/portal/withdraw', 'withdrawals', id + ':req');
  if (byIb) notify(mePr.id, 'withdrawal', 'Withdrawal ' + code + ' for ' + who.full_name + ' · payment processed', fmtMoney(amount) + ' · ' + how, '/portal/withdraw', 'withdrawals', id + ':req-ib');
  audit('withdrawal.request', 'withdrawal', id, code, str(a.p_note, 'Withdrawal requested'), null, { amount, date: d, status: row.status, method, mt5_account: row.mt5_account, ib: ib?.code || null, requested_by: mePr.code, parts: parts.map(p => ({ code: p.code, amount: p.amount })) });
  return id;
}
function completeWithdrawal(a: Row) {
  const adminId = requireAdmin();
  const w = T('withdrawals').find(x => x.id === a.p_id) || fail('Withdrawal not found.');
  if (w.status !== 'pending') fail(`${w.code} is already ${w.status}.`);
  const on = str(a.p_paid_on, today());
  const method = WD_METHODS.includes(String(a.p_method)) ? String(a.p_method) : w.method;
  let ibId = w.ib_id;
  if (method === 'ib' && !ibId) { ibId = T('profiles').find(p => p.id === w.investor_id)?.introduced_by || null; if (!ibId) fail('This investor is not under an IB.'); }
  Object.assign(w, { status: 'completed', completed_on: on, completed_by: adminId, payment_ref: str(a.p_ref), method, mt5_account: method === 'mt5' ? str(a.p_mt5, w.mt5_account) : w.mt5_account ?? null, ib_id: method === 'ib' ? ibId : w.ib_id ?? null, admin_note: str(a.p_note), updated_at: nowIso() });
  const how = wdHow(w);
  T('ledger_entries').filter(l => l.source_table === 'withdrawals' && String(l.source_id).startsWith(w.id + ':')).forEach(l => Object.assign(l, { status: 'confirmed', occurred_on: on, reference: w.payment_ref || w.code, note: 'Withdrawal paid · ' + how, updated_at: nowIso() }));
  notify(w.investor_id, 'withdrawal', 'Withdrawal ' + w.code + ' · payment fulfilled', fmtMoney(w.amount) + ' · ' + how + ' on ' + fmtDate(on) + (w.payment_ref ? ' · ' + w.payment_ref : ''), '/portal/withdraw', 'withdrawals', w.id + ':done');
  if (method === 'ib' && w.ib_id) notify(w.ib_id, 'withdrawal', 'Transfer received: ' + fmtMoney(w.amount), 'From ' + (T('profiles').find(p => p.id === w.investor_id)?.full_name || 'your sub-investor') + ' · ' + w.code + ' approved by the company', '/portal/network/' + w.investor_id, 'withdrawals', w.id + ':ib');
  if (w.requested_by && w.requested_by !== w.investor_id && w.requested_by !== w.ib_id && T('profiles').some(p => p.id === w.requested_by && p.role === 'investor'))
    notify(w.requested_by, 'withdrawal', 'Withdrawal ' + w.code + ' · payment fulfilled', fmtMoney(w.amount) + ' · ' + how, '/portal/withdraw', 'withdrawals', w.id + ':done-ib');
  audit('withdrawal.complete', 'withdrawal', w.id, w.code, str(a.p_note, 'Paid'), { status: 'pending' }, { status: 'completed', paid_on: on, reference: w.payment_ref });
}
function cancelWithdrawal(a: Row) {
  requireAdmin(); if (blank(a.p_reason)) fail('Enter a reason.');
  const w = T('withdrawals').find(x => x.id === a.p_id) || fail('Withdrawal not found.');
  if (w.status !== 'pending') fail(`${w.code} is already ${w.status}.`);
  // only while no month that includes the request date has been accrued at the lower amount
  const late = (w.allocations || []).some((pt: Row) => T('accruals').some(ac => ac.investment_id === pt.investment_id && ac.kind === 'regular' && ac.period_end >= w.requested_on && String(ac.created_at) > String(w.requested_at)));
  if (late) fail('A monthly return has already been calculated on the lower amount. Complete it, or record a new investment for the amount instead.');
  (w.allocations || []).forEach((pt: Row) => {
    const i = T('investments').find(x => x.id === pt.investment_id); if (!i) return;
    i.principal_changes = (i.principal_changes || []).filter((c: Row) => c.withdrawal_id !== w.id);
    i.principal = principalOn(i, '9999-12-31'); applySplit(i);
    if (i.status === 'redeemed') i.status = i.maturity_date && i.maturity_date <= today() ? 'matured' : 'active';
    i.updated_at = nowIso();
  });
  T('ledger_entries').filter(l => l.source_table === 'withdrawals' && String(l.source_id).startsWith(w.id + ':')).forEach(l => Object.assign(l, { status: 'reversed', updated_at: nowIso() }));
  Object.assign(w, { status: 'cancelled', cancelled_reason: String(a.p_reason).trim(), updated_at: nowIso() });
  notify(w.investor_id, 'withdrawal', 'Withdrawal ' + w.code + ' cancelled', String(a.p_reason).trim(), '/portal/withdraw', 'withdrawals', w.id + ':cancel');
  if (w.requested_by && w.requested_by !== w.investor_id && T('profiles').some(p => p.id === w.requested_by && p.role === 'investor'))
    notify(w.requested_by, 'withdrawal', 'Withdrawal ' + w.code + ' cancelled', String(a.p_reason).trim(), '/portal/withdraw', 'withdrawals', w.id + ':cancel-ib');
  audit('withdrawal.cancel', 'withdrawal', w.id, w.code, a.p_reason, { status: 'pending' }, { status: 'cancelled' });
}

/* ---------- edit and delete (Super Admin everywhere; investors only their own pending withdrawals) ---------- */
/** Removes the calculated returns of periods ending on or after `from` (accruals with their payouts, bonuses, ledger lines and
 *  notifications) so the next accrual run recalculates them. Refused when any of them has been approved or paid. */
function resetReturnsFrom(i: Row, from: string) {
  const accs = T('accruals').filter(a => a.investment_id === i.id && String(a.period_end) >= from);
  const ids = new Set(accs.map(a => a.id));
  T('accruals').forEach(a => { if (a.reverses_id && ids.has(a.reverses_id)) ids.add(a.id); });
  // months closed as paid (the closing date) are recalculated and recorded as paid again; other approved or paid returns are kept
  if (T('payouts').some(p => ids.has(p.accrual_id) && !p.closed && ['approved', 'processing', 'paid'].includes(p.status)) || T('admin_bonuses').some(b => ids.has(b.accrual_id) && !b.closed && b.status === 'paid'))
    fail(`Returns of ${i.code} from ${fmtDate(from === '0000-01-01' ? i.start_date || today() : from)} are already approved or paid, so they cannot be recalculated. Only the reference and notes can be changed now.`);
  const payIds = new Set(T('payouts').filter(p => ids.has(p.accrual_id)).map(p => p.id));
  S.tables.accruals = T('accruals').filter(a => !ids.has(a.id));
  S.tables.payouts = T('payouts').filter(p => !ids.has(p.accrual_id));
  S.tables.admin_bonuses = T('admin_bonuses').filter(b => !ids.has(b.accrual_id));
  S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'accruals' && ids.has(l.source_id)) && !(l.source_table === 'payouts' && payIds.has(l.source_id)));
  S.tables.notifications = T('notifications').filter(n => !(n.source_table === 'accruals' && ids.has(n.source_id)));
}
const RET_TABLES = ['investments', 'accruals', 'payouts', 'admin_bonuses', 'ledger_entries', 'notifications'];

/** Super Admin: change an investment's terms. ROI, bonus, lock-in, principal or start date recalculate its returns
 *  (only while none has been approved or paid); the reference and notes can always be changed. */
function updateInvestment(a: Row) {
  requireAdmin();
  const i = T('investments').find(x => x.id === a.p_id) || fail('Investment not found.');
  if (['cancelled', 'redeemed'].includes(i.status)) fail(`${i.code} is closed and cannot be edited.`);
  const before = { monthly_rate: i.monthly_rate, admin_bonus_rate: i.admin_bonus_rate, lockin_months: i.lockin_months, principal: i.original_principal ?? i.principal, start_date: i.start_date || i.expected_start, reference: i.deposit_ref, notes: i.notes, roi_method: i.roi_method ?? null, roi_upi: i.roi_upi ?? null };
  const rate = blank(a.p_rate) ? Number(i.monthly_rate) : Number(a.p_rate);
  const bonus = blank(a.p_bonus) ? Number(i.admin_bonus_rate || 0) : Number(a.p_bonus);
  const lock = blank(a.p_lockin_months) ? Number(i.lockin_months) : Number(a.p_lockin_months);
  const principal = blank(a.p_principal) ? Number(i.original_principal ?? i.principal) : Number(a.p_principal);
  const start = str(a.p_start_date, i.start_date || i.expected_start || today());
  if (!(rate > 0 && rate <= 100)) fail('Enter the monthly ROI, e.g. 0.25, 2.3 or 6.');
  if (!(bonus >= 0 && bonus <= 100)) fail('Enter the IB bonus as 0 or more.');
  if (!(Number.isInteger(lock) && lock >= 0 && lock <= 120)) fail('Lock-in must be 0 (no lock-in) to 120 months.');
  if (!(principal > 0) || round2(principal) !== principal) fail('Enter the principal (at most 2 decimals).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('Enter the start date.');
  const who = T('profiles').find(p => p.id === i.investor_id);
  if (bonus > 0 && !who?.introduced_by) fail(`${who?.full_name || 'This investor'} is not under an IB, so the bonus must be 0.`);
  const oldPrincipal = Number(i.original_principal ?? i.principal), oldStart = i.start_date || i.expected_start;
  const financial = rate !== Number(i.monthly_rate) || bonus !== Number(i.admin_bonus_rate || 0) || lock !== Number(i.lockin_months) || principal !== oldPrincipal || start !== oldStart;
  if (financial) {
    const wd = (i.principal_changes || []).length > 0;
    if (wd && (principal !== oldPrincipal || start !== oldStart)) fail(`${i.code} has withdrawals, so its principal and start date cannot be changed. Edit or delete those withdrawals first.`);
    resetReturnsFrom(i, '0000-01-01');
    if (principal !== oldPrincipal) { i.original_principal = principal; i.principal = principal; }
    Object.assign(i, { monthly_rate: rate, admin_bonus_rate: bonus, lockin_months: lock });
    if (!i.plan_id) { i.plan_name = rate + '% Monthly'; i.bonus_on_top = true; }
    if (i.status === 'pending_funding') i.expected_start = start;
    else {
      const maturity = lock > 0 ? addMonths(start, lock) : null;
      Object.assign(i, { start_date: start, expected_start: start, maturity_date: maturity, lockin_end_date: maturity || start, request_from_date: maturity ? addDays(maturity, -settings().request_window_days) : null });
      if (i.status === 'matured' && (!maturity || maturity > today())) i.status = 'active';
    }
    applySplit(i);
    ledgerFor('investments', i.id).forEach(l => Object.assign(l, { amount: principal, occurred_on: start, updated_at: nowIso() }));
  }
  if (a.p_roi_method !== undefined) Object.assign(i, roiMethodOf(a, false));
  if (a.p_reference != null) { i.deposit_ref = str(a.p_reference).trim(); i.agreement_ref = i.deposit_ref; }
  if (a.p_notes != null) i.notes = str(a.p_notes).trim();
  i.updated_at = nowIso();
  audit('investment.update', 'investment', i.id, i.code, str(a.p_reason, financial ? 'Terms changed; returns recalculated' : 'Details changed'), before,
    { monthly_rate: i.monthly_rate, admin_bonus_rate: i.admin_bonus_rate, lockin_months: i.lockin_months, principal: i.original_principal ?? i.principal, start_date: i.start_date || i.expected_start, reference: i.deposit_ref, notes: i.notes, roi_method: i.roi_method ?? null, roi_upi: i.roi_upi ?? null });
  if (financial) runAccrualsFor(i, today());
}

/** Removes an investment and everything calculated from it. Its withdrawals must be deleted first (unless deleting the investor). */
function removeInvestment(i: Row, reason: string, withWithdrawals = false) {
  const wds = T('withdrawals').filter(w => w.status !== 'cancelled' && (w.allocations || []).some((p: Row) => p.investment_id === i.id));
  if (wds.length && !withWithdrawals) fail(`${i.code} has withdrawals (${wds.map(w => w.code).join(', ')}). Delete them first.`);
  const accIds = new Set(T('accruals').filter(x => x.investment_id === i.id).map(x => x.id));
  S.tables.accruals = T('accruals').filter(x => x.investment_id !== i.id);
  S.tables.payouts = T('payouts').filter(x => x.investment_id !== i.id);
  S.tables.admin_bonuses = T('admin_bonuses').filter(x => x.investment_id !== i.id);
  S.tables.ledger_entries = T('ledger_entries').filter(x => x.investment_id !== i.id);
  S.tables.documents = T('documents').filter(x => x.investment_id !== i.id);
  S.tables.contract_amendments = T('contract_amendments').filter(x => x.investment_id !== i.id);
  S.tables.notifications = T('notifications').filter(n => !(accIds.has(n.source_id) || (n.source_table === 'investments' && n.source_id === i.id) || String(n.link || '').endsWith('/' + i.code)));
  T('investment_requests').forEach(r => { if (r.investment_id === i.id) { r.investment_id = null; r.decision_note = str(r.decision_note) + ' (investment ' + i.code + ' was deleted)'; } });
  S.tables.investments = T('investments').filter(x => x.id !== i.id);
  audit('investment.delete', 'investment', i.id, i.code, reason || 'Deleted', { ...i, principal_changes: undefined }, null);
}

/** Puts back what a withdrawal took out of the investments (principal, closed status, ledger lines) and recalculates
 *  the returns from its date. A later withdrawal of the same person must be removed first. */
function undoWithdrawal(w: Row) {
  const later = T('withdrawals').find(x => x.id !== w.id && x.investor_id === w.investor_id && x.status !== 'cancelled' && wdOrder(x, w) > 0);
  if (later) fail(`${later.code} was requested after ${w.code}. Delete or edit ${later.code} first.`);
  const invs = (w.allocations || []).map((pt: Row) => T('investments').find(x => x.id === pt.investment_id)).filter(Boolean) as Row[];
  invs.forEach(i => resetReturnsFrom(i, w.requested_on));
  invs.forEach(i => {
    i.principal_changes = (i.principal_changes || []).filter((c: Row) => c.withdrawal_id !== w.id);
    i.principal = principalOn(i, '9999-12-31'); applySplit(i);
    if (i.status === 'redeemed' && Number(i.principal) > 0) i.status = i.maturity_date && i.maturity_date <= today() ? 'matured' : 'active';
    i.updated_at = nowIso();
  });
  S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'withdrawals' && String(l.source_id).startsWith(w.id + ':')));
  return invs;
}
/** Who may change a withdrawal: the Super Admin, or (while it is pending) the investor, the person who asked for it, or their IB. */
function mayChangeWithdrawal(w: Row) {
  if (isAdmin()) return;
  const u = currentUid;
  if (w.status !== 'pending') fail(`${w.code} is already ${w.status}. Only pending requests can be changed.`);
  if (!(w.investor_id === u || w.requested_by === u || isMySub(w.investor_id))) fail('Withdrawal not found.');
}
function updateWithdrawal(a: Row) {
  const w = T('withdrawals').find(x => x.id === a.p_id) || fail('Withdrawal not found.');
  mayChangeWithdrawal(w);
  if (w.status !== 'pending') fail(`${w.code} is already ${w.status}. Only pending requests can be edited; delete it instead.`);
  const before = { amount: w.amount, method: w.method, mt5_account: w.mt5_account, note: w.note };
  const who = T('profiles').find(p => p.id === w.investor_id) || fail('Investor not found.');
  const amount = blank(a.p_amount) ? Number(w.amount) : Number(a.p_amount);
  if (!(amount > 0) || round2(amount) !== amount) fail('Enter the amount to withdraw (at most 2 decimals).');
  const method = WD_METHODS.includes(String(a.p_method)) ? String(a.p_method) : w.method;
  if (method === 'cash' && !isAdmin()) fail('Choose the bank account, an MT5 account or a transfer to the IB.');
  const mt5 = str(a.p_mt5, w.mt5_account || '').trim();
  if (method === 'mt5' && !/^[A-Za-z0-9._-]{3,40}$/.test(mt5)) fail('Enter the MT5 account number (letters and digits only).');
  const ib = who.introduced_by ? T('profiles').find(p => p.id === who.introduced_by && p.role === 'investor') || null : null;
  if (method === 'ib' && !ib) fail(`${who.full_name} is not under an IB, so a transfer to an IB is not possible.`);
  const invs = undoWithdrawal(w);
  const available = round2(T('investments').filter(i => i.investor_id === who.id && WD_LIVE(i)).reduce((x, i) => x + Number(i.principal), 0));
  if (amount > available) fail(`Up to ${fmtMoney(available)} can be withdrawn.`);
  const parts = planWithdrawal(who.id, amount, String(w.requested_on));
  if (round2(parts.reduce((t, q) => t + Number(q.amount), 0)) < amount) fail(`Up to ${fmtMoney(round2(parts.reduce((t, q) => t + Number(q.amount), 0)))} can be withdrawn on ${fmtDate(w.requested_on)}.`);
  Object.assign(w, { amount, method, mt5_account: method === 'mt5' ? mt5 : null, ib_id: method === 'ib' ? ib!.id : null, note: a.p_note != null ? str(a.p_note).trim() : w.note, allocations: parts, updated_at: nowIso() });
  if (a.p_attachments != null) w.attachments = cleanAttachments(a.p_attachments);
  const how = wdHow(w), d = w.requested_on;
  parts.forEach(pt => {
    const i = T('investments').find(x => x.id === pt.investment_id)!;
    if (i.original_principal === undefined) i.original_principal = Number(i.principal);
    i.principal_changes = [...(i.principal_changes || []), { date: d, principal: pt.after, withdrawal_id: w.id }];
    i.principal = pt.after; applySplit(i); i.updated_at = nowIso(); closeIfEmpty(i);
    ledger({ investment_id: i.id, investor_id: who.id, type: 'principal_redemption', amount: pt.amount, status: 'pending', occurred_on: d, reference: w.code, note: 'Withdrawal requested · ' + how, source_table: 'withdrawals', source_id: w.id + ':' + i.id });
  });
  [...invs, ...parts.map(pt => T('investments').find(x => x.id === pt.investment_id)!)].forEach(i => runAccrualsFor(i, today()));
  if (!isAdmin()) T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(ad =>
    notify(ad.id, 'withdrawal', 'Withdrawal ' + w.code + ' was changed: ' + fmtMoney(amount), who.full_name + ' · ' + how, '/admin/withdrawals', 'withdrawals', w.id + ':edit:' + nowIso()));
  audit('withdrawal.update', 'withdrawal', w.id, w.code, str(a.p_reason, 'Withdrawal changed'), before, { amount, method, mt5_account: w.mt5_account, note: w.note });
}
function deleteWithdrawal(a: Row) {
  const w = T('withdrawals').find(x => x.id === a.p_id) || fail('Withdrawal not found.');
  mayChangeWithdrawal(w);
  const invs = w.status === 'cancelled' ? [] : undoWithdrawal(w);
  if (w.status === 'cancelled') S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'withdrawals' && String(l.source_id).startsWith(w.id + ':')));
  S.tables.withdrawals = T('withdrawals').filter(x => x.id !== w.id);
  S.tables.notifications = T('notifications').filter(n => !(n.source_table === 'withdrawals' && String(n.source_id).startsWith(w.id)));
  invs.forEach(i => runAccrualsFor(i, today()));
  if (!isAdmin()) T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(ad =>
    notify(ad.id, 'withdrawal', 'Withdrawal ' + w.code + ' was deleted by the investor', fmtMoney(w.amount), '/admin/withdrawals', 'withdrawals_deleted', w.id));
  audit('withdrawal.delete', 'withdrawal', w.id, w.code, str(a.p_reason, 'Withdrawal deleted'), { amount: w.amount, method: w.method, status: w.status }, null);
}

/** Super Admin: remove an investor with everything recorded for them (investments, returns, withdrawals, requests, documents, login). */
function deleteInvestor(a: Row) {
  requireAdmin();
  const p = T('profiles').find(x => x.id === a.p_id) || fail('Investor not found.');
  if (p.role !== 'investor') fail('Only investors can be deleted here.');
  const subs = T('profiles').filter(x => x.role === 'investor' && x.introduced_by === p.id);
  if (subs.length) fail(`${p.full_name} has ${subs.length} sub-investor${subs.length === 1 ? '' : 's'} (${subs.slice(0, 3).map(x => x.full_name).join(', ')}${subs.length > 3 ? '…' : ''}). Delete them or place them under someone else first.`);
  const wdIds = new Set(T('withdrawals').filter(w => w.investor_id === p.id).map(w => w.id));
  S.tables.withdrawals = T('withdrawals').filter(w => !wdIds.has(w.id));
  S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'withdrawals' && wdIds.has(String(l.source_id).split(':')[0])));
  T('investments').filter(i => i.investor_id === p.id).forEach(i => removeInvestment(i, 'Investor deleted', true));
  S.tables.investment_requests = T('investment_requests').filter(r => r.investor_id !== p.id && r.requested_by !== p.id);
  S.tables.queries = T('queries').filter(q => q.investor_id !== p.id);
  S.tables.documents = T('documents').filter(d => d.owner_id !== p.id);
  S.tables.notifications = T('notifications').filter(n => n.user_id !== p.id);
  S.tables.payouts = T('payouts').filter(x => x.investor_id !== p.id);
  S.tables.ledger_entries = T('ledger_entries').filter(x => x.investor_id !== p.id);
  S.tables.brochure_views = T('brochure_views').filter(x => x.user_id !== p.id);
  S.tables.password_requests = T('password_requests').filter(x => x.user_id !== p.id);
  T('admin_bonuses').forEach(b => { if (b.admin_id === p.id) b.admin_id = null; });
  S.tables.profiles = T('profiles').filter(x => x.id !== p.id);
  S.users = S.users.filter(u => u.id !== p.id);
  audit('investor.delete', 'profile', p.id, p.code, str(a.p_reason, 'Investor deleted'), { full_name: p.full_name, phone: p.phone, code: p.code }, null);
}

/* ---------- queries: an investor asks, the Super Admin answers ---------- */
function askQuery(a: Row): string {
  const mePr = me() || fail('Not signed in.');
  if (mePr.role !== 'investor') fail('Only investors can ask a query.');
  if (blank(a.p_subject)) fail('Enter a subject.'); if (blank(a.p_message)) fail('Write your question.');
  const id = uuid(), code = 'Q-' + pad(nextSeq('query', 1), 4);
  T('queries').push({ id, code, investor_id: mePr.id, subject: String(a.p_subject).trim(), status: 'open', created_at: nowIso(), updated_at: nowIso(),
    messages: [{ from: 'investor', by: mePr.id, text: String(a.p_message).trim(), at: nowIso() }] });
  T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(ad =>
    notify(ad.id, 'query', 'New query ' + code + ' from ' + mePr.full_name, String(a.p_subject).trim(), '/admin/queries?open=' + id, 'queries', id + ':' + nowIso()));
  return id;
}
function replyQuery(a: Row) {
  const mePr = me() || fail('Not signed in.');
  const q = T('queries').find(x => x.id === a.p_id) || fail('Query not found.');
  const admin = isAdmin();
  if (!admin && q.investor_id !== mePr.id) fail('Query not found.');
  if (blank(a.p_message)) fail('Write a message.');
  q.messages = [...(q.messages || []), { from: admin ? 'admin' : 'investor', by: mePr.id, text: String(a.p_message).trim(), at: nowIso() }];
  q.status = admin ? (a.p_close ? 'closed' : 'answered') : 'open'; q.updated_at = nowIso();
  if (admin) notify(q.investor_id, 'query', 'Reply to your query ' + q.code, q.subject, '/portal/queries?open=' + q.id, 'queries', q.id + ':' + nowIso());
  else T('profiles').filter(p => p.role === 'super_admin' && p.account_status === 'active').forEach(ad => notify(ad.id, 'query', 'New message on ' + q.code + ' from ' + mePr.full_name, q.subject, '/admin/queries?open=' + q.id, 'queries', q.id + ':' + nowIso()));
}

/* ---------- accounts ---------- */
export async function createAccount(u: Row): Promise<{ id: string; code: string }> {
  requireAdmin();
  const email = String(u.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('Enter a valid email address.');
  if (blank(u.full_name)) fail('Enter the full name.');
  if (String(u.password || '').length < 10) fail('Temporary password must be at least 10 characters.');
  if (S.users.some(x => x.email === email)) fail('A user with this email already exists.');
  const id = uuid(); const admin = u.role === 'super_admin';
  S.users.push({ id, email, pw: await hash(u.password) });
  const by = admin ? null : blank(u.introduced_by) ? currentUid : String(u.introduced_by);
  if (by && !canBeIntroducer(by)) fail('Choose a valid person for "Introduced by".');
  const code = admin ? 'ADM-' + nextSeq('admin', 1) : 'INVR-' + nextSeq('investor', 1001);
  const pr = profileRow(id, email, String(u.full_name).trim(), code, admin ? 'super_admin' : 'investor', admin ? 'verified' : 'pending', { ...u, introduced_by: by });
  if (admin && u.read_only) pr.read_only = true;
  T('profiles').push(pr);
  audit(admin ? 'admin.create' : 'investor.create', 'profile', id, code, 'Created with temporary password', null, { email, full_name: u.full_name, role: admin ? 'super_admin' : 'investor' });
  persist('profiles', 'audit_logs');
  return { id, code };
}
/** Super Admins need at least 10 characters; investors, IBs and sub-investors at least 8 (as set at registration). */
const minPw = (userId: string) => (T('profiles').find(p => p.id === userId)?.role === 'super_admin' ? 10 : PW_MIN);
export async function setPassword(userId: string, pw: string) {
  const n = minPw(userId);
  if (pw.length < n) fail(`Use at least ${n} characters.`);
  if (pw.length > 200) fail('Use at most 200 characters.');
  const u = S.users.find(x => x.id === userId) || fail('User not found.');
  u.pw = await hash(pw); persist();
}
/** Change password: the current password is checked first (only a salted hash is ever stored). */
export async function changePassword(userId: string, current: string, next: string) {
  const u = S.users.find(x => x.id === userId) || fail('User not found.');
  if (!current || !(await verify(current, u.pw))) fail('The current password is incorrect.');
  if (current === next) fail('Choose a new password that is different from the current one.');
  await setPassword(userId, next);
  const p = T('profiles').find(x => x.id === userId);
  if (p) { p.password_changed_at = nowIso(); p.updated_at = nowIso(); }
  audit('user.password_change', 'profile', userId, p?.code || p?.email || '', 'Password changed by the user', null, null);
  persist('profiles', 'audit_logs');
}
export async function adminResetPassword(userId: string, pw: string) {
  requireAdmin(); await setPassword(userId, pw);
  const p = T('profiles').find(x => x.id === userId); audit('user.password_reset', 'profile', userId, p?.code || p?.email || '', 'Temporary password set by administrator', null, null); persist('audit_logs');
}
/** Sets a person's login password, or creates their login (phone number + password) if they have none. */
export async function adminSetLogin(userId: string, pw: string) {
  requireAdmin();
  if (pw.length < PW_MIN) fail(`The password must be at least ${PW_MIN} characters.`);
  const p = T('profiles').find(x => x.id === userId) || fail('Investor not found.');
  if (S.users.some(u => u.id === userId)) await setPassword(userId, pw);
  else addLogin(userId, p.phone, await hash(pw));
  p.has_login = true; p.updated_at = nowIso();
  audit('user.password_reset', 'profile', userId, p.code || '', 'Password set by administrator', null, null); persist('profiles', 'audit_logs');
}
/** Super Admin: change a CRM login's email and/or password, or remove the CRM login. */
export async function adminCrmLogin(a: Row): Promise<null> {
  requireAdmin();
  const p = T('profiles').find(x => x.id === String(a.userId) && x.role === 'super_admin' && x.read_only) || fail('CRM login not found.');
  const u = S.users.find(x => x.id === p.id) || fail('CRM login not found.');
  if (a.remove) {
    S.users = S.users.filter(x => x.id !== p.id);
    S.tables.profiles = T('profiles').filter(x => x.id !== p.id);
    S.tables.notifications = T('notifications').filter(n => n.user_id !== p.id);
    audit('crm.delete', 'profile', p.id, p.code, 'CRM login removed', { email: u.email }, null); persist('profiles', 'audit_logs');
    return null;
  }
  const before = { email: u.email, full_name: p.full_name };
  if (!blank(a.email)) {
    const e = String(a.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) fail('Enter a valid email address.');
    if (S.users.some(x => x.email === e && x.id !== p.id)) fail('Another login already uses this email.');
    u.email = e; p.email = e;
  }
  if (!blank(a.full_name)) p.full_name = String(a.full_name).trim();
  if (!blank(a.password)) {
    if (String(a.password).length < 10) fail('The password must be at least 10 characters.');
    u.pw = await hash(String(a.password));
  }
  p.updated_at = nowIso();
  audit('crm.update', 'profile', p.id, p.code, blank(a.password) ? 'CRM login changed' : 'CRM login changed (new password)', before, { email: u.email, full_name: p.full_name }); persist('profiles', 'audit_logs');
  return null;
}
export async function checkLogin(email: string, pw: string): Promise<string | null> {
  // an IB signs in with the phone number the Super Admin registered
  const key = email.includes('@') ? '' : phoneKey(email);
  const ib = key.length === 10 ? T('profiles').find(p => p.role === 'investor' && phoneKey(p.phone) === key && S.users.some(x => x.id === p.id)) : null;
  const u = ib ? S.users.find(x => x.id === ib.id) : S.users.find(x => x.email === email.trim().toLowerCase());
  return u && await verify(pw, u.pw) ? u.id : null;
}
export const userEmail = (id: string) => S.users.find(u => u.id === id)?.email || '';

/* ---------- forgot password: the Super Admin is told (in-app and by email) and sets a new temporary password ---------- */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
/** Records a forgot-password request and returns the email for the Super Admins (null when nothing should be sent).
 *  The answer to the person is always the same, so it never reveals whether an account exists.
 *  At most one request per account every 15 minutes, and 30 an hour in total. */
export function forgotPassword(identifier: string, message: string, siteUrl: string): { to: string[]; subject: string; text: string; html: string } | null {
  const raw = String(identifier || '').trim().slice(0, 120);
  if (!raw) return null;
  const key = raw.includes('@') ? '' : phoneKey(raw);
  let p: Row | null = null;
  if (key.length === 10) p = T('profiles').find(x => x.role === 'investor' && phoneKey(x.phone) === key && hasLogin(x.id)) || null;
  else if (raw.includes('@')) { const u = S.users.find(x => x.email === raw.toLowerCase()); p = u ? T('profiles').find(x => x.id === u.id) || null : null; }
  if (!p) return null;
  const now = Date.now();
  S.tables.password_requests = T('password_requests').filter(r => now - Date.parse(r.at) < 7 * 864e5);
  const log = T('password_requests');
  if (log.some(r => r.user_id === p!.id && now - Date.parse(r.at) < 15 * 60e3)) return null;
  if (log.filter(r => now - Date.parse(r.at) < 3600e3).length >= 30) return null;
  const note = String(message || '').trim().slice(0, 500);
  log.push({ id: uuid(), user_id: p.id, at: nowIso(), note });
  const kind = p.role === 'super_admin' ? 'Super Admin' : isIbProfile(p) ? 'IB' : p.introduced_by ? 'Sub-investor' : 'Investor';
  const login = p.role === 'super_admin' ? userEmail(p.id) : p.phone;
  const admins = T('profiles').filter(x => x.role === 'super_admin' && x.account_status === 'active');
  const path = '/admin/investors/' + encodeURIComponent(p.code || '');
  admins.forEach(ad => notify(ad.id, 'password_reset', (p!.full_name || login) + ' forgot their password', kind + ' · ' + login + (note ? ' · “' + note + '”' : '') + ' · open and use Reset password', path, 'password_requests', uuid()));
  audit('user.password_forgot', 'profile', p.id, p.code || '', 'Forgot password requested from the sign-in page', null, { login });
  persist('password_requests', 'notifications', 'audit_logs');
  const to = [...new Set([...admins.map(ad => userEmail(ad.id) || ad.email), settings()?.support_email]
    .map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && !e.endsWith('@investor.login')))];
  const company = settings()?.company_name || 'Portfolio';
  const link = siteUrl ? siteUrl + path : '';
  const rows: [string, string][] = [['Name', p.full_name || '—'], ['ID', p.code || '—'], ['Account', kind], [p.role === 'super_admin' ? 'Email' : 'Phone (login)', login || '—'], ['Requested', fmtDate(today()) + ' ' + new Date().toISOString().slice(11, 16) + ' UTC']];
  if (note) rows.push(['Message', note]);
  return {
    to, subject: `${company}: ${p.full_name || login} forgot their password`,
    text: `${p.full_name || login} asked for a new password on the sign-in page.\n\n${rows.map(([k, v]) => k + ': ' + v).join('\n')}\n\nSet a new temporary password with “Reset password”${link ? ' at ' + link : ' on their page under Investors'}, then share it with them offline. They can change it after signing in.\n\nIf this was not them, you can ignore this email; their password has not changed.`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b1b1b;max-width:560px">
<p><b>${esc(p.full_name || login)}</b> asked for a new password on the ${esc(company)} sign-in page.</p>
<table style="border-collapse:collapse;margin:12px 0">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p>Set a new temporary password with <b>Reset password</b> on their page, then share it with them offline. They can change it after signing in.</p>
${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0F2147;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open ${esc(p.full_name || 'account')}</a></p>` : ''}
<p style="color:#777;font-size:12px">If this was not them, ignore this email. Their password has not changed.</p></div>`
  };
}

function profileRow(id: string, email: string, name: string, code: string, role: string, kyc: string, x: Row = {}): Row {
  return { id, role, code, full_name: name, email, phone: str(x.phone), address: str(x.address), city: str(x.city), id_number_masked: str(x.id_number_masked), bank_name: str(x.bank_name),
    bank_account_masked: str(x.bank_account_masked), bank_ifsc: str(x.bank_ifsc), kyc_status: kyc, account_status: 'active', notify_email: true, branch_id: x.branch_id ?? null, introduced_by: role === 'investor' ? (x.introduced_by ?? null) : null, can_introduce: role === 'investor' ? !!x.can_introduce : false,
    created_at: x.created_at || nowIso(), updated_at: nowIso() };
}

/* ---------- first run: an empty company with one Super Admin (no sample data) ---------- */
export async function freshStore(admin: { email: string; name: string; password: string }): Promise<Store> {
  S = { v: 9, tables: Object.fromEntries(TABLES.map(t => [t, []])), seq: {}, users: [] };
  const email = admin.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('PMS_ADMIN_EMAIL is not a valid email address.');
  if (String(admin.password || '').length < 10) fail('PMS_ADMIN_PASSWORD must be at least 10 characters.');
  T('settings').push({ id: 1, company_name: 'Parva Realty', tagline: 'Every investment, return and maturity in one place.', logo_url: null, primary_color: '#0F2147', currency: 'INR', locale: 'en-IN',
    timezone: 'Asia/Kolkata', approaching_days: 60, request_window_days: 30, default_payout_lag_days: 3, four_eyes: false, allow_custom_lockin: true, lockin_options: [6, 12],
    default_terms: 'Returns are simple interest on the original principal at the monthly rate in this agreement. Unpaid returns are not added to principal.',
    default_risk_disclosure: 'Investments carry risk, including loss of principal. Contractual rates are not a guarantee of payment.',
    support_email: email, support_phone: '', legal_footer: 'Parva Realty · Dubai & India', property_site_url: 'https://parvarealty.ae/', show_properties_to: 'all', updated_at: nowIso(), updated_by: null });
  const adminId = uuid();
  S.users.push({ id: adminId, email, pw: await hash(admin.password) });
  T('profiles').push(profileRow(adminId, email, admin.name.trim() || 'Super Admin', 'ADM-' + nextSeq('admin', 1), 'super_admin', 'verified'));
  T('properties').push(...parvaProperties(adminId));
  return S;
}

/* ---------- the property catalogue published on parvarealty.ae (October 2026) ---------- */
const PARVA_URL = 'https://www.parvarealty.ae/#properties';
// photos as shown in each property's details on parvarealty.ae
const PARVA_IMG: Record<string, string> = {
  'Mercedes-Benz Places': 'https://www.parvarealty.ae/assets/image-1-CXaW41xx.png',
  'Portofino Felicita': 'https://www.parvarealty.ae/assets/image-43-B4Mm8xRT.png',
  'SAMANA South Haven': 'https://www.parvarealty.ae/assets/image-7-BUDqZRZd.png',
  'Sunset Bay Grand': 'https://www.parvarealty.ae/assets/image-16-B8QVYKbA.png',
  'The Symphony': 'https://www.parvarealty.ae/assets/image-20-BZPMbuKe.png',
  'Auresta Tower': 'https://www.parvarealty.ae/assets/image-11-Diy888YD.png',
  'Tiger Sky Tower': 'https://www.parvarealty.ae/assets/image-28-DU1kaeTK.png',
  'Serenz': 'https://www.parvarealty.ae/assets/image-31-B0ydBebC.png',
  'Bianca': 'https://www.parvarealty.ae/assets/image-37-Dcl805qL.png',
  'Enre Residence': 'https://www.parvarealty.ae/assets/image-47-YM830T3P.png',
  'TIMEZ': 'https://www.parvarealty.ae/assets/image-54-BruEDsDt.png',
  'Greenz': 'https://www.parvarealty.ae/assets/image-59-C68cVji4.png',
};
// [title, location, developer, type, size, handover, price, rental yield, capital growth, summary]
const PARVA: [string, string, string, string, string, string, string, string, string, string][] = [
  ['Mercedes-Benz Places', 'Downtown Dubai', 'Binghatti Developers', 'Branded Luxury Residences', '1,500 – 4,000 sq ft', 'Q4 2027', '₹13.03 Cr+ (AED 5M+)', '6.8%', '14.2%', 'The only Mercedes-Benz co-branded residential tower in the world, with Burj Khalifa views.'],
  ['Portofino Felicita', 'Europe Island, The World Islands', 'The Heart of Europe', 'Sea-View Resort Units', '1,200 – 2,000 sq ft', 'Q2 2027', '₹13.6 – 14.3 Cr (AED 5.22M – 5.49M)', '7.2%', '13.5%', 'A resort-style sea-view residence on a man-made island.'],
  ['SAMANA South Haven', 'Dubai South', 'SAMANA Developers', 'Studio / 1BR', '450 – 680 sq ft', 'Q3 2027', '₹1.56 Cr (from AED 599K)', '8.4%', '7.8%', 'Private-pool studios in the Al Maktoum Airport growth corridor, with a 1% monthly payment plan.'],
  ['Sunset Bay Grand', 'Dubai Islands', 'Imtiaz Developments', '1BR / 2BR / 3BR Duplex', '900 – 2,800 sq ft', 'Q3 2027', '₹6.10 Cr (~AED 2.34M)', '8.1%', '11.2%', 'Waterfront address with direct sea access and a 3BR duplex format.'],
  ['The Symphony', 'Meydan Horizon', 'Imtiaz Developments', '4BR / 5BR Residences', '3,200 – 6,500 sq ft', 'Q1 2028', '₹18.95 Cr (~AED 7.27M)', '6.5%', '15.1%', 'Design-led ultra-luxury residences in Meydan with racecourse views.'],
  ['Auresta Tower', 'Jumeirah Village Circle', 'Tiger Properties', 'Studio / 1BR', '480 – 750 sq ft', 'Q2 2027', '₹2.22 Cr (~AED 850K)', '9.1%', '7.2%', 'JVC studios, an area known for some of Dubai’s highest studio rental yields.'],
  ['Tiger Sky Tower', 'Business Bay', 'Tiger Properties', '1BR / 2BR / 3BR+', '780 – 2,400 sq ft', 'Q4 2027', '₹8.26 Cr (~AED 3.17M)', '7.8%', '10.5%', 'Iconic architecture in central Business Bay.'],
  ['Serenz', 'Jumeirah Village Circle', 'Danube Properties', 'Studio / 1BR / 2BR', '500 – 1,100 sq ft', 'Q4 2027', '₹2.87 Cr (~AED 1.10M)', '8.8%', '7.5%', 'Danube project in JVC with a flexible 1% payment plan.'],
  ['Bianca', 'Dubailand', 'Reportage Properties', '2BR Townhouse', '1,450 – 1,800 sq ft', 'Q1 2028', '₹3.47 Cr (~AED 1.33M)', '7.9%', '9.4%', 'Townhouses at mid-range pricing with strong family rental demand.'],
  ['Enre Residence', 'Dubai South', 'Imtiaz Developments', '2BR', '1,200 – 1,550 sq ft', 'Q2 2027', '₹4.92 Cr (~AED 1.89M)', '8.5%', '9.8%', 'Premium-design 2BR homes in the Dubai South growth corridor.'],
  ['TIMEZ', 'Dubai Silicon Oasis', 'Danube Properties', '1BR / 2BR', '900 – 1,350 sq ft', 'Q3 2027', '₹4.30 Cr (~AED 1.65M)', '8.2%', '8.6%', 'Tech-hub location with steady rental demand and a 1% payment plan.'],
  ['Greenz', 'Academic City', 'Danube Properties', '3BR Family', '1,800 – 2,400 sq ft', 'Q1 2028', '₹9.56 Cr (~AED 3.67M)', '7.5%', '9.9%', 'Large family apartments next to Academic City’s 50,000-student catchment.']
];
function parvaProperties(by: string | null): Row[] {
  return PARVA.map(([title, location, dev, type, size, handover, price, yld, cap, about], k) => ({
    id: uuid(), title, location, property_type: type, price_text: price,
    description: `${about} By ${dev} · ${size} · handover ${handover} · ${yld} rental yield, ${cap} capital growth (as listed by Parva Realty).`,
    image_url: PARVA_IMG[title] || null, url: PARVA_URL, status: 'published', sort_order: k + 1, created_by: by, created_at: nowIso(), updated_at: nowIso()
  }));
}

/* ---------- server: one request at a time works on this store ---------- */
export function attach(store: Store) { S = store; TABLES.forEach(t => { S.tables[t] ||= []; }); }
export const current = () => S;
/** Monthly returns that have fallen due since the last request. */
export function catchUp() { const prev = currentUid; currentUid = null; try { toCalendarMonths(); bonusOnTop(); runAllAccruals(); paidPast(); } finally { currentUid = prev; } }
/** One-time: when returns stopped being limited to the lock-in, every month up to the last ended month (at the time this
 *  ran) was already given to the investors and IBs, so all returns and IB bonuses up to that month's end are marked paid
 *  on that date. Later months follow the normal flow (Pending until paid). Runs only once. */
function paidPast() {
  if (S.seq.paid_past) return;
  const t = today(), y = +t.slice(0, 4), mo = +t.slice(5, 7);
  const last = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  closeMonth({ p_month: last });
  S.seq.paid_past = 1;
  persist('payouts', 'admin_bonuses', 'ledger_entries');
}

/** Removes an investment's calculated returns (accruals, their payouts, bonuses, ledger lines and notifications) so the
 *  next accrual run recreates them. Only used while none of them has been approved or paid. */
const moneyMoved = (i: Row) => T('payouts').some(p => p.investment_id === i.id && ['approved', 'processing', 'paid'].includes(p.status))
  || T('admin_bonuses').some(b => b.investment_id === i.id && b.status === 'paid');
function resetReturns(i: Row): number {
  const accIds = new Set(T('accruals').filter(a => a.investment_id === i.id).map(a => a.id));
  S.tables.accruals = T('accruals').filter(a => !accIds.has(a.id));
  S.tables.payouts = T('payouts').filter(p => p.investment_id !== i.id);
  S.tables.admin_bonuses = T('admin_bonuses').filter(b => b.investment_id !== i.id);
  S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'accruals' && accIds.has(l.source_id)));
  S.tables.notifications = T('notifications').filter(n => !(n.source_table === 'accruals' && accIds.has(n.source_id)));
  return accIds.size;
}
/** One-time switch: investments recorded directly (not on a plan) with an IB bonus taken out of the ROI now get the bonus
 *  on top: the investor keeps the whole ROI and the IB gets the bonus in addition. Returns are recalculated while nothing
 *  has been approved or paid; otherwise the investment is left as it was and flagged for review. */
function bonusOnTop() {
  T('investments').forEach(i => {
    if (i.bonus_on_top || i.bonus_review || i.plan_id || !(Number(i.admin_bonus_rate || 0) > 0)) return;
    if (['cancelled', 'redeemed'].includes(i.status)) return;
    if (moneyMoved(i)) { i.bonus_review = true; audit('investment.bonus_mode', 'investment', i.id, i.code, 'IB bonus is now paid on top of the ROI; this investment already had approved or paid returns, so it was left unchanged for review', null, null); return; }
    const before = { investor_rate: i.investor_rate, monthly_return: i.monthly_return, admin_bonus: i.admin_bonus };
    const removed = resetReturns(i);
    i.bonus_on_top = true; applySplit(i); i.updated_at = nowIso();
    audit('investment.bonus_mode', 'investment', i.id, i.code, 'IB bonus moved on top of the ROI: the investor keeps the whole ROI' + (removed ? '; returns recalculated' : ''), before, { investor_rate: i.investor_rate, monthly_return: i.monthly_return, admin_bonus: i.admin_bonus });
  });
}

/** One-time switch of investments recorded before returns followed calendar months (they used start-date-to-start-date months).
 *  While none of an investment's returns or bonuses have been approved or paid, its returns are recalculated by calendar month
 *  (the next accrual run recreates them). If money has already moved, nothing is changed and the investment is flagged for review. */
function toCalendarMonths() {
  T('investments').forEach(i => {
    if (i.accrual_mode) return;
    const accIds = new Set(T('accruals').filter(a => a.investment_id === i.id).map(a => a.id));
    const moved = T('payouts').some(p => p.investment_id === i.id && ['approved', 'processing', 'paid'].includes(p.status))
      || T('admin_bonuses').some(b => b.investment_id === i.id && b.status === 'paid');
    if (moved) {
      i.accrual_mode = 'anniversary_review';
      audit('investment.accrual_mode', 'investment', i.id, i.code, 'Returns follow calendar months from now on; this investment already had approved or paid returns, so it was left unchanged for review', null, { accrual_mode: i.accrual_mode });
      return;
    }
    const removed = accIds.size;
    S.tables.accruals = T('accruals').filter(a => !accIds.has(a.id));
    S.tables.payouts = T('payouts').filter(p => p.investment_id !== i.id);
    S.tables.admin_bonuses = T('admin_bonuses').filter(b => b.investment_id !== i.id);
    S.tables.ledger_entries = T('ledger_entries').filter(l => !(l.source_table === 'accruals' && accIds.has(l.source_id)));
    S.tables.notifications = T('notifications').filter(n => !(n.source_table === 'accruals' && accIds.has(n.source_id)));
    i.accrual_mode = 'calendar'; i.updated_at = nowIso();
    if (removed) audit('investment.accrual_mode', 'investment', i.id, i.code, 'Returns recalculated by calendar month (from the day after the start date to month end, then whole months)', { periods: removed }, { accrual_mode: 'calendar' });
  });
}
export { brochureVisible };
