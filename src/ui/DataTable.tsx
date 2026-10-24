import { ReactNode, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';

export interface Col<T> {
  h: string;
  /** value used for search and sorting */
  v?: (r: T) => string | number | null | undefined;
  /** custom cell */
  r?: (r: T) => ReactNode;
  n?: boolean; // numeric (right aligned)
  m?: boolean; // mono
}

interface Props<T> {
  rows: T[];
  cols: Col<T>[];
  rowKey: (r: T) => string;
  title?: string;
  right?: ReactNode;
  tools?: ReactNode;
  search?: boolean;
  searchPh?: string;
  text?: (r: T) => string;
  filters?: [string, string][];
  filterFn?: (r: T, f: string) => boolean;
  /** filter chip selected on first render (defaults to the first one) */
  initialFilter?: string;
  sort?: number;
  dir?: 1 | -1;
  per?: number;
  href?: (r: T) => string | null;
  emptyTitle?: string;
  empty?: string;
  select?: { selected: Set<string>; onChange: (s: Set<string>) => void; can?: (r: T) => boolean };
}

/** Card with search, filter chips, sortable headers and pagination (same look as the design). */
export function DataTable<T>(p: Props<T>) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(p.initialFilter && p.filters?.some(f => f[1] === p.initialFilter) ? p.initialFilter : p.filters ? p.filters[0][1] : '');
  const [sort, setSort] = useState<number | null>(p.sort ?? null);
  const [dir, setDir] = useState<1 | -1>(p.dir ?? -1);
  const [page, setPage] = useState(0);
  const per = p.per || 15;

  const rows = useMemo(() => {
    let rs = p.rows.slice();
    if (p.filters && p.filterFn && filter) rs = rs.filter(r => p.filterFn!(r, filter));
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      rs = rs.filter(r => p.cols.some(c => String(c.v ? c.v(r) ?? '' : '').toLowerCase().includes(s)) || (p.text ? p.text(r).toLowerCase().includes(s) : false));
    }
    if (sort != null && p.cols[sort]?.v) {
      const c = p.cols[sort];
      rs.sort((a, b) => {
        const x = c.v!(a) ?? '', y = c.v!(b) ?? '';
        return (x > y ? 1 : x < y ? -1 : 0) * dir;
      });
    }
    return rs;
  }, [p.rows, p.cols, filter, q, sort, dir, p.filters, p.filterFn, p.text]);

  const pages = Math.max(1, Math.ceil(rows.length / per));
  const pg = Math.min(page, pages - 1);
  const slice = rows.slice(pg * per, pg * per + per);
  const sel = p.select;
  const selectable = sel ? slice.filter(r => (sel.can ? sel.can(r) : true)) : [];
  const allOn = sel && selectable.length > 0 && selectable.every(r => sel.selected.has(p.rowKey(r)));

  return (
    <div className="card">
      {p.title && <div className="card-h"><h3>{p.title}</h3><div className="r">{p.right}</div></div>}
      {(p.search !== false || p.filters || p.tools) && (
        <div className="toolbar">
          {p.search !== false && (
            <label className="search"><Icon name="search" /><input value={q} onChange={e => { setQ(e.target.value); setPage(0); }} placeholder={p.searchPh || 'Search'} aria-label="Search table" /></label>
          )}
          {p.filters && (
            <div className="chips">
              {p.filters.map(f => <button key={f[1]} className={'chip ' + (filter === f[1] ? 'on' : '')} onClick={() => { setFilter(f[1]); setPage(0); }}>{f[0]}</button>)}
            </div>
          )}
          {p.tools && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>{p.tools}</div>}
        </div>
      )}
      <div className="tbl">
        {rows.length ? (
          <table>
            <thead>
              <tr>
                {sel && <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all on this page" checked={!!allOn} onChange={e => {
                  const s = new Set(sel.selected);
                  selectable.forEach(r => e.target.checked ? s.add(p.rowKey(r)) : s.delete(p.rowKey(r)));
                  sel.onChange(s);
                }} /></th>}
                {p.cols.map((c, i) => (
                  <th key={i} className={(c.n ? 'n ' : '') + (c.v ? 'sort' : '')} onClick={() => { if (!c.v) return; setDir(sort === i ? (dir === 1 ? -1 : 1) : -1); setSort(i); }}>
                    {c.h}{sort === i ? (dir > 0 ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map(r => {
                const href = p.href ? p.href(r) : null;
                const k = p.rowKey(r);
                return (
                  <tr key={k} className={href ? 'click' : ''} onClick={e => { if (href && !(e.target as HTMLElement).closest('button,a,input,label')) nav(href); }}>
                    {sel && <td><input type="checkbox" aria-label="Select row" disabled={sel.can ? !sel.can(r) : false} checked={sel.selected.has(k)} onChange={e => {
                      const s = new Set(sel.selected); e.target.checked ? s.add(k) : s.delete(k); sel.onChange(s);
                    }} /></td>}
                    {p.cols.map((c, i) => <td key={i} className={(c.n ? 'n ' : '') + (c.m ? 'm' : '')}>{c.r ? c.r(r) : String(c.v ? c.v(r) ?? '' : '')}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 18 }}><div className="empty"><b>{p.emptyTitle || 'Nothing here yet'}</b>{p.empty || 'No records match these filters.'}</div></div>
        )}
      </div>
      <div className="pager">
        <span>{rows.length ? `${pg * per + 1}–${Math.min(rows.length, pg * per + per)} of ${rows.length}` : '0 records'}</span>
        <div className="sp">
          <button className="btn sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</button>
          <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
