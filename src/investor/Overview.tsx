import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, must, rpc } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { date, dateShort, isUnlocked, lockinText, money, moneyShort, rate, today } from '../lib/format';
import { Empty, ErrorNote, Kpi, Loading, PageHead } from '../ui/kit';
import { BarChart, Donut, LineChart, monthLabel } from '../ui/Charts';
import { Icon } from '../ui/Icon';
import type { Announcement, Investment } from '../lib/types';
import { bal, isLive, lastMonths, loadPortfolio, nextAccrual, type Portfolio } from './data';
import { Tracker } from './parts';
import { loadMyBrochures } from './Brochures';
import { loadProperties, ParvaBanner, PropertyGrid } from './Properties';
import { MyNetwork } from './Network';

export function Overview() {
  const { profile, settings } = useAuth();
  const nav = useNavigate();
  const id = profile!.id;
  const q = useQuery(async () => {
    const [p, ann, bros, props, myRank] = await Promise.all([
      loadPortfolio(id),
      api.from('announcements').select('id,code,title,category,published_at').eq('status', 'published').order('published_at', { ascending: false }).limit(4),
      loadMyBrochures(),
      loadProperties(),
      rpc<MyRank | null>('my_rank').catch(() => null)
    ]);
    return { p, myRank, anns: must(ann) as Pick<Announcement, 'id' | 'code' | 'title' | 'category' | 'published_at'>[], bros, props };
  }, [id]);

  const first = (profile!.full_name || '').trim().split(/\s+/)[0] || 'there';
  const t = today();

  if (q.loading && !q.data) return <><PageHead crumbs={['Overview']} title={`Welcome back, ${first}`} /><Loading /></>;
  if (q.error || !q.data) return <><PageHead crumbs={['Overview']} title={`Welcome back, ${first}`} /><ErrorNote msg={q.error || 'Could not load your portfolio.'} retry={q.reload} /></>;

  const { p, myRank, anns, bros, props } = q.data;
  const inv = p.investments;
  const live = inv.filter(isLive);
  const principal = live.reduce((s, i) => s + Number(i.principal), 0);
  const unlockedInv = live.filter(i => isUnlocked(i, t));
  const unlocked = unlockedInv.reduce((s, i) => s + Number(i.principal), 0);
  const locked = principal - unlocked;
  const totalReturns = inv.reduce((s, i) => s + Number(bal(p, i.id).accrued), 0);
  const paid = inv.reduce((s, i) => s + Number(bal(p, i.id).paid), 0);
  const siteUrl = settings?.property_site_url || 'https://parvarealty.ae/';
  const showProps = unlocked > 0 || settings?.show_properties_to !== 'unlocked';
  // published brochures and announcements together, newest first
  const updates = [
    ...bros.map(b => ({ key: 'b' + b.id, title: b.title, tag: 'Brochure', when: b.publish_on, unread: !b.acknowledged, go: () => nav('/portal?brochure=' + b.id) })),
    ...anns.map(a => ({ key: 'a' + a.id, title: a.title, tag: a.category, when: a.published_at || '', unread: false, go: () => nav('/portal/announcements?open=' + a.id) }))
  ].sort((a, b) => b.when.localeCompare(a.when)).slice(0, 5);
  const byRate = [...live.reduce((m, i) => m.set(Number(i.monthly_rate), (m.get(Number(i.monthly_rate)) || 0) + Number(i.principal)), new Map<number, number>())].sort((a, b) => a[0] - b[0]);
  const nextMat = live.filter(i => i.lockin_end_date && i.lockin_end_date > t).sort((a, b) => a.lockin_end_date!.localeCompare(b.lockin_end_date!))[0];

  // Monthly returns by accrual month, split by payout status (last 7 months).
  const months = lastMonths(7);
  const payByAcc = Object.fromEntries(p.payouts.map(x => [x.accrual_id, x.status]));
  const sumBy = (st: string[]) => months.map(m => p.accruals.filter(a => a.kind !== 'reversal' && a.accrual_date.slice(0, 7) === m && st.includes(payByAcc[a.id] || '')).reduce((s, a) => s + Number(a.amount), 0));

  return (
    <>
      <PageHead crumbs={['Overview']} title={`Welcome back, ${first}`} sub={`Figures as of ${date(t)}. Returns are simple interest on your original principal.`}
        actions={<button className="btn" onClick={() => nav('/portal/statement')}><Icon name="download" />Account statement</button>} />

      {!inv.length ? (
        <>
          <div className="card"><div className="card-b">
            <Empty title="No investment of your own">Your own investments appear here when the company records them. The people under you are below.</Empty>
          </div></div>
          <MyNetwork />
        </>
      ) : (
        <>
          <ParvaBanner items={props} siteUrl={siteUrl} unlocked={unlocked} />

          <div className="card">
            <div className="card-h"><h3>How much you have invested</h3>
              <div className="r legend"><span><i style={{ background: 'var(--chart-1)' }} />Invested</span><span><i style={{ background: 'var(--green)' }} />ROI released</span></div></div>
            <div className="card-b">
              <BarChart label="Principal invested and ROI released for each investment" labels={live.map(i => `${i.code} · ${rate(i.monthly_rate).replace(' / month', '')}`)} fmt={moneyShort} tipFmt={money}
                onBar={ix => nav('/portal/investments/' + live[ix].code)}
                series={[{ name: 'Invested', color: 'var(--chart-1)', values: live.map(i => Number(i.principal)) }, { name: 'ROI released', color: 'var(--green)', values: live.map(i => Number(bal(p, i.id).paid)) }]} />
            </div>
          </div>

          <div className="kpis k4">
            <Kpi label="Total principal invested" value={moneyShort(principal)} sub={`${live.length} live investment${live.length === 1 ? '' : 's'} · view details`} onClick={() => nav('/portal/investments')}
              tip="The amount you invested in investments that are live today. It does not include returns." />
            <Kpi label="Unlocked principal" value={moneyShort(unlocked)} cls={unlocked ? 'pos' : ''} sub={`${unlockedInv.length} investment${unlockedInv.length === 1 ? '' : 's'} past lock-in`} onClick={() => nav('/portal/investments?view=unlocked')}
              tip="Principal of investments whose lock-in period has ended. It is a status only: it is not a return and is not paid out or reinvested automatically." />
            <Kpi label="Locked principal" value={moneyShort(locked)} sub={nextMat ? `Next unlocks ${date(nextMat.lockin_end_date)}` : 'Nothing in lock-in'} onClick={() => nav('/portal/investments?view=locked')}
              tip="Principal of investments still inside their 6-month or 1-year lock-in." />
            <Kpi label="Total returns" value={moneyShort(totalReturns)} sub={`${moneyShort(paid)} received`} onClick={() => nav('/portal/returns')}
              tip="All monthly returns earned so far (accrued), whether paid or not. Open to see every month." />
          </div>

          <RoiReleased p={p} inv={inv} principal={principal} rank={myRank} />

          <div className="grid g-1-1-1">
            <div className="card">
              <div className="card-h"><h3>Locked vs unlocked</h3></div>
              <div className="card-b">
                <Donut label="Principal locked and unlocked" fmt={moneyShort} center1="Principal" center2={moneyShort(principal)}
                  onPart={ix => nav('/portal/investments?view=' + (ix ? 'unlocked' : 'locked'))}
                  parts={[{ name: 'Locked', value: locked, color: 'var(--violet)', sub: nextMat ? 'Next unlocks ' + dateShort(nextMat.lockin_end_date!) : undefined }, { name: 'Unlocked', value: unlocked, color: 'var(--green)' }]} />
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>My money by plan</h3></div>
              <div className="card-b">
                <Donut label="Principal by plan rate" fmt={moneyShort} center1="Plans" center2={String(byRate.length)} onPart={() => nav('/portal/investments')}
                  parts={byRate.map(([r, v], k) => ({ name: rate(r), value: v, color: PLAN_COLORS[k % PLAN_COLORS.length] }))} />
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Returns paid vs pending</h3></div>
              <div className="card-b">
                <Donut label="Returns paid and still pending" fmt={moneyShort} center1="Earned" center2={moneyShort(totalReturns)} onPart={() => nav('/portal/returns')}
                  parts={[{ name: 'Paid to you', value: paid, color: 'var(--green)' }, { name: 'Pending', value: Math.max(0, totalReturns - paid), color: 'var(--amber)' }]} />
              </div>
            </div>
          </div>

          {unlocked > 0 && (
            <div className="card explore">
              <div className="card-h"><h3>Unlocked for you: Parva Realty properties</h3><div className="r"><Link to="/portal/properties">View all</Link></div></div>
              <div className="card-b" style={{ display: 'grid', gap: 14 }}>
                <p className="hint">Your lock-in has ended on {money(unlocked)} of principal. If you are interested in property, here is what Parva Realty currently lists. Viewing a property does not move or reinvest your principal.</p>
                <PropertyGrid items={props} siteUrl={siteUrl} limit={3} />
              </div>
            </div>
          )}

          <div className="inv-cards">
            {inv.filter(i => i.status !== 'cancelled').map(i => {
              const b = bal(p, i.id);
              const n = nextAccrual(i, b);
              return (
                <div key={i.id} className="card" style={{ cursor: 'pointer' }} onClick={() => nav('/portal/investments/' + i.code)}>
                  <div className="card-b" style={{ display: 'grid', gap: 14 }}>
                    <div>
                      <div className="num" style={{ fontSize: 24, fontWeight: 700 }}>{money(i.principal)}</div>
                      <div className="hint">{rate(i.monthly_rate)} · {lockinText(i.lockin_months)} lock-in</div>
                    </div>
                    <Tracker i={i} compact />
                    <div className="mini-roi" title={`${money(b.paid)} received of ${money(b.accrued)} earned`}>
                      <div className="mini-bar"><i style={{ width: (Number(b.accrued) ? Math.min(100, (Number(b.paid) / Number(b.accrued)) * 100) : 0) + '%' }} /></div>
                      <span><b className="pos">{moneyShort(b.paid)}</b> received · {money(i.monthly_return)}/month{n ? ' · next ' + dateShort(n.date) : ''}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* investors this investor brought in (only shown when the company allowed them to add investors) */}
          <MyNetwork />

          <div className="grid g-2-1">
            <div className="card">
              <div className="card-h"><h3>Monthly returns</h3>
                <div className="r legend"><span><i style={{ background: 'var(--green)' }} />Paid</span><span><i style={{ background: 'var(--amber)' }} />Processing / approved</span><span><i style={{ background: 'var(--chart-4)' }} />Accrued</span></div>
              </div>
              <div className="card-b">
                {p.accruals.length ? (
                  <BarChart labels={months.map(monthLabel)} label="My monthly returns by accrual month" fmt={moneyShort} tipFmt={money} series={[
                    { name: 'Paid', color: 'var(--green)', values: sumBy(['paid']) },
                    { name: 'Processing / approved', color: 'var(--amber)', values: sumBy(['processing', 'approved']) },
                    { name: 'Accrued', color: 'var(--chart-4)', values: sumBy(['accrued', 'failed']) }
                  ]} />
                ) : <Empty title="No returns yet">Your first monthly return accrues one month after your start date.</Empty>}
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Latest announcements</h3><div className="r"><Link to="/portal/announcements">All</Link></div></div>
              <div className="card-b list">
                {updates.map(u => (
                  <div key={u.key} style={{ cursor: 'pointer' }} onClick={u.go} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') u.go(); }}>
                    <Icon name={u.tag === 'Brochure' ? 'brochure' : 'announce'} />
                    <div className="grow"><b>{u.title}</b><span>{u.tag} · {dateShort(u.when)}</span></div>
                    {u.unread && <span className="dot unread" aria-label="New" />}
                  </div>
                ))}
                {!updates.length && <Empty title="No announcements yet">Brochures and notices from the company will appear here.</Empty>}
              </div>
            </div>
          </div>

          {unlocked === 0 && showProps && (
            <div className="card">
              <div className="card-h"><h3>Explore Properties with Parva Realty</h3><div className="r"><Link to="/portal/properties">View all</Link></div></div>
              <div className="card-b" style={{ display: 'grid', gap: 14 }}>{nextMat && <p className="hint"><Icon name="lock" /> Your first principal unlocks on {date(nextMat.lockin_end_date)}. Until then you can still browse what Parva Realty lists.</p>}<PropertyGrid items={props} siteUrl={siteUrl} limit={3} /></div>
            </div>
          )}
          <p className="hint">Rates are contractual monthly rates under your agreement. Scheduled values are estimates and are not guaranteed.</p>
        </>
      )}
    </>
  );
}

const PLAN_COLORS = ['var(--chart-3)', 'var(--chart-2)', 'var(--chart-1)', 'var(--violet)'];

interface MyRank { rank: number; total: number; multiple: number; branch: string | null; branch_rank: number; branch_total: number }

type Range = '6m' | '1y' | 'all';

/** How much return has been released against what was invested, month by month. */
export function RoiReleased({ p, inv, principal, rank }: { p: Portfolio; inv: Investment[]; principal: number; rank?: MyRank | null }) {
  const [range, setRange] = useState<Range>('all');
  const t = today();
  const starts = inv.map(i => i.start_date).filter((x): x is string => !!x).sort();
  if (!starts.length) return null;
  const all: string[] = [];
  for (let m = starts[0].slice(0, 7); m <= t.slice(0, 7); ) { all.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }
  const months = range === 'all' ? all : all.slice(-(range === '6m' ? 6 : 12));
  const paidRows = p.payouts.filter(x => x.status === 'paid' && x.paid_on);
  const upTo = (m: string) => ({
    paid: paidRows.filter(x => x.paid_on!.slice(0, 7) <= m).reduce((s, x) => s + Number(x.amount), 0),
    earned: p.accruals.filter(a => a.accrual_date.slice(0, 7) <= m).reduce((s, a) => s + Number(a.amount), 0),
    invested: inv.filter(i => isLive(i) && i.start_date && i.start_date.slice(0, 7) <= m).reduce((s, i) => s + Number(i.principal), 0)
  });
  const pts = months.map(upTo);
  const released = paidRows.reduce((s, x) => s + Number(x.amount), 0);
  const earned = p.accruals.reduce((s, a) => s + Number(a.amount), 0);
  const times = principal ? released / principal : 0;
  const pct = principal ? Math.min(100, (released / principal) * 100) : 0;
  return (
    <div className="card roi-card">
      <div className="card-h"><h3>Your ROI released</h3>
        {rank && <span className="rank-pill" title="Your position among all investors, by ROI released compared with principal"><Icon name="rank" />Rank {rank.rank} of {rank.total} · {rank.multiple >= 1 ? rank.multiple.toFixed(1) + '×' : Math.round(rank.multiple * 100) + '%'}{rank.branch ? ` · #${rank.branch_rank} of ${rank.branch_total} in ${rank.branch}` : ''}</span>}
        <div className="r chips" role="group" aria-label="Time range">
          {(['6m', '1y', 'all'] as Range[]).map(r => <button key={r} type="button" className={'chip ' + (range === r ? 'on' : '')} onClick={() => setRange(r)}>{r === '6m' ? '6 months' : r === '1y' ? '1 year' : 'Since you started'}</button>)}
        </div>
      </div>
      <div className="card-b roi-body">
        <div className="roi-hero">
          <div className="roi-big num">{money(released)}</div>
          <div className="hint">released to you on {money(principal)} invested since {date(starts[0])}</div>
          <div className="roi-x"><b className="num">{times >= 1 ? times.toFixed(1) + '×' : Math.round(times * 100) + '%'}</b><span>{times >= 1 ? 'of your principal has come back as returns' : 'of your principal has come back as returns so far'}</span></div>
          <div className="roi-bar" aria-hidden="true"><i style={{ width: pct + '%' }} /></div>
          <div className="roi-legend">
            <span><i style={{ background: 'var(--green)' }} />Released {money(released)}</span>
            <span><i style={{ background: 'var(--chart-1)' }} />Earned {money(earned)}</span>
            <span><i className="dash" />Invested {money(principal)}</span>
          </div>
        </div>
        <LineChart label="Returns released over time compared with principal invested" labels={months.map(monthLabel)} fmt={moneyShort} tipFmt={money} series={[
          { name: 'Invested', color: 'var(--fg-3)', dashed: true, values: pts.map(x => x.invested) },
          { name: 'Earned', color: 'var(--chart-1)', values: pts.map(x => x.earned) },
          { name: 'Released', color: 'var(--green)', area: true, values: pts.map(x => x.paid) }
        ]} />
      </div>
    </div>
  );
}
