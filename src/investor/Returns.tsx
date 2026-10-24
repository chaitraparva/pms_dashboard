import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { downloadCsv } from '../lib/csv';
import { date, dateShort, money, moneyShort, pct, rate } from '../lib/format';
import { Badge, Empty, ErrorNote, Kpi, Loading, PageHead, PayBadge } from '../ui/kit';
import { DataTable } from '../ui/DataTable';
import { BarChart, Donut, monthLabel } from '../ui/Charts';
import { Icon } from '../ui/Icon';
import { RoiReleased } from './Overview';
import type { Accrual, Payout } from '../lib/types';
import { bal, codeMap, isLive, lastMonths, loadPortfolio, projectedRemaining, unpaid } from './data';

interface Row { a: Accrual; code: string; pay: Payout | null }

export function Returns() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const q = useQuery(() => loadPortfolio(profile!.id), [profile?.id]);

  if (q.loading && !q.data) return <><PageHead crumbs={['ROI Released']} title="ROI released" /><Loading /></>;
  if (q.error || !q.data) return <><PageHead crumbs={['ROI Released']} title="ROI released" /><ErrorNote msg={q.error || 'Could not load your returns.'} retry={q.reload} /></>;

  const p = q.data;
  const inv = p.investments;
  const codes = codeMap(inv);
  const payBy = Object.fromEntries(p.payouts.map(x => [x.accrual_id, x]));
  const rows: Row[] = p.accruals.map(a => ({ a, code: codes[a.investment_id] || '—', pay: payBy[a.id] || null }));
  const sumB = (k: 'unapproved' | 'approved' | 'processing' | 'paid' | 'accrued') => inv.reduce((s, i) => s + Number(bal(p, i.id)[k]), 0);
  const projected = inv.reduce((s, i) => s + projectedRemaining(i, bal(p, i.id)), 0);
  const livePrincipal = inv.filter(isLive).reduce((s, i) => s + Number(i.principal), 0);

  const months = lastMonths(12);
  const accrued = months.map(m => p.accruals.filter(a => a.accrual_date.slice(0, 7) === m).reduce((s, a) => s + Number(a.amount), 0));
  const paid = months.map(m => p.payouts.filter(x => x.status === 'paid' && (x.paid_on || '').slice(0, 7) === m).reduce((s, x) => s + Number(x.amount), 0));
  const example = inv.find(i => i.status === 'active') || inv[0];

  const exportCsv = () => downloadCsv('monthly-returns', ['Accrual date', 'Investment', 'Period', 'Period start', 'Period end', 'Kind', 'Amount', 'Payout', 'Payout status', 'Due date', 'Payment reference', 'Paid on'],
    rows.map(r => [r.a.accrual_date, r.code, r.a.period_no, r.a.period_start, r.a.period_end, r.a.kind, Number(r.a.amount).toFixed(2), r.pay?.code || '', r.pay?.status || '', r.pay?.due_date || '', r.pay?.payment_ref || '', r.pay?.paid_on || '']));

  return (
    <>
      <PageHead crumbs={['ROI Released']} title="ROI released" sub="Simple interest: each month's return is your original principal × your contract rate. Returns are never added to principal."
        actions={rows.length ? <button className="btn" onClick={exportCsv}><Icon name="download" />Export CSV</button> : undefined} />
      {!inv.length ? (
        <div className="card"><div className="card-b"><Empty title="You have no investments yet">Your advisor will record your investment once funds are received. Monthly returns will be listed here.</Empty></div></div>
      ) : (
        <>
          <RoiReleased p={q.data} inv={inv} principal={inv.filter(isLive).reduce((s, i) => s + Number(i.principal), 0)} />
          <div className="kpis">
            <Kpi label="Accrued" value={money(sumB('unapproved'))} sub="Earned, not yet approved" tip="Returns recorded for completed months, waiting for approval." />
            <Kpi label="Approved" value={money(sumB('approved'))} sub="Scheduled for payment" tip="Approved for payment but not yet sent to the bank." />
            <Kpi label="Processing" value={money(sumB('processing'))} sub="Sent to bank" subCls="warn" tip="Sent for payment. Shown as paid only once confirmed." />
            <Kpi label="Paid" value={money(sumB('paid'))} cls="pos" sub="Confirmed" />
            <Kpi label="Projected" value={money(projected)} sub="Projected to maturity" subCls="warn" tip="Remaining months at your contract rates if nothing changes. Not guaranteed." />
          </div>

          <div className="grid g-2-1">
            <div className="card">
              <div className="card-h"><h3>Last 12 months</h3><div className="r legend"><span><i style={{ background: 'var(--chart-2)' }} />Accrued (by accrual date)</span><span><i style={{ background: 'var(--green)' }} />Paid (by payment date)</span></div></div>
              <div className="card-b">
                <BarChart labels={months.map(monthLabel)} fmt={moneyShort} tipFmt={money} label="Returns accrued and paid in each of the last 12 months"
                  series={[{ name: 'Accrued', color: 'var(--chart-2)', values: accrued }, { name: 'Paid', color: 'var(--green)', values: paid }]} />
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Principal vs returns</h3></div>
              <div className="card-b">
                <Donut fmt={money} label="Principal versus returns" center1="Live principal" center2={moneyShort(livePrincipal)} parts={[
                  { name: 'Live principal', value: livePrincipal, color: 'var(--chart-1)' },
                  { name: 'Returns received', value: sumB('paid'), color: 'var(--green)' },
                  { name: 'Returns not yet paid', value: inv.reduce((s, i) => s + unpaid(bal(p, i.id)), 0), color: 'var(--amber)' }
                ]} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Performance by investment</h3></div>
            <div className="tbl"><table>
              <thead><tr><th>Investment</th><th>Rate</th><th className="n">Principal</th><th className="n">Monthly return</th><th className="n">Months accrued</th><th className="n">Accrued</th><th className="n">Paid</th><th className="n">Not yet paid</th><th className="n">Projected</th><th className="n">Return on principal</th></tr></thead>
              <tbody>
                {inv.map(i => {
                  const b = bal(p, i.id);
                  return (
                    <tr key={i.id} className="click" onClick={() => nav('/portal/investments/' + i.code)}>
                      <td className="m">{i.code}</td><td>{rate(i.monthly_rate)}</td><td className="n">{money(i.principal)}</td><td className="n">{money(i.monthly_return)}</td>
                      <td className="n">{b.periods_accrued} / {i.lockin_months}</td><td className="n">{money(b.accrued)}</td><td className="n pos">{money(b.paid)}</td>
                      <td className="n">{money(unpaid(b))}</td><td className="n muted">{money(projectedRemaining(i, b))}</td>
                      <td className="n">{pct((Number(b.accrued) / Number(i.principal)) * 100)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>

          <DataTable rows={rows} rowKey={r => r.a.id} title="All accruals" searchPh="Search by investment or reference" sort={0} per={15}
            emptyTitle="No returns yet" empty="Your first monthly return accrues one month after your start date."
            filters={[['All', 'all'], ['Accrued', 'accrued'], ['Approved', 'approved'], ['Processing', 'processing'], ['Paid', 'paid']]}
            filterFn={(r, f) => f === 'all' || r.pay?.status === f}
            text={r => [r.pay?.payment_ref, r.pay?.code].filter(Boolean).join(' ')}
            cols={[
              { h: 'Accrual date', v: r => r.a.accrual_date, r: r => date(r.a.accrual_date) },
              { h: 'Investment', v: r => r.code, m: true },
              { h: 'Period', v: r => r.a.period_no, r: r => <>{r.a.kind === 'reversal' ? 'Reversal' : `Month ${r.a.period_no}`}<span className="sub">{dateShort(r.a.period_start)} – {dateShort(r.a.period_end)}</span></> },
              { h: 'Amount', n: true, v: r => Number(r.a.amount), r: r => <span className={Number(r.a.amount) < 0 ? 'neg' : ''}>{money(r.a.amount)}</span> },
              { h: 'Payout status', v: r => r.pay?.status || '', r: r => r.pay ? <PayBadge s={r.pay.status} /> : r.a.kind === 'reversal' ? <Badge cls="b-grey">Reversal</Badge> : <Badge cls="b-grey">—</Badge> },
              { h: 'Payment reference', v: r => r.pay?.payment_ref || '', r: r => r.pay?.status === 'paid' ? <span className="mono">{r.pay.payment_ref}<span className="sub">Paid {date(r.pay.paid_on)}</span></span> : r.pay ? <span className="sub">Due {date(r.pay.due_date)}</span> : '—' }
            ]} />

          {example && (
            <div className="note info"><b>How your return is calculated.</b> {example.code}: {money(example.principal)} × {pct(example.monthly_rate)} = {money(example.monthly_return)} per full month, for each of the {example.lockin_months} months of the lock-in. That is {money(Number(example.monthly_return) * example.lockin_months)} in total if the full principal stays invested and nothing changes. This illustration is not a guarantee of payment.</div>
          )}
        </>
      )}
    </>
  );
}
