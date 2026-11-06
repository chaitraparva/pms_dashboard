import { money } from '../lib/format';
import type { BankDetails } from '../lib/types';
import { Field } from './kit';

/* Where the money goes (withdrawals and ROI requests): Bank (account holder name, account no., IFSC, branch),
   UPI (UPI ID or UPI phone number), Cash, or MT5 (MT5 ID; the whole amount goes to it). What the person fills in
   is sent with the request and shown to the Super Admin. */

export type PayMethod = 'bank' | 'upi' | 'cash' | 'mt5' | 'ib';
export interface PayDetails { mt5: string; upi: string; bank: BankDetails }
interface PayRow { method?: string | null; mt5_account?: string | null; upi_id?: string | null; bank_details?: BankDetails | null }

export const emptyPay = (): PayDetails => ({ mt5: '', upi: '', bank: { name: '', account: '', ifsc: '', branch: '' } });
export const payFrom = (r: PayRow): PayDetails => ({ mt5: r.mt5_account || '', upi: r.upi_id || '', bank: { name: '', account: '', ifsc: '', branch: '', ...(r.bank_details || {}) } });
export const PAY_LABEL: Record<PayMethod, string> = { bank: 'Bank', upi: 'UPI', cash: 'Cash', mt5: 'MT5', ib: 'Transfer to IB' };

/** Same checks as the server. `required` = everything must be filled (investors and IBs). */
export function payErrors(method: string, d: PayDetails, required: boolean): Partial<Record<'mt5' | 'upi' | 'name' | 'account' | 'ifsc' | 'branch', string>> {
  const e: Partial<Record<'mt5' | 'upi' | 'name' | 'account' | 'ifsc' | 'branch', string>> = {};
  if (method === 'mt5') { const v = d.mt5.trim(); if ((v || required) && !/^[A-Za-z0-9._-]{3,40}$/.test(v)) e.mt5 = 'Enter the MT5 ID (letters and digits only).'; }
  if (method === 'upi') {
    const v = d.upi.trim(), ph = v.replace(/[\s-]/g, '');
    if ((v || required) && !(/^[\w.\-]{1,64}@[\w.\-]{2,64}$/.test(v) || /^(\+?91)?[6-9]\d{9}$/.test(ph))) e.upi = 'Enter the UPI ID (e.g. name@okaxis) or the 10-digit UPI phone number.';
  }
  if (method === 'bank') {
    const b = d.bank, any = b.name.trim() || b.account.trim() || b.ifsc.trim() || b.branch.trim();
    if (required || any) {
      if (!b.name.trim()) e.name = 'Enter the account holder name.';
      if (!/^\d{6,20}$/.test(b.account.replace(/[\s-]/g, ''))) e.account = 'Enter the account number (6 to 20 digits).';
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc.trim().toUpperCase())) e.ifsc = 'Enter the 11-character IFSC code, e.g. SBIN0001234.';
      if (!b.branch.trim()) e.branch = 'Enter the branch.';
    }
  }
  return e;
}
export const payArgs = (method: string, d: PayDetails) => ({
  p_mt5: method === 'mt5' ? d.mt5.trim() : '', p_upi: method === 'upi' ? d.upi.trim() : '',
  p_bank: method === 'bank' ? { name: d.bank.name.trim(), account: d.bank.account.replace(/[\s-]/g, ''), ifsc: d.bank.ifsc.trim().toUpperCase(), branch: d.bank.branch.trim() } : null
});

/** The method buttons. */
export function PayChips({ ways, value, onChange }: { ways: [PayMethod, string][]; value: string; onChange: (m: PayMethod) => void }) {
  return <div className="chips" role="radiogroup">{ways.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={value === k} className={'chip ' + (value === k ? 'on' : '')} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

/** The boxes for the chosen method. */
export function PayFields({ method, d, onChange, tried, required, amount }: { method: string; d: PayDetails; onChange: (d: PayDetails) => void; tried: boolean; required: boolean; amount?: number }) {
  const e = tried ? payErrors(method, d, required) : {};
  const star = required ? ' *' : '';
  const setB = (k: keyof BankDetails, v: string) => onChange({ ...d, bank: { ...d.bank, [k]: v } });
  if (method === 'bank') return (
    <>
      <div className="f-row">
        <Field label={'Account holder name' + star} err={e.name}><input className={'input ' + (e.name ? 'bad' : '')} value={d.bank.name} onChange={ev => setB('name', ev.target.value)} placeholder="Name as in the bank" /></Field>
        <Field label={'Account number' + star} err={e.account}><input className={'input mono ' + (e.account ? 'bad' : '')} inputMode="numeric" value={d.bank.account} onChange={ev => setB('account', ev.target.value)} /></Field>
      </div>
      <div className="f-row">
        <Field label={'IFSC code' + star} err={e.ifsc}><input className={'input mono ' + (e.ifsc ? 'bad' : '')} value={d.bank.ifsc} onChange={ev => setB('ifsc', ev.target.value.toUpperCase())} placeholder="e.g. SBIN0001234" maxLength={11} /></Field>
        <Field label={'Branch' + star} err={e.branch}><input className={'input ' + (e.branch ? 'bad' : '')} value={d.bank.branch} onChange={ev => setB('branch', ev.target.value)} placeholder="e.g. Jayanagar, Bengaluru" /></Field>
      </div>
    </>
  );
  if (method === 'upi') return (
    <Field label={'UPI ID or UPI phone number' + star} err={e.upi}><input className={'input mono ' + (e.upi ? 'bad' : '')} value={d.upi} onChange={ev => onChange({ ...d, upi: ev.target.value })} placeholder="e.g. name@okaxis or 9876543210" /></Field>
  );
  if (method === 'mt5') return (
    <Field label={'MT5 ID' + star} err={e.mt5} hint={amount != null && amount > 0 ? `${money(amount)} goes to this MT5 ID.` : 'The whole amount goes to this MT5 ID.'}>
      <input className={'input mono ' + (e.mt5 ? 'bad' : '')} value={d.mt5} onChange={ev => onChange({ ...d, mt5: ev.target.value })} placeholder="e.g. 51234567" />
    </Field>
  );
  if (method === 'cash') return <p className="hint">Paid in cash by the company.</p>;
  return null;
}

/** One line, e.g. for Excel. */
export function payText(r: PayRow): string {
  const b = r.bank_details;
  if (r.method === 'bank') return 'Bank' + (b ? ` · ${b.name} · A/c ${b.account} · IFSC ${b.ifsc} · ${b.branch}` : '');
  if (r.method === 'upi') return 'UPI' + (r.upi_id ? ' · ' + r.upi_id : '');
  if (r.method === 'mt5') return 'MT5' + (r.mt5_account ? ' · ' + r.mt5_account : '');
  if (r.method === 'cash') return 'Cash';
  if (r.method === 'ib') return 'Transfer to IB';
  return '';
}

/** What the person filled in, for the Super Admin's tables. */
export function PayView({ r, amount }: { r: PayRow; amount?: number }) {
  const b = r.bank_details;
  if (r.method === 'bank') return <>Bank{b ? <>
    <span className="sub" style={{ display: 'block' }}>{b.name}</span>
    <span className="sub mono" style={{ display: 'block' }}>A/c {b.account}</span>
    <span className="sub mono" style={{ display: 'block' }}>IFSC {b.ifsc}</span>
    <span className="sub" style={{ display: 'block' }}>{b.branch}</span></> : <span className="sub">no details given</span>}</>;
  if (r.method === 'upi') return <>UPI{r.upi_id && <span className="sub mono" style={{ display: 'block' }}>{r.upi_id}</span>}</>;
  if (r.method === 'mt5') return <>MT5{r.mt5_account && <span className="sub mono" style={{ display: 'block' }}>ID {r.mt5_account}</span>}{amount != null && <span className="sub" style={{ display: 'block' }}>{money(amount)} to this ID</span>}</>;
  if (r.method === 'cash') return <>Cash</>;
  return null;
}
