import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, moneyShort, date, dateShort, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { Accrual, Dashboard } from '../lib/types';
import { Badge, PayBadge, Kpi, ErrorNote, Loading, PageHead, Modal, Field, IconBtn, useAction, useToast } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';

type Person = { id: string; code: string | null; full_name: string; email: string };
type Inv = { id: string; code: string; investor_id: string; principal: number; monthly_rate: number; monthly_return: number; status: string; start_date: string | null };
type PayLite = { id: string; code: string; accrual_id: string; status: string };

interface Row extends Accrual {
  inv?: Inv;
  investor?: Person;
  payout?: PayLite;
  reversed: boolean;
}

const ACCRUING = ['active', 'redemption_requested', 'redemption_processing'];
const KIND: Record<string, [string, string]> = { regular: ['Regular', 'b-blue'], stub: ['Stub (pro-rata)', 'b-violet'], reversal: ['Reversal', 'b-red'] };
const nameOf = (p?: Person) => (p ? p.full_name || p.email : '—');

async function load() {
  const [acc, pays, invs, people, dash] = await Promise.all([
    fetchAll<Accrual>((a, b) => api.from('accruals').select('*').order('accrual_date', { ascending: false }).order('created_at', { ascending: false }).range(a, b)),
    fetchAll<PayLite>((a, b) => api.from('payouts').select('id, code, accrual_id, status').range(a, b)),
    fetchAll<Inv>((a, b) => api.from('investments').select('id, code, investor_id, principal, monthly_rate, monthly_return, status, start_date').range(a, b)),
    fetchAll<Person>((a, b) => api.from('profiles').select('id, code, full_name, email').range(a, b)),
    rpc<Dashboard>('admin_dashboard')
  ]);
  const invBy = new Map(invs.map(i => [i.id, i]));
  const pplBy = new Map(people.map(p => [p.id, p]));
  const payBy = new Map(pays.map(p => [p.accrual_id, p]));
  const reversedIds = new Set(acc.filter(a => a.reverses_id).map(a => a.reverses_id as string));
  const rows: Row[] = acc.map(a => {
    const inv = invBy.get(a.investment_id);
    return { ...a, inv, investor: inv ? pplBy.get(inv.investor_id) : undefined, payout: payBy.get(a.id), reversed: reversedIds.has(a.id) };
  });
  const accruing = invs.filter(i => ACCRUING.includes(i.status) && i.start_date);
  return { rows, dash, accruing };
}

export function Accruals() {
  const q = useQuery(load, []);
  const { busy, run } = useAction();
  const toast = useToast();
  const [rev, setRev] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const t = today();
  const month = t.slice(0, 7);

  const rows = q.data?.rows || [];
  const thisMonth = useMemo(() => rows.filter(r => r.kind !== 'reversal' && r.accrual_date.slice(0, 7) === month), [rows, month]);
  const reversals = useMemo(() => rows.filter(r => r.kind === 'reversal'), [rows]);

  const canReverse = (r: Row) => r.kind === 'regular' && !r.reversed && (!r.payout || !['paid', 'processing', 'cancelled'].includes(r.payout.status));

  const runJob = async () => {
    const res = await run(() => rpc<{ as_of: string; created: number }>('admin_run_accruals'));
    if (!res) return;
    const n = Number(res.created || 0);
    toast('Accrual job complete', n
      ? `${n} new accrual${n === 1 ? '' : 's'} posted as of ${date(res.as_of)}. Payouts were created for each.`
      : `No new accruals as of ${date(res.as_of)}. Every period due was already posted, so nothing was duplicated.`);
    refreshAll();
  };

  const doReverse = async () => {
    if (!rev) return;
    if (!reason.trim()) { setErr('Enter the reason for the reversal. It is saved to the audit log.'); return; }
    const ok = await run(() => rpc('admin_reverse_accrual', { p_accrual: rev.id, p_reason: reason.trim() }).then(() => true),
      ['Accrual reversed', `${rev.inv?.code || ''} · period ${rev.period_no} · reversing entry of ${money(-rev.amount)} posted`]);
    if (ok) { setRev(null); setReason(''); setErr(null); refreshAll(); }
  };

  const exportCsv = () => downloadCsv(`accruals-${t}`,
    ['Investment', 'Investor ID', 'Investor', 'Period', 'Kind', 'Period start', 'Period end', 'Accrual date', 'Days', 'Days in period', 'Amount', 'Payout', 'Payout status', 'Reason'],
    rows.map(r => [r.inv?.code, r.investor?.code, nameOf(r.investor), r.period_no, r.kind, r.period_start, r.period_end, r.accrual_date, r.days, r.days_in_period,
      Number(r.amount).toFixed(2), r.payout?.code || '', r.payout?.status || '', r.reason || '']));

  const cols: Col<Row>[] = [
    { h: 'Investment', v: r => r.inv?.code, r: r => r.inv ? <Link className="mono" to={`/admin/investments/${r.inv.code}`}>{r.inv.code}</Link> : '—' },
    { h: 'Investor', v: r => nameOf(r.investor), r: r => r.investor?.code ? <><Link to={`/admin/investors/${r.investor.code}`}>{nameOf(r.investor)}</Link><span className="sub">{r.investor.code}</span></> : nameOf(r.investor) },
    { h: 'Period', v: r => r.period_no, r: r => <>#{r.period_no}<span className="sub">{dateShort(r.period_start)} – {dateShort(r.period_end)}{r.kind === 'stub' ? ` · ${r.days} of ${r.days_in_period} days` : ''}</span></> },
    { h: 'Accrued on', v: r => r.accrual_date, r: r => date(r.accrual_date) },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => <span className={Number(r.amount) < 0 ? 'neg' : ''}>{money(r.amount)}</span> },
    { h: 'Kind', v: r => r.kind, r: r => <Badge cls={KIND[r.kind][1]}>{KIND[r.kind][0]}</Badge> },
    {
      h: 'Payout', v: r => r.payout?.status || '', r: r => r.kind === 'reversal'
        ? <span className="muted">Reverses period {r.period_no}{r.reason ? <span className="sub">{r.reason}</span> : null}</span>
        : r.payout ? <><PayBadge s={r.payout.status} /><span className="sub mono">{r.payout.code}</span></> : <span className="muted">—</span>
    },
    { h: '', r: r => canReverse(r) ? <button className="btn sm danger" onClick={() => { setRev(r); setReason(''); setErr(null); }}>Reverse</button> : null }
  ];

  const d = q.data?.dash;
  const accruing = q.data?.accruing || [];
  return (
    <>
      <PageHead crumbs={['Monthly ROI & Accruals']} title="Monthly ROI & Accruals"
        sub="The accrual job posts each investment's monthly return on its start-date anniversary. It runs automatically every hour and can be run on demand."
        actions={<>
          <IconBtn icon="download" onClick={exportCsv} disabled={!rows.length}>Export CSV</IconBtn>
          <IconBtn icon="refresh" className="primary" onClick={runJob} disabled={busy}>{busy ? 'Running…' : 'Run accrual job now'}</IconBtn>
        </>} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <>
          <div className="kpis k4">
            <Kpi label="Accrued this month" value={money(thisMonth.reduce((s, r) => s + Number(r.amount), 0))} sub={`${thisMonth.length} accrual entr${thisMonth.length === 1 ? 'y' : 'ies'}`} />
            <Kpi label="Accrued to date" value={moneyShort(d?.accrued_total)} sub="Net of reversals" tip="Sum of every accrual entry, including reversing entries. Accrued is not the same as paid." />
            <Kpi label="Reversed" value={money(d?.reversed_total)} cls={Number(d?.reversed_total) < 0 ? 'neg' : ''} sub={`${reversals.length} reversing entr${reversals.length === 1 ? 'y' : 'ies'}`} />
            <Kpi label="Investments accruing" value={accruing.length} sub={`${money(accruing.reduce((s, i) => s + Number(i.monthly_return), 0))} per month`} tip="Investments inside their lock-in that still earn monthly returns." />
          </div>
          <div className="note info">
            <b>How returns accrue.</b> Monthly return = original principal × monthly ROI ÷ 100, rounded to 2 decimals per entry. It is simple interest on the original
            principal: returns are never added to principal and never compound. Period <i>k</i> accrues on the start date + <i>k</i> calendar months; when that day
            does not exist the date is clamped to month end (31 May + 6 months = 30 Nov). Each investment can have only one accrual per period, so re-running the job
            never creates duplicates. A wrong accrual is corrected with a reversing entry; nothing is deleted.
          </div>
          <DataTable rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search investment, investor, period"
            text={r => `${r.inv?.code || ''} ${nameOf(r.investor)} ${r.investor?.code || ''} ${r.payout?.code || ''}`}
            filters={[['All', 'all'], ['This month', 'month'], ['Reversals', 'rev']]}
            filterFn={(r, f) => f === 'all' || (f === 'month' && r.accrual_date.slice(0, 7) === month) || (f === 'rev' && r.kind === 'reversal')}
            sort={3} dir={-1} per={15}
            emptyTitle={rows.length ? 'No matching accruals' : 'No accruals yet'}
            empty={rows.length ? 'No accrual entries match these filters.' : 'Returns start accruing one month after an investment\'s deposit is confirmed. Activate an investment, then run the accrual job.'} />
        </>
      )}
      {rev && (
        <Modal title={`Reverse accrual for ${rev.inv?.code || ''} · period ${rev.period_no}?`}
          sub="A reversing entry of the opposite amount is posted and the unpaid payout is cancelled. Nothing is deleted: the original accrual stays in the register and the ledger."
          onClose={() => setRev(null)}
          foot={<><button className="btn ghost" onClick={() => setRev(null)}>Cancel</button><button className="btn danger" onClick={doReverse} disabled={busy}>{busy ? 'Posting…' : 'Post reversing entry'}</button></>}>
          <div className="form">
            <dl className="kv">
              <dt>Investor</dt><dd>{nameOf(rev.investor)}</dd>
              <dt>Period</dt><dd>{date(rev.period_start)} – {date(rev.period_end)}</dd>
              <dt>Accrued on</dt><dd>{date(rev.accrual_date)}</dd>
              <dt>Amount</dt><dd>{money(rev.amount)}</dd>
              <dt>Reversing entry</dt><dd className="neg">{money(-rev.amount)}</dd>
              <dt>Payout</dt><dd>{rev.payout ? <PayBadge s={rev.payout.status} /> : '—'}</dd>
            </dl>
            <Field label="Reason (required, saved to audit log)" err={err}>
              <input className={'input' + (err ? ' bad' : '')} value={reason} onChange={e => { setReason(e.target.value); setErr(null); }} placeholder="e.g. Accrued on wrong start date; corrected per IC-2026-14" />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
