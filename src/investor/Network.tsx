import { Fragment, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { money, date, rateShort } from '../lib/format';
import { loadNetwork, type Network, type NetInvestment, type NetInvestor } from '../lib/networkApi';
import { Badge, Empty, ErrorNote, Kpi, Loading, PageHead } from '../ui/kit';

/* Investors who bring in investors.
   The introducer sees, below their own investments: the investors they brought in, those investors' investments
   and the bonus they earn from them. The investors they brought in never see any of this. */

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const r2 = (x: number) => Math.round(x * 100) / 100;

const INV_STATUS: Record<string, [string, string]> = {
  pending_funding: ['Awaiting deposit', 'b-amber'], active: ['Active', 'b-green'], matured: ['Matured', 'b-blue'],
  redemption_requested: ['Closing', 'b-grey'], redemption_processing: ['Closing', 'b-grey'], redeemed: ['Closed', 'b-grey']
};
const InvStatus = ({ s }: { s: string }) => { const [l, c] = INV_STATUS[s] || [s, 'b-grey']; return <Badge cls={c}>{l}</Badge>; };
const PersonStatus = ({ p }: { p: NetInvestor }) => p.account_status !== 'active' ? <Badge cls="b-red">Suspended</Badge>
  : p.kyc_status === 'verified' ? <Badge cls="b-green">Verified</Badge> : p.kyc_status === 'rejected' ? <Badge cls="b-red">Not verified</Badge> : <Badge cls="b-amber">Awaiting verification</Badge>;

const livePrincipal = (p: NetInvestor) => p.investments.filter(i => LIVE.includes(i.status)).reduce((s, i) => s + i.principal, 0);
const monthlyBonus = (invs: NetInvestment[]) => r2(invs.filter(i => i.status === 'active').reduce((s, i) => s + i.bonus_monthly, 0));
const earned = (invs: NetInvestment[]) => r2(invs.reduce((s, i) => s + i.bonus_earned, 0));
const earnedPaid = (invs: NetInvestment[]) => r2(invs.reduce((s, i) => s + i.bonus_paid, 0));

/** "My investors" section. On the Overview it sits below the investor's own investments; `page` renders it as its own page. */
export function MyNetwork({ page = false }: { page?: boolean }) {
  const { profile } = useAuth();
  const q = useQuery(loadNetwork, [profile?.id]);
  const [open, setOpen] = useState<string | null>(null);
  const [allBonus, setAllBonus] = useState(false);

  const head = page ? <PageHead crumbs={['My people']} title="People under you" sub="Their investments and the bonus you earn from them. Everything here is entered by the company." /> : null;
  if (q.error) return page ? <>{head}<ErrorNote msg={q.error} retry={q.reload} /></> : null;
  if (!q.data) return page ? <>{head}<Loading /></> : null;
  const d: Network = q.data;
  if (!d.can_introduce && !d.investors.length) {
    return page ? <>{head}<div className="card"><div className="card-b"><Empty title="Nobody under you yet">When the company records an investment for someone under you, they appear here with your bonus.</Empty></div></div></> : null;
  }

  const allInv = d.investors.flatMap(p => p.investments);
  const unpaid = r2(d.bonuses.filter(b => b.status === 'accrued').reduce((s, b) => s + b.amount, 0));
  const paid = r2(d.bonuses.filter(b => b.status === 'paid').reduce((s, b) => s + b.amount, 0));
  const bonusRows = allBonus ? d.bonuses : d.bonuses.slice(0, 8);

  return (
    <>
      {page ? <PageHead crumbs={['My people']} title="People under you" sub="Their investments and the bonus you earn from them. Everything here is entered by the company."  /> : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
          <div style={{ flex: 1, minWidth: 220 }}><h2 style={{ margin: 0, fontSize: 20 }}>People under you</h2>
            <p className="hint" style={{ marginTop: 4 }}>Their investments and the bonus you earn from them. Added by the company.</p></div>
        </div>
      )}

      <div className="kpis k4">
        <Kpi label="People under me" value={d.investors.length} sub={`${d.investors.filter(p => p.investments.some(i => LIVE.includes(i.status))).length} with live investments`} />
        <Kpi label="Their total investment" value={money(d.investors.reduce((s, p) => s + livePrincipal(p), 0))} sub={`${allInv.filter(i => LIVE.includes(i.status)).length} live investments`} />
        <Kpi label="My bonus per month" value={money(monthlyBonus(allInv))} sub="from active investments" />
        <Kpi label="Bonus received" cls="pos" value={money(paid)} sub={unpaid ? `${money(unpaid)} still to be paid` : 'nothing pending'} />
      </div>

      <div className="card">
        <div className="card-h"><h3>People under me</h3><div className="r">click a row to see their investments</div></div>
        {d.investors.length ? (
          <div className="tbl"><table>
            <thead><tr><th>Name</th><th>Status</th><th className="n">Investment</th><th className="n">My bonus / month</th><th className="n">Bonus earned</th><th /></tr></thead>
            <tbody>{d.investors.map(p => (
              <Fragment key={p.id}>
                <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <td><b>{p.name}</b><span className="sub">{p.code} · {p.phone || p.email}</span></td>
                  <td><PersonStatus p={p} /></td>
                  <td className="n">{money(livePrincipal(p))}<span className="sub">{p.investments.length} investment{p.investments.length === 1 ? '' : 's'}</span></td>
                  <td className="n">{money(monthlyBonus(p.investments))}</td>
                  <td className="n">{money(earned(p.investments))}<span className="sub">{money(earnedPaid(p.investments))} received</span></td>
                  <td className="n"><span className="muted">{open === p.id ? 'Hide ▴' : 'View ▾'}</span></td>
                </tr>
                {open === p.id && (
                  <tr><td colSpan={6} style={{ background: 'var(--surface-2, transparent)' }}>
                    {p.investments.length ? (
                      <div className="tbl"><table>
                        <thead><tr><th>Investment</th><th>Plan</th><th className="n">Amount</th><th>Their return / your bonus</th><th>Started</th><th className="n">My bonus / month</th><th className="n">Earned</th><th>Status</th></tr></thead>
                        <tbody>{p.investments.map(i => (
                          <tr key={i.id}>
                            <td className="mono">{i.code}</td>
                            <td>{i.plan_name}<span className="sub">{i.lockin_months ? i.lockin_months + ' months lock-in' : 'No lock-in'}</span></td>
                            <td className="n">{money(i.principal)}</td>
                            <td>{rateShort(i.investor_rate)} to them · <b>{rateShort(i.bonus_rate)} to you</b></td>
                            <td>{i.start_date ? date(i.start_date) : <span className="muted">Not started</span>}{i.maturity_date && <span className="sub">matures {date(i.maturity_date)}</span>}</td>
                            <td className="n">{money(i.bonus_monthly)}</td>
                            <td className="n">{money(i.bonus_earned)}</td>
                            <td><InvStatus s={i.status} /></td>
                          </tr>
                        ))}</tbody>
                      </table></div>
                    ) : <p className="hint" style={{ padding: 8 }}>No investments yet.</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}</tbody>
          </table></div>
        ) : <div className="card-b"><Empty title="Nobody under you yet">When the company records an investment for someone under you, they appear here with your bonus.</Empty></div>}
      </div>

      <div className="card">
        <div className="card-h"><h3>My bonus from the people under me</h3><div className="r">{d.bonuses.length > 8 && <a style={{ cursor: 'pointer' }} onClick={() => setAllBonus(!allBonus)}>{allBonus ? 'Show latest' : `Show all ${d.bonuses.length}`}</a>}</div></div>
        {d.bonuses.length ? (
          <div className="tbl"><table>
            <thead><tr><th>Month</th><th>From</th><th>Investment</th><th>Rate</th><th className="n">Amount</th><th>Status</th></tr></thead>
            <tbody>{bonusRows.map(b => (
              <tr key={b.id}>
                <td>{date(b.accrual_date)}<span className="sub">month {b.period_no}</span></td>
                <td>{b.investor_name}<span className="sub">{b.investor_code}</span></td>
                <td className="mono">{b.investment_code}</td>
                <td>{rateShort(b.rate)}</td>
                <td className="n">{money(b.amount)}</td>
                <td>{b.status === 'paid' ? <Badge cls="b-green">Received{b.paid_on ? ' ' + date(b.paid_on) : ''}</Badge> : <Badge cls="b-amber">To be paid</Badge>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="card-b"><Empty title="No bonus yet">Your bonus starts one month after a person’s investment starts.</Empty></div>}
      </div>

    </>
  );
}
