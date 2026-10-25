import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, rateShort } from '../lib/format';
import { uploadAttachment } from '../lib/docs';
import type { Investment, MyAccount, Withdrawal, WithdrawalMethod, WithdrawalPart } from '../lib/types';
import { Badge, Empty, ErrorNote, Field, Kpi, Loading, Modal, PageHead, useAction } from '../ui/kit';
import { AttachmentLinks, FilePicker } from '../ui/Attach';
import { loadAccount } from './data';
import { AmountWords } from '../ui/AmountWords';

/* Withdrawals. The amount is always taken from the highest monthly ROI first, whatever the lock-in.
   From the day of the request, returns are calculated on the lower amount. The company pays and marks it completed.
   An investor requests for themselves; an IB also for the sub-investors under them.
   Paid to the bank account, to an MT5 account, or transferred to the IB (the Super Admin approves). */

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
export const WdBadge = ({ s }: { s: string }) => s === 'completed' ? <Badge cls="b-green">Payment fulfilled</Badge> : s === 'cancelled' ? <Badge cls="b-grey">Cancelled</Badge> : <Badge cls="b-amber">Payment processed</Badge>;
export const methodText = (m: string) => (m === 'cash' ? 'Cash' : m === 'mt5' ? 'MT5 account' : m === 'ib' ? 'Transfer to IB' : 'Bank transfer');

async function load(id: string) {
  const acc = await loadAccount();
  const ids = [id, ...(acc?.subs || []).map(s => s.id)];
  const [invs, wds] = await Promise.all([
    fetchAll<Investment>((a, b) => api.from('investments').select('*').eq('investor_id', id).range(a, b)),
    fetchAll<Withdrawal>((a, b) => api.from('withdrawals').select('*').in('investor_id', ids).order('requested_at', { ascending: false }).range(a, b))
  ]);
  return { acc, invs, wds };
}

export function Withdraw() {
  const { profile } = useAuth();
  const act = useAction();
  const [sp] = useSearchParams();
  const me = profile!.id;
  const q = useQuery(() => load(me), [me]);
  const [forId, setForId] = useState(sp.get('for') || me);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<WithdrawalMethod>('bank');
  const [mt5, setMt5] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [order, setOrder] = useState<WithdrawalPart[] | null>(null);
  const [preview, setPreview] = useState<WithdrawalPart[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [tried, setTried] = useState(false);
  const [editing, setEditing] = useState<Withdrawal | null>(null);
  const [del, setDel] = useState<Withdrawal | null>(null);

  const acc: MyAccount | null = q.data?.acc || null;
  const sub = forId !== me ? acc?.subs.find(s => s.id === forId) : undefined;
  const forMe = !sub;
  const forArg = forMe ? {} : { p_investor: forId };
  // the exact order the company takes money in (highest ROI first), for the chosen person
  useEffect(() => {
    let live = true; setOrder(null);
    rpc<WithdrawalPart[]>('withdrawal_preview', { p_amount: 1e15, ...(forId !== me ? { p_investor: forId } : {}) }).then(r => { if (live) setOrder(r || []); }).catch(() => { if (live) setOrder([]); });
    return () => { live = false; };
  }, [forId, me, q.data]);
  const parts = order || [];
  const available = Math.round(parts.reduce((s, p) => s + Number(p.before), 0) * 100) / 100;
  const amt = Number(amount);
  useEffect(() => {
    if (!(amt > 0)) { setPreview([]); return; }
    let live = true;
    rpc<WithdrawalPart[]>('withdrawal_preview', { p_amount: Math.min(amt, available), ...(forId !== me ? { p_investor: forId } : {}) }).then(r => { if (live) setPreview(r || []); }).catch(() => {});
    return () => { live = false; };
  }, [amt, available, forId, me]);
  // a transfer to an IB is only possible when the person is under one (for a sub-investor, that IB is me)
  const ibName = forMe ? acc?.ib?.name || null : profile!.full_name;
  useEffect(() => { if (method === 'ib' && !ibName) setMethod('bank'); }, [ibName, method]);

  if (q.error) return <><PageHead crumbs={['Withdraw']} title="Withdraw" /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <><PageHead crumbs={['Withdraw']} title="Withdraw" /><Loading /></>;
  const { invs, wds } = q.data;
  const whoName = (id: string) => (id === me ? 'Me' : acc?.subs.find(s => s.id === id)?.full_name || '—');
  const bank = forMe ? acc?.bank : sub ? { name: sub.bank_name, account: sub.bank_account } : undefined;
  const err = !(amt > 0) || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? 'Enter the amount to withdraw.' : amt > available ? `Up to ${money(available)} can be withdrawn.` : null;
  const mt5Err = method === 'mt5' && !/^[A-Za-z0-9._-]{3,40}$/.test(mt5.trim()) ? 'Enter the MT5 account number.' : null;
  const mine = wds.filter(w => w.investor_id === forId);
  const pending = mine.filter(w => w.status === 'pending');
  const monthlyOf = (list: WithdrawalPart[], useAfter: boolean) => list.reduce((s, p) => s + Math.round((useAfter ? p.after : p.before) * Number(p.rate)) / 100, 0);
  const nowMonthly = monthlyOf(parts, false);
  const newMonthly = nowMonthly - monthlyOf(preview, false) + monthlyOf(preview, true);
  const lockOf = (id: string) => invs.find(i => i.id === id && LIVE.includes(i.status));
  const how = method === 'mt5' ? `to MT5 account ${mt5.trim()}` : method === 'ib' ? `as a transfer to ${forMe ? 'your IB ' + ibName : 'you (IB)'}` : `to ${forMe ? 'your' : sub!.full_name + '’s'} bank account${bank?.account ? ' ' + bank.account : ''}`;

  const send = async () => {
    const r = await act.run(async () => {
      const attachments = [];
      for (const f of files) attachments.push(await uploadAttachment(f, me));
      return rpc('request_withdrawal', { ...forArg, p_amount: amt, p_method: method, p_mt5: method === 'mt5' ? mt5.trim() : '', p_note: note.trim(), p_attachments: attachments });
    }, [method === 'ib' ? 'Transfer to IB requested' : 'Withdrawal requested', method === 'ib' ? 'The company approves it. It shows as Payment processed until then.' : 'It shows as Payment processed; it becomes Payment fulfilled when the company pays it.']);
    if (r !== undefined) { setConfirm(false); setAmount(''); setNote(''); setFiles([]); setTried(false); refreshAll(); q.reload(); }
  };
  const ways: [WithdrawalMethod, string, string][] = [
    ['bank', forMe ? 'Request withdrawal to my bank account' : 'Withdraw to their bank account', bank?.account ? `${bank.name || 'Bank'} · ${bank.account}` : 'Registered bank account'],
    ['mt5', forMe ? 'Transfer to my MT5 account' : 'Transfer to their MT5 account', 'Enter the MT5 account number'],
    ...(ibName ? [['ib', forMe ? 'Transfer to my IB' : 'Transfer to me (IB)', (forMe ? ibName : 'You') + ' · the company approves it'] as [WithdrawalMethod, string, string]] : [])
  ];

  return (
    <>
      <PageHead crumbs={['Withdraw']} title="Withdraw" sub="Money is taken from the highest monthly ROI first. From the day of the request, returns are calculated on the lower amount." />
      {acc && acc.subs.length > 0 && (
        <div className="card"><div className="card-b">
          <Field label="Withdraw for">
            <div className="chips">
              <button type="button" className={'chip ' + (forMe ? 'on' : '')} onClick={() => { setForId(me); setAmount(''); }}>Myself</button>
              {acc.subs.map(s => <button key={s.id} type="button" className={'chip ' + (forId === s.id ? 'on' : '')} onClick={() => { setForId(s.id); setAmount(''); }}>{s.full_name}<span className="muted"> · {money(s.available)}</span></button>)}
            </div>
            <p className="hint">As their IB you can request withdrawals for the sub-investors under you. They are notified too.</p>
          </Field>
        </div></div>
      )}
      <div className="kpis k4">
        <Kpi label="Available to withdraw" value={order ? money(available) : '…'} sub={`${parts.length} live investment${parts.length === 1 ? '' : 's'}${forMe ? '' : ' · ' + sub!.full_name}`} />
        <Kpi label="Monthly return now" value={money(nowMonthly)} sub="on the current amount" />
        <Kpi label="Payment processed" value={money(pending.reduce((s, w) => s + Number(w.amount), 0))} sub={`${pending.length} waiting for the company`} subCls={pending.length ? 'warn' : ''} />
        <Kpi label="Withdrawn so far" cls="pos" value={money(mine.filter(w => w.status === 'completed').reduce((s, w) => s + Number(w.amount), 0))} sub="completed" />
      </div>

      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>{forMe ? 'Apply for a withdrawal' : `Withdrawal for ${sub!.full_name}`}</h3></div>
          <div className="card-b">
            {!order ? <Loading rows={2} /> : !parts.length ? <Empty title="Nothing to withdraw">{forMe ? 'You have' : sub!.full_name + ' has'} no live investment right now.</Empty> : (
              <div className="form">
                <Field label="Amount (INR) *" err={tried ? err : null} hint={`Up to ${money(available)}.`}>
                  <input className={'input num ' + (tried && err ? 'bad' : '')} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 100000" />
                  <AmountWords v={amount} />
                </Field>
                <Field label="Where should the money go? *">
                  <div style={{ display: 'grid', gap: 8 }} role="radiogroup">
                    {ways.map(([k, l, s]) => (
                      <button key={k} type="button" role="radio" aria-checked={method === k} className={'role ' + (method === k ? 'on' : '')} style={{ textAlign: 'left' }} onClick={() => setMethod(k)}>
                        <b>{l}</b><span>{s}</span>
                      </button>
                    ))}
                  </div>
                </Field>
                {method === 'mt5' && (
                  <Field label="MT5 account number *" err={tried ? mt5Err : null}><input className={'input mono ' + (tried && mt5Err ? 'bad' : '')} value={mt5} onChange={e => setMt5(e.target.value)} placeholder="e.g. 51234567" /></Field>
                )}
                {method === 'bank' && !bank?.account && <div className="note">No bank account is registered{forMe ? ' for you' : ''} yet. The company will confirm the account details before paying.</div>}
                <Field label="Note (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the company should know" /></Field>
                <FilePicker label="Attachments (optional)" files={files} onChange={setFiles} hint="Optional: a signed request, bank details or other proof (image, PDF, Word or Excel, 3 MB each)." />
                {preview.length > 0 && !err && (
                  <div className="tbl"><table>
                    <thead><tr><th>Taken from</th><th>Monthly ROI</th><th className="n">Now</th><th className="n">Withdrawn</th><th className="n">After</th></tr></thead>
                    <tbody>{preview.map(p => (
                      <tr key={p.investment_id}><td className="mono">{p.code}</td><td>{rateShort(p.rate)}</td><td className="n">{money(p.before)}</td><td className="n"><b>{money(p.amount)}</b></td><td className="n">{money(p.after)}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
                {preview.length > 0 && !err && <div className="note info">From today the monthly return becomes about <b>{money(newMonthly)}</b> (now {money(nowMonthly)}).</div>}
                <button className="btn primary" onClick={() => { setTried(true); if (!err && !mt5Err) setConfirm(true); }}>{method === 'ib' ? 'Request transfer to IB' : 'Apply for withdrawal'}</button>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Taken in this order</h3><div className="r">highest ROI first</div></div>
          <div className="card-b">
            {parts.length ? <div className="list">{parts.map((p, k) => { const i = lockOf(p.investment_id); return (
              <div key={p.investment_id}><div className="grow"><b>{k + 1}. {p.code} · {rateShort(p.rate)} a month</b><span>{money(p.before)}{i ? (i.lockin_months ? ` · lock-in until ${date(i.maturity_date)}` : ' · no lock-in') : ''}</span></div></div>
            ); })}</div> : <Empty title="No live investments" />}
            <p className="hint" style={{ marginTop: 10 }}>A withdrawal is allowed whatever the lock-in.</p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>{acc && acc.subs.length ? 'Withdrawals (me and my sub-investors)' : 'My withdrawals'}</h3></div>
        {wds.length ? (
          <div className="tbl"><table>
            <thead><tr><th>Request</th>{acc && acc.subs.length > 0 && <th>For</th>}<th>Applied on</th><th className="n">Amount</th><th>Where</th><th>Taken from</th><th>Attachments</th><th>Status</th><th /></tr></thead>
            <tbody>{wds.map(w => (
              <tr key={w.id}>
                <td className="mono">{w.code}</td>
                {acc && acc.subs.length > 0 && <td>{whoName(w.investor_id)}</td>}
                <td>{date(w.requested_on)}</td>
                <td className="n">{money(w.amount)}</td>
                <td>{methodText(w.method)}{w.method === 'mt5' && w.mt5_account && <span className="sub mono">{w.mt5_account}</span>}</td>
                <td>{(w.allocations || []).map(p => `${p.code} (${rateShort(p.rate)}): ${money(p.amount)}`).join(', ')}</td>
                <td><AttachmentLinks items={w.attachments} /></td>
                <td><WdBadge s={w.status} />{w.status === 'completed' && <span className="sub">{w.method === 'ib' ? 'approved' : 'paid'} {date(w.completed_on)}{w.payment_ref ? ' · ' + w.payment_ref : ''}</span>}{w.status === 'cancelled' && w.cancelled_reason && <span className="sub">{w.cancelled_reason}</span>}</td>
                <td>{w.status === 'pending' && <span style={{ display: 'inline-flex', gap: 6 }}><button className="btn sm" onClick={() => setEditing(w)}>Edit</button><button className="btn sm danger" onClick={() => setDel(w)}>Delete</button></span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="card-b"><Empty title="No withdrawals yet">Requests show here as Payment processed, then Payment fulfilled once paid.</Empty></div>}
      </div>

      {editing && <EditWithdrawal w={editing} who={whoName(editing.investor_id)} hasIb={editing.investor_id === me ? !!acc?.ib : true} ibLabel={editing.investor_id === me ? 'Transfer to my IB' : 'Transfer to me (IB)'} onClose={() => setEditing(null)} />}
      {del && <DeleteWithdrawal w={del} who={whoName(del.investor_id)} onClose={() => setDel(null)} />}
      {confirm && (
        <Modal title={`Withdraw ${money(amt)}${forMe ? '' : ' for ' + sub!.full_name}?`} sub={`Taken from ${preview.map(p => `${p.code} (${rateShort(p.rate)})`).join(', ')}, ${how}. From today, returns are calculated on the lower amount. ${method === 'ib' ? 'The company approves the transfer and marks it completed.' : 'The company pays it and marks it completed.'}${files.length ? ` ${files.length} attachment${files.length === 1 ? '' : 's'} included.` : ''}`}
          onClose={() => setConfirm(false)}
          foot={<><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={send} disabled={act.busy}>{act.busy ? 'Sending…' : 'Send request'}</button></>} />
      )}
    </>
  );
}

/** Edit a pending withdrawal: amount, where the money goes, note. The investor (or their IB) and the Super Admin can do this. */
export function EditWithdrawal({ w, who, hasIb, ibLabel = 'Transfer to IB', admin = false, onClose }: { w: Withdrawal; who: string; hasIb: boolean; ibLabel?: string; admin?: boolean; onClose: () => void }) {
  const act = useAction();
  const [amount, setAmount] = useState(String(w.amount));
  const [method, setMethod] = useState<WithdrawalMethod>(w.method);
  const [mt5, setMt5] = useState(w.mt5_account || '');
  const [note, setNote] = useState(w.note || '');
  const amt = Number(amount);
  const err = !(amt > 0) || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? 'Enter the amount.' : method === 'mt5' && !/^[A-Za-z0-9._-]{3,40}$/.test(mt5.trim()) ? 'Enter the MT5 account number.' : null;
  const ways: [WithdrawalMethod, string][] = [['bank', 'Bank account'], ['mt5', 'MT5 account'], ...(hasIb ? [['ib', ibLabel] as [WithdrawalMethod, string]] : []), ...(admin ? [['cash', 'Cash'] as [WithdrawalMethod, string]] : [])];
  const go = async () => {
    const r = await act.run(() => rpc('update_withdrawal', { p_id: w.id, p_amount: amt, p_method: method, p_mt5: method === 'mt5' ? mt5.trim() : '', p_note: note.trim() }), ['Withdrawal updated', `${w.code} · ${money(amt)}`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Edit ${w.code}`} sub={`${who ? who + ' · ' : ''}taken again from the highest monthly ROI first, from ${date(w.requested_on)}.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy || !!err}>{act.busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="form">
        <Field label="Amount (INR) *" err={err && !(amt > 0) ? err : null}><input className="input num" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /><AmountWords v={amount} /></Field>
        <Field label="Where should the money go?"><div className="chips">
          {ways.map(([k, l]) => <button key={k} type="button" className={'chip ' + (method === k ? 'on' : '')} onClick={() => setMethod(k)}>{l}</button>)}
        </div></Field>
        {method === 'mt5' && <Field label="MT5 account number *"><input className="input mono" value={mt5} onChange={e => setMt5(e.target.value)} /></Field>}
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** Delete a withdrawal: the amount goes back into the investments it was taken from and the returns are recalculated. */
export function DeleteWithdrawal({ w, who, onClose }: { w: Withdrawal; who: string; onClose: () => void }) {
  const act = useAction();
  const go = async () => {
    const r = await act.run(() => rpc('delete_withdrawal', { p_id: w.id }), ['Withdrawal deleted', `${w.code} · the amount is back in the investments`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Delete ${w.code}?`} sub={`${money(w.amount)}${who ? ' · ' + who : ''}. The amount goes back into the investments it was taken from${w.status === 'completed' ? ' (this withdrawal was already paid)' : ''}, and returns are recalculated from ${date(w.requested_on)}. This cannot be undone.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Keep</button><button className="btn danger" onClick={go} disabled={act.busy}>{act.busy ? 'Deleting…' : 'Delete withdrawal'}</button></>} />
  );
}
