import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, rateShort, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { ErrorNote, Field, Kpi, Loading, Modal, PageHead, useAction, Empty } from '../ui/kit';
import { Icon } from '../ui/Icon';
import { DateInput } from '../ui/DateInput';
import { RoiBadge, monthText, type RoiRequest } from '../investor/RequestRoi';
import { PayView, payText } from '../ui/PayTo';

/* ROI requests from investors (any day, for months that have ended) and from IBs for people under them without a login.
   Pay a request with "Mark fulfilled": its returns become paid, highest ROI % first. ROI not requested stays pending. */

type P = { id: string; code: string; full_name: string; phone: string | null };
type Tab = 'pending' | 'completed' | 'cancelled' | 'all';

export function RoiRequests() {
  const q = useQuery(async () => {
    const [reqs, people] = await Promise.all([
      fetchAll<RoiRequest>((a, b) => api.from('roi_requests').select('*').order('requested_at', { ascending: false }).range(a, b)),
      fetchAll<P>((a, b) => api.from('profiles').select('id,code,full_name,phone').range(a, b))
    ]);
    return { reqs, pm: new Map(people.map(p => [p.id, p])) };
  }, []);
  const [tab, setTab] = useState<Tab>('pending');
  const [pay, setPay] = useState<RoiRequest | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const act = useAction();
  const head = <PageHead crumbs={['ROI requests']} title="ROI requests" sub="Investors request a month’s ROI any day after it ends (in November → October; missed months can be requested together). IBs can request for people under them who have no login. ROI that is not requested stays pending." />;
  if (q.error) return <>{head}<ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <>{head}<Loading /></>;
  const { reqs, pm } = q.data;
  const rows = reqs.filter(r => tab === 'all' || r.status === tab);
  const sum = (s: string) => reqs.filter(r => r.status === s).reduce((x, r) => x + Number(r.amount), 0);
  const cancel = async (r: RoiRequest) => { const x = await act.run(() => rpc('cancel_roi_request', { p_id: r.id, p_reason: 'Cancelled by the company' }), ['Request cancelled', r.code + ' · its ROI is pending again']); if (x !== undefined) { refreshAll(); q.reload(); } };
  return (
    <>
      <PageHead crumbs={['ROI requests']} title="ROI requests" sub="Investors request a month’s ROI any day after it ends (in November → October; missed months can be requested together). IBs can request for people under them who have no login. ROI that is not requested stays pending."
        actions={<button className="btn" onClick={() => downloadCsv('roi-requests', ['Request', 'Investor ID', 'Investor', 'Phone', 'Requested by', 'Requested on', 'Months', 'Amount', 'Pay to', 'Status', 'Paid on', 'Reference'],
          rows.map(r => [r.code, pm.get(r.investor_id)?.code, pm.get(r.investor_id)?.full_name, pm.get(r.investor_id)?.phone, r.requested_by !== r.investor_id ? pm.get(r.requested_by)?.full_name : 'Self', r.requested_on, r.months.map(monthText).join(', '), Number(r.amount).toFixed(2), payText(r), r.status, r.completed_on, r.payment_ref]))}><Icon name="download" />Export to Excel</button>} />
      <div className="kpis">
        <Kpi label="Payment processed" value={money(sum('pending'))} sub={`${reqs.filter(r => r.status === 'pending').length} to pay`} subCls={reqs.some(r => r.status === 'pending') ? 'warn' : ''} />
        <Kpi label="Payment fulfilled" cls="pos" value={money(sum('completed'))} sub={`${reqs.filter(r => r.status === 'completed').length} paid`} />
      </div>
      <div className="card">
        <div className="card-b"><div className="chips">
          {([['pending', 'Payment processed'], ['completed', 'Payment fulfilled'], ['cancelled', 'Cancelled'], ['all', 'All']] as [Tab, string][]).map(([k, l]) => <button key={k} type="button" className={'chip ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>{l}</button>)}
        </div></div>
        {!rows.length ? <div className="card-b"><Empty title="No requests here">ROI requests from investors and IBs appear here.</Empty></div> : (
          <div className="tbl"><table>
            <thead><tr><th>Request</th><th>Investor</th><th>Requested by</th><th>Months</th><th className="n">Amount</th><th>Pay to</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.flatMap(r => {
              const who = pm.get(r.investor_id), by = r.requested_by !== r.investor_id ? pm.get(r.requested_by) : null;
              const main = (
                <tr key={r.id} className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="mono">{r.code}<span className="sub">{date(r.requested_on)}</span></td>
                  <td>{who ? <Link to={'/admin/investors/' + who.code} onClick={e => e.stopPropagation()}><b>{who.full_name}</b></Link> : '—'}<span className="sub">{who?.code}{who?.phone ? ' · ' + who.phone : ''}</span></td>
                  <td>{by ? <>{by.full_name}<span className="sub">IB</span></> : 'Self'}</td>
                  <td>{r.months.map(monthText).join(', ')}</td>
                  <td className="n"><b>{money(r.amount)}</b></td>
                  <td><PayView r={r} amount={Number(r.amount)} /></td>
                  <td><RoiBadge s={r.status} />{r.status === 'completed' && <span className="sub">{date(r.completed_on)}{r.payment_ref ? ' · ' + r.payment_ref : ''}</span>}</td>
                  <td onClick={e => e.stopPropagation()}>{r.status === 'pending' && <span style={{ display: 'flex', gap: 6 }}>
                    <button className="btn sm primary" onClick={() => setPay(r)}>Mark fulfilled</button>
                    <button className="btn sm" disabled={act.busy} onClick={() => cancel(r)}>Cancel</button></span>}</td>
                </tr>
              );
              if (open !== r.id) return [main];
              return [main, <tr key={r.id + ':d'}><td colSpan={8}><div className="hint" style={{ marginBottom: 4 }}>Released highest ROI first:</div>
                {(r.items || []).map((it, k) => <div key={k} className="sub" style={{ display: 'block' }}><span className="mono">{it.code}</span> · {rateShort(it.rate)} · {it.month ? monthText(it.month) : ''} · {money(it.amount)}</div>)}</td></tr>];
            })}</tbody>
          </table></div>
        )}
      </div>
      {pay && <PayDialog r={pay} who={pm.get(pay.investor_id)?.full_name || ''} onClose={() => { setPay(null); q.reload(); }} />}
    </>
  );
}

function PayDialog({ r, who, onClose }: { r: RoiRequest; who: string; onClose: () => void }) {
  const act = useAction();
  const [on, setOn] = useState(today());
  const [ref, setRef] = useState('');
  const go = async () => {
    const x = await act.run(() => rpc('admin_complete_roi_request', { p_id: r.id, p_paid_on: on || today(), p_ref: ref.trim() }), ['Payment fulfilled', `${r.code} · ${money(r.amount)} · the investor now sees it as paid`]);
    if (x !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Mark ${r.code} as payment fulfilled?`} sub={`${who} · ${r.months.map(monthText).join(', ')} · ${money(r.amount)}. Released highest ROI first.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>{act.busy ? 'Saving…' : 'Mark fulfilled'}</button></>}>
      <div className="form">
        <Field label="Pay to"><div><PayView r={r} amount={Number(r.amount)} /></div></Field>
        <div className="f-row">
          <Field label="Paid on"><DateInput className="input" max={today()} value={on} onChange={e => setOn(e.target.value)} /></Field>
          <Field label="Payment reference" hint="UTR, receipt no. (optional)."><input className="input mono" value={ref} onChange={e => setRef(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}
