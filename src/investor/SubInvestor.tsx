import { useNavigate, useParams } from 'react-router-dom';
import { rpc } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { date, money, moneyShort, rateShort, today } from '../lib/format';
import { Badge, Empty, ErrorNote, KycBadge, Kpi, Loading, PageHead } from '../ui/kit';
import { BarChart, Donut, LineChart, monthLabel } from '../ui/Charts';
import { Icon } from '../ui/Icon';
import { BackLink } from './parts';
import { methodText, WdBadge } from './Withdraw';
import { ReqBadge } from './RequestInvestment';

/* One sub-investor, as their IB sees them. Only the IB the person is directly under can open this page;
   the server checks it. Bank and ID details are never shown here beyond the masked account. */

interface SubData {
  profile: { id: string; code: string; full_name: string; phone: string; email: string; city: string; kyc_status: string; account_status: string; created_at: string; has_login: boolean; bank_name: string; bank_account: string };
  investments: { id: string; code: string; plan_name: string; principal: number; original_principal: number; investor_rate: number; bonus_rate: number; monthly_return: number; bonus_monthly: number;
    status: string; start_date: string | null; maturity_date: string | null; lockin_months: number; created_at: string; accrued: number; paid: number; bonus_earned: number; bonus_paid: number }[];
  accruals: { date: string; amount: number }[];
  paid: { date: string | null; amount: number }[];
  bonuses: { date: string; amount: number; status: string }[];
  withdrawals: { id: string; code: string; amount: number; method: string; mt5_account: string | null; status: string; requested_on: string; completed_on: string | null; cancelled_reason: string | null }[];
  requests: { id: string; code: string; amount: number; status: string; created_at: string; investment_code: string | null; decision_note: string | null }[];
}

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const STATUS: Record<string, [string, string]> = {
  pending_funding: ['Awaiting deposit', 'b-amber'], active: ['Active', 'b-green'], matured: ['Matured', 'b-blue'],
  redemption_requested: ['Closing', 'b-grey'], redemption_processing: ['Closing', 'b-grey'], redeemed: ['Closed', 'b-grey']
};
const InvStatus = ({ s }: { s: string }) => { const [l, c] = STATUS[s] || [s, 'b-grey']; return <Badge cls={c}>{l}</Badge>; };
const r2 = (x: number) => Math.round(x * 100) / 100;

export function SubInvestor() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { profile } = useAuth();
  const q = useQuery(() => rpc<SubData>('my_sub_investor', { p_id: id }), [id, profile?.id]);

  if (q.error) return <><BackLink to="/portal/network">My sub-investors</BackLink><PageHead crumbs={['My sub-investors', 'Not found']} title="Sub-investor" /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <><BackLink to="/portal/network">My sub-investors</BackLink><PageHead crumbs={['My sub-investors']} title="Sub-investor" /><Loading /></>;
  const d = q.data, p = d.profile;
  const live = d.investments.filter(i => LIVE.includes(i.status));
  const principal = r2(live.reduce((s, i) => s + i.principal, 0));
  const accrued = r2(d.investments.reduce((s, i) => s + i.accrued, 0));
  const paid = r2(d.investments.reduce((s, i) => s + i.paid, 0));
  const bonusMonthly = r2(live.filter(i => i.status === 'active').reduce((s, i) => s + i.bonus_monthly, 0));
  const bonusEarned = r2(d.bonuses.reduce((s, b) => s + b.amount, 0));
  const bonusPaid = r2(d.bonuses.filter(b => b.status === 'paid').reduce((s, b) => s + b.amount, 0));

  // month by month since the first investment started (at most 24 months shown)
  const t = today();
  const starts = d.investments.map(i => i.start_date).filter((x): x is string => !!x).sort();
  const months: string[] = [];
  if (starts.length) for (let m = starts[0].slice(0, 7); m <= t.slice(0, 7);) { months.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }
  const shown = months.slice(-24);
  const upTo = (rows: { date: string | null; amount: number }[], m: string) => r2(rows.filter(x => x.date && x.date.slice(0, 7) <= m).reduce((s, x) => s + x.amount, 0));
  const inMonth = (rows: { date: string | null; amount: number }[], m: string) => r2(rows.filter(x => x.date && x.date.slice(0, 7) === m).reduce((s, x) => s + x.amount, 0));

  return (
    <>
      <BackLink to="/portal/network">My sub-investors</BackLink>
      <PageHead crumbs={['My sub-investors', p.full_name]} title={p.full_name}
        actions={<>
          <button className="btn" onClick={() => nav('/portal/withdraw?for=' + p.id)}><Icon name="payout" />Request withdrawal</button>
          <button className="btn accent" onClick={() => nav('/portal/request-investment?for=' + p.id)}><Icon name="plus" />Request investment</button>
        </>}>
        <h1>{p.full_name} <KycBadge k={p.kyc_status} />{p.account_status !== 'active' && <> <Badge cls="b-red">Suspended</Badge></>}</h1>
        <p>{[p.code, p.phone, p.city, 'sub-investor since ' + date(p.created_at), p.has_login ? 'has a login' : 'no login yet'].filter(Boolean).join(' · ')}</p>
      </PageHead>

      <div className="kpis">
        <Kpi label="Investment (live)" value={moneyShort(principal)} sub={`${live.length} live investment${live.length === 1 ? '' : 's'}`} />
        <Kpi label="Their returns" value={moneyShort(accrued)} sub={`${moneyShort(paid)} paid to them`} />
        <Kpi label="My bonus / month" value={money(bonusMonthly)} sub="from their active investments" />
        <Kpi label="My bonus earned" cls="pos" value={money(bonusEarned)} sub={`${money(bonusPaid)} received`} />
        <Kpi label="Bank account" value={p.bank_account || '—'} sub={p.bank_name || 'not registered'} />
      </div>

      {!d.investments.length ? (
        <div className="card"><div className="card-b"><Empty title="No investments yet">Request an investment for {p.full_name}. It shows here once the company approves it.</Empty></div></div>
      ) : (
        <>
          <div className="grid g-2-1">
            <div className="card">
              <div className="card-h"><h3>Returns and my bonus over time</h3></div>
              <div className="card-b">
                {shown.length ? (
                  <LineChart label="Their returns earned and paid, and my bonus, over time" labels={shown.map(monthLabel)} fmt={moneyShort} tipFmt={money} series={[
                    { name: 'Their returns earned', color: 'var(--chart-1)', values: shown.map(m => upTo(d.accruals, m)) },
                    { name: 'Paid to them', color: 'var(--green)', area: true, values: shown.map(m => upTo(d.paid, m)) },
                    { name: 'My bonus', color: 'var(--amber)', values: shown.map(m => upTo(d.bonuses, m)) }
                  ]} />
                ) : <Empty title="Nothing yet">The chart starts when an investment starts.</Empty>}
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Their money by investment</h3></div>
              <div className="card-b">
                <Donut label="Live principal by investment" fmt={moneyShort} center1="Live" center2={moneyShort(principal)}
                  parts={live.map((i, k) => ({ name: `${i.code} · ${rateShort(i.investor_rate)}`, value: i.principal, color: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--violet)'][k % 5] }))} />
              </div>
            </div>
          </div>
          {shown.length > 0 && (
            <div className="card">
              <div className="card-h"><h3>Month by month</h3><div className="r legend"><span><i style={{ background: 'var(--chart-1)' }} />Their return</span><span><i style={{ background: 'var(--amber)' }} />My bonus</span></div></div>
              <div className="card-b">
                <BarChart label="Their monthly return and my monthly bonus" labels={shown.slice(-12).map(monthLabel)} fmt={moneyShort} tipFmt={money} series={[
                  { name: 'Their return', color: 'var(--chart-1)', values: shown.slice(-12).map(m => inMonth(d.accruals, m)) },
                  { name: 'My bonus', color: 'var(--amber)', values: shown.slice(-12).map(m => inMonth(d.bonuses, m)) }
                ]} />
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-h"><h3>Investments</h3><div className="r">{d.investments.length} total</div></div>
            <div className="tbl"><table>
              <thead><tr><th>Investment</th><th>Plan</th><th className="n">Amount</th><th>Their ROI / my bonus</th><th>Started</th><th>Lock-in</th><th className="n">Returns</th><th className="n">My bonus</th><th>Status</th></tr></thead>
              <tbody>{d.investments.map(i => (
                <tr key={i.id}>
                  <td className="mono">{i.code}</td>
                  <td>{i.plan_name}</td>
                  <td className="n">{money(i.principal)}{i.original_principal !== i.principal && <span className="sub">of {money(i.original_principal)}</span>}</td>
                  <td>{rateShort(i.investor_rate)} · <b>{rateShort(i.bonus_rate)} to me</b><span className="sub">{money(i.monthly_return)} / {money(i.bonus_monthly)} a month</span></td>
                  <td>{i.start_date ? date(i.start_date) : <span className="muted">Not started</span>}</td>
                  <td>{i.lockin_months ? `${i.lockin_months} months` : 'No lock-in'}{i.maturity_date && <span className="sub">until {date(i.maturity_date)}</span>}</td>
                  <td className="n">{money(i.accrued)}<span className="sub">{money(i.paid)} paid</span></td>
                  <td className="n">{money(i.bonus_earned)}<span className="sub">{money(i.bonus_paid)} received</span></td>
                  <td><InvStatus s={i.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        </>
      )}

      <div className="grid g-1-1">
        <div className="card">
          <div className="card-h"><h3>Withdrawals</h3></div>
          {d.withdrawals.length ? <div className="tbl"><table>
            <thead><tr><th>Request</th><th>Applied</th><th className="n">Amount</th><th>Where</th><th>Status</th></tr></thead>
            <tbody>{d.withdrawals.map(w => <tr key={w.id}><td className="mono">{w.code}</td><td>{date(w.requested_on)}</td><td className="n">{money(w.amount)}</td>
              <td>{methodText(w.method)}{w.mt5_account && <span className="sub mono">{w.mt5_account}</span>}</td>
              <td><WdBadge s={w.status} />{w.status === 'completed' && <span className="sub">{date(w.completed_on)}</span>}{w.cancelled_reason && <span className="sub">{w.cancelled_reason}</span>}</td></tr>)}</tbody>
          </table></div> : <div className="card-b"><Empty title="No withdrawals" /></div>}
        </div>
        <div className="card">
          <div className="card-h"><h3>Investment requests</h3></div>
          {d.requests.length ? <div className="tbl"><table>
            <thead><tr><th>Request</th><th>Sent</th><th className="n">Amount</th><th>Status</th></tr></thead>
            <tbody>{d.requests.map(r => <tr key={r.id}><td className="mono">{r.code}</td><td>{date(r.created_at)}</td><td className="n">{money(r.amount)}</td>
              <td><ReqBadge s={r.status} />{r.investment_code && <span className="sub mono">{r.investment_code}</span>}{r.decision_note && r.status !== 'approved' && <span className="sub">{r.decision_note}</span>}</td></tr>)}</tbody>
          </table></div> : <div className="card-b"><Empty title="No requests" /></div>}
        </div>
      </div>
    </>
  );
}
