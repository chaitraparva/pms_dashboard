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
import { WdBadge, methodText } from '../investor/Withdraw';

/* Withdrawals: requested by investors (or recorded here for them), taken from the highest monthly ROI first.
   Returns already use the lower amount from the request date. The Super Admin pays and marks them completed. */

type P = Pick<Profile, 'id' | 'code' | 'full_name' | 'phone'>;
interface Row extends Withdrawal { who?: P }
type Tab = 'pending' | 'completed' | 'cancelled' | 'all';

async function load() {
  const [wds, people] = await Promise.all([
    fetchAll<Withdrawal>((a, b) => api.from('withdrawals').select('*').order('requested_at', { ascending: false }).range(a, b)),
    fetchAll<P>((a, b) => api.from('profiles').select('id,code,full_name,phone').eq('role', 'investor').order('full_name').range(a, b))
  ]);
  const pm = new Map(people.map(p => [p.id, p]));
  return { rows: wds.map<Row>(w => ({ ...w, who: pm.get(w.investor_id) })), people };
}

export function Withdrawals() {
  const q = useQuery(load, []);
  const [tab, setTab] = useState<Tab>('pending');
  const [done, setDone] = useState<Row | null>(null);
  const [cancel, setCancel] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const all = q.data?.rows || [];
  const rows = all.filter(r => tab === 'all' || r.status === tab);
  const n = (k: Tab) => (k === 'all' ? all.length : all.filter(r => r.status === k).length);
  const sum = (rs: Row[]) => rs.reduce((s, r) => s + Number(r.amount), 0);
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'Request', m: true, v: r => r.code },
    { h: 'Investor', v: r => r.who?.full_name || '', r: r => r.who ? <><Link to={'/admin/investors/' + r.who.code}>{r.who.full_name}</Link><span className="sub">{r.who.code} · {r.who.phone}</span></> : '—' },
    { h: 'Applied on', v: r => r.requested_on, r: r => date(r.requested_on) },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => <b>{money(r.amount)}</b> },
    { h: 'How', v: r => r.method, r: r => methodText(r.method) },
    { h: 'Taken from (highest ROI first)', v: r => (r.allocations || []).map(p => p.code).join(' '), r: r => <>{(r.allocations || []).map((p: WithdrawalPart) => <div key={p.investment_id} className="sub" style={{ display: 'block' }}><span className="mono">{p.code}</span> · {rateShort(p.plan_rate ?? p.rate)} · {money(p.amount)} → {money(p.after)} left</div>)}</> },
    { h: 'Status', v: r => r.status, r: r => <><WdBadge s={r.status} />{r.status === 'completed' && <span className="sub">{date(r.completed_on)}{r.payment_ref ? ' · ' + r.payment_ref : ''}</span>}{r.status === 'cancelled' && <span className="sub">{r.cancelled_reason}</span>}</> },
    { h: '', r: r => r.status === 'pending' ? <span style={{ display: 'flex', gap: 6 }}><button className="btn sm primary" onClick={e => { e.stopPropagation(); setDone(r); }}>Mark completed</button><button className="btn sm" onClick={e => { e.stopPropagation(); setCancel(r); }}>Cancel</button></span> : null }
  ], []);
  return (
    <>
      <PageHead crumbs={['Withdrawals']} title="Withdrawals" sub="Taken automatically from the investor’s highest monthly ROI first, whatever the lock-in. Returns already use the lower amount from the request date. Pay the investor, then mark it completed."
        actions={<>
          <button className="btn" disabled={!rows.length} onClick={() => downloadCsv('withdrawals-' + tab, ['Request', 'Investor ID', 'Investor', 'Phone', 'Applied on', 'Amount', 'How', 'Taken from', 'Status', 'Paid on', 'Reference'],
            rows.map(r => [r.code, r.who?.code, r.who?.full_name, r.who?.phone, r.requested_on, Number(r.amount).toFixed(2), methodText(r.method), (r.allocations || []).map(p => `${p.code} ${p.amount}`).join('; '), r.status, r.completed_on, r.payment_ref]))}><Icon name="download" />Export CSV</button>
          <button className="btn accent" onClick={() => setAdding(true)}><Icon name="plus" />Record a withdrawal</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="kpis k4">
            <Kpi label="Pending" value={money(sum(all.filter(r => r.status === 'pending')))} sub={`${n('pending')} to pay`} subCls={n('pending') ? 'warn' : ''} />
            <Kpi label="Completed" cls="pos" value={money(sum(all.filter(r => r.status === 'completed')))} sub={`${n('completed')} paid`} />
            <Kpi label="By bank transfer" value={money(sum(all.filter(r => r.status !== 'cancelled' && r.method === 'bank')))} />
            <Kpi label="In cash" value={money(sum(all.filter(r => r.status !== 'cancelled' && r.method === 'cash')))} />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="card"><div className="tabs" style={{ padding: '0 12px' }} role="tablist">
              {([['pending', 'Pending'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']] as [Tab, string][]).map(([k, l]) =>
                <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>{l}<span className="c">{n(k)}</span></button>)}
            </div></div>
            <DataTable key={tab} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search request, investor, phone" text={r => `${r.who?.code || ''} ${r.who?.phone || ''}`} sort={2} dir={-1} per={20}
              emptyTitle="No withdrawals here" empty="Requests from investors show here as Pending." />
          </div>
        </>
      )}
      {done && <CompleteDialog w={done} onClose={() => setDone(null)} />}
      {cancel && <CancelDialog w={cancel} onClose={() => setCancel(null)} />}
      {adding && q.data && <RecordDialog people={q.data.people} onClose={() => setAdding(false)} />}
    </>
  );
}

function CompleteDialog({ w, onClose }: { w: Row; onClose: () => void }) {
  const act = useAction();
  const [on, setOn] = useState(today());
  const [method, setMethod] = useState(w.method);
  const [ref, setRef] = useState('');
  const go = async () => {
    const r = await act.run(() => rpc('admin_complete_withdrawal', { p_id: w.id, p_paid_on: on, p_method: method, p_ref: ref.trim() }), ['Withdrawal completed', `${w.code} · ${money(w.amount)} · the investor now sees Completed`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Mark ${w.code} completed?`} sub={`Only after ${w.who?.full_name || 'the investor'} has received ${money(w.amount)}.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Mark completed</button></>}>
      <div className="form">
        <Field label="Paid by"><div className="chips">
          <button type="button" className={'chip ' + (method === 'bank' ? 'on' : '')} onClick={() => setMethod('bank')}>Bank transfer</button>
          <button type="button" className={'chip ' + (method === 'cash' ? 'on' : '')} onClick={() => setMethod('cash')}>Cash</button>
        </div></Field>
        <div className="f-row">
          <Field label="Paid on"><input className="input" type="date" value={on} onChange={e => setOn(e.target.value)} /></Field>
          <Field label={method === 'cash' ? 'Receipt number' : 'Bank / UTR reference'}><input className="input mono" value={ref} onChange={e => setRef(e.target.value)} /></Field>
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
  const [method, setMethod] = useState<'cash' | 'bank'>('bank');
  const [parts, setParts] = useState<WithdrawalPart[]>([]);
  const amt = Number(amount);
  const look = async (id: string, a: number) => { setParts(id && a > 0 ? await rpc<WithdrawalPart[]>('withdrawal_preview', { p_investor: id, p_amount: a }).catch(() => []) : []); };
  const go = async () => {
    const r = await act.run(() => rpc('request_withdrawal', { p_investor: who, p_amount: amt, p_method: method, p_note: 'Recorded by Super Admin' }), ['Withdrawal recorded', 'Pending until you mark it completed.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title="Record a withdrawal" sub="Taken from the investor’s highest monthly ROI first. Returns use the lower amount from today." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy || !who || !(amt > 0)}>Record withdrawal</button></>}>
      <div className="form">
        <Field label="Investor *"><select className="input" value={who} onChange={e => { setWho(e.target.value); look(e.target.value, amt); }}>
          <option value="">Choose…</option>{people.map(p => <option key={p.id} value={p.id}>{p.full_name} · {p.code} · {p.phone}</option>)}
        </select></Field>
        <div className="f-row">
          <Field label="Amount (INR) *"><input className="input num" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); look(who, Number(e.target.value)); }} /></Field>
          <Field label="How"><div className="chips">
            <button type="button" className={'chip ' + (method === 'bank' ? 'on' : '')} onClick={() => setMethod('bank')}>Bank transfer</button>
            <button type="button" className={'chip ' + (method === 'cash' ? 'on' : '')} onClick={() => setMethod('cash')}>Cash</button>
          </div></Field>
        </div>
        {parts.length > 0 && <p className="hint">Taken from {parts.map(p => `${p.code} (${rateShort(p.plan_rate ?? p.rate)}): ${money(p.amount)}`).join(', ')}.</p>}
      </div>
    </Modal>
  );
}
