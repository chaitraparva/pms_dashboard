import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { money, date, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { Dashboard, Payout, PayoutStatus } from '../lib/types';
import { PayBadge, Kpi, ErrorNote, Loading, PageHead, Modal, Field, IconBtn, useAction } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';

type Person = { id: string; code: string | null; full_name: string; email: string; bank_name: string; bank_account_masked: string; bank_ifsc: string };
type Inv = { id: string; code: string; plan_name: string };
type AccLite = { id: string; period_no: number; kind: string };

interface Row extends Payout { inv?: Inv; investor?: Person; acc?: AccLite }

type Tab = 'accrued' | 'approved' | 'processing' | 'paid' | 'failed' | 'all';
const TABS: [Tab, string][] = [['accrued', 'Due / accrued'], ['approved', 'Approved'], ['processing', 'Processing'], ['paid', 'Paid'], ['failed', 'Failed'], ['all', 'All']];
type Op = 'approved' | 'processing' | 'paid' | 'failed';
const OP_FROM: Record<Op, PayoutStatus[]> = { approved: ['accrued', 'failed'], processing: ['approved'], paid: ['processing'], failed: ['processing'] };
const OP_DONE: Record<Op, string> = { approved: 'Payouts approved', processing: 'Sent to bank', paid: 'Payouts confirmed as paid', failed: 'Payouts marked failed' };
const nameOf = (p?: Person) => (p ? p.full_name || p.email : '—');

async function load() {
  const [pays, invs, people, accs, dash] = await Promise.all([
    fetchAll<Payout>((a, b) => api.from('payouts').select('*').order('due_date', { ascending: false }).range(a, b)),
    fetchAll<Inv>((a, b) => api.from('investments').select('id, code, plan_name').range(a, b)),
    fetchAll<Person>((a, b) => api.from('profiles').select('id, code, full_name, email, bank_name, bank_account_masked, bank_ifsc').range(a, b)),
    fetchAll<AccLite>((a, b) => api.from('accruals').select('id, period_no, kind').neq('kind', 'reversal').range(a, b)),
    rpc<Dashboard>('admin_dashboard')
  ]);
  const invBy = new Map(invs.map(i => [i.id, i]));
  const pplBy = new Map(people.map(p => [p.id, p]));
  const accBy = new Map(accs.map(a => [a.id, a]));
  const rows: Row[] = pays.map(p => ({ ...p, inv: invBy.get(p.investment_id), investor: pplBy.get(p.investor_id), acc: accBy.get(p.accrual_id) }));
  return { rows, dash, pplBy };
}

export function Payouts() {
  const q = useQuery(load, []);
  const { settings, profile } = useAuth();
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>('accrued');
  const [dueOnly, setDueOnly] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<Op | null>(null);
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const t = today();

  const all = q.data?.rows || [];
  const count = (k: Tab) => (k === 'all' ? all.length : all.filter(r => r.status === k).length);
  const rows = useMemo(() => all.filter(r => (tab === 'all' || r.status === tab) && (!dueOnly || r.due_date <= t)), [all, tab, dueOnly, t]);
  const ops: Op[] = tab === 'accrued' || tab === 'failed' ? ['approved'] : tab === 'approved' ? ['processing'] : tab === 'processing' ? ['paid', 'failed'] : [];
  const selectable = (r: Row) => ops.some(o => OP_FROM[o].includes(r.status));
  const chosen = rows.filter(r => sel.has(r.id) && selectable(r));
  const chosenSum = chosen.reduce((s, r) => s + Number(r.amount), 0);

  const switchTab = (k: Tab) => { setTab(k); setSel(new Set()); };
  const openOp = (o: Op) => { setOp(o); setRef(''); setReason(''); setErr(null); };

  const submit = async () => {
    if (!op) return;
    const ids = chosen.filter(r => OP_FROM[op].includes(r.status)).map(r => r.id);
    if (!ids.length) { setErr('Select at least one payout.'); return; }
    if (op === 'paid' && !ref.trim()) { setErr('Enter the bank / UTR reference that confirms these payments.'); return; }
    if (op === 'failed' && !reason.trim()) { setErr('Enter why the payment failed.'); return; }
    const sum = chosen.filter(r => ids.includes(r.id)).reduce((s, r) => s + Number(r.amount), 0);
    const n = await run(() => rpc<number>('admin_payouts_transition', {
      p_ids: ids, p_to: op, p_ref: op === 'paid' || op === 'processing' ? ref.trim() || null : null, p_reason: op === 'failed' ? reason.trim() : null
    }), [OP_DONE[op], `${ids.length} payout${ids.length === 1 ? '' : 's'} · ${money(sum)}${op === 'paid' || op === 'processing' ? ' · investors notified' : ''}`]);
    if (n === undefined) return;
    setOp(null); setSel(new Set());
    switchTab(op === 'processing' ? 'processing' : op === 'paid' ? 'paid' : op === 'failed' ? 'failed' : 'approved');
    refreshAll();
  };

  const exportCsv = () => downloadCsv(`payouts-${tab}-${t}`,
    ['Payout', 'Investor ID', 'Investor', 'Investment', 'Plan', 'Period', 'Due date', 'Amount', 'Status', 'Bank', 'Account', 'IFSC', 'Batch reference', 'Payment reference', 'Paid on', 'Failure reason'],
    rows.map(r => [r.code, r.investor?.code, nameOf(r.investor), r.inv?.code, r.inv?.plan_name, r.acc ? r.acc.period_no + (r.acc.kind === 'stub' ? ' (stub)' : '') : '', r.due_date,
      Number(r.amount).toFixed(2), r.status, r.investor?.bank_name, r.investor?.bank_account_masked, r.investor?.bank_ifsc, r.batch_ref, r.payment_ref, r.paid_on, r.failure_reason]));

  const cols: Col<Row>[] = [
    { h: 'Payout', m: true, v: r => r.code },
    { h: 'Investor', v: r => nameOf(r.investor), r: r => r.investor?.code ? <><Link to={`/admin/investors/${r.investor.code}`}>{nameOf(r.investor)}</Link><span className="sub">{r.investor.code}</span></> : nameOf(r.investor) },
    { h: 'Investment', v: r => r.inv?.code, r: r => r.inv ? <><Link className="mono" to={`/admin/investments/${r.inv.code}`}>{r.inv.code}</Link><span className="sub">{r.inv.plan_name}</span></> : '—' },
    { h: 'Period', v: r => r.acc?.period_no ?? 0, r: r => r.acc ? `#${r.acc.period_no}${r.acc.kind === 'stub' ? ' (stub)' : ''}` : '—' },
    { h: 'Due', v: r => r.due_date, r: r => <span style={r.due_date <= t && !['paid', 'cancelled'].includes(r.status) ? { color: 'var(--amber)' } : undefined}>{date(r.due_date)}</span> },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => money(r.amount) },
    { h: 'Bank', v: r => r.investor?.bank_name || '', r: r => r.investor?.bank_name || r.investor?.bank_account_masked ? <>{r.investor.bank_name || '—'}<span className="sub mono">{r.investor.bank_account_masked}</span></> : <span className="muted">Not on file</span> },
    {
      h: 'Reference', v: r => r.payment_ref || r.batch_ref || r.failure_reason || '', r: r => r.payment_ref
        ? <span className="mono">{r.payment_ref}{r.paid_on && <span className="sub">Paid {date(r.paid_on)}</span>}</span>
        : r.status === 'failed' || r.status === 'cancelled' ? <span className="muted">{r.failure_reason || '—'}</span>
          : r.batch_ref ? <span className="mono muted">{r.batch_ref}</span> : <span className="muted">—</span>
    },
    { h: 'Status', v: r => r.status, r: r => <PayBadge s={r.status} /> }
  ];

  const by = q.data?.dash.payouts_by_status || {};
  const tile = (k: PayoutStatus, l: string, cls?: string) => {
    const x = by[k] || { count: 0, amount: 0 };
    return <Kpi label={l} value={money(x.amount)} cls={cls} sub={`${x.count} payout${Number(x.count) === 1 ? '' : 's'}`} />;
  };
  const sentBy = op === 'paid' ? Array.from(new Set(chosen.map(r => r.sent_by).filter(Boolean) as string[])) : [];
  const selfSent = !!profile && sentBy.includes(profile.id);

  return (
    <>
      <PageHead crumbs={['Payouts']} title="Payouts"
        sub="Payments are made by bank transfer outside the platform and confirmed here with a reference. Nothing shows as paid until it is confirmed."
        actions={<IconBtn icon="download" onClick={exportCsv} disabled={!rows.length}>Export CSV</IconBtn>} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <>
          <div className="kpis k4">
            {tile('accrued', 'Due / accrued')}{tile('approved', 'Approved')}{tile('processing', 'Processing')}{tile('paid', 'Paid', 'pos')}
          </div>
          <div className="note info">
            Workflow: <b>Accrued</b> (accrual job) → <b>Approved</b> (admin) → <b>Processing</b> (sent to bank) → <b>Paid</b> (confirmed with the bank / UTR reference).
            A failed transfer is marked <b>Failed</b> and can be approved again for retry.
            {settings?.four_eyes && <> Four-eyes is on: another Super Admin must confirm payment of a batch you sent to the bank.</>}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="card">
              <div className="tabs" style={{ padding: '0 12px' }} role="tablist">
                {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => switchTab(k)}>{l}<span className="c">{count(k)}</span></button>)}
              </div>
            </div>
            <DataTable key={tab} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search payout, investor, investment, reference"
              text={r => `${r.investor?.code || ''} ${r.batch_ref || ''} ${r.payment_ref || ''}`}
              sort={4} dir={tab === 'paid' || tab === 'all' ? -1 : 1} per={20}
              select={ops.length ? { selected: sel, onChange: setSel, can: selectable } : undefined}
              tools={<>
                <label className="check"><input type="checkbox" checked={dueOnly} onChange={e => { setDueOnly(e.target.checked); setSel(new Set()); }} /> Due on or before today</label>
                {ops.length > 0 && <span className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>{chosen.length ? `${chosen.length} selected · ${money(chosenSum)}` : 'None selected'}</span>}
                {ops.includes('approved') && <button className="btn primary sm" disabled={!chosen.length} onClick={() => openOp('approved')}>{tab === 'failed' ? 'Approve for retry' : 'Approve selected'}</button>}
                {ops.includes('processing') && <button className="btn primary sm" disabled={!chosen.length} onClick={() => openOp('processing')}>Send to bank</button>}
                {ops.includes('failed') && <button className="btn danger sm" disabled={!chosen.length} onClick={() => openOp('failed')}>Mark failed</button>}
                {ops.includes('paid') && <button className="btn primary sm" disabled={!chosen.length} onClick={() => openOp('paid')}>Confirm paid</button>}
              </>}
              emptyTitle={all.length ? `No ${tab === 'all' ? '' : TABS.find(x => x[0] === tab)![1].toLowerCase() + ' '}payouts` : 'No payouts yet'}
              empty={!all.length ? 'A payout is created for every monthly accrual. They appear here after the accrual job posts the first returns.'
                : tab === 'accrued' ? 'New accruals appear here after the accrual job runs.' : tab === 'paid' ? 'Confirmed payments appear here.' : 'Move payouts forward from the previous tab.'} />
          </div>
        </>
      )}
      {op && (
        <Modal
          title={op === 'approved' ? `Approve ${chosen.length} payout${chosen.length === 1 ? '' : 's'}?` : op === 'processing' ? `Send ${chosen.length} payout${chosen.length === 1 ? '' : 's'} to the bank?`
            : op === 'paid' ? `Confirm ${chosen.length} payout${chosen.length === 1 ? '' : 's'} as paid?` : `Mark ${chosen.length} payout${chosen.length === 1 ? '' : 's'} as failed?`}
          sub={op === 'approved' ? 'Approved payouts are queued for the next bank batch.'
            : op === 'processing' ? 'Upload the transfers to your bank. Investors see these payouts as "Processing" until you confirm them.'
              : op === 'paid' ? 'Only confirm after the bank shows these transfers as completed. Investors are notified that they have been paid.'
                : 'The ledger entries are marked failed. You can approve the payouts again to retry; investors still see them as unpaid.'}
          onClose={() => setOp(null)}
          foot={<><button className="btn ghost" onClick={() => setOp(null)}>Cancel</button>
            <button className={'btn ' + (op === 'failed' ? 'danger' : 'primary')} onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : op === 'approved' ? 'Approve' : op === 'processing' ? 'Send to bank' : op === 'paid' ? 'Confirm paid' : 'Mark failed'}
            </button></>}>
          <div className="form">
            <dl className="kv">
              <dt>Payouts</dt><dd>{chosen.length}</dd>
              <dt>Investors</dt><dd>{new Set(chosen.map(r => r.investor_id)).size}</dd>
              <dt>Total</dt><dd>{money(chosenSum)}</dd>
              {op === 'paid' && <><dt>Batch</dt><dd className="mono">{Array.from(new Set(chosen.map(r => r.batch_ref).filter(Boolean))).join(', ') || '—'}</dd></>}
              {op === 'paid' && sentBy.length > 0 && <><dt>Sent to bank by</dt><dd>{sentBy.map(id => nameOf(q.data?.pplBy.get(id))).join(', ')}</dd></>}
            </dl>
            {op === 'processing' && (
              <Field label="Batch reference (optional)" hint="Leave blank to generate one such as BATCH-20261016-143000." err={err}>
                <input className="input mono" value={ref} onChange={e => { setRef(e.target.value); setErr(null); }} placeholder="e.g. HDFC-BULK-0412" />
              </Field>
            )}
            {op === 'paid' && (
              <Field label="Bank / UTR reference (required)" hint="Recorded on every selected payout and shown to investors." err={err}>
                <input className={'input mono' + (err ? ' bad' : '')} value={ref} onChange={e => { setRef(e.target.value); setErr(null); }} placeholder="e.g. NEFT UTR or bank batch confirmation" />
              </Field>
            )}
            {op === 'failed' && (
              <Field label="Reason (required)" err={err}>
                <input className={'input' + (err ? ' bad' : '')} value={reason} onChange={e => { setReason(e.target.value); setErr(null); }} placeholder="e.g. Bank returned transfer: account closed" />
              </Field>
            )}
            {op === 'approved' && err && <p className="hint err">{err}</p>}
            {op === 'paid' && settings?.four_eyes && (
              <div className="note">{selfSent
                ? <><b>Another Super Admin must confirm payment.</b> You sent some of these payouts to the bank, so the database will refuse your confirmation while another active Super Admin exists.</>
                : <>Four-eyes is on: the admin who sent a batch to the bank cannot also confirm it as paid.</>}</div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
