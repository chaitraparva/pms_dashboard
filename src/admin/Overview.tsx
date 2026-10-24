import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rpc, must, fetchAll } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useAuth, useSettings } from '../lib/auth';
import { downloadCsv } from '../lib/csv';
import { money, moneyShort, date, today, addMonths, lockinText, rateShort, investmentLabel } from '../lib/format';
import type { Branch, Dashboard, Investment, Profile, LedgerEntry, Balance } from '../lib/types';
import { BranchCard, rateColor, withStandardRates } from './Branches';
import { Kpi, Empty, ErrorNote, Loading, PageHead, Badge, useAction } from '../ui/kit';
import { BarChart, Donut, CHART_COLORS, monthLabel } from '../ui/Charts';
import { Icon } from '../ui/Icon';
import { TopInvestors } from './Ranking';

type Lite = Pick<Profile, 'id' | 'full_name' | 'code'>;
interface ActionItem { tag: string; text: string; to: string; cls?: string }

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Last day of a YYYY-MM month. */
const monthEnd = (ym: string) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);

async function loadOverview(approachingDays: number, branch: string, from: string, to: string) {
  const t = today();
  const [dash, plansCount, branches, pend, kyc, maturing, ledger, recent] = await Promise.all([
    rpc<Dashboard>('admin_dashboard', { p_branch: branch || null, p_from: from + '-01', p_to: to >= t.slice(0, 7) ? t : monthEnd(to) }),
    api.from('plans').select('id', { count: 'exact', head: true }),
    api.from('branches').select('*').order('name'),
    api.from('investments').select('id,code,investor_id,principal,created_at').eq('status', 'pending_funding').order('created_at').limit(50),
    api.from('profiles').select('id,code,full_name,created_at').eq('role', 'investor').eq('kyc_status', 'pending').order('created_at').limit(50),
    api.from('investments').select('*').eq('status', 'active').gte('maturity_date', t).lte('maturity_date', addDays(t, approachingDays)).order('maturity_date').limit(5),
    api.from('ledger_entries').select('*').order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(6),
    api.from('profiles').select('*').eq('role', 'investor').order('created_at', { ascending: false }).limit(5)
  ]);
  if (plansCount.error) throw new Error(plansCount.error.message);
  const branchList = must(branches) as Branch[];
  const pendRows = must(pend) as { id: string; code: string; investor_id: string; principal: number }[];
  const kycRows = must(kyc) as { id: string; code: string | null; full_name: string }[];
  const matRows = must(maturing) as Investment[];
  const ledRows = must(ledger) as LedgerEntry[];
  const recentRows = must(recent) as Profile[];

  const pIds = [...new Set([...pendRows.map(r => r.investor_id), ...matRows.map(r => r.investor_id), ...ledRows.map(r => r.investor_id).filter((x): x is string => !!x)])];
  const iIds = [...new Set([...ledRows.map(r => r.investment_id).filter((x): x is string => !!x)])];
  const [people, invs] = await Promise.all([
    pIds.length ? api.from('profiles').select('id,full_name,code').in('id', pIds) : Promise.resolve({ data: [], error: null }),
    iIds.length ? api.from('investments').select('id,code').in('id', iIds) : Promise.resolve({ data: [], error: null })
  ]);
  const names: Record<string, Lite> = {};
  (must(people) as Lite[]).forEach(p => { names[p.id] = p; });
  const codes: Record<string, string> = {};
  (must(invs) as { id: string; code: string }[]).forEach(i => { codes[i.id] = i.code; });
  return { dash, planCount: plansCount.count || 0, branchList, pendRows, kycRows, matRows, ledRows, recentRows, names, codes };
}

export function Overview() {
  const { profile } = useAuth();
  const s = useSettings();
  const nav = useNavigate();
  const act = useAction();
  const [branch, setBranch] = useState('');
  const [from, setFrom] = useState(() => addMonths(today().slice(0, 7) + '-01', -7).slice(0, 7));
  const [to, setTo] = useState(() => today().slice(0, 7));
  const q = useQuery(() => loadOverview(s.approaching_days, branch, from, to), [s.approaching_days, branch, from, to]);

  const first = (profile?.full_name || '').trim().split(/\s+/)[0] || 'there';
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const exportCsv = () => act.run(async () => {
    const [rows, bal, people] = await Promise.all([
      fetchAll<Investment>((a, b) => api.from('investments').select('*').in('status', ['active', 'matured', 'redemption_requested', 'redemption_processing']).order('code').range(a, b)),
      fetchAll<Balance>((a, b) => api.from('investment_balances').select('*').range(a, b)),
      fetchAll<Lite>((a, b) => api.from('profiles').select('id,full_name,code').range(a, b))
    ]);
    const bm = new Map(bal.map(x => [x.investment_id, x]));
    const pm = new Map(people.map(x => [x.id, x]));
    downloadCsv(`live-investments-${today()}`,
      ['Investment', 'Investor ID', 'Investor', 'Plan', 'Version', 'Rate %/month', 'Principal', 'Monthly return', 'Lock-in months', 'Start', 'Maturity', 'Accrued', 'Paid', 'Outstanding', 'Status', 'Agreement ref'],
      rows.map(i => {
        const b = bm.get(i.id); const p = pm.get(i.investor_id);
        return [i.code, p?.code || '', p?.full_name || '', i.plan_name, i.plan_version, i.monthly_rate, i.principal, i.monthly_return, i.lockin_months, i.start_date, i.maturity_date,
          b?.accrued ?? 0, b?.paid ?? 0, b ? Number(b.unapproved) + Number(b.approved) + Number(b.processing) : 0, investmentLabel(i, s.approaching_days), i.agreement_ref];
      }));
    return rows.length;
  }, ['Export ready', 'Live investments downloaded as CSV']);

  const branchRow = q.data?.branchList.find(b => b.id === branch);
  const head = (
    <PageHead crumbs={['Overview']} title={`${greet}, ${first}`}
      sub={`${branchRow ? branchRow.name + ' branch' : 'All branches'} · portfolio as of ${date(q.data?.dash.today || today())} · all figures derived from ledger records`}
      actions={<>
        <select className="input" style={{ width: 'auto' }} value={branch} onChange={e => setBranch(e.target.value)} aria-label="Branch">
          <option value="">All branches</option>{(q.data?.branchList || []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button className="btn" onClick={exportCsv} disabled={act.busy}><Icon name="download" />Export CSV</button>
        <button className="btn accent" onClick={() => nav('/admin/investments?new=1')}><Icon name="plus" />Record investment</button>
      </>} />
  );

  if (q.error) return <>{head}<ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data) return <>{head}<Loading rows={6} /></>;
  const { dash: d, pendRows, kycRows, names } = q.data;

  /* ---------- first-run setup ---------- */
  const steps: { done: boolean; title: string; sub: string; to: string; cta: string }[] = [
    { done: !!s.company_name.trim(), title: 'Add company details', sub: 'Company name, logo, colours and support contacts shown to investors.', to: '/admin/settings', cta: 'Open settings' },
    { done: !!s.company_name.trim() && !!(s.default_terms.trim() || s.default_risk_disclosure.trim()), title: 'Confirm currency and default terms', sub: `Currency is ${s.currency}. Add the default terms and risk disclosure used on new plans.`, to: '/admin/settings?tab=terms', cta: 'Set terms' },
        { done: d.registered_investors > 0, title: 'Record the first investment', sub: 'Name, phone, individual or under an investor, ROI, bonus, lock-in, principal and start date. The investor gets their login.', to: '/admin/investments?new=1', cta: 'Record investment' }
  ];
  const showSetup = !s.company_name.trim() || d.registered_investors === 0;
  const doneCount = steps.filter(x => x.done).length;

  /* ---------- pending actions from real data ---------- */
  const pbs = d.payouts_by_status || {};
  const cnt = (k: string) => Number(pbs[k]?.count || 0);
  const amt = (k: string) => Number(pbs[k]?.amount || 0);
  const actions: ActionItem[] = [];
  if (cnt('failed')) actions.push({ tag: 'Payouts', cls: 'b-red', text: `${cnt('failed')} failed payout${cnt('failed') === 1 ? '' : 's'} need a retry · ${money(amt('failed'))}`, to: '/admin/payouts' });
  if (cnt('processing')) actions.push({ tag: 'Payouts', text: `${cnt('processing')} payout${cnt('processing') === 1 ? '' : 's'} waiting for payment confirmation · ${money(amt('processing'))}`, to: '/admin/payouts' });
  if (cnt('approved')) actions.push({ tag: 'Payouts', text: `${cnt('approved')} approved payout${cnt('approved') === 1 ? '' : 's'} waiting to be sent · ${money(amt('approved'))}`, to: '/admin/payouts' });
  if (cnt('accrued')) actions.push({ tag: 'Payouts', cls: 'b-grey', text: `${cnt('accrued')} accrued return${cnt('accrued') === 1 ? '' : 's'} awaiting approval · ${money(amt('accrued'))}`, to: '/admin/payouts' });
  if (d.unassigned_investors && !branch) actions.push({ tag: 'Branch', text: `${d.unassigned_investors} investor${d.unassigned_investors === 1 ? '' : 's'} without a branch · ${money(d.unassigned_principal)} principal`, to: '/admin/investors?branch=none' });
  pendRows.forEach(i => actions.push({ tag: 'Funding', text: `${i.code} awaiting deposit confirmation · ${names[i.investor_id]?.full_name || ''} · ${money(i.principal)}`, to: '/admin/investments/' + i.code }));
  kycRows.forEach(p => actions.push({ tag: 'KYC', text: `${p.full_name || p.code} awaiting verification`, to: '/admin/investors/' + p.code }));

  const months = d.monthly || [];
  const labels = months.map(m => monthLabel(m.month));
  const byPlan = (d.by_plan || []).map((p, i) => ({ name: p.plan, value: Number(p.principal), color: CHART_COLORS[i % CHART_COLORS.length] }));
  const rates = withStandardRates(d.by_rate || []).filter(r => Number(r.investors) > 0);
  const br = d.by_branch || [];
  const brLabels = br.map(b => b.name);
  const branchCode = branchRow ? '&branch=' + branchRow.code : '';
  const lock = d.by_lockin || [];
  const lockTotal = lock.reduce((x, l) => x + Number(l.count), 0);
  const fmtAxis = (v: number) => moneyShort(v).replace(/\.00(?=[A-Za-z]|$)/, '');

  return (
    <>
      {head}

      {showSetup && (
        <div className="card setup-card">
          <div className="card-h"><h3>Finish setting up your platform</h3><div className="r">{doneCount} of {steps.length} done</div></div>
          <div className="card-b">
            <div className="hbar" style={{ marginBottom: 10 }}><div style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
            <div className="list">
              {steps.map(st => (
                <div key={st.title}>
                  <span className={'badge ' + (st.done ? 'b-green' : 'b-grey')} style={{ minWidth: 74, justifyContent: 'center' }}>{st.done ? 'Done' : 'To do'}</span>
                  <div className="grow"><b>{st.title}</b><span>{st.sub}</span></div>
                  <Link className={'btn sm ' + (st.done ? '' : 'primary')} to={st.to}>{st.done ? 'Review' : st.cta}</Link>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <AdminBanner principal={Number(d.principal_invested)} investors={d.investors_with_investments} branches={(d.by_branch || []).map(b => b.name)} />

      <div className="grid g-1-1">
        <div className="card"><div className="card-h"><h3>Investors by branch</h3><div className="r hint">Click a branch to open it</div></div><div className="card-b">
          <Donut label="Investors in each branch" fmt={v => `${v} investor${v === 1 ? '' : 's'}`} center1="Investors" center2={String((d.by_branch || []).reduce((n, b) => n + Number(b.investors), 0))}
            onPart={ix => nav('/admin/branches/' + d.by_branch[ix].code)}
            parts={(d.by_branch || []).map((b, i) => ({ name: b.name, value: Number(b.investors), color: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'][i % 3], sub: moneyShort(Number(b.principal)) + ' invested' }))} />
        </div></div>
        <div className="card"><div className="card-h"><h3>Principal by branch</h3><div className="r hint">Click a branch to open it</div></div><div className="card-b">
          <Donut label="Principal invested in each branch" fmt={moneyShort} center1="Principal" center2={moneyShort(Number(d.principal_invested))}
            onPart={ix => nav('/admin/branches/' + d.by_branch[ix].code)}
            parts={(d.by_branch || []).map((b, i) => ({ name: b.name, value: Number(b.principal), color: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'][i % 3], sub: `${moneyShort(Number(b.unlocked))} unlocked` }))} />
        </div></div>
      </div>

      <div className="kpis">
        <Kpi label="Total investors" value={d.total_investors} sub={`+${d.new_investors_month} this month · ${d.investors_with_investments} invested`} subCls={d.new_investors_month ? 'up' : ''} onClick={() => nav('/admin/investors' + (branchRow ? '?branch=' + branchRow.code : ''))} tip="Investor accounts in this view, any status." />
        <Kpi label="Total principal invested" value={moneyShort(d.principal_invested)} sub={`${d.live_investments} live investments`} onClick={() => nav('/admin/investments' + (branchRow ? '?branch=' + branchRow.code : ''))} tip="Sum of principal on live investments. This is investor money, not company revenue." />
        <Kpi label="Unlocked principal" value={moneyShort(d.unlocked_principal)} cls={Number(d.unlocked_principal) ? 'pos' : ''} sub={`${d.unlocked_count} investment${d.unlocked_count === 1 ? '' : 's'} past lock-in`} onClick={() => nav('/admin/investments?f=unlocked' + branchCode)} tip="Principal of investments whose lock-in end date has passed. A status only: nothing is paid out or reinvested automatically." />
        <Kpi label="Locked principal" value={moneyShort(d.locked_principal)} sub={`${d.locked_count} in lock-in`} onClick={() => nav('/admin/investments?f=locked' + branchCode)} tip="Principal of live investments still inside their 6-month or 1-year lock-in." />
        <Kpi label="Total returns" value={moneyShort(d.accrued_total)} sub={Number(d.reversed_total) ? `Net of ${money(Math.abs(Number(d.reversed_total)))} reversals` : 'Accrued, net of reversals'} onClick={() => nav('/admin/accruals')} tip="Sum of all accrual entries less reversals. Accrued is not the same as paid." />
      </div>

      <div className="branch-cards">
        {br.map(b => <BranchCard key={b.id} b={b} />)}
        {!br.length && <div className="card"><div className="card-b"><Empty title="No branches">Add branches on the Branches page.</Empty></div></div>}
      </div>

      <div className="grid g-1-1-1">
        <div className="card"><div className="card-h"><h3>{brLabels.length > 1 ? brLabels.join(' vs ') : 'Branch comparison'}</h3>
          <div className="r legend"><span><i style={{ background: 'var(--chart-1)' }} />Principal</span><span><i style={{ background: 'var(--chart-3)' }} />Returns</span></div></div>
          <div className="card-b">
            {br.some(b => Number(b.principal) > 0 || Number(b.accrued) > 0)
              ? <BarChart labels={brLabels} w={420} h={220} label="Principal and returns by branch" fmt={fmtAxis} tipFmt={money} onBar={i => nav('/admin/branches/' + br[i].code)}
                  series={[{ name: 'Principal invested', color: 'var(--chart-1)', values: br.map(b => Number(b.principal)) }, { name: 'Returns accrued', color: 'var(--chart-3)', values: br.map(b => Number(b.accrued)) }]} />
              : <Empty title="No branch figures yet">Assign investors to a branch and confirm deposits to compare branches.</Empty>}
            <p className="hint" style={{ marginTop: 8 }}>Click a bar to open that branch.</p>
          </div>
        </div>
        <div className="card"><div className="card-h"><h3>Investors by monthly ROI</h3></div><div className="card-b">
          {rates.length
            ? <Donut parts={rates.map((r, i) => ({ name: `${rateShort(r.rate)} monthly`, value: Number(r.investors), color: rateColor(r.rate, i), sub: moneyShort(r.principal) }))}
                fmt={v => `${v} investor${v === 1 ? '' : 's'}`} center1="Investors" center2={String(d.investors_with_investments)} label="Investors across the ROI plans"
                onPart={ix => nav('/admin/investments?rate=' + rates[ix].rate + branchCode)} />
            : <Empty title="No live investments yet">'The split by ROI appears once investments are recorded.'</Empty>}
          <p className="hint" style={{ marginTop: 8 }}>Click a plan to see its investments. An investor with investments at two rates counts under both.</p>
        </div></div>
        <div className="card"><div className="card-h"><h3>Locked vs unlocked principal</h3>
          <div className="r legend"><span><i style={{ background: 'var(--violet)' }} />Locked</span><span><i style={{ background: 'var(--green)' }} />Unlocked</span></div></div>
          <div className="card-b">
            {br.some(b => Number(b.principal) > 0)
              ? <BarChart labels={brLabels} w={420} h={220} label="Locked and unlocked principal by branch" fmt={fmtAxis} tipFmt={money}
                  onBar={(i, j) => nav(`/admin/investments?branch=${br[i].code}&f=${j === 0 ? 'locked' : 'unlocked'}`)}
                  series={[{ name: 'Locked', color: 'var(--violet)', values: br.map(b => Number(b.locked)) }, { name: 'Unlocked', color: 'var(--green)', values: br.map(b => Number(b.unlocked)) }]} />
              : <Empty title="No live principal yet">Principal appears here once a deposit is confirmed for an investor with a branch.</Empty>}
            <p className="hint" style={{ marginTop: 8 }}>All branches: {moneyShort(d.locked_principal)} locked · {moneyShort(d.unlocked_principal)} unlocked{Number(d.unassigned_principal) && !branch ? ` (incl. ${moneyShort(d.unassigned_principal)} without a branch)` : ''}. Click a bar to list those investments.</p>
          </div>
        </div>
      </div>

      <TopInvestors />

      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>Monthly returns: accrued vs paid</h3>
            <div className="r" style={{ gap: 6 }}>
              <input className="input" type="month" style={{ width: 'auto', padding: '5px 8px' }} value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} aria-label="From month" />
              <span>to</span>
              <input className="input" type="month" style={{ width: 'auto', padding: '5px 8px' }} value={to} min={from} max={today().slice(0, 7)} onChange={e => e.target.value && setTo(e.target.value)} aria-label="To month" />
            </div>
            <div className="legend" style={{ width: '100%', justifyContent: 'flex-end' }}><span><i style={{ background: 'var(--chart-1)' }} />Accrued</span><span><i style={{ background: 'var(--green)' }} />Paid</span></div></div>
          <div className="card-b">
            <BarChart labels={labels} label="Accrued vs paid returns by month" fmt={fmtAxis} tipFmt={money}
              series={[{ name: 'Accrued', color: 'var(--chart-1)', values: months.map(m => Number(m.accrued)) }, { name: 'Paid', color: 'var(--green)', values: months.map(m => Number(m.paid)) }]} />
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Pending administrative actions</h3><div className="r">{actions.length} open</div></div>
          <div className="card-b list">
            {actions.length ? actions.slice(0, 8).map((x, i) => (
              <div key={i} style={{ cursor: 'pointer' }} onClick={() => nav(x.to)} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') nav(x.to); }}>
                <Badge cls={x.cls || 'b-amber'}>{x.tag}</Badge><div className="grow"><b>{x.text}</b></div><span className="muted">›</span>
              </div>
            )) : <Empty title="All clear">No actions waiting.</Empty>}
            {actions.length > 8 && <div><div className="grow"><span>{actions.length - 8} more · see Payouts, Investments and Investors</span></div></div>}
          </div>
        </div>
      </div>

      <div className="grid g-1-1-1">
        <div className="card"><div className="card-h"><h3>Monthly investment volume</h3></div><div className="card-b">
          <BarChart labels={labels} w={420} h={200} label="New principal by month" fmt={fmtAxis} tipFmt={money}
            series={[{ name: 'New principal', color: 'var(--chart-2)', values: months.map(m => Number(m.invested)) }]} />
        </div></div>
        <div className="card"><div className="card-h"><h3>Principal by plan</h3></div><div className="card-b">
          {byPlan.length && byPlan.some(p => p.value > 0)
            ? <Donut parts={byPlan} fmt={moneyShort} center1="Total" center2={moneyShort(d.principal_invested)} label="Principal by plan" />
            : <Empty title="No live principal yet">'Principal appears here once an investment is recorded.'</Empty>}
        </div></div>
        <div className="card"><div className="card-h"><h3>6-month and 1-year lock-ins</h3></div><div className="card-b" style={{ display: 'grid', gap: 14 }}>
          {lock.length ? lock.map(l => {
            const p = lockTotal ? (Number(l.count) / lockTotal) * 100 : 0;
            return (
              <div key={l.months}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, gap: 8 }}>
                  <span>{lockinText(l.months)} lock-in</span>
                  <b className="num" style={{ fontWeight: 500 }}>{l.count} investment{Number(l.count) === 1 ? '' : 's'} · {Math.round(p)}%</b>
                </div>
                <div className="hbar" title={money(l.principal)}><div style={{ width: `${p}%` }} /></div>
                <div className="hint" style={{ marginTop: 4 }}>{money(l.principal)} · {money(l.unlocked)} unlocked</div>
              </div>
            );
          }) : <Empty title="No live investments">The split by lock-in appears once investments are active.</Empty>}
          <p className="hint">Live investments only. Custom lock-in is {s.allow_custom_lockin ? 'enabled' : 'disabled'} in Settings.</p>
        </div></div>
      </div>

    </>
  );
}

/** Parva Realty banner at the top of the Super Admin Overview: a property photo with the portfolio at a glance. */
function AdminBanner({ principal, investors, branches }: { principal: number; investors: number; branches: string[] }) {
  const nav = useNavigate();
  const pq = useQuery(async () => must(await api.from('properties').select('title,image_url,status').eq('status', 'published').order('sort_order')) as { title: string; image_url: string | null }[], []);
  const photo = pq.data?.find(p => p.image_url)?.image_url;
  return (
    <div className="parva-banner admin-banner" style={photo ? { backgroundImage: `linear-gradient(90deg, rgba(11,24,52,.95) 0%, rgba(11,24,52,.75) 50%, rgba(11,24,52,.2) 100%), url("${photo}")` } : undefined}>
      <span className="pb-tag">PARVA REALTY · PORTFOLIO MANAGEMENT</span>
      <b>{moneyShort(principal)} invested by {investors} investor{investors === 1 ? '' : 's'}</b>
      <span className="pb-sub">{branches.length ? branches.join(' and ') + ' branches · ' : ''}{pq.data?.length || 0} Parva properties live for investors</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button type="button" className="btn pb-btn" onClick={() => nav('/admin/ranking')}>Investor ranking</button>
        <button type="button" className="btn pb-btn ghost-w" onClick={() => nav('/admin/branches')}>Manage branches</button>
        <button type="button" className="btn pb-btn ghost-w" onClick={() => nav('/admin/properties')}>Parva properties</button>
        <a className="btn pb-btn ghost-w" href="https://www.parvarealty.ae/" target="_blank" rel="noopener noreferrer">parvarealty.ae ›</a>
      </div>
    </div>
  );
}
