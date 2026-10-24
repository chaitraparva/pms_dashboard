/* eslint-disable @typescript-eslint/no-explicit-any */
// Runs one table query from the browser against the data engine, with the signed-in user's read rules.
import * as db from '../src/lib/localdb';
import type { FilterSpec, QuerySpec, Res } from '../src/lib/wire';

const ok = <T,>(data: T, count?: number | null): Res<T> => ({ data, error: null, count });
const err = (m: string): Res<any> => ({ data: null, error: { message: m } });
const likeRe = (p: string) => new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
const cmp = (a: any, b: any) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

function test(f: FilterSpec): (r: any) => boolean {
  switch (f.t) {
    case 'eq': return r => r[f.c] === f.v || (r[f.c] != null && f.v != null && String(r[f.c]) === String(f.v));
    case 'neq': return r => String(r[f.c]) !== String(f.v);
    case 'in': { const s = new Set((f.v || []).map(String)); return r => s.has(String(r[f.c])); }
    case 'is': return r => (f.v === null ? r[f.c] == null : r[f.c] === f.v);
    case 'gt': return r => r[f.c] != null && cmp(r[f.c], f.v) > 0;
    case 'gte': return r => r[f.c] != null && cmp(r[f.c], f.v) >= 0;
    case 'lt': return r => r[f.c] != null && cmp(r[f.c], f.v) < 0;
    case 'lte': return r => r[f.c] != null && cmp(r[f.c], f.v) <= 0;
    case 'ilike': { const re = likeRe(String(f.v)); return r => re.test(String(r[f.c] ?? '')); }
    case 'or': {
      // PostgREST "or" filter, e.g. `full_name.ilike.%ana%,email.ilike.%ana%`
      const parts = String(f.v).split(/,(?=[a-z_]+\.(?:eq|ilike|like|neq|is)\.)/i).map(p => { const m = p.match(/^([a-z_]+)\.(eq|ilike|like|neq|is)\.(.*)$/i); return m ? { c: m[1], op: m[2].toLowerCase(), v: m[3] } : null; }).filter(Boolean) as { c: string; op: string; v: string }[];
      return r => parts.some(p => p.op === 'eq' ? String(r[p.c]) === p.v : p.op === 'neq' ? String(r[p.c]) !== p.v : p.op === 'is' ? (p.v === 'null' ? r[p.c] == null : String(r[p.c]) === p.v) : likeRe(p.v).test(String(r[p.c] ?? '')));
    }
  }
}

export function runQuery(q: QuerySpec): Res {
  if (!db.TABLES.includes(q.table) && q.table !== 'investment_balances') return err('Unknown table ' + q.table + '.');
  const shape = (rows: any[]) => rows.map(r => { const c = JSON.parse(JSON.stringify(r)); if (!q.cols) return c; const o: any = {}; q.cols.forEach(k => { o[k] = c[k]; }); return o; });
  if (q.op === 'insert') {
    if (!db.canWrite(q.table)) return err('You do not have permission to do this.');
    const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((x: any) => ({ ...x, id: db.uuid(), created_at: new Date().toISOString() }));
    db.T(q.table).push(...list); db.persist(q.table);
    const out = shape(list);
    return ok(q.one ? out[0] ?? null : out);
  }
  const base = db.view(q.table) || db.T(q.table);
  const tests = (q.filters || []).map(test);
  // rows the user may read; investors get a redacted copy (their own share only, never the bonus split)
  const raw = base.filter(r => db.canRead(q.table, r) && tests.every(f => f(db.redact(q.table, r))));
  if (q.op === 'delete' || q.op === 'update') {
    if (!db.canWrite(q.table)) return err('You do not have permission to do this.');
    const set = new Set(raw);
    if (q.op === 'delete') { const all = db.T(q.table); for (let i = all.length - 1; i >= 0; i--) if (set.has(all[i])) all.splice(i, 1); }
    else { const { id: _i, created_at: _c, ...patch } = (q.payload || {}) as any; raw.forEach(r => Object.assign(r, patch, { updated_at: new Date().toISOString() })); }
    db.persist(q.table); return ok(shape(raw));
  }
  let rows = raw.map(r => db.redact(q.table, r));
  for (const o of [...(q.orders || [])].reverse()) rows = [...rows].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
  const count = rows.length;
  if (q.rng) rows = rows.slice(q.rng[0], q.rng[1] + 1);
  if (q.lim != null) rows = rows.slice(0, q.lim);
  if (q.head) return ok(null, q.count ? count : null);
  const out = shape(rows);
  if (q.one === 'single') return out.length === 1 ? ok(out[0]) : err(out.length ? 'More than one row returned.' : 'Record not found.');
  if (q.one === 'maybe') return ok(out[0] ?? null);
  return ok(out, q.count ? count : null);
}
