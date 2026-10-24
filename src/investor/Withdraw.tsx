import { useEffect, useState } from 'react';
import { api, rpc, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, rateShort } from '../lib/format';
import type { Investment, Withdrawal, WithdrawalPart } from '../lib/types';
import { Badge, Empty, ErrorNote, Field, Kpi, Loading, Modal, PageHead, useAction } from '../ui/kit';

/* Withdrawals. The amount is always taken from the highest monthly ROI first, whatever the lock-in.
   From the day of the request, returns are calculated on the lower amount. The company pays and marks it completed. */

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
export const WdBadge = ({ s }: { s: string }) => s === 'completed' ? <Badge cls="b-green">Completed</Badge> : s === 'cancelled' ? <Badge cls="b-grey">Cancelled</Badge> : <Badge cls="b-amber">Pending</Badge>;
export const methodText = (m: string) => (m === 'cash' ? 'Cash' : 'Bank transfer');

async function load(id: string) {
  const [invs, wds] = await Promise.all([
    fetchAll<Investment>((a, b) => api.from('investments').select('*').eq('investor_id', id).range(a, b)),
    fetchAll<Withdrawal>((a, b) => api.from('withdrawals').select('*').eq('investor_id', id).order('requested_at', { ascending: false }).range(a, b))
  ]);
  // the exact order the company takes money in (highest ROI first)
  const order = await rpc<WithdrawalPart[]>('withdrawal_preview', { p_amount: 1e15 }).catch(() => [] as WithdrawalPart[]);
  const pos = (id: string) => { const k = order.findIndex(p => p.investment_id === id); return k < 0 ? 999 : k; };
  const live = invs.filter(i => LIVE.includes(i.status) && Number(i.principal) > 0).sort((x, y) => pos(x.id) - pos(y.id));
  return { live, wds };
}

export function Withdraw() {
  const { profile } = useAuth();
  const act = useAction();
  const q = useQuery(() => load(profile!.id), [profile?.id]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank'>('bank');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<WithdrawalPart[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [tried, setTried] = useState(false);

  const amt = Number(amount);
  const available = (q.data?.live || []).reduce((s, i) => s + Number(i.principal), 0);
  useEffect(() => {
    if (!(amt > 0)) { setPreview([]); return; }
    let live = true;
    rpc<WithdrawalPart[]>('withdrawal_preview', { p_amount: Math.min(amt, available) }).then(r => { if (live) setPreview(r || []); }).catch(() => {});
    return () => { live = false; };
  }, [amt, available]);

  if (q.error) return <><PageHead crumbs={['Withdraw']} title="Withdraw" /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <><PageHead crumbs={['Withdraw']} title="Withdraw" /><Loading /></>;
  const { live, wds } = q.data;
  const err = !(amt > 0) || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? 'Enter the amount to withdraw.' : amt > available ? `You can withdraw up to ${money(available)}.` : null;
  const pending = wds.filter(w => w.status === 'pending');
  const newMonthly = live.reduce((s, i) => {
    const pt = preview.find(p => p.investment_id === i.id);
    return s + Math.round((pt ? pt.after : Number(i.principal)) * Number(i.monthly_rate)) / 100;
  }, 0);
  const nowMonthly = live.reduce((s, i) => s + Number(i.monthly_return), 0);

  const send = async () => {
    const r = await act.run(() => rpc('request_withdrawal', { p_amount: amt, p_method: method, p_note: note.trim() }),
      ['Withdrawal requested', 'It shows as Pending until the company pays it.']);
    if (r !== undefined) { setConfirm(false); setAmount(''); setNote(''); setTried(false); refreshAll(); q.reload(); }
  };

  return (
    <>
      <PageHead crumbs={['Withdraw']} title="Withdraw" sub="Money is taken from your highest monthly ROI first. From the day you apply, your returns are calculated on the lower amount." />
      <div className="kpis k4">
        <Kpi label="Available to withdraw" value={money(available)} sub={`${live.length} live investment${live.length === 1 ? '' : 's'}`} />
        <Kpi label="Monthly return now" value={money(nowMonthly)} sub="on your current amount" />
        <Kpi label="Pending withdrawals" value={money(pending.reduce((s, w) => s + Number(w.amount), 0))} sub={`${pending.length} waiting for the company`} subCls={pending.length ? 'warn' : ''} />
        <Kpi label="Withdrawn so far" cls="pos" value={money(wds.filter(w => w.status === 'completed').reduce((s, w) => s + Number(w.amount), 0))} sub="completed" />
      </div>

      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>Apply for a withdrawal</h3></div>
          <div className="card-b">
            {!live.length ? <Empty title="Nothing to withdraw">You have no live investment right now.</Empty> : (
              <div className="form">
                <Field label="Amount (INR) *" err={tried ? err : null} hint={`Up to ${money(available)}.`}>
                  <input className={'input num ' + (tried && err ? 'bad' : '')} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 100000" />
                </Field>
                <Field label="How do you want to receive it? *">
                  <div className="chips">
                    <button type="button" className={'chip ' + (method === 'bank' ? 'on' : '')} onClick={() => setMethod('bank')}>Bank transfer</button>
                    <button type="button" className={'chip ' + (method === 'cash' ? 'on' : '')} onClick={() => setMethod('cash')}>Cash</button>
                  </div>
                </Field>
                <Field label="Note (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the company should know" /></Field>
                {preview.length > 0 && !err && (
                  <div className="tbl"><table>
                    <thead><tr><th>Taken from</th><th>Monthly ROI</th><th className="n">Now</th><th className="n">Withdrawn</th><th className="n">After</th></tr></thead>
                    <tbody>{preview.map(p => (
                      <tr key={p.investment_id}><td className="mono">{p.code}</td><td>{rateShort(p.rate)}</td><td className="n">{money(p.before)}</td><td className="n"><b>{money(p.amount)}</b></td><td className="n">{money(p.after)}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
                {preview.length > 0 && !err && <div className="note info">From today your monthly return becomes about <b>{money(newMonthly)}</b> (now {money(nowMonthly)}).</div>}
                <button className="btn primary" onClick={() => { setTried(true); if (!err) setConfirm(true); }}>Apply for withdrawal</button>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Taken in this order</h3><div className="r">highest ROI first</div></div>
          <div className="card-b">
            {live.length ? <div className="list">{live.map((i, k) => (
              <div key={i.id}><div className="grow"><b>{k + 1}. {i.code} · {rateShort(i.monthly_rate)} a month</b><span>{money(i.principal)}{i.lockin_months ? ` · lock-in until ${date(i.maturity_date)}` : ' · no lock-in'}</span></div></div>
            ))}</div> : <Empty title="No live investments" />}
            <p className="hint" style={{ marginTop: 10 }}>A withdrawal is allowed whatever the lock-in.</p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>My withdrawals</h3></div>
        {wds.length ? (
          <div className="tbl"><table>
            <thead><tr><th>Request</th><th>Applied on</th><th className="n">Amount</th><th>How</th><th>Taken from</th><th>Status</th></tr></thead>
            <tbody>{wds.map(w => (
              <tr key={w.id}>
                <td className="mono">{w.code}</td>
                <td>{date(w.requested_on)}</td>
                <td className="n">{money(w.amount)}</td>
                <td>{methodText(w.method)}</td>
                <td>{(w.allocations || []).map(p => `${p.code} (${rateShort(p.rate)}): ${money(p.amount)}`).join(', ')}</td>
                <td><WdBadge s={w.status} />{w.status === 'completed' && <span className="sub">paid {date(w.completed_on)}{w.payment_ref ? ' · ' + w.payment_ref : ''}</span>}{w.status === 'cancelled' && w.cancelled_reason && <span className="sub">{w.cancelled_reason}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="card-b"><Empty title="No withdrawals yet">Requests you make show here as Pending until the company completes them.</Empty></div>}
      </div>

      {confirm && (
        <Modal title={`Withdraw ${money(amt)}?`} sub={`Taken from ${preview.map(p => `${p.code} (${rateShort(p.rate)})`).join(', ')}. From today, returns are calculated on the lower amount. The company will pay you by ${methodText(method).toLowerCase()} and mark it completed.`}
          onClose={() => setConfirm(false)}
          foot={<><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={send} disabled={act.busy}>{act.busy ? 'Sending…' : 'Apply for withdrawal'}</button></>} />
      )}
    </>
  );
}
