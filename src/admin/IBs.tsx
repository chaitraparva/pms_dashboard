import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fetchAll } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { money } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { AdminBonus, Branch, Investment, Profile } from '../lib/types';
import { AcctBadge, ErrorNote, Kpi, Loading, PageHead } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';
import { Icon } from '../ui/Icon';

/* Network: investors with people under them, and the bonus they earn from them. */

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const r2 = (x: number) => Math.round(x * 100) / 100;
interface Row extends Profile { branch: string; people: number; peoplePrincipal: number; own: number; monthly: number; earned: number; paid: number }

async function load() {
  const [people, invs, bon, branches] = await Promise.all([
    fetchAll<Profile>((a, b) => api.from('profiles').select('*').eq('role', 'investor').range(a, b)),
    fetchAll<Investment>((a, b) => api.from('investments').select('*').range(a, b)),
    fetchAll<AdminBonus>((a, b) => api.from('admin_bonuses').select('*').range(a, b)),
    fetchAll<Branch>((a, b) => api.from('branches').select('*').range(a, b))
  ]);
  const bn = new Map(branches.map(b => [b.id, b.name]));
  const live = invs.filter(i => LIVE.includes(i.status));
  const rows: Row[] = people.filter(p => people.some(x => x.introduced_by === p.id)).map(p => {
    const under = people.filter(x => x.introduced_by === p.id).map(x => x.id);
    const theirs = live.filter(i => under.includes(i.investor_id));
    const mine = bon.filter(b => b.admin_id === p.id && b.status !== 'cancelled');
    return {
      ...p, branch: p.branch_id ? bn.get(p.branch_id) || '' : '', people: under.length,
      peoplePrincipal: theirs.reduce((s, i) => s + Number(i.principal), 0),
      own: live.filter(i => i.investor_id === p.id).reduce((s, i) => s + Number(i.principal), 0),
      monthly: r2(theirs.filter(i => i.status === 'active').reduce((s, i) => s + Number(i.admin_bonus || 0), 0)),
      earned: r2(mine.reduce((s, b) => s + Number(b.amount), 0)), paid: r2(mine.filter(b => b.status === 'paid').reduce((s, b) => s + Number(b.amount), 0))
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name));
  return { rows, branches };
}

export function IBs() {
  const nav = useNavigate();
  const q = useQuery(load, []);
  const rows = q.data?.rows || [];
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'Investor', v: r => r.full_name, r: r => <><b>{r.full_name}</b><span className="sub">{r.code}{r.branch ? ' · ' + r.branch : ''}</span></> },
    { h: 'Login phone', v: r => r.phone, r: r => <span className="num">{r.phone || '—'}</span> },
    { h: 'People under', n: true, v: r => r.people },
    { h: 'Their principal', n: true, v: r => r.peoplePrincipal, r: r => money(r.peoplePrincipal) },
    { h: 'Own investment', n: true, v: r => r.own, r: r => r.own ? money(r.own) : <span className="muted">—</span> },
    { h: 'Bonus / month', n: true, v: r => r.monthly, r: r => money(r.monthly) },
    { h: 'Bonus earned', n: true, v: r => r.earned, r: r => <>{money(r.earned)}<span className="sub">{money(r.paid)} paid</span></> },
    { h: 'Login', v: r => r.account_status, r: r => <AcctBadge s={r.account_status} /> }
  ], []);
  const sum = (k: 'people' | 'peoplePrincipal' | 'monthly' | 'earned') => rows.reduce((s, r) => s + r[k], 0);
  return (
    <>
      <PageHead crumbs={['Network']} title="Network"
        sub="Investors who have people under them. Each one sees the people under them, their investments and the bonus they earn in their own login."
        actions={<>
          <button className="btn" disabled={!rows.length} onClick={() => downloadCsv('network', ['Investor ID', 'Name', 'Phone', 'Branch', 'People under', 'Their principal', 'Own investment', 'Bonus / month', 'Bonus earned', 'Bonus paid'],
            rows.map(r => [r.code, r.full_name, r.phone, r.branch, r.people, r.peoplePrincipal.toFixed(2), r.own.toFixed(2), r.monthly.toFixed(2), r.earned.toFixed(2), r.paid.toFixed(2)]))}><Icon name="download" />Export CSV</button>
          <button className="btn accent" onClick={() => nav('/admin/investments?new=1')}><Icon name="plus" />Record investment</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="kpis k4">
            <Kpi label="Investors with people" value={rows.length} sub="have someone under them" />
            <Kpi label="People under them" value={sum('people')} sub={money(sum('peoplePrincipal')) + ' live principal'} />
            <Kpi label="Bonus per month" value={money(sum('monthly'))} sub="from active investments" />
            <Kpi label="Bonus earned" value={money(sum('earned'))} sub="pay it under Bonus" />
          </div>
          <DataTable rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search name, ID, phone" text={r => `${r.code} ${r.phone}`} href={r => '/admin/investors/' + r.code} sort={0} dir={1} per={20}
            emptyTitle="Nobody has people under them yet" empty="Use “Record investment”, choose “Under an investor” and pick who brought them in." />
        </>
      )}
    </>
  );
}
