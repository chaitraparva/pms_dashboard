import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { approveInvestmentRequest } from '../lib/adminApi';
import { money, date, dateTime, lockinText, rate, rateShort, addMonths } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { InvestmentRequest, Profile } from '../lib/types';
import { Badge, Drawer, ErrorNote, Field, Kpi, Loading, Modal, PageHead, useAction } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';
import { AttachmentLinks } from '../ui/Attach';
import { Icon } from '../ui/Icon';

/* Investment requests from the portal: an investor for themselves, or an IB for a sub-investor.
   The Super Admin sets the ROI (and the IB bonus) and approves; the investment then shows in the portal. */

type P = Pick<Profile, 'id' | 'code' | 'full_name' | 'phone' | 'introduced_by' | 'has_login'>;
interface Row extends InvestmentRequest { subject?: P; by?: P; ib?: P; forName: string }
type Tab = 'pending' | 'approved' | 'rejected' | 'all';

export const ReqBadge = ({ s }: { s: string }) => s === 'approved' ? <Badge cls="b-green">Approved</Badge> : s === 'rejected' ? <Badge cls="b-red">Not approved</Badge>
  : s === 'cancelled' ? <Badge cls="b-grey">Cancelled</Badge> : <Badge cls="b-amber">Waiting for approval</Badge>;

async function load() {
  const [reqs, people] = await Promise.all([
    fetchAll<InvestmentRequest>((a, b) => api.from('investment_requests').select('*').order('created_at', { ascending: false }).range(a, b)),
    fetchAll<P>((a, b) => api.from('profiles').select('id,code,full_name,phone,introduced_by,has_login').eq('role', 'investor').range(a, b))
  ]);
  const pm = new Map(people.map(p => [p.id, p]));
  return reqs.map<Row>(r => {
    const subject = r.investor_id ? pm.get(r.investor_id) : undefined;
    const ibId = r.kind === 'sub' ? r.requested_by : subject?.introduced_by;
    return { ...r, subject, by: pm.get(r.requested_by), ib: ibId ? pm.get(ibId) : undefined, forName: subject?.full_name || r.new_sub?.name || '—' };
  });
}

export function Requests() {
  const q = useQuery(load, []);
  const [tab, setTab] = useState<Tab>('pending');
  const [approve, setApprove] = useState<Row | null>(null);
  const [reject, setReject] = useState<Row | null>(null);
  const all = q.data || [];
  const rows = all.filter(r => tab === 'all' || r.status === tab || (tab === 'rejected' && r.status === 'cancelled'));
  const n = (k: Tab) => (k === 'all' ? all.length : all.filter(r => r.status === k || (k === 'rejected' && r.status === 'cancelled')).length);
  const sum = (rs: Row[]) => rs.reduce((s, r) => s + Number(r.amount), 0);
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'Request', m: true, v: r => r.code, r: r => <>{r.code}<span className="sub">{dateTime(r.created_at)}</span></> },
    { h: 'Investment for', v: r => r.forName, r: r => <>{r.subject ? <Link to={'/admin/investors/' + r.subject.code} onClick={e => e.stopPropagation()}>{r.subject.full_name}</Link> : <b>{r.forName}</b>}
      <span className="sub">{r.subject ? r.subject.code + ' · ' + r.subject.phone : 'New sub-investor · ' + (r.new_sub?.phone || '')}</span></> },
    { h: 'Type', v: r => r.kind, r: r => r.kind === 'sub' ? <>Sub-investor<span className="sub">IB {r.by?.full_name || '—'}</span></> : <>{r.ib ? 'Sub-investor (self)' : 'Self'}{r.ib && <span className="sub">IB {r.ib.full_name}</span>}</> },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => <b>{money(r.amount)}</b> },
    { h: 'Lock-in', v: r => r.lockin_months, r: r => lockinText(r.lockin_months) },
    { h: 'Start', v: r => r.start_date, r: r => date(r.start_date) },
    { h: 'Proof', v: r => (r.attachments || []).length, r: r => <AttachmentLinks items={r.attachments} empty="None" /> },
    { h: 'Status', v: r => r.status, r: r => <><ReqBadge s={r.status} />{r.investment_code && <span className="sub"><Link to={'/admin/investments/' + r.investment_code} onClick={e => e.stopPropagation()}>{r.investment_code}</Link></span>}{r.decision_note && r.status !== 'approved' && <span className="sub">{r.decision_note}</span>}</> },
    { h: '', r: r => r.status === 'pending' ? <span style={{ display: 'flex', gap: 6 }}><button className="btn sm primary" onClick={e => { e.stopPropagation(); setApprove(r); }}>Approve</button><button className="btn sm" onClick={e => { e.stopPropagation(); setReject(r); }}>Reject</button></span> : null }
  ], []);
  return (
    <>
      <PageHead crumbs={['Investment requests']} title="Investment requests" sub="Requested from the investor portal: by investors for themselves, or by IBs for their sub-investors. Set the ROI and approve; the investment then shows in their portal."
        actions={<button className="btn" disabled={!rows.length} onClick={() => downloadCsv('investment-requests-' + tab, ['Request', 'For', 'Phone', 'Type', 'Requested by', 'Amount', 'Lock-in', 'Start', 'Attachments', 'Status', 'Investment', 'Note'],
          rows.map(r => [r.code, r.forName, r.subject?.phone || r.new_sub?.phone, r.kind, r.by?.full_name, Number(r.amount).toFixed(2), r.lockin_months, r.start_date, (r.attachments || []).length, r.status, r.investment_code, r.note]))}><Icon name="download" />Export CSV</button>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="kpis k4">
            <Kpi label="Waiting for approval" value={money(sum(all.filter(r => r.status === 'pending')))} sub={`${n('pending')} request${n('pending') === 1 ? '' : 's'}`} subCls={n('pending') ? 'warn' : ''} />
            <Kpi label="Approved" cls="pos" value={money(sum(all.filter(r => r.status === 'approved')))} sub={`${n('approved')} recorded as investments`} />
            <Kpi label="For sub-investors" value={all.filter(r => r.kind === 'sub' && r.status === 'pending').length} sub="pending, from IBs" />
            <Kpi label="Not approved / cancelled" value={n('rejected')} />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="card"><div className="tabs" style={{ padding: '0 12px' }} role="tablist">
              {([['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Not approved'], ['all', 'All']] as [Tab, string][]).map(([k, l]) =>
                <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>{l}<span className="c">{n(k)}</span></button>)}
            </div></div>
            <DataTable key={tab} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search request, investor, phone" text={r => `${r.subject?.code || ''} ${r.subject?.phone || r.new_sub?.phone || ''} ${r.by?.full_name || ''} ${r.reference}`} sort={0} dir={-1} per={20}
              emptyTitle="No requests here" empty="Requests made in the investor portal show here." />
          </div>
        </>
      )}
      {approve && <ApproveDrawer r={approve} onClose={() => setApprove(null)} />}
      {reject && <RejectDialog r={reject} onClose={() => setReject(null)} />}
    </>
  );
}

const genPw = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)]; return 'Parva@' + s; };
const DEC = (v: string, d: number) => new RegExp('^\\d+(\\.\\d{1,' + d + '})?$').test(v.trim());

function ApproveDrawer({ r, onClose }: { r: Row; onClose: () => void }) {
  const act = useAction();
  const nav = useNavigate();
  const [roi, setRoi] = useState('');
  const [bonus, setBonus] = useState('');
  const [lock, setLock] = useState(String(r.lockin_months));
  const [amount, setAmount] = useState(String(r.amount));
  const [start, setStart] = useState(r.start_date);
  const [ref, setRef] = useState(r.reference || '');
  const [note, setNote] = useState('');
  const [pw, setPw] = useState(genPw);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<null | { code: string; pw: string | null }>(null);
  const underIb = !!r.ib || !r.investor_id;
  const ibName = r.ib?.full_name || r.by?.full_name || 'the IB';
  const needPw = !r.subject || !r.subject.has_login;
  const rr = Number(roi), b = underIb ? Number(bonus || 0) : 0, amt = Number(amount), months = Number(lock);
  const errs: Record<string, string | null> = {
    roi: !(rr > 0 && rr <= 100) || !DEC(roi, 4) ? 'Enter the monthly ROI, e.g. 2.3 or 6.' : null,
    bonus: underIb && (!DEC(bonus || '0', 4) || (rr > 0 && b >= rr)) ? 'The bonus must be 0 or more and less than the ROI.' : null,
    lock: !(Number.isInteger(months) && months >= 0 && months <= 120) ? '0 to 120 months.' : null,
    amount: !(amt > 0) || !DEC(amount, 2) ? 'Enter the principal (at most 2 decimals).' : null,
    start: !start ? 'Enter the start date.' : null,
    pw: needPw && pw.length < 8 ? 'At least 8 characters.' : null
  };
  const e = (k: string) => (tried ? errs[k] : null);
  const go = async () => {
    setTried(true); if (Object.values(errs).some(Boolean)) return;
    const res = await act.run(() => approveInvestmentRequest({ p_id: r.id, p_rate: roi.trim(), p_bonus: underIb ? (bonus.trim() || '0') : '0', p_lockin_months: months, p_principal: amt, p_start_date: start, p_reference: ref.trim(), p_note: note.trim(), p_password: needPw ? pw : '' }),
      ['Request approved', `${r.code} · ${money(amt)} for ${r.forName}`]);
    if (res) { refreshAll(); setDone({ code: res.code, pw: needPw ? pw : null }); }
  };
  if (done) return (
    <Drawer title="Request approved" sub={done.pw ? 'Share the login details with the sub-investor offline.' : 'The investment now shows in their portal.'} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Close</button><button className="btn primary" onClick={() => nav('/admin/investments/' + done.code)}>Open investment</button></>}>
      <dl className="kv">
        <dt>Investment</dt><dd className="mono">{done.code}</dd><dt>For</dt><dd>{r.forName}</dd>
        {done.pw && <><dt>Login (phone)</dt><dd className="mono">{r.new_sub?.phone || r.subject?.phone}</dd><dt>Password</dt><dd className="mono">{done.pw}</dd></>}
      </dl>
    </Drawer>
  );
  return (
    <Drawer title={`Approve ${r.code}`} sub="The investment is recorded with these terms and shows in the portal straight away." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>{act.busy ? 'Approving…' : 'Approve & record investment'}</button></>}>
      <div className="form">
        <div className="ib-card">
          <dl className="kv">
            <dt>For</dt><dd><b>{r.forName}</b> {r.subject ? <span className="muted mono">{r.subject.code}</span> : <Badge cls="b-amber">New sub-investor</Badge>}</dd>
            <dt>Phone</dt><dd className="num">{r.subject?.phone || r.new_sub?.phone || '—'}</dd>
            {underIb && <><dt>IB</dt><dd>{ibName}</dd></>}
            <dt>Requested by</dt><dd>{r.by?.full_name || '—'} · {dateTime(r.created_at)}</dd>
            <dt>Requested</dt><dd>{money(r.amount)} · {lockinText(r.lockin_months)} · from {date(r.start_date)}</dd>
            {r.note && <><dt>Note</dt><dd>{r.note}</dd></>}
            <dt>Proof</dt><dd><AttachmentLinks items={r.attachments} empty="None attached" /></dd>
          </dl>
        </div>
        <div className="f-row">
          <Field label="Monthly ROI (% per month) *" err={e('roi')}><input className={'input num ' + (e('roi') ? 'bad' : '')} inputMode="decimal" value={roi} onChange={ev => setRoi(ev.target.value)} placeholder="e.g. 6" /></Field>
          <Field label={underIb ? `Bonus to ${ibName} (% per month)` : 'IB bonus'} err={e('bonus')} hint={underIb ? (rr > 0 && b < rr ? `Investor gets ${Math.round((rr - b) * 10000) / 10000}%.` : 'Taken out of the ROI.') : 'Not under an IB.'}>
            <input className={'input num ' + (e('bonus') ? 'bad' : '')} inputMode="decimal" value={underIb ? bonus : ''} onChange={ev => setBonus(ev.target.value)} disabled={!underIb} placeholder={underIb ? 'e.g. 2' : '—'} />
          </Field>
        </div>
        <div className="f-row">
          <Field label="Principal (INR) *" err={e('amount')}><input className={'input num ' + (e('amount') ? 'bad' : '')} inputMode="decimal" value={amount} onChange={ev => setAmount(ev.target.value)} /></Field>
          <Field label="Lock-in (months) *" err={e('lock')} hint="0 = no lock-in."><input className={'input num ' + (e('lock') ? 'bad' : '')} inputMode="numeric" value={lock} onChange={ev => setLock(ev.target.value)} /></Field>
        </div>
        <div className="f-row">
          <Field label="Start date *" err={e('start')}><input className="input" type="date" value={start} onChange={ev => setStart(ev.target.value)} /></Field>
          <Field label="Reference"><input className="input mono" value={ref} onChange={ev => setRef(ev.target.value)} /></Field>
        </div>
        {needPw && (
          <Field label={`Login password for ${r.forName} *`} err={e('pw')} hint="They sign in with their phone number and this password, and can change it after signing in.">
            <div style={{ display: 'flex', gap: 6 }}><input className={'input mono ' + (e('pw') ? 'bad' : '')} value={pw} onChange={ev => setPw(ev.target.value)} autoComplete="new-password" /><button type="button" className="btn" onClick={() => setPw(genPw())}><Icon name="refresh" /></button></div>
          </Field>
        )}
        <Field label="Note to the investor (optional)"><input className="input" value={note} onChange={ev => setNote(ev.target.value)} /></Field>
        {rr > 0 && amt > 0 && <div className="note info">{rate(rr)} on {money(amt)}{underIb && b > 0 ? ` · ${rateShort(b)} to ${ibName}` : ''} · first return {date(addMonths(start, 1))}{months > 0 ? ` · lock-in ends ${date(addMonths(start, months))}` : ' · no lock-in'}.</div>}
      </div>
    </Drawer>
  );
}

function RejectDialog({ r, onClose }: { r: Row; onClose: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const go = async () => {
    const res = await act.run(() => rpc('admin_reject_investment_request', { p_id: r.id, p_reason: reason.trim() }), ['Request not approved', `${r.code} · the investor is told why`]);
    if (res !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Reject ${r.code}?`} sub={`${money(r.amount)} for ${r.forName}. Nothing is recorded.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Back</button><button className="btn danger" onClick={go} disabled={act.busy || !reason.trim()}>Reject request</button></>}>
      <Field label="Reason (shown to the investor) *"><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Payment not received yet" /></Field>
    </Modal>
  );
}
