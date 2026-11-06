import { useState } from 'react';
import { api, rpc, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, MONTHS, rateShort } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, Loading, PageHead, useAction } from '../ui/kit';
import { PayChips, PayFields, PayView, emptyPay, payArgs, payErrors, type PayDetails, type PayMethod } from '../ui/PayTo';
import type { BankDetails } from '../lib/types';

/* Request ROI: on any day the investor asks for the ROI of the months that have ended (in November → October),
   together with any earlier month they did not ask for. ROI is paid only after it is requested. An IB can ask for the people under them who have no login.
   They choose how it is paid: Bank (name, account no., IFSC, branch), UPI (ID or phone), Cash or MT5 (MT5 ID). */

interface Item { payout_id: string | null; investment_id?: string; code: string; rate: number; amount: number; month?: string }
interface MonthOpt { month: string; amount: number; items: Item[] }
interface Person { id: string; code: string; name: string; self: boolean; months: MonthOpt[] }
interface Options { people: Person[] }
export interface RoiRequest { id: string; code: string; investor_id: string; requested_by: string; months: string[]; items: Item[]; amount: number; status: 'pending' | 'completed' | 'cancelled'; requested_on: string; completed_on: string | null; payment_ref: string | null; cancelled_reason: string | null;
  method?: string | null; mt5_account?: string | null; upi_id?: string | null; bank_details?: BankDetails | null }

const WAYS: [PayMethod, string][] = [['bank', 'Bank'], ['upi', 'UPI'], ['cash', 'Cash'], ['mt5', 'MT5']];
export const monthText = (m: string) => MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
export const RoiBadge = ({ s }: { s: string }) => s === 'completed' ? <Badge cls="b-green">Payment fulfilled</Badge> : s === 'cancelled' ? <Badge cls="b-grey">Cancelled</Badge> : <Badge cls="b-amber">Payment processed</Badge>;

export function RequestRoi() {
  const { profile } = useAuth();
  const act = useAction();
  const q = useQuery(async () => {
    const [opts, reqs, people] = await Promise.all([
      rpc<Options>('roi_request_options'),
      fetchAll<RoiRequest>((a, b) => api.from('roi_requests').select('*').order('requested_at', { ascending: false }).range(a, b)),
      fetchAll<{ id: string; full_name: string }>((a, b) => api.from('profiles').select('id,full_name').range(a, b))
    ]);
    return { opts, reqs, names: new Map(people.map(p => [p.id, p.full_name])) };
  }, []);
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [how, setHow] = useState<Record<string, PayMethod>>({});
  const [pays, setPays] = useState<Record<string, PayDetails>>({});
  const [tried, setTried] = useState<Record<string, boolean>>({});

  const head = <PageHead crumbs={['Request ROI']} title="Request ROI" sub="Request the ROI of a month after it ends (in November → October). ROI is paid only after you request it; months you have not requested stay here so you can request them together." />;
  if (q.error) return <>{head}<ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <>{head}<Loading /></>;
  const { opts, reqs, names } = q.data;
  const chosen = (p: Person) => pick[p.id] ?? p.months.map(m => m.month);
  const toggle = (p: Person, m: string) => { const c = chosen(p); setPick({ ...pick, [p.id]: c.includes(m) ? c.filter(x => x !== m) : [...c, m] }); };
  const send = async (ps: Person[]) => {
    const withMonths = ps.filter(p => chosen(p).length && p.months.length);
    if (!withMonths.length) return;
    setTried(t => ({ ...t, ...Object.fromEntries(withMonths.map(p => [p.id, true])) }));
    if (withMonths.some(p => !how[p.id] || Object.keys(payErrors(how[p.id], pays[p.id] || emptyPay(), true)).length)) return;
    // one call per set of months (an IB's bulk request for several people with the same months goes together)
    const r = await act.run(async () => {
      for (const p of withMonths) await rpc('request_roi', { p_investor: p.id, p_months: chosen(p), p_method: how[p.id], ...payArgs(how[p.id], pays[p.id] || emptyPay()) });
      return true;
    }, ['ROI requested', `${withMonths.length === 1 ? withMonths[0].name : withMonths.length + ' people'} · the company pays it and you see it here`]);
    if (r) { setPick({}); setHow({}); setPays({}); setTried({}); refreshAll(); q.reload(); }
  };
  const me = opts.people.find(p => p.self);
  const subs = opts.people.filter(p => !p.self);
  const total = (p: Person) => p.months.filter(m => chosen(p).includes(m.month)).reduce((x, m) => x + m.amount, 0);

  const card = (p: Person, title: string) => (
    <div className="card" key={p.id}>
      <div className="card-h"><h3>{title}</h3><div className="r">{p.months.length ? <b>{money(total(p))}</b> : null}</div></div>
      <div className="card-b form">
        {!p.months.length ? <p className="hint">No ROI to request right now. Months that have ended and are not requested yet appear here.</p> : <>
          <div className="chips" role="group" aria-label="Months">
            {p.months.map(m => <button key={m.month} type="button" className={'chip ' + (chosen(p).includes(m.month) ? 'on' : '')} onClick={() => toggle(p, m.month)}>{monthText(m.month)} · {money(m.amount)}</button>)}
          </div>
          <div className="tbl"><table>
            <thead><tr><th>Month</th><th>Investment</th><th>ROI</th><th className="n">Amount</th></tr></thead>
            <tbody>{p.months.filter(m => chosen(p).includes(m.month)).flatMap(m => m.items.map(it => (
              <tr key={(it.payout_id || it.investment_id || it.code) + m.month}><td>{monthText(m.month)}</td><td className="mono">{it.code}</td><td>{rateShort(it.rate)}</td><td className="n">{money(it.amount)}</td></tr>)))}</tbody>
          </table></div>
          <p className="hint">Released highest ROI first.</p>
          <Field label="How should the ROI be paid? *" err={tried[p.id] && !how[p.id] ? 'Choose bank, UPI, cash or MT5.' : null}>
            <PayChips ways={WAYS} value={how[p.id] || ''} onChange={m => setHow({ ...how, [p.id]: m })} />
          </Field>
          {how[p.id] && <PayFields method={how[p.id]} d={pays[p.id] || emptyPay()} onChange={d => setPays({ ...pays, [p.id]: d })} tried={!!tried[p.id]} required amount={total(p)} />}
        </>}
      </div>
    </div>
  );

  return (
    <>
      {head}
      {me && card(me, 'My ROI')}
      {me && me.months.length > 0 && <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={act.busy || !chosen(me).length} onClick={() => send([me])}>{act.busy ? 'Sending…' : `Request ${money(total(me))}`}</button>}
      {subs.length > 0 && <>
        <h3 style={{ margin: '18px 0 4px' }}>People under you without a login</h3>
        <p className="hint">They cannot sign in, so you can request their ROI for them, all together.</p>
        {subs.map(p => card(p, p.name + ' · ' + p.code))}
        {subs.some(p => p.months.length) && <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={act.busy} onClick={() => send(subs)}>{act.busy ? 'Sending…' : `Request for all (${subs.filter(p => p.months.length && chosen(p).length).length} people · ${money(subs.reduce((x, p) => x + total(p), 0))})`}</button>}
      </>}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-h"><h3>My requests</h3></div>
        {!reqs.length ? <div className="card-b"><Empty title="No requests yet">Your ROI requests appear here.</Empty></div> : (
          <div className="tbl"><table>
            <thead><tr><th>Request</th><th>For</th><th>Months</th><th className="n">Amount</th><th>Paid by</th><th>Status</th><th /></tr></thead>
            <tbody>{reqs.map(r => (
              <tr key={r.id}>
                <td className="mono">{r.code}<span className="sub">{date(r.requested_on)}</span></td>
                <td>{r.investor_id === profile?.id ? 'Me' : names.get(r.investor_id) || '—'}</td>
                <td>{r.months.map(monthText).join(', ')}</td>
                <td className="n"><b>{money(r.amount)}</b></td>
                <td><PayView r={r} /></td>
                <td><RoiBadge s={r.status} />{r.status === 'completed' && <span className="sub">{date(r.completed_on)}{r.payment_ref ? ' · ' + r.payment_ref : ''}</span>}</td>
                <td>{r.status === 'pending' && <button className="btn sm" disabled={act.busy} onClick={async () => { const x = await act.run(() => rpc('cancel_roi_request', { p_id: r.id, p_reason: 'Cancelled by the requester' }), ['Request cancelled', r.code]); if (x !== undefined) { refreshAll(); q.reload(); } }}>Cancel</button>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
