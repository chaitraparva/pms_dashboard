import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { downloadCsv } from '../lib/csv';
import { date, LEDGER_TYPE, money } from '../lib/format';
import { ErrorNote, LedgerBadge, Loading, PageHead } from '../ui/kit';
import { DataTable } from '../ui/DataTable';
import { Icon } from '../ui/Icon';
import type { LedgerEntry } from '../lib/types';
import { codeMap, loadInvestments, loadLedger } from './data';

interface Row extends LedgerEntry { inv: string; typeLabel: string }

const FILTERS: [string, string][] = [['All', 'all'], ['Deposits', 'deposit'], ['Return payouts', 'return_payout'], ['Accruals', 'return_accrual'], ['Principal & adjustments', 'adj']];
const match = (r: Row, f: string) => f === 'all' || r.type === f
  || (f === 'adj' && ['fee', 'adjustment', 'reversal', 'refund', 'redemption_request', 'principal_redemption'].includes(r.type));

export function Transactions() {
  const { profile } = useAuth();
  const [sp, setSp] = useSearchParams();
  const term = (sp.get('q') || '').trim();
  const q = useQuery(async () => {
    const [inv, led] = await Promise.all([loadInvestments(profile!.id), loadLedger(profile!.id)]);
    const codes = codeMap(inv);
    return { inv, rows: led.map(l => ({ ...l, inv: l.investment_id ? codes[l.investment_id] || '' : '', typeLabel: LEDGER_TYPE[l.type] || l.type })) as Row[] };
  }, [profile?.id]);

  const s = term.toLowerCase();
  const all = q.data?.rows || [];
  const rows = s ? all.filter(r => [r.code, r.inv, r.typeLabel, r.reference, r.note, r.status, String(r.amount)].some(x => (x || '').toLowerCase().includes(s))) : all;
  const invHits = s ? (q.data?.inv || []).filter(i => i.code.toLowerCase().includes(s) || i.plan_name.toLowerCase().includes(s)) : [];

  const exportCsv = () => downloadCsv('transactions' + (term ? '-' + term.replace(/[^\w-]+/g, '_') : ''), ['Date', 'Transaction', 'Type', 'Investment', 'Amount', 'Status', 'Reference', 'Note'],
    rows.map(r => [r.occurred_on, r.code, r.typeLabel, r.inv, Number(r.amount).toFixed(2), r.status, r.reference, r.note]));

  return (
    <>
      <PageHead crumbs={['Transactions']} title="Transactions" sub="Every movement on your investments. Payouts show as paid only after the bank confirms them."
        actions={rows.length ? <button className="btn" onClick={exportCsv}><Icon name="download" />Export CSV</button> : undefined} />
      {term && (
        <div className="note info" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Showing results for <b>“{term}”</b>: {rows.length} transaction{rows.length === 1 ? '' : 's'}.</span>
          {invHits.map(i => <Link key={i.id} to={'/portal/investments/' + i.code}>Open {i.code}</Link>)}
          <a style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={() => setSp({})}>Clear search</a>
        </div>
      )}
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {q.loading && !q.data ? <Loading /> : q.data && (
        <DataTable key={term} rows={rows} rowKey={r => r.id} searchPh="Search by investment, type or reference" sort={0} per={15}
          filters={FILTERS} filterFn={match}
          emptyTitle={all.length ? 'No transactions match' : 'No transactions yet'}
          empty={all.length ? 'Nothing matches these filters.' : 'Deposits, monthly returns and payouts will be listed here once your investment is recorded.'}
          text={r => r.note}
          cols={[
            { h: 'Date', v: r => r.occurred_on, r: r => date(r.occurred_on) },
            { h: 'Transaction', v: r => r.code, m: true },
            { h: 'Type', v: r => r.typeLabel, r: r => <>{r.typeLabel}{r.note && <span className="sub">{r.note}</span>}</> },
            { h: 'Investment', v: r => r.inv, r: r => r.inv ? <Link className="mono" to={'/portal/investments/' + r.inv}>{r.inv}</Link> : '—' },
            { h: 'Amount', n: true, v: r => Number(r.amount), r: r => <span className={Number(r.amount) < 0 ? 'neg' : ''}>{money(r.amount)}</span> },
            { h: 'Status', v: r => r.status, r: r => <LedgerBadge s={r.status} /> },
            { h: 'Reference', v: r => r.reference, r: r => <span className="mono muted">{r.reference || '—'}</span> }
          ]} />
      )}
    </>
  );
}
