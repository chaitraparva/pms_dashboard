import { useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { money, date, MONTHS, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { Badge, ErrorNote, Kpi, Loading, PageHead } from '../ui/kit';
import { Icon } from '../ui/Icon';

/* Monthly bills: each ended month is a closing bill (its returns and IB bonuses, paid or pending); the running month is
   calculated day by day up to today and shown as Pending. Nothing here is typed in: it all comes from the calculations. */

interface BillRow { investor_id: string; code: string; name: string; phone: string; branch: string; ib_id: string | null; ib_code: string; ib_name: string; investments: number; roi: number; roi_paid: number; bonus: number; bonus_paid: number }
interface Bill { month: string; months: string[]; running: boolean; from: string | null; to: string | null; rows: BillRow[]; totals: { roi: number; roi_paid: number; bonus: number; bonus_paid: number } }

const monthText = (m: string) => MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
const St = ({ total, paid, running }: { total: number; paid: number; running: boolean }) =>
  total <= 0 ? <span className="muted">—</span> : running ? <Badge cls="b-amber">Pending · running</Badge>
    : paid >= total - 0.005 ? <Badge cls="b-green">Paid</Badge> : paid > 0 ? <Badge cls="b-amber">Part paid · {money(total - paid)} pending</Badge> : <Badge cls="b-amber">Pending</Badge>;

export function Bills() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const q = useQuery(() => rpc<Bill>('monthly_bill', { p_month: month }), [month]);
  const b = q.data;
  const title = b ? monthText(b.month) + (b.running ? ' · running month' : ' · closing bill') : 'Monthly bills';
  const exportIt = () => b && downloadCsv('bill-' + b.month,
    ['Month', 'Investor ID', 'Investor', 'Phone', 'Branch', 'Investments', 'Returns (ROI)', 'ROI paid', 'ROI status', 'IB', 'IB ID', 'IB bonus', 'Bonus paid', 'Bonus status'],
    b.rows.map(r => [monthText(b.month), r.code, r.name, r.phone, r.branch, r.investments, r.roi.toFixed(2), r.roi_paid.toFixed(2), b.running ? 'Pending (running)' : r.roi_paid >= r.roi - 0.005 ? 'Paid' : 'Pending',
      r.ib_name, r.ib_code, r.bonus.toFixed(2), r.bonus_paid.toFixed(2), r.bonus <= 0 ? '' : b.running ? 'Pending (running)' : r.bonus_paid >= r.bonus - 0.005 ? 'Paid' : 'Pending']));
  return (
    <>
      <PageHead crumbs={['Monthly bills']} title="Monthly bills"
        sub="Pick a month. An ended month shows its closing bill: the returns (ROI) of every investor and the bonus of their IB, paid or pending. The running month grows every day and shows as Pending until it ends."
        actions={<>
          <select className="input" style={{ width: 'auto' }} value={month} onChange={e => setMonth(e.target.value)} aria-label="Month">
            {(b?.months || [month]).map(m => <option key={m} value={m}>{monthText(m)}{m === today().slice(0, 7) ? ' (running)' : ''}</option>)}
          </select>
          <button className="btn" onClick={exportIt} disabled={!b?.rows.length}><Icon name="download" />Export to Excel</button>
          <button className="btn" onClick={() => window.print()} disabled={!b?.rows.length}><Icon name="print" />Print</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !b ? <Loading rows={4} /> : <>
        <div className="card" style={{ boxShadow: 'none' }}><div className="card-b">
          <b>{title}</b>{b.from && <span className="muted"> · {date(b.from)} – {date(b.to)}{b.running ? ' (calculated day by day up to today)' : ''}</span>}
        </div></div>
        <div className="kpis">
          <Kpi label="Returns (ROI)" value={money(b.totals.roi)} sub={`${b.rows.filter(r => r.roi > 0).length} investors`} />
          <Kpi label={b.running ? 'ROI pending (running)' : 'ROI paid'} cls={b.running ? '' : 'pos'} value={money(b.running ? b.totals.roi : b.totals.roi_paid)}
            sub={b.running ? 'Billed when the month ends' : b.totals.roi - b.totals.roi_paid > 0.005 ? money(b.totals.roi - b.totals.roi_paid) + ' pending' : 'All paid'} subCls={!b.running && b.totals.roi - b.totals.roi_paid > 0.005 ? 'warn' : ''} />
          <Kpi label="IB bonus" value={money(b.totals.bonus)} sub={`${new Set(b.rows.filter(r => r.bonus > 0).map(r => r.ib_id)).size} IBs`} />
          <Kpi label={b.running ? 'Bonus pending (running)' : 'Bonus paid'} cls={b.running ? '' : 'pos'} value={money(b.running ? b.totals.bonus : b.totals.bonus_paid)}
            sub={b.running ? 'Billed when the month ends' : b.totals.bonus - b.totals.bonus_paid > 0.005 ? money(b.totals.bonus - b.totals.bonus_paid) + ' pending' : 'All paid'} subCls={!b.running && b.totals.bonus - b.totals.bonus_paid > 0.005 ? 'warn' : ''} />
        </div>
        <div className="card">
          {!b.rows.length ? <div className="card-b"><p className="muted">No returns for {monthText(b.month)}.</p></div> : (
            <div className="tbl"><table>
              <thead><tr><th>Investor</th><th>Branch</th><th className="n">Investments</th><th className="n">Returns (ROI)</th><th>ROI status</th><th>IB</th><th className="n">IB bonus</th><th>Bonus status</th></tr></thead>
              <tbody>
                {b.rows.map(r => (
                  <tr key={r.investor_id}>
                    <td><Link to={'/admin/investors/' + r.code}><b>{r.name}</b></Link><span className="sub mono">{r.code}</span></td>
                    <td>{r.branch || <span className="muted">—</span>}</td>
                    <td className="n">{r.investments}</td>
                    <td className="n"><b>{money(r.roi)}</b></td>
                    <td><St total={r.roi} paid={r.roi_paid} running={b.running} /></td>
                    <td>{r.ib_name || <span className="muted">—</span>}{r.ib_code && <span className="sub mono">{r.ib_code}</span>}</td>
                    <td className="n">{r.bonus > 0 ? money(r.bonus) : <span className="muted">—</span>}</td>
                    <td><St total={r.bonus} paid={r.bonus_paid} running={b.running} /></td>
                  </tr>
                ))}
                <tr><td colSpan={3}><b>Total</b></td><td className="n"><b>{money(b.totals.roi)}</b></td><td /><td /><td className="n"><b>{money(b.totals.bonus)}</b></td><td /></tr>
              </tbody>
            </table></div>
          )}
        </div>
      </>}
    </>
  );
}
