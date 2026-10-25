import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, rateShort, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { Profile, Withdrawal, WithdrawalPart } from '../lib/types';
import { ErrorNote, Field, Kpi, Loading, Modal, PageHead, useAction } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';
import { Icon } from '../ui/Icon';
import { WdBadge, methodText, EditWithdrawal, DeleteWithdrawal } from '../investor/Withdraw';
import { AttachmentLinks } from '../ui/Attach';
import type { WithdrawalMethod } from '../lib/types';
import { SearchSelect } from '../ui/SearchSelect';

/* Withdrawals: requested by investors (or recorded here for them), taken from the highest monthly ROI first.
   Returns already use the lower amount from the request date. The Super Admin pays and marks them completed. */

type P = Pick<Profile, 'id' | 'code' | 'full_name' | 'phone' | 'introduced_by'>;
interface Row extends Withdrawal { who?: P; ib?: P; by?: P }
type Tab = 'pending' | 'completed' | 'cancelled' | 'all';

async function load() {
  const [wds, people] = await Promise.all([
    fetchAll<Withdrawal>((a, b) => api.from('withdrawals').select('*').order('requested_at', { ascending: false }).range(a, b)),
    fetchAll<P>((a, b) => api.from('profiles').select('id,code,full_name,phone,introduced_by').eq('role', 'investor').order('full_name').range(a, b))
  ]);
  const pm = new Map(people.map(p => [p.id, p]));
  return { rows: wds.map<Row>(w => ({ ...w, who: pm.get(w.investor_id), ib: w.ib_id ? pm.get(w.ib_id) : undefined, by: w.requested_by && w.requested_by !== w.investor_id ? pm.get(w.requested_by) : undefined })), people };
}

export function Withdrawals() {
  const q = useQuery(load, []);
  const [tab, setTab] = useState<Tab>('pending');
  const [done, setDone] = useState<Row | null>(null);
  const [cancel, setCancel] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const all = q.data?.rows || [];
  const rows = all.filter(r => tab === 'all' || r.status === tab);
  const n = (k: Tab) => (k === 'all' ? all.length : all.filter(r => r.status === k).length);
  const sum = (rs: Row[]) => rs.reduce((s, r) => s + Number(r.amount), 0);
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'Request', m: true, v: r => r.code },
    { h: 'Investor', v: r => r.who?.full_name || '', r: r => r.who ? <><Link to={'/admin/investors/' + r.who.code}>{r.who.full_name}</Link><span className="sub">{r.who.code} · {r.who.phone}</span>{r.by && <span className="sub">requested by IB {r.by.full_name}</span>}</> : '—' },
    { h: 'Applied on', v: r => r.requested_on, r: r => date(r.requested_on) },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => <b>{money(r.amount)}</b> },
    { h: 'How', v: r => r.method, r: r => <>{methodText(r.method)}{r.method === 'mt5' && r.mt5_account && <span className="sub mono">{r.mt5_account}</span>}{r.method === 'ib' && <span className="sub">to {r.ib?.full_name || 'IB'} · needs approval</span>}</> },
    { h: 'Proof', v: r => (r.attachments || []).length, r: r => <AttachmentLinks items={r.attachments} /> },
    { h: 'Taken from (highest ROI first)', v: r => (r.allocations || []).map(p => p.code).join(' '), r: r => <>{(r.allocations || []).map((p: WithdrawalPart) => <div key={p.investment_id} className="sub" style={{ display: 'block' }}><span className="mono">{p.code}</span> · {rateShort(p.plan_rate ?? p.rate)} · {money(p.amount)} → {money(p.after)} left</div>)}</> },
    { h: 'Status', v: r => r.status, r: r => <><WdBadge s={r.status} />{r.status === 'completed' && <span className="sub">{date(r.completed_on)}{r.payment_ref ? ' · ' + r.payment_ref : ''}</span>}{r.status === 'cancelled' && <span className="sub">{r.cancelled_reason}</span>}</> },
    { h: '', r: r => <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {r.status === 'pending' && <><button className="btn sm primary" onClick={e => { e.stopPropagation(); setDone(r); }}>{r.method === 'ib' ? 'Approve transfer' : 'Mark fulfilled'}</button>
        <button className="btn sm" onClick={e => { e.stopPropagation(); setEditing(r); }}>Edit</button>
        <button className="btn sm" onClick={e => { e.stopPropagation(); setCancel(r); }}>Cancel</button></>}
      <button className="btn sm danger" onClick={e => { e.stopPropagation(); setDel(r); }}>Delete</button>
    </span> }
  ], []);
  return (
    <>
      <PageHead crumbs={['Withdrawals']} title="Withdrawals" sub="Taken automatically from the investor’s highest monthly ROI first, whatever the lock-in. Returns already use the lower amount from the request date. Pay the investor, then click Mark fulfilled."
        actions={<>
          <button className="btn" disabled={!rows.length} onClick={() => downloadCsv('withdrawals-' + tab, ['Request', 'Investor ID', 'Investor', 'Phone', 'Applied on', 'Amount', 'How', 'Taken from', 'Status', 'Paid on', 'Reference'],
            rows.map(r => [r.code, r.who?.code, r.who?.full_name, r.who?.phone, r.requested_on, Number(r.amount).toFixed(2), methodText(r.method) + (r.mt5_account ? ' ' + r.mt5_account : '') + (r.ib ? ' ' + r.ib.full_name : ''), (r.allocations || []).map(p => `${p.code} ${p.amount}`).join('; '), r.status, r.completed_on, r.payment_ref]))}><Icon name="download" />Export to Excel</button>
          <button className="btn accent" onClick={() => setAdding(true)}><Icon name="plus" />Record a withdrawal</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="kpis k4">
            <Kpi label="Payment processed" value={money(sum(all.filter(r => r.status === 'pending')))} sub={`${n('pending')} to pay`} subCls={n('pending') ? 'warn' : ''} />
            <Kpi label="Payment fulfilled" cls="pos" value={money(sum(all.filter(r => r.status === 'completed')))} sub={`${n('completed')} fulfilled`} />
            <Kpi label="To bank accounts" value={money(sum(all.filter(r => r.status !== 'cancelled' && r.method === 'bank')))} sub={'cash ' + money(sum(all.filter(r => r.status !== 'cancelled' && r.method === 'cash')))} />
            <Kpi label="To MT5 / to IB" value={money(sum(all.filter(r => r.status !== 'cancelled' && (r.method === 'mt5' || r.method === 'ib'))))} sub={`${all.filter(r => r.status === 'pending' && r.method === 'ib').length} IB transfer${all.filter(r => r.status === 'pending' && r.method === 'ib').length === 1 ? '' : 's'} to approve`} />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="card"><div className="tabs" style={{ padding: '0 12px' }} role="tablist">
              {([['pending', 'Payment processed'], ['completed', 'Payment fulfilled'], ['cancelled', 'Cancelled'], ['all', 'All']] as [Tab, string][]).map(([k, l]) =>
                <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>{l}<span className="c">{n(k)}</span></button>)}
            </div></div>
            <DataTable key={tab} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search request, investor, phone" text={r => `${r.who?.code || ''} ${r.who?.phone || ''}`} sort={2} dir={-1} per={20}
              emptyTitle="No withdrawals here" empty="Requests from investors show here as Payment processed." />
          </div>
        </>
      )}
      {done && <CompleteDialog w={done} onClose={() => setDone(null)} />}
      {cancel && <CancelDialog w={cancel} onClose={() => setCancel(null)} />}
      {editing && <EditWithdrawal w={editing} who={editing.who?.full_name || ''} hasIb={!!editing.who?.introduced_by} admin onClose={() => setEditing(null)} />}
      {del && <DeleteWithdrawal w={del} who={del.who?.full_name || ''} onClose={() => setDel(null)} />}
      {adding && q.data && <RecordDialog people={q.data.people} onClose={() => setAdding(false)} />}
    </>
  );
}

function CompleteDialog({ w, onClose }: { w: Row; onClose: () => void }) {
  const act = useAction();
  const [on, setOn] = useState(today());
  const [method, setMethod] = useState<WithdrawalMethod>(w.method);
  const [mt5, setMt5] = useState(w.mt5_account || '');
  const [ref, setRef] = useState('');
  const go = async () => {
    const r = await act.run(() => rpc('admin_complete_withdrawal', { p_id: w.id, p_paid_on: on, p_method: method, p_mt5: mt5.trim(), p_ref: ref.trim() }), [method === 'ib' ? 'Transfer approved' : 'Payment fulfilled', `${w.code} · ${money(w.amount)} · the investor now sees Payment fulfilled`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={w.method === 'ib' ? `Approve transfer ${w.code} to ${w.ib?.full_name || 'the IB'}?` : `Mark ${w.code} as payment fulfilled?`}
      sub={w.method === 'ib' ? `${money(w.amount)} from ${w.who?.full_name || 'the investor'} is transferred to their IB ${w.ib?.full_name || ''}. Both are notified.` : `Only after ${w.who?.full_name || 'the investor'} has received ${money(w.amount)}.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy || (method === 'mt5' && !mt5.trim())}>{method === 'ib' ? 'Approve transfer' : 'Mark fulfilled'}</button></>}>
      <div className="form">
        {(w.attachments || []).length > 0 && <Field label="Attached by the investor"><AttachmentLinks items={w.attachments} /></Field>}
        {w.note && <p className="hint">Note: {w.note}</p>}
        <Field label="Paid by"><div className="chips">
          {(w.method === 'ib' ? [['ib', 'Transfer to IB']] : [['bank', 'Bank transfer'], ['mt5', 'MT5 account'], ['cash', 'Cash']]).map(([k, l]) =>
            <button key={k} type="button" className={'chip ' + (method === k ? 'on' : '')} onClick={() => setMethod(k as WithdrawalMethod)}>{l}</button>)}
        </div></Field>
        {method === 'mt5' && <Field label="MT5 account *"><input className="input mono" value={mt5} onChange={e => setMt5(e.target.value)} /></Field>}
        <div className="f-row">
          <Field label={method === 'ib' ? 'Approved on' : 'Paid on'}><input className="input" type="date" value={on} onChange={e => setOn(e.target.value)} /></Field>
          <Field label={method === 'cash' ? 'Receipt number' : method === 'ib' ? 'Reference (optional)' : method === 'mt5' ? 'MT5 deposit / ticket reference' : 'Bank / UTR reference'}><input className="input mono" value={ref} onChange={e => setRef(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function CancelDialog({ w, onClose }: { w: Row; onClose: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const go = async () => {
    const r = await act.run(() => rpc('admin_cancel_withdrawal', { p_id: w.id, p_reason: reason.trim() }), ['Withdrawal cancelled', 'The amount is back in the investments it was taken from.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Cancel ${w.code}?`} sub="The amount goes back into the investments it was taken from, as if it had not been requested." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Back</button><button className="btn danger" onClick={go} disabled={act.busy || !reason.trim()}>Cancel withdrawal</button></>}>
      <Field label="Reason (shown to the investor) *"><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Investor changed their mind" /></Field>
    </Modal>
  );
}

/** For a request made offline: same rules as when the investor applies. */
function RecordDialog({ people, onClose }: { people: P[]; onClose: () => void }) {
  const act = useAction();
  const [who, setWho] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<WithdrawalMethod>('bank');
  const [mt5, setMt5] = useState('');
  const [parts, setParts] = useState<WithdrawalPart[]>([]);
  const hasIb = !!people.find(p => p.id === who)?.introduced_by;
  const amt = Number(amount);
  const look = async (id: string, a: number) => { setParts(id && a > 0 ? await rpc<WithdrawalPart[]>('withdrawal_preview', { p_investor: id, p_amount: a }).catch(() => []) : []); };
  const go = async () => {
    const r = await act.run(() => rpc('request_withdrawal', { p_investor: who, p_amount: amt, p_method: method, p_mt5: mt5.trim(), p_note: 'Recorded by Super Admin' }), ['Withdrawal recorded', 'Shown as Payment processed until you mark it fulfilled.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title="Record a withdrawal" sub="Taken from the investor’s highest monthly ROI first. Returns use the lower amount from today." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy || !who || !(amt > 0) || (method === 'mt5' && !mt5.trim())}>Record withdrawal</button></>}>
      <div className="form">
        <Field label="Investor *"><SearchSelect value={who} onChange={v => { setWho(v); look(v, amt); }}
          options={people.map(p => ({ value: p.id, label: p.full_name + ' · ' + p.code, sub: p.phone || undefined }))} /></Field>
        <div className="f-row">
          <Field label="Amount (INR) *"><input className="input num" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); look(who, Number(e.target.value)); }} /></Field>
          <Field label="How"><div className="chips">
            {([['bank', 'Bank transfer'], ['mt5', 'MT5 account'], ['cash', 'Cash'], ...(hasIb ? [['ib', 'Transfer to IB']] : [])] as [WithdrawalMethod, string][]).map(([k, l]) =>
              <button key={k} type="button" className={'chip ' + (method === k ? 'on' : '')} onClick={() => setMethod(k)}>{l}</button>)}
          </div></Field>
        </div>
        {method === 'mt5' && <Field label="MT5 account *"><input className="input mono" value={mt5} onChange={e => setMt5(e.target.value)} /></Field>}
        {parts.length > 0 && <p className="hint">Taken from {parts.map(p => `${p.code} (${rateShort(p.plan_rate ?? p.rate)}): ${money(p.amount)}`).join(', ')}.</p>}
      </div>
    </Modal>
  );
}
