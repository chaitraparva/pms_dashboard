// Branch-wise view of the one Super Admin dashboard: Bangalore and Tumkur (and any
// branch added later). Every figure comes from the database; branch totals are sums
// of the investor records shown on each branch page.
import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, rpc, must, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useSettings } from '../lib/auth';
import { downloadCsv } from '../lib/csv';
import { date, isUnlocked, lockinText, money, moneyShort, rateShort, today } from '../lib/format';
import type { Balance, Branch, BranchStats, Dashboard, Investment, Profile, RateSplit } from '../lib/types';
import { DataTable, Col } from '../ui/DataTable';
import { Badge, Empty, ErrorNote, Field, InvBadge, Kpi, Loading, Modal, PageHead, useAction } from '../ui/kit';
import { Donut, CHART_COLORS } from '../ui/Charts';
import { Icon } from '../ui/Icon';

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
export const RATE_COLORS: Record<string, string> = { '2': 'var(--chart-3)', '3.3': 'var(--chart-2)', '4': '#0EA5A4', '5': '#6366F1', '6': 'var(--chart-1)' };
export const rateColor = (r: number | string, i: number) => RATE_COLORS[String(Number(r))] || CHART_COLORS[(i + 3) % CHART_COLORS.length];

/** The monthly ROI rates in use, lowest first (any rate can be typed per investment). */
export function withStandardRates(list: RateSplit[]): RateSplit[] {
  return [...list].sort((x, y) => Number(x.rate) - Number(y.rate));
}

export function RateRows({ rates, by = 'investors' }: { rates: RateSplit[]; by?: 'investors' | 'principal' }) {
  const rows = withStandardRates(rates);
  const max = Math.max(1, ...rows.map(r => Number(r[by])));
  return (
    <div className="rate-rows">
      {rows.map((r, i) => (
        <div key={r.rate}>
          <b>{rateShort(r.rate)}</b>
          <div className="hbar" title={money(r.principal)}><div style={{ width: `${(Number(r[by]) / max) * 100}%`, background: rateColor(r.rate, i) }} /></div>
          <span className="num">{r.investors} investor{Number(r.investors) === 1 ? '' : 's'} · {moneyShort(r.principal)}</span>
        </div>
      ))}
    </div>
  );
}

export function SplitBar({ locked, unlocked }: { locked: number; unlocked: number }) {
  const t = locked + unlocked;
  return (
    <div>
      <div className="split-bar" role="img" aria-label={`Locked ${money(locked)}, unlocked ${money(unlocked)}`}>
        {t > 0 && <><i style={{ width: `${(locked / t) * 100}%`, background: 'var(--violet)' }} /><i style={{ width: `${(unlocked / t) * 100}%`, background: 'var(--green)' }} /></>}
      </div>
      <div className="legend" style={{ marginTop: 6, fontSize: 12 }}>
        <span><i style={{ background: 'var(--violet)' }} />Locked {t ? Math.round((locked / t) * 100) : 0}%</span>
        <span><i style={{ background: 'var(--green)' }} />Unlocked {t ? Math.round((unlocked / t) * 100) : 0}%</span>
      </div>
    </div>
  );
}

/** One clickable branch section on the Overview. */
export function BranchCard({ b }: { b: BranchStats }) {
  const nav = useNavigate();
  const go = () => nav('/admin/branches/' + b.code);
  return (
    <div className="card branch-card" onClick={go} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') go(); }} aria-label={`${b.name} branch details`}>
      <div className="card-h"><h3>{b.name} Branch</h3><div className="r">View investors ›</div></div>
      <div className="card-b" style={{ display: 'grid', gap: 16 }}>
        <div className="bk">
          <div><span>Investors</span><b>{b.investors}</b></div>
          <div><span>Total principal invested</span><b>{moneyShort(b.principal)}</b></div>
          <div><span>Locked principal</span><b>{moneyShort(b.locked)}</b></div>
          <div><span>Unlocked principal</span><b className={Number(b.unlocked) ? 'pos' : ''}>{moneyShort(b.unlocked)}</b></div>
          <div><span>Total returns accrued</span><b>{moneyShort(b.accrued)}</b></div>
          <div><span>Returns paid</span><b>{moneyShort(b.paid)}</b></div>
        </div>
        <SplitBar locked={Number(b.locked)} unlocked={Number(b.unlocked)} />
        <div><div className="hint" style={{ marginBottom: 8 }}>ROI plan distribution (investors)</div><RateRows rates={b.by_rate || []} /></div>
      </div>
    </div>
  );
}

/* =============================== LIST / MANAGE =============================== */
export function Branches() {
  const q = useQuery(async () => {
    const [d, list] = await Promise.all([rpc<Dashboard>('admin_dashboard'), api.from('branches').select('*').order('name').then(r => must(r) as Branch[])]);
    return { d, list };
  }, []);
  const [edit, setEdit] = useState<Branch | 'new' | null>(null);
  return (
    <>
      <PageHead crumbs={['Branches']} title="Branches" sub="Branch-wise view of the same Super Admin dashboard. Investors are assigned to a branch on their profile or in bulk from Investors."
        actions={<button className="btn" onClick={() => setEdit('new')}><Icon name="plus" />Add branch</button>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="branch-cards">{q.data.d.by_branch.map(b => <BranchCard key={b.id} b={b} />)}</div>
          {q.data.d.unassigned_investors > 0 && (
            <div className="note">{q.data.d.unassigned_investors} investor{q.data.d.unassigned_investors === 1 ? ' has' : 's have'} no branch yet ({money(q.data.d.unassigned_principal)} principal), so {q.data.d.unassigned_investors === 1 ? 'it is' : 'they are'} not counted in either branch. <Link to="/admin/investors?branch=none">Assign branches</Link></div>
          )}
          <div className="card">
            <div className="card-h"><h3>Manage branches</h3></div>
            <div className="tbl"><table>
              <thead><tr><th>Code</th><th>Name</th><th>City</th><th>Status</th><th /></tr></thead>
              <tbody>{q.data.list.map(b => (
                <tr key={b.id}><td className="m">{b.code}</td><td><Link to={'/admin/branches/' + b.code}>{b.name}</Link></td><td>{b.city || '—'}</td>
                  <td>{b.status === 'active' ? <Badge cls="b-green">Active</Badge> : <Badge cls="b-grey">Inactive</Badge>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setEdit(b)}>Edit</button></td></tr>
              ))}</tbody>
            </table></div>
          </div>
        </>
      )}
      {edit && <BranchForm b={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function BranchForm({ b, onClose }: { b: Branch | null; onClose: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ code: b?.code || '', name: b?.name || '', city: b?.city || '', status: b?.status || 'active' });
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const err = !f.name.trim() ? 'Enter the branch name.' : !/^[A-Za-z0-9]{2,8}$/.test(f.code.trim()) ? 'Use a short code of 2 to 8 letters or digits, e.g. TMK.' : null;
  const go = async () => {
    setTried(true); if (err) return;
    const r = await act.run(() => rpc('admin_save_branch', { p_id: b?.id || null, p_code: f.code.trim(), p_name: f.name.trim(), p_city: f.city.trim(), p_status: f.status, p_reason: reason.trim() || (b ? 'Branch updated' : 'Branch added') }),
      [b ? 'Branch saved' : 'Branch added', f.name]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={b ? 'Edit ' + b.name : 'Add branch'} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Save</button></>}>
      <div className="f-row">
        <Field label="Name *" err={tried && !f.name.trim() ? 'Enter the branch name.' : null}><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Code *" err={tried && err && f.name.trim() ? err : null}><input className="input mono" value={f.code} onChange={e => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="TMK" /></Field>
      </div>
      <div className="f-row">
        <Field label="City"><input className="input" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} /></Field>
        <Field label="Status"><select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value as Branch['status'] })}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
      </div>
      {b && <Field label="Reason (saved to audit log)"><input className="input" value={reason} onChange={e => setReason(e.target.value)} /></Field>}
    </Modal>
  );
}

/* =============================== BRANCH DETAIL =============================== */
interface InvRow { p: Profile; invs: Investment[]; principal: number; unlocked: number; locked: number; accrued: number; paid: number; rates: number[]; lockins: number[]; first: string | null; nextUnlock: string | null; lastMaturity: string | null }
interface Line extends Investment { who: Profile; bal: Balance | undefined }

async function loadBranch(code: string) {
  const branch = must(await api.from('branches').select('*').eq('code', code).maybeSingle()) as Branch | null;
  if (!branch || !branch.id) return null;
  const people = await fetchAll<Profile>((a, b) => api.from('profiles').select('*').eq('role', 'investor').eq('branch_id', branch.id).order('full_name').range(a, b));
  const ids = people.map(p => p.id);
  const invs: Investment[] = [];
  for (let i = 0; i < ids.length; i += 150) invs.push(...await fetchAll<Investment>((a, b) => api.from('investments').select('*').in('investor_id', ids.slice(i, i + 150)).order('created_at').range(a, b)));
  const bal: Balance[] = [];
  const invIds = invs.map(i => i.id);
  for (let i = 0; i < invIds.length; i += 150) bal.push(...must(await api.from('investment_balances').select('*').in('investment_id', invIds.slice(i, i + 150))) as Balance[]);
  const dash = await rpc<Dashboard>('admin_dashboard', { p_branch: branch.id });
  return { branch, people, invs, bal: new Map(bal.map(b => [b.investment_id, b])), dash };
}

export function BranchDetail() {
  const { code = '' } = useParams();
  const s = useSettings();
  const nav = useNavigate();
  const [tab, setTab] = useState<'investors' | 'investments'>('investors');
  const q = useQuery(() => loadBranch(code), [code]);
  const t = today();

  const data = useMemo(() => {
    if (!q.data) return null;
    const { people, invs, bal } = q.data;
    const rows: InvRow[] = people.map(p => {
      const mine = invs.filter(i => i.investor_id === p.id);
      const live = mine.filter(i => LIVE.includes(i.status));
      const unlocked = live.filter(i => isUnlocked(i, t)).reduce((x, i) => x + Number(i.principal), 0);
      const principal = live.reduce((x, i) => x + Number(i.principal), 0);
      return {
        p, invs: mine, principal, unlocked, locked: principal - unlocked,
        accrued: mine.reduce((x, i) => x + Number(bal.get(i.id)?.accrued || 0), 0),
        paid: mine.reduce((x, i) => x + Number(bal.get(i.id)?.paid || 0), 0),
        rates: [...new Set(live.map(i => Number(i.monthly_rate)))].sort((a, b) => a - b),
        lockins: [...new Set(live.map(i => i.lockin_months))].sort((a, b) => a - b),
        first: mine.map(i => i.start_date).filter((x): x is string => !!x).sort()[0] || null,
        nextUnlock: live.filter(i => !isUnlocked(i, t)).map(i => i.lockin_end_date).filter((x): x is string => !!x).sort()[0] || null,
        lastMaturity: live.map(i => i.maturity_date).filter((x): x is string => !!x).sort().slice(-1)[0] || null
      };
    });
    const pm = new Map(people.map(p => [p.id, p]));
    const lines: Line[] = invs.map(i => ({ ...i, who: pm.get(i.investor_id)!, bal: bal.get(i.id) })).sort((a, b) => (b.start_date || b.created_at).localeCompare(a.start_date || a.created_at));
    return { rows, lines };
  }, [q.data, t]);

  const head = (title: string) => <PageHead crumbs={['Branches', title]} title={title} />;
  if (q.error) return <>{head(code)}<ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data && q.loading) return <>{head(code)}<Loading rows={6} /></>;
  if (!q.data || !data) return <>{head('Branch not found')}<Empty title="Branch not found">No branch has the code {code}. <Link to="/admin/branches">All branches</Link></Empty></>;
  const { branch, dash: d } = q.data;
  const { rows, lines } = data;
  const sum = (k: 'principal' | 'unlocked' | 'locked' | 'accrued' | 'paid') => rows.reduce((x, r) => x + r[k], 0);
  const reconciles = Math.abs(sum('principal') - Number(d.principal_invested)) < 0.005 && Math.abs(sum('unlocked') - Number(d.unlocked_principal)) < 0.005;
  const rates = withStandardRates(d.by_rate || []);

  const investorCols: Col<InvRow>[] = [
    { h: 'Investor', v: r => r.p.full_name || r.p.email, r: r => <><b>{r.p.full_name || '—'}</b><span className="sub">{r.p.email}</span></> },
    { h: 'Total principal', n: true, v: r => r.principal, r: r => money(r.principal) },
    { h: 'ROI', v: r => r.rates[0] ?? -1, r: r => r.rates.length ? r.rates.map(rateShort).join(', ') : '—' },
    { h: 'Lock-in', v: r => r.lockins[0] ?? -1, r: r => r.lockins.length ? r.lockins.map(m => m === 12 ? '1 year' : m + ' mo').join(', ') : '—' },
    { h: 'Invested on', v: r => r.first || '9999', r: r => date(r.first) },
    { h: 'Maturity', v: r => r.lastMaturity || '9999', r: r => <>{date(r.lastMaturity)}{r.nextUnlock && r.nextUnlock !== r.lastMaturity && <span className="sub">next unlock {date(r.nextUnlock)}</span>}</> },
    { h: 'Locked', n: true, v: r => r.locked, r: r => money(r.locked) },
    { h: 'Unlocked', n: true, v: r => r.unlocked, r: r => <span className={r.unlocked ? 'pos' : ''}>{money(r.unlocked)}</span> },
    { h: 'Returns accrued', n: true, v: r => r.accrued, r: r => money(r.accrued) },
    { h: 'Returns paid', n: true, v: r => r.paid, r: r => <span className="pos">{money(r.paid)}</span> },
    { h: 'Status', v: r => r.p.kyc_status + r.p.account_status, r: r => r.p.account_status !== 'active' ? <Badge cls="b-red">Suspended</Badge> : r.p.kyc_status !== 'verified' ? <Badge cls="b-amber">KYC {r.p.kyc_status}</Badge> : r.invs.length ? <Badge cls="b-green">{r.invs.filter(i => LIVE.includes(i.status)).length} live</Badge> : <Badge cls="b-grey">No investments</Badge> }
  ];
  const lineCols: Col<Line>[] = [
    { h: 'Investment', v: r => r.code, m: true },
    { h: 'Investor', v: r => r.who?.full_name || '', r: r => <>{r.who?.full_name || '—'}<span className="sub">{r.who?.email}</span></> },
    { h: 'Investment date', v: r => r.start_date || r.expected_start || '', r: r => date(r.start_date || r.expected_start) },
    { h: 'Principal', n: true, v: r => Number(r.principal), r: r => money(r.principal) },
    { h: 'ROI', v: r => Number(r.monthly_rate), r: r => rateShort(r.monthly_rate) },
    { h: 'Lock-in', v: r => r.lockin_months, r: r => r.lockin_months === 12 ? '1 year' : r.lockin_months + ' months' },
    { h: 'Maturity', v: r => r.maturity_date || '', r: r => date(r.maturity_date) },
    { h: 'Accrued', n: true, v: r => Number(r.bal?.accrued || 0), r: r => money(r.bal?.accrued || 0) },
    { h: 'Paid', n: true, v: r => Number(r.bal?.paid || 0), r: r => <span className="pos">{money(r.bal?.paid || 0)}</span> },
    { h: 'Status', v: r => r.status, r: r => <InvBadge i={r} approachingDays={s.approaching_days} /> }
  ];
  const exportCsv = () => downloadCsv(`${branch.code.toLowerCase()}-branch-${t}`,
    ['Investment', 'Investor', 'Email', 'Investment date', 'Principal', 'Monthly ROI %', 'Lock-in months', 'Maturity', 'Locked / unlocked', 'Accrued', 'Paid', 'Status'],
    lines.map(l => [l.code, l.who?.full_name, l.who?.email, l.start_date || l.expected_start, Number(l.principal).toFixed(2), l.monthly_rate, l.lockin_months, l.maturity_date,
      LIVE.includes(l.status) ? (isUnlocked(l, t) ? 'Unlocked' : 'Locked') : '', Number(l.bal?.accrued || 0).toFixed(2), Number(l.bal?.paid || 0).toFixed(2), l.status]));

  return (
    <>
      <Link className="back" to="/admin"><Icon name="back" /> Overview</Link>
      <PageHead crumbs={['Branches', branch.name]} title={`${branch.name} Branch`}
        sub={`${rows.length} investor${rows.length === 1 ? '' : 's'}${branch.city ? ' · ' + branch.city : ''} · figures from the investment records below`}
        actions={<>
          <button className="btn" onClick={exportCsv} disabled={!lines.length}><Icon name="download" />Export CSV</button>
          <button className="btn" onClick={() => nav('/admin/investors?branch=' + branch.code)}><Icon name="users" />Manage investors</button>
        </>} />
      <div className="kpis">
        <Kpi label="Investors" value={rows.length} sub={`${d.investors_with_investments} with live investments`} />
        <Kpi label="Total principal invested" value={moneyShort(d.principal_invested)} sub={`${d.live_investments} live investments`} />
        <Kpi label="Locked principal" value={moneyShort(d.locked_principal)} sub={`${d.locked_count} in lock-in`} onClick={() => nav(`/admin/investments?branch=${branch.code}&f=locked`)} />
        <Kpi label="Unlocked principal" value={moneyShort(d.unlocked_principal)} cls={Number(d.unlocked_principal) ? 'pos' : ''} sub={`${d.unlocked_count} past lock-in`} onClick={() => nav(`/admin/investments?branch=${branch.code}&f=unlocked`)} />
        <Kpi label="Total returns" value={moneyShort(d.accrued_total)} sub={`${moneyShort(d.paid_total)} paid`} />
      </div>
      {!reconciles && <div className="note">Branch totals and the investor rows below differ. Refresh the page; if it persists, check the investments of this branch.</div>}
      <div className="grid g-1-1">
        <div className="card"><div className="card-h"><h3>ROI plan distribution</h3><div className="r">investors per monthly rate</div></div><div className="card-b">
          {rates.some(r => Number(r.investors) > 0)
            ? <Donut parts={rates.filter(r => Number(r.investors) > 0).map((r, i) => ({ name: `${rateShort(r.rate)} monthly`, value: Number(r.investors), color: rateColor(r.rate, i), sub: moneyShort(r.principal) }))}
                fmt={v => `${v} investor${v === 1 ? '' : 's'}`} center1="Investors" center2={String(d.investors_with_investments)} label={`${branch.name} investors by ROI plan`}
                onPart={ix => nav(`/admin/investments?branch=${branch.code}&rate=${rates.filter(r => Number(r.investors) > 0)[ix].rate}`)} />
            : <Empty title="No live investments">The split appears once investments in this branch are active.</Empty>}
        </div></div>
        <div className="card"><div className="card-h"><h3>Locked and unlocked principal</h3></div><div className="card-b" style={{ display: 'grid', gap: 16 }}>
          <SplitBar locked={Number(d.locked_principal)} unlocked={Number(d.unlocked_principal)} />
          <dl className="kv">
            {(d.by_lockin || []).map(l => <Fragment key={l.months}><dt>{lockinText(l.months)} lock-in</dt><dd>{l.count} investment{Number(l.count) === 1 ? '' : 's'} · {money(l.principal)} · {money(l.unlocked)} unlocked</dd></Fragment>)}
          </dl>
          {!d.by_lockin?.length && <p className="hint">No live investments yet.</p>}
        </div></div>
      </div>
      <div className="chips">
        <button className={'chip ' + (tab === 'investors' ? 'on' : '')} onClick={() => setTab('investors')}>Investors · {rows.length}</button>
        <button className={'chip ' + (tab === 'investments' ? 'on' : '')} onClick={() => setTab('investments')}>Investment history · {lines.length}</button>
      </div>
      {tab === 'investors'
        ? <DataTable<InvRow> rows={rows} cols={investorCols} rowKey={r => r.p.id} searchPh="Search name or email" sort={1} per={20}
            text={r => `${r.p.code} ${r.p.phone}`} href={r => (r.p.code ? '/admin/investors/' + r.p.code : null)}
            emptyTitle="No investors in this branch" empty="Assign investors to this branch from the Investors page." />
        : <DataTable<Line> rows={lines} cols={lineCols} rowKey={r => r.id} searchPh="Search investment or investor" per={20}
            href={r => '/admin/investments/' + r.code} emptyTitle="No investments yet" empty="Investments of this branch's investors appear here."
            filters={[['All', 'all'], ['Locked', 'locked'], ['Unlocked', 'unlocked'], ['Pending funding', 'pending_funding'], ['Closed', 'closed']]}
            filterFn={(r, f) => f === 'all' || (f === 'locked' ? LIVE.includes(r.status) && !isUnlocked(r, t) : f === 'unlocked' ? isUnlocked(r, t) : f === 'closed' ? ['redeemed', 'cancelled'].includes(r.status) : r.status === f)} />}
    </>
  );
}
