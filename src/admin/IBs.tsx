import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fetchAll } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { moneyBoth, sumByCur, invCurrency } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { AdminBonus, Branch, Investment, Profile } from '../lib/types';
import { AcctBadge, ErrorNote, Kpi, Loading, PageHead } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';
import { Icon } from '../ui/Icon';

/* IBs & network: IBs (introducing brokers) and their sub-investors, and the bonus the IBs earn from them. */

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
/** money from the people under an IB: [from INR investors, from AED investors (as saved)] — never added together */
type Two = [number, number];
interface Row extends Profile { branch: string; people: number; peoplePrincipal: Two; own: number; ownTwo: Two; monthly: Two; earned: Two; paid: Two }

async function load() {
  const [people, invs, bon, branches] = await Promise.all([
    fetchAll<Profile>((a, b) => api.from('profiles').select('*').eq('role', 'investor').range(a, b)),
    fetchAll<Investment>((a, b) => api.from('investments').select('*').range(a, b)),
    fetchAll<AdminBonus>((a, b) => api.from('admin_bonuses').select('*').range(a, b)),
    fetchAll<Branch>((a, b) => api.from('branches').select('*').range(a, b))
  ]);
  const bn = new Map(branches.map(b => [b.id, b.name]));
  const live = invs.filter(i => LIVE.includes(i.status));
  // IBs: registered as an IB, allowed to add investors, or with sub-investors under them
  const rows: Row[] = people.filter(p => p.is_ib || p.can_introduce || people.some(x => x.introduced_by === p.id)).map(p => {
    const under = people.filter(x => x.introduced_by === p.id).map(x => x.id);
    const theirs = live.filter(i => under.includes(i.investor_id));
    const mine = bon.filter(b => b.admin_id === p.id && b.status !== 'cancelled');
    return {
      ...p, branch: p.branch_id ? bn.get(p.branch_id) || '' : '', people: under.length,
      peoplePrincipal: sumByCur(theirs, i => Number(i.principal), i => invCurrency(i.id, i.investor_id)),
      own: live.filter(i => i.investor_id === p.id).reduce((s, i) => s + Number(i.principal), 0), ownTwo: sumByCur(live.filter(i => i.investor_id === p.id), i => Number(i.principal), i => invCurrency(i.id, p.id)),
      monthly: sumByCur(theirs.filter(i => ['active', 'matured', 'redemption_requested', 'redemption_processing'].includes(i.status)), i => Number(i.admin_bonus || 0), i => invCurrency(i.id, i.investor_id)),
      earned: sumByCur(mine, b => Number(b.amount), b => invCurrency(b.investment_id, b.investor_id)), paid: sumByCur(mine.filter(b => b.status === 'paid'), b => Number(b.amount), b => invCurrency(b.investment_id, b.investor_id))
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name));
  return { rows, branches };
}

export function IBs() {
  const nav = useNavigate();
  const q = useQuery(load, []);
  const rows = q.data?.rows || [];
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'IB', v: r => r.full_name, r: r => <><b>{r.full_name}</b><span className="sub">{r.code}{r.branch ? ' · ' + r.branch : ''}</span></> },
    { h: 'Login phone', v: r => r.phone, r: r => <span className="num">{r.phone || '—'}</span> },
    { h: 'Sub-investors', n: true, v: r => r.people },
    { h: 'Sub-investors’ principal', n: true, v: r => r.peoplePrincipal[0] + r.peoplePrincipal[1], r: r => moneyBoth(...r.peoplePrincipal) },
    { h: 'Own investment', n: true, v: r => r.own, r: r => r.own ? moneyBoth(...r.ownTwo) : <span className="muted">—</span> },
    { h: 'Bonus / month', n: true, v: r => r.monthly[0] + r.monthly[1], r: r => moneyBoth(...r.monthly) },
    { h: 'Bonus earned', n: true, v: r => r.earned[0] + r.earned[1], r: r => <>{moneyBoth(...r.earned)}<span className="sub">{moneyBoth(...r.paid)} paid</span></> },
    { h: 'Login', v: r => r.account_status, r: r => <><AcctBadge s={r.account_status} />{!r.has_login && <span className="sub">no login yet</span>}</> }
  ], []);
  const sum = (k: 'peoplePrincipal' | 'monthly' | 'earned') => moneyBoth(rows.reduce((s, r) => s + r[k][0], 0), rows.reduce((s, r) => s + r[k][1], 0));
  const people = rows.reduce((s, r) => s + r.people, 0);
  return (
    <>
      <PageHead crumbs={['IBs & Network']} title="IBs & Network"
        sub="IBs and the sub-investors under them. Each IB sees their sub-investors, their investments and the bonus they earn in their own login."
        actions={<>
          <button className="btn" disabled={!rows.length} onClick={() => downloadCsv('network', ['Investor ID', 'Name', 'Phone', 'Branch', 'People under', 'Their principal', 'Own investment', 'Bonus / month', 'Bonus earned', 'Bonus paid'],
            rows.map(r => [r.code, r.full_name, r.phone, r.branch, r.people, moneyBoth(...r.peoplePrincipal), moneyBoth(...r.ownTwo), moneyBoth(...r.monthly), moneyBoth(...r.earned), moneyBoth(...r.paid)]))}><Icon name="download" />Export to Excel</button>
          <button className="btn accent" onClick={() => nav('/admin/investments?new=1')}><Icon name="plus" />Record investment</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="kpis k4">
            <Kpi label="IBs" value={rows.length} sub={`${rows.filter(r => r.people > 0).length} with sub-investors`} />
            <Kpi label="Sub-investors" value={people} sub={sum('peoplePrincipal') + ' live principal'} />
            <Kpi label="Bonus per month" value={sum('monthly')} sub="from active investments" />
            <Kpi label="Bonus earned" value={sum('earned')} sub="pay it under Bonus" />
          </div>
          <DataTable rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search name, ID, phone" text={r => `${r.code} ${r.phone}`} href={r => '/admin/investors/' + r.code} sort={0} dir={1} per={20}
            emptyTitle="No IBs yet" empty="Use “Record investment”, choose Investor type “IB”, then choose or register the IB." />
        </>
      )}
    </>
  );
}
