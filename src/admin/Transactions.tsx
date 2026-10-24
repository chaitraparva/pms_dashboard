import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fetchAll } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { money, date, today, LEDGER_TYPE } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { LedgerEntry } from '../lib/types';
import { LedgerBadge, ErrorNote, Loading, PageHead, IconBtn } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';

type Person = { id: string; code: string | null; full_name: string; email: string };
type Inv = { id: string; code: string };
interface Row extends LedgerEntry { inv?: Inv; investor?: Person; createdBy?: Person }

const GROUPS: Record<string, string[]> = {
  dep: ['deposit', 'allocation'],
  acc: ['return_accrual'],
  pay: ['return_payout'],
  adj: ['fee', 'adjustment', 'reversal', 'refund', 'redemption_request', 'principal_redemption']
};
const nameOf = (p?: Person) => (p ? p.full_name || p.email : '');

async function load() {
  const [led, invs, people] = await Promise.all([
    fetchAll<LedgerEntry & { created_by: string | null }>((a, b) => api.from('ledger_entries').select('*').order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).range(a, b)),
    fetchAll<Inv>((a, b) => api.from('investments').select('id, code').range(a, b)),
    fetchAll<Person>((a, b) => api.from('profiles').select('id, code, full_name, email').range(a, b))
  ]);
  const invBy = new Map(invs.map(i => [i.id, i]));
  const pplBy = new Map(people.map(p => [p.id, p]));
  return led.map<Row>(l => ({
    ...l,
    inv: l.investment_id ? invBy.get(l.investment_id) : undefined,
    investor: l.investor_id ? pplBy.get(l.investor_id) : undefined,
    createdBy: l.created_by ? pplBy.get(l.created_by) : undefined
  }));
}

export function Transactions() {
  const q = useQuery(load, []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const all = q.data || [];
  const rows = useMemo(() => all.filter(r => (!from || r.occurred_on >= from) && (!to || r.occurred_on <= to)), [all, from, to]);

  const exportCsv = () => downloadCsv(`ledger-${from || 'start'}-to-${to || today()}`,
    ['Transaction', 'Date', 'Type', 'Investment', 'Investor ID', 'Investor', 'Amount', 'Status', 'Reference', 'Note', 'Created by', 'Recorded at'],
    rows.map(r => [r.code, r.occurred_on, LEDGER_TYPE[r.type] || r.type, r.inv?.code, r.investor?.code, nameOf(r.investor), Number(r.amount).toFixed(2), r.status,
      r.reference, r.note, r.createdBy ? nameOf(r.createdBy) : 'System', r.created_at]));

  const cols: Col<Row>[] = [
    { h: 'Transaction', m: true, v: r => r.code },
    { h: 'Date', v: r => r.occurred_on, r: r => date(r.occurred_on) },
    { h: 'Type', v: r => LEDGER_TYPE[r.type] || r.type },
    { h: 'Investment', v: r => r.inv?.code, r: r => r.inv ? <Link className="mono" to={`/admin/investments/${r.inv.code}`}>{r.inv.code}</Link> : <span className="muted">—</span> },
    { h: 'Investor', v: r => nameOf(r.investor), r: r => r.investor?.code ? <><Link to={`/admin/investors/${r.investor.code}`}>{nameOf(r.investor)}</Link><span className="sub">{r.investor.code}</span></> : <span className="muted">—</span> },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => <span className={Number(r.amount) < 0 ? 'neg' : ''}>{money(r.amount)}</span> },
    { h: 'Status', v: r => r.status, r: r => <LedgerBadge s={r.status} /> },
    { h: 'Reference', v: r => r.reference, r: r => r.reference ? <span className="mono muted">{r.reference}</span> : <span className="muted">—</span> },
    { h: 'Note', v: r => r.note, r: r => <span className="muted">{r.note || '—'}</span> }
  ];

  return (
    <>
      <PageHead crumbs={['Transactions']} title="Transaction ledger"
        sub="Append-only. Entries are never edited or deleted; corrections are posted as separate reversing entries."
        actions={<IconBtn icon="download" onClick={exportCsv} disabled={!rows.length}>Export CSV</IconBtn>} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <DataTable rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search ID, investment, investor, reference"
          text={r => `${r.investor?.code || ''} ${r.investor?.email || ''}`}
          filters={[['All', 'all'], ['Deposits', 'dep'], ['Returns accrued', 'acc'], ['Return payouts', 'pay'], ['Principal, fees & adjustments', 'adj']]}
          filterFn={(r, f) => f === 'all' || (GROUPS[f] || []).includes(r.type)}
          sort={1} dir={-1} per={20}
          tools={<>
            <label className="check" style={{ cursor: 'default' }}>From <input className="input" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="From date" style={{ width: 'auto' }} /></label>
            <label className="check" style={{ cursor: 'default' }}>To <input className="input" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="To date" style={{ width: 'auto' }} /></label>
            {(from || to) && <button className="btn ghost sm" onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>}
          </>}
          emptyTitle={all.length ? 'No matching entries' : 'The ledger is empty'}
          empty={all.length ? 'No ledger entries match these filters or dates.' : 'Entries are posted automatically when you record an investment, confirm a deposit, accrue returns or pay out.'} />
      )}
    </>
  );
}
