import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { dateTime } from '../lib/format';
import type { Profile, Query } from '../lib/types';
import { ErrorNote, Kpi, Loading, PageHead, useAction } from '../ui/kit';
import { QStatus, QueryThread } from '../investor/Queries';

/* Queries from investors. Answer them here; the investor gets a notification and sees the answer in their login. */

type P = Pick<Profile, 'id' | 'code' | 'full_name' | 'phone'>;
type Tab = 'open' | 'answered' | 'closed' | 'all';

export function Queries() {
  const act = useAction();
  const [sp, setSp] = useSearchParams();
  const q = useQuery(async () => {
    const [qs, people] = await Promise.all([
      fetchAll<Query>((a, b) => api.from('queries').select('*').order('updated_at', { ascending: false }).range(a, b)),
      fetchAll<P>((a, b) => api.from('profiles').select('id,code,full_name,phone').eq('role', 'investor').range(a, b))
    ]);
    const pm = new Map(people.map(p => [p.id, p]));
    return qs.map(x => ({ ...x, who: pm.get(x.investor_id) }));
  }, []);
  const [tab, setTab] = useState<Tab>('open');
  const [open, setOpen] = useState<string | null>(sp.get('open'));
  useEffect(() => { const o = sp.get('open'); if (o) { setOpen(o); const n = new URLSearchParams(sp); n.delete('open'); setSp(n, { replace: true }); } }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = q.data || [];
  const rows = all.filter(x => tab === 'all' || x.status === tab);
  const n = (k: Tab) => (k === 'all' ? all.length : all.filter(x => x.status === k).length);
  const cur = all.find(x => x.id === open);
  const close = async (id: string) => { const r = await act.run(() => rpc('admin_close_query', { p_id: id }), ['Query closed']); if (r !== undefined) { refreshAll(); q.reload(); } };
  return (
    <>
      <PageHead crumbs={['Queries']} title="Queries" sub="Questions from investors, for example about a return that has not arrived. Your answer shows in their login with a notification." />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <>
          <div className="kpis k4">
            <Kpi label="Waiting for reply" value={n('open')} subCls={n('open') ? 'warn' : ''} sub="new or follow-up" />
            <Kpi label="Answered" value={n('answered')} />
            <Kpi label="Closed" value={n('closed')} />
            <Kpi label="All queries" value={n('all')} />
          </div>
          <div className="grid g-2-1">
            <div className="card">
              <div className="tabs" style={{ padding: '0 12px' }} role="tablist">
                {([['open', 'Waiting'], ['answered', 'Answered'], ['closed', 'Closed'], ['all', 'All']] as [Tab, string][]).map(([k, l]) =>
                  <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>{l}<span className="c">{n(k)}</span></button>)}
              </div>
              {rows.length ? (
                <div className="tbl"><table><thead><tr><th>Query</th><th>Investor</th><th>Subject</th><th>Last update</th><th>Status</th></tr></thead>
                  <tbody>{rows.map(x => (
                    <tr key={x.id} style={{ cursor: 'pointer', background: x.id === open ? 'var(--blue-soft, #EEF2FF)' : undefined }} onClick={() => setOpen(x.id)}>
                      <td className="mono">{x.code}</td>
                      <td>{x.who ? <><Link to={'/admin/investors/' + x.who.code} onClick={e => e.stopPropagation()}>{x.who.full_name}</Link><span className="sub">{x.who.phone}</span></> : '—'}</td>
                      <td><b>{x.subject}</b><span className="sub">{(x.messages || []).slice(-1)[0]?.text.slice(0, 70)}</span></td>
                      <td>{dateTime(x.updated_at)}</td><td><QStatus s={x.status} /></td>
                    </tr>))}</tbody></table></div>
              ) : <div className="card-b"><p className="hint">Nothing here.</p></div>}
            </div>
            <div className="card">
              <div className="card-h"><h3>{cur ? cur.subject : 'Choose a query'}</h3>{cur && <div className="r"><QStatus s={cur.status} />{cur.status !== 'closed' && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => close(cur.id)}>Close</button>}</div>}</div>
              <div className="card-b">{cur ? <><p className="hint" style={{ marginBottom: 10 }}>{cur.code} · {cur.who?.full_name} · {cur.who?.phone}</p><QueryThread q={cur} me="admin" admin onSent={q.reload} /></> : <p className="hint">Click a query on the left to read and answer it.</p>}</div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
