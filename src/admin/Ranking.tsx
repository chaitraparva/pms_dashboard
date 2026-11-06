import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { date, money, moneyShort } from '../lib/format';
import { Empty, ErrorNote, Loading, PageHead } from '../ui/kit';
import { loadBranches } from './Investors';

export interface RankRow { id: string; code: string; name: string; email: string; phone?: string; branch: string | null; principal: number; released: number; multiple: number; since: string | null; last: string | null; rank: number; plans: string;
  pending: number; upcoming: number; to_release: number }
type Period = '' | '6m' | '1y';

export const multipleText = (m: number) => (m >= 1 ? m.toFixed(1) + '×' : Math.round(m * 100) + '%');

/** Investors ranked by total invested: the most money in live investments is rank 1. */
export function Ranking() {
  const nav = useNavigate();
  const [branch, setBranch] = useState('');
  const [period, setPeriod] = useState<Period>('');
  const bq = useQuery(loadBranches, []);
  const q = useQuery(() => rpc<{ total: number; rows: RankRow[] }>('admin_investor_ranking', { p_branch: branch || null, p_period: period || null }), [branch, period]);
  const head = <PageHead crumbs={['Investor ranking']} title="Investor ranking" sub="Ranked by total invested: the investor with the most money invested is rank 1. Each investor sees their own rank in their portal." />;
  if (q.loading && !q.data) return <>{head}<Loading /></>;
  if (q.error || !q.data) return <>{head}<ErrorNote msg={q.error || 'Could not load the ranking.'} retry={q.reload} /></>;
  const { rows, total } = q.data;
  const top = Math.max(1, ...rows.map(r => Number(r.principal)));
  const open = (r: RankRow) => nav('/admin/investors/' + r.code);
  return (
    <>
      {head}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
      <div className="chips" role="group" aria-label="Branch">
        <button type="button" className={'chip ' + (!branch ? 'on' : '')} onClick={() => setBranch('')}>All branches</button>
        {(bq.data || []).map(b => <button key={b.id} type="button" className={'chip ' + (branch === b.id ? 'on' : '')} onClick={() => setBranch(b.id)}>{b.name}</button>)}
      </div>
      <div className="chips" role="group" aria-label="Period">
        {([['6m', 'Invested in last 6 months'], ['1y', 'Last 1 year'], ['', 'All']] as [Period, string][]).map(([v, l]) => <button key={l} type="button" className={'chip ' + (period === v ? 'on' : '')} onClick={() => setPeriod(v)}>{l}</button>)}
      </div>
      </div>
      {!rows.length ? <div className="card"><div className="card-b"><Empty title="No investors to rank yet">Investors appear here once they have a live investment.</Empty></div></div> : (
        <>
          <div className="card">
            <div className="card-h"><h3>Highest invested first</h3><div className="r hint">Longer bar = more invested · click to open</div></div>
            <div className="card-b rank-bars">
              {rows.slice(0, 15).map(r => (
                <button key={r.id} type="button" className="rank-bar" onClick={() => open(r)} title={`${r.name}: ${money(r.principal)} invested · ${money(r.released)} released · ${money(r.to_release)} to be released`}>
                  <span className="rank-no">#{r.rank}</span>
                  <span className="rank-name">{r.name}<small>{r.branch || 'No branch'}</small></span>
                  <span className="rank-track"><i style={{ width: Math.max(4, (Number(r.principal) / top) * 100) + '%' }} /></span>
                  <b className="num">{moneyShort(r.principal)}</b>
                </button>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="tbl">
              <table>
                <thead><tr><th>Rank</th><th>Investor</th><th>Branch</th><th>Last invested</th><th className="n">Principal</th><th className="n">ROI released</th><th className="n">ROI to be released</th><th>ROI</th><th>Investing since</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => open(r)}>
                      <td><b>#{r.rank}</b> <span className="muted">of {total}</span></td>
                      <td><b>{r.name}</b><span className="sub">{r.email}</span></td>
                      <td>{r.branch || '—'}</td>
                      <td><b>{date(r.last)}</b></td>
                      <td className="n">{moneyShort(r.principal)}</td>
                      <td className="n pos">{money(r.released)}<span className="sub">{multipleText(r.multiple)} of principal</span></td>
                      <td className="n">{money(r.to_release)}<span className="sub">{money(r.pending)} earned · {money(r.upcoming)} to come</span></td>
                      <td>{r.plans}</td>
                      <td>{r.since ? date(r.since) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Small card on the Overview: the five investors with the most ROI released relative to principal. */
export function TopInvestors() {
  const nav = useNavigate();
  const q = useQuery(() => rpc<{ total: number; rows: RankRow[] }>('admin_investor_ranking', {}), []);
  const rows = (q.data?.rows || []).slice(0, 5);
  return (
    <div className="card">
      <div className="card-h"><h3>Ranking · top 5 by amount invested</h3><div className="r"><a style={{ cursor: 'pointer' }} onClick={() => nav('/admin/ranking')}>Full ranking</a></div></div>
      <div className="card-b rank-bars">
        {rows.map(r => (
          <button key={r.id} type="button" className="rank-bar" onClick={() => nav('/admin/investors/' + r.code)} title={`${money(r.principal)} invested · ${money(r.to_release)} to be released`}>
            <span className="rank-no">#{r.rank}</span><span className="rank-name">{r.name}<small>{r.branch || 'No branch'}</small></span>
            <span className="rank-track"><i style={{ width: Math.max(4, (Number(r.principal) / Math.max(1, Number(rows[0]?.principal || 1))) * 100) + '%' }} /></span><b className="num">{moneyShort(r.principal)}</b>
          </button>
        ))}
        {!rows.length && <Empty title="No investors to rank yet" />}
      </div>
    </div>
  );
}
