import { useEffect, useMemo, useState } from 'react';
import { api, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { onExport, type ExportRequest } from '../lib/csv';
import { downloadXlsx } from '../lib/xlsx';
import { MONTHS } from '../lib/format';
import { Field, Modal } from './kit';
import { Icon } from './Icon';

/* "Export to Excel" on every list opens this dialog: choose a month (or all) and a branch (or all), then download an .xlsx file.
   The month is taken from a date column of the list; the branch from its Branch column, or (for the Super Admin) looked up
   from the Investor ID column. */

type Cell = string | number | null | undefined;
const isDate = (v: Cell) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
const monthText = (ym: string) => MONTHS[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);
const slug = (s: string) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

export function ExportHost() {
  const [req, setReq] = useState<ExportRequest | null>(null);
  useEffect(() => onExport(setReq), []);
  return req ? <ExportDialog req={req} onClose={() => setReq(null)} /> : null;
}

function ExportDialog({ req, onClose }: { req: ExportRequest; onClose: () => void }) {
  const { profile } = useAuth();
  const admin = profile?.role === 'super_admin';
  // columns that hold dates (the month filter uses one of them)
  const dateCols = useMemo(() => req.headers.map((h, i) => ({ h, i })).filter(c => req.rows.some(r => isDate(r[c.i]))), [req]);
  const [dateCol, setDateCol] = useState(dateCols[0]?.i ?? -1);
  const [mode, setMode] = useState<'all' | 'month' | 'range'>('all');
  const [month, setMonth] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branch, setBranch] = useState('');
  // branch: a Branch column in the list, or looked up from the Investor ID column (Super Admin only)
  const branchIdx = req.headers.findIndex(h => /^branch$/i.test(h));
  const invIdx = req.headers.findIndex(h => /^investor id$/i.test(h));
  const [lookup, setLookup] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (branchIdx >= 0 || invIdx < 0 || !admin) return;
    let live = true;
    Promise.all([
      fetchAll<{ code: string; branch_id: string | null }>((a, b) => api.from('profiles').select('code,branch_id').eq('role', 'investor').range(a, b)),
      fetchAll<{ id: string; name: string }>((a, b) => api.from('branches').select('id,name').range(a, b))
    ]).then(([people, branches]) => {
      if (!live) return;
      const bn = new Map(branches.map(b => [b.id, b.name]));
      setLookup(Object.fromEntries(people.map(p => [p.code, p.branch_id ? bn.get(p.branch_id) || '' : ''])));
    }).catch(() => setLookup({}));
    return () => { live = false; };
  }, [branchIdx, invIdx, admin]);

  const headers = branchIdx < 0 && lookup ? [...req.headers, 'Branch'] : req.headers;
  const rows = useMemo(() => (branchIdx < 0 && lookup ? req.rows.map(r => [...r, lookup[String(r[invIdx] ?? '')] || '']) : req.rows), [req, lookup, branchIdx, invIdx]);
  const bIdx = branchIdx >= 0 ? branchIdx : lookup ? headers.length - 1 : -1;
  const months = useMemo(() => dateCol < 0 ? [] : [...new Set(rows.map(r => r[dateCol]).filter(isDate).map(v => String(v).slice(0, 7)))].sort().reverse(), [rows, dateCol]);
  const branches = useMemo(() => bIdx < 0 ? [] : [...new Set(rows.map(r => String(r[bIdx] ?? '')))].sort((a, b) => (a ? a.localeCompare(b) : 1)), [rows, bIdx]);
  const day = (r: Cell[]) => (isDate(r[dateCol]) ? String(r[dateCol]).slice(0, 10) : '');
  const inPeriod = (r: Cell[]) => mode === 'all' ? true : mode === 'month' ? (!month || day(r).slice(0, 7) === month) : (!!day(r) && (!from || day(r) >= from) && (!to || day(r) <= to));
  const picked = rows.filter(r => inPeriod(r)
    && (!branch || (branch === '__none' ? !r[bIdx] : String(r[bIdx] ?? '') === branch)));

  const go = () => {
    const period = mode === 'month' && month ? monthText(month) : mode === 'range' && (from || to) ? (from || 'start') + ' to ' + (to || 'today') : '';
    const parts = [req.name, period && slug(period), branch && (branch === '__none' ? 'no-branch' : slug(branch))].filter(Boolean);
    downloadXlsx(parts.join('-'), headers, picked, (branch && branch !== '__none' ? branch + ' ' : '') + (period || req.sheet || 'Data'));
    onClose();
  };
  return (
    <Modal title="Export to Excel" sub="Choose a month and a branch, or download everything in this list." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={!picked.length}><Icon name="download" />Download Excel ({picked.length} row{picked.length === 1 ? '' : 's'})</button></>}>
      <div className="form">
        {dateCols.length > 1 && (
          <Field label="Month by">
            <select className="input" value={dateCol} onChange={e => { setDateCol(Number(e.target.value)); setMonth(''); }}>
              {dateCols.map(c => <option key={c.i} value={c.i}>{c.h}</option>)}
            </select>
          </Field>
        )}
        <Field label={'Date' + (dateCols.length ? ' (' + (dateCols.find(c => c.i === dateCol)?.h || '') + ')' : '')} hint={!dateCols.length ? 'This list has no dates.' : undefined}>
          <div className="chips">
            {([['all', 'All dates'], ['month', 'A month'], ['range', 'From – to']] as ['all' | 'month' | 'range', string][]).map(([k, l]) =>
              <button key={k} type="button" className={'chip ' + (mode === k ? 'on' : '')} disabled={!dateCols.length && k !== 'all'} onClick={() => setMode(k)}>{l}</button>)}
          </div>
          {mode === 'month' && (
            <select className="input" style={{ marginTop: 8 }} value={month} onChange={e => setMonth(e.target.value)}>
              <option value="">Choose a month…</option>
              {months.map(m => <option key={m} value={m}>{monthText(m)}</option>)}
            </select>
          )}
          {mode === 'range' && (
            <div className="f-row" style={{ marginTop: 8 }}>
              <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date" />
              <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date" />
            </div>
          )}
        </Field>
        <div className="f-row">
          <Field label="Branch" hint={bIdx < 0 ? 'This list has no branch.' : undefined}>
            <select className="input" value={branch} onChange={e => setBranch(e.target.value)} disabled={bIdx < 0}>
              <option value="">All branches</option>
              {branches.filter(Boolean).map(b => <option key={b} value={b}>{b}</option>)}
              {branches.includes('') && <option value="__none">No branch</option>}
            </select>
          </Field>
        </div>
        {!picked.length && <p className="hint">Nothing matches this month and branch.</p>}
      </div>
    </Modal>
  );
}
