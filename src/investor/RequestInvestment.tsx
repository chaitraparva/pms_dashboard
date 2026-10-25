import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, dateTime, lockinText, today, addMonths } from '../lib/format';
import { uploadAttachment } from '../lib/docs';
import type { InvestmentRequest } from '../lib/types';
import { Badge, Empty, ErrorNote, Field, Kpi, Loading, Modal, PageHead, useAction } from '../ui/kit';
import { AttachmentLinks, FilePicker } from '../ui/Attach';
import { loadAccount } from './data';
import { SearchSelect } from '../ui/SearchSelect';

/* Request an investment. An investor requests for themselves; an IB also for a sub-investor (existing or new).
   Every request goes to the Super Admin, who sets the ROI and approves it. Approved investments then show in the portal. */

export const ReqBadge = ({ s }: { s: string }) => s === 'approved' ? <Badge cls="b-green">Approved</Badge> : s === 'rejected' ? <Badge cls="b-red">Not approved</Badge>
  : s === 'cancelled' ? <Badge cls="b-grey">Cancelled</Badge> : <Badge cls="b-amber">Waiting for approval</Badge>;
const LOCKS: [string, string][] = [['0', 'No lock-in'], ['6', '6 months'], ['12', '12 months'], ['custom', 'Other']];

async function load() {
  const acc = await loadAccount();
  const reqs = await fetchAll<InvestmentRequest>((a, b) => api.from('investment_requests').select('*').order('created_at', { ascending: false }).range(a, b));
  return { acc, reqs };
}

export function RequestInvestment() {
  const { profile } = useAuth();
  const act = useAction();
  const [sp] = useSearchParams();
  const me = profile!.id;
  const q = useQuery(load, [me]);
  const preSub = sp.get('for') || '';
  const [forWho, setForWho] = useState<'self' | 'sub'>(preSub ? 'sub' : 'self');
  const [subId, setSubId] = useState(preSub || '');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCity, setNewCity] = useState('');
  const [amount, setAmount] = useState('');
  const [lock, setLock] = useState('12');
  const [customLock, setCustomLock] = useState('');
  const [start, setStart] = useState(today());
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState(false);

  if (q.error) return <><PageHead crumbs={['Request investment']} title="Request investment" /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <><PageHead crumbs={['Request investment']} title="Request investment" /><Loading /></>;
  const { acc, reqs } = q.data;
  const isIb = !!acc?.is_ib;
  const subs = acc?.subs || [];
  const isNew = forWho === 'sub' && subId === 'new';
  const months = lock === 'custom' ? Number(customLock) : Number(lock);
  const amt = Number(amount);
  const digits = newPhone.replace(/\D/g, '').slice(-10);
  const errs: Record<string, string | null> = {
    sub: forWho === 'sub' && !subId ? 'Choose the sub-investor, or add a new one.' : null,
    newName: isNew && !newName.trim() ? 'Enter their name.' : null,
    newPhone: isNew && newPhone.trim() ? (digits.length !== 10 ? 'Enter a 10-digit phone number, or leave it empty.' : digits === (profile!.phone || '').replace(/\D/g, '').slice(-10) ? 'That is your own number.' : null) : null,
    amount: !(amt > 0) || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? 'Enter the amount (at most 2 decimals).' : null,
    lock: !(Number.isInteger(months) && months >= 0 && months <= 120) ? 'Lock-in in months, 0 to 120.' : null,
    start: !start ? 'Choose the start date.' : null
  };
  const bad = Object.values(errs).some(Boolean);
  const e = (k: string) => (tried ? errs[k] : null);
  const forName = forWho === 'self' ? 'yourself' : isNew ? newName.trim() || 'a new sub-investor' : subs.find(s => s.id === subId)?.full_name || 'your sub-investor';
  const nameOf = (r: InvestmentRequest) => (r.investor_id === me ? 'Me' : subs.find(s => s.id === r.investor_id)?.full_name || r.new_sub?.name || '—');
  const pending = reqs.filter(r => r.status === 'pending');

  const send = async () => {
    const r = await act.run(async () => {
      const attachments = [];
      for (const f of files) attachments.push(await uploadAttachment(f, me));
      return rpc<string>('request_investment', {
        p_for: forWho, p_sub_id: forWho === 'sub' && !isNew ? subId : null, p_new_sub: isNew ? { name: newName.trim(), phone: newPhone.trim(), city: newCity.trim() } : null,
        p_amount: amt, p_lockin_months: months, p_start_date: start, p_reference: ref.trim(), p_note: note.trim(), p_attachments: attachments
      });
    }, ['Request sent', 'The company reviews it. Once approved, the investment shows in the portal.']);
    if (r !== undefined) { setConfirm(false); setAmount(''); setRef(''); setNote(''); setFiles([]); setTried(false); setNewName(''); setNewPhone(''); setNewCity(''); refreshAll(); q.reload(); }
  };
  const cancel = async (r: InvestmentRequest) => {
    const x = await act.run(() => rpc('cancel_investment_request', { p_id: r.id }), ['Request cancelled', r.code]);
    if (x !== undefined) q.reload();
  };

  return (
    <>
      <PageHead crumbs={['Request investment']} title="Request investment" sub={isIb ? 'Request an investment for yourself or for one of your sub-investors. The company sets the monthly ROI and approves it.' : 'Request a new investment. The company sets the monthly ROI and approves it; it then shows under My Investments.'} />
      <div className="kpis k4">
        <Kpi label="Waiting for approval" value={money(pending.reduce((s, r) => s + Number(r.amount), 0))} sub={`${pending.length} request${pending.length === 1 ? '' : 's'}`} subCls={pending.length ? 'warn' : ''} />
        <Kpi label="Approved" cls="pos" value={money(reqs.filter(r => r.status === 'approved').reduce((s, r) => s + Number(r.amount), 0))} sub={`${reqs.filter(r => r.status === 'approved').length} now investments`} />
        {isIb && <Kpi label="My sub-investors" value={subs.length} sub="you can request for them" />}
      </div>
      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>New request</h3></div>
          <div className="card-b">
            <div className="form">
              {isIb && (
                <Field label="Investment for *" err={e('sub')}>
                  <div className="chips">
                    <button type="button" className={'chip ' + (forWho === 'self' ? 'on' : '')} onClick={() => setForWho('self')}>Myself</button>
                    <button type="button" className={'chip ' + (forWho === 'sub' ? 'on' : '')} onClick={() => setForWho('sub')}>A sub-investor</button>
                  </div>
                  {forWho === 'sub' && (
                    <div style={{ marginTop: 8 }}>
                      <SearchSelect value={subId} onChange={setSubId} bad={!!e('sub')} placeholder="Type the sub-investor’s name or phone number…"
                        options={[...subs.map(s => ({ value: s.id, label: s.full_name + ' · ' + s.code, sub: s.phone || undefined })), { value: 'new', label: '+ A new sub-investor' }]} />
                    </div>
                  )}
                </Field>
              )}
              {isNew && (
                <div className="sec">
                  <h4>New sub-investor</h4>
                  <div className="f-row">
                    <Field label="Name *" err={e('newName')}><input className={'input ' + (e('newName') ? 'bad' : '')} value={newName} onChange={ev => setNewName(ev.target.value)} /></Field>
                    <Field label="Phone number (optional)" err={e('newPhone')} hint="Needed only if they should sign in."><input className={'input num ' + (e('newPhone') ? 'bad' : '')} inputMode="tel" value={newPhone} onChange={ev => setNewPhone(ev.target.value)} /></Field>
                  </div>
                  <Field label="City (optional)"><input className="input" value={newCity} onChange={ev => setNewCity(ev.target.value)} /></Field>
                  <p className="hint">The company registers them under you when approving. With a phone number, the company can also give them a login.</p>
                </div>
              )}
              <div className="f-row">
                <Field label="Amount (INR) *" err={e('amount')}><input className={'input num ' + (e('amount') ? 'bad' : '')} inputMode="decimal" value={amount} onChange={ev => setAmount(ev.target.value)} placeholder="e.g. 500000" /></Field>
                <Field label="Preferred start date *" err={e('start')}><input className="input" type="date" value={start} onChange={ev => setStart(ev.target.value)} /></Field>
              </div>
              <Field label="Preferred lock-in *" err={e('lock')}>
                <div className="chips">{LOCKS.map(([v, l]) => <button key={v} type="button" className={'chip ' + (lock === v ? 'on' : '')} onClick={() => setLock(v)}>{l}</button>)}</div>
                {lock === 'custom' && <input className="input num" style={{ marginTop: 8 }} inputMode="numeric" value={customLock} onChange={ev => setCustomLock(ev.target.value)} placeholder="Months, e.g. 3" />}
              </Field>
              <div className="f-row">
                <Field label="Payment reference (optional)" hint="Bank / UTR number if already transferred."><input className="input mono" value={ref} onChange={ev => setRef(ev.target.value)} /></Field>
                <Field label="Note (optional)"><input className="input" value={note} onChange={ev => setNote(ev.target.value)} /></Field>
              </div>
              <FilePicker label="Payment proof (optional)" files={files} onChange={setFiles} hint="Optional: transfer receipt or screenshot (image, PDF, Word or Excel, 3 MB each)." />
              <button className="btn primary" onClick={() => { setTried(true); if (!bad) setConfirm(true); }}>Send request</button>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>How it works</h3></div>
          <div className="card-b list">
            <div><div className="grow"><b>1. You send the request</b><span>For {isIb ? 'yourself or a sub-investor' : 'yourself'}, with the amount and an optional proof.</span></div></div>
            <div><div className="grow"><b>2. The company approves it</b><span>They confirm the funds and set the monthly ROI{isIb ? ' and your IB bonus' : ''}.</span></div></div>
            <div><div className="grow"><b>3. It shows in the portal</b><span>{isIb ? 'Your own investments under My Investments; a sub-investor’s under My Sub-Investors.' : 'Under My Investments, with its monthly returns.'}</span></div></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>My requests</h3></div>
        {reqs.length ? (
          <div className="tbl"><table>
            <thead><tr><th>Request</th>{isIb && <th>For</th>}<th className="n">Amount</th><th>Lock-in</th><th>Start</th><th>Proof</th><th>Status</th><th /></tr></thead>
            <tbody>{reqs.map(r => (
              <tr key={r.id}>
                <td className="mono">{r.code}<span className="sub">{dateTime(r.created_at)}</span></td>
                {isIb && <td>{nameOf(r)}{!r.investor_id && <span className="sub">new sub-investor</span>}</td>}
                <td className="n">{money(r.amount)}</td>
                <td>{lockinText(r.lockin_months)}</td>
                <td>{date(r.start_date)}</td>
                <td><AttachmentLinks items={r.attachments} /></td>
                <td><ReqBadge s={r.status} />{r.status === 'approved' && r.investment_code && <span className="sub">{r.investor_id === me ? <Link to={'/portal/investments/' + r.investment_code}>{r.investment_code}</Link> : r.investor_id ? <Link to={'/portal/network/' + r.investor_id}>{r.investment_code}</Link> : r.investment_code}</span>}{r.decision_note && r.status !== 'approved' && <span className="sub">{r.decision_note}</span>}</td>
                <td>{r.status === 'pending' && r.requested_by === me && <button className="btn sm" disabled={act.busy} onClick={() => cancel(r)}>Cancel</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="card-b"><Empty title="No requests yet">Requests you send show here until the company approves them.</Empty></div>}
      </div>

      {confirm && (
        <Modal title={`Request ${money(amt)} for ${forName}?`} sub={`${lockinText(months)}${months > 0 ? ', ending about ' + date(addMonths(start, months)) : ''}, from ${date(start)}. The company sets the monthly ROI and approves it.${files.length ? ` ${files.length} attachment${files.length === 1 ? '' : 's'} included.` : ''}`}
          onClose={() => setConfirm(false)}
          foot={<><button className="btn ghost" onClick={() => setConfirm(false)}>Back</button><button className="btn primary" onClick={send} disabled={act.busy}>{act.busy ? 'Sending…' : 'Send request'}</button></>} />
      )}
    </>
  );
}
