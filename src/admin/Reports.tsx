import { ReactNode, useState } from 'react';
import { api, rpc, fetchAll, must } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { money, today, addMonths, daysBetween, investmentLabel, isUnlocked, rateShort, LEDGER_TYPE } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { Accrual, AuditLog, Balance, Dashboard, Investment, LedgerEntry, Payout, Plan, PlanVersion, Profile, Branch } from '../lib/types';
import { ErrorNote, Loading, PageHead, Empty, useAction } from '../ui/kit';
import { Icon } from '../ui/Icon';
import { monthLabel } from '../ui/Charts';

type Cell = string | number | null | undefined;
type Person = Pick<Profile, 'id' | 'code' | 'full_name' | 'email' | 'phone' | 'city' | 'kyc_status' | 'account_status' | 'created_at' | 'role' | 'bank_name' | 'bank_account_masked' | 'bank_ifsc' | 'branch_id'>;

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const n2 = (v: number | string | null | undefined) => (v == null ? '' : Number(v).toFixed(2));
const nameOf = (p?: { full_name: string; email: string }) => (p ? p.full_name || p.email : '');

async function people() {
  const ps = await fetchAll<Person>((a, b) => api.from('profiles').select('id, code, full_name, email, phone, city, kyc_status, account_status, created_at, role, bank_name, bank_account_masked, bank_ifsc, branch_id').range(a, b));
  return new Map(ps.map(p => [p.id, p]));
}
const branchNames = async () => new Map((must(await api.from('branches').select('*')) as Branch[]).map(b => [b.id, b.name]));
const investments = () => fetchAll<Investment>((a, b) => api.from('investments').select('*').order('created_at').range(a, b));
async function balances() {
  const bs = await fetchAll<Balance>((a, b) => api.from('investment_balances').select('*').range(a, b));
  return new Map(bs.map(b => [b.investment_id, b]));
}
const outstanding = (b?: Balance) => (b ? Number(b.unapproved) + Number(b.approved) + Number(b.processing) : 0);

function RangeInputs({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <div className="f-row">
      <div className="field"><label>From</label><input className="input" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></div>
      <div className="field"><label>To</label><input className="input" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></div>
    </div>
  );
}

function ReportCard({ title, desc, children, onCsv }: { title: string; desc: string; children?: ReactNode; onCsv: () => Promise<number> }) {
  const { busy, run } = useAction();
  const [last, setLast] = useState<number | null>(null);
  return (
    <div className="card"><div className="card-b" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div className="icon-btn" style={{ width: 42, height: 42, background: 'var(--blue-soft)', color: 'var(--blue)', border: 0, flex: 'none' }}><Icon name="report" /></div>
        <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 600 }}>{title}</b><p className="hint">{desc}</p></div>
        <button className="btn sm" disabled={busy} onClick={async () => { const n = await run(onCsv, ['Export ready', title]); if (n !== undefined) setLast(n); }}>
          <Icon name="download" />{busy ? 'Preparing…' : 'CSV'}
        </button>
      </div>
      {children}
      {last != null && <p className="hint">{last ? `Last export: ${last} row${last === 1 ? '' : 's'}.` : 'Last export had no rows for these filters.'}</p>}
    </div></div>
  );
}

export function Reports() {
  const { settings } = useAuth();
  const t = today();
  const yearStart = t.slice(0, 4) + '-01-01';
  const dash = useQuery(() => rpc<Dashboard>('admin_dashboard'), []);

  const [accFrom, setAccFrom] = useState(yearStart), [accTo, setAccTo] = useState(t);
  const [payFrom, setPayFrom] = useState(yearStart), [payTo, setPayTo] = useState(t), [payStatus, setPayStatus] = useState('');
  const [matDays, setMatDays] = useState(90);
  const [ledFrom, setLedFrom] = useState(yearStart), [ledTo, setLedTo] = useState(t);
  const [audFrom, setAudFrom] = useState(addMonths(t, -1)), [audTo, setAudTo] = useState(t);

  const csv = (name: string, headers: string[], rows: Cell[][]) => { downloadCsv(`${name}-${t}`, headers, rows); return rows.length; };

  const portfolio = async () => {
    const [invs, bal, ppl, bn] = await Promise.all([investments(), balances(), people(), branchNames()]);
    return csv('portfolio', ['Investment', 'Investor ID', 'Investor', 'Branch', 'Plan', 'Plan version', 'Rate % / month', 'Principal', 'Monthly return', 'Lock-in months', 'Status', 'Start', 'Maturity',
      'Principal locked / unlocked', 'Periods accrued', 'Accrued (net)', 'Paid', 'Processing', 'Approved', 'Accrued not approved', 'Outstanding', 'Agreement ref', 'Deposit ref'],
      invs.map(i => { const b = bal.get(i.id); const p = ppl.get(i.investor_id); return [i.code, p?.code, nameOf(p), p?.branch_id ? bn.get(p.branch_id) : '', i.plan_name, i.plan_version, i.monthly_rate, n2(i.principal), n2(i.monthly_return), i.lockin_months,
        investmentLabel(i, settings?.approaching_days ?? 60, t), i.start_date, i.maturity_date, LIVE.includes(i.status) ? (isUnlocked(i, t) ? 'Unlocked' : 'Locked') : '', b?.periods_accrued ?? 0, n2(b?.accrued), n2(b?.paid), n2(b?.processing), n2(b?.approved), n2(b?.unapproved),
        n2(outstanding(b)), i.agreement_ref, i.deposit_ref]; }));
  };

  const investorSummary = async () => {
    const [invs, bal, ppl, bn] = await Promise.all([investments(), balances(), people(), branchNames()]);
    const inv = Array.from(ppl.values()).filter(p => p.role === 'investor').sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    return csv('investor-summary', ['Investor ID', 'Name', 'Email', 'Branch', 'Phone', 'City', 'Registered', 'KYC', 'Account', 'Live investments', 'Live principal', 'Unlocked principal', 'Locked principal', 'Accrued (net)', 'Paid', 'Outstanding', 'Next unlock', 'Bank', 'Account no.', 'IFSC'],
      inv.map(p => {
        const mine = invs.filter(i => i.investor_id === p.id);
        const live = mine.filter(i => LIVE.includes(i.status));
        const bs = mine.map(i => bal.get(i.id));
        const next = live.filter(i => !isUnlocked(i, t) && i.lockin_end_date).map(i => i.lockin_end_date as string).sort()[0] || '';
        const unl = live.filter(i => isUnlocked(i, t)).reduce((s, i) => s + Number(i.principal), 0), tot = live.reduce((s, i) => s + Number(i.principal), 0);
        return [p.code, p.full_name, p.email, p.branch_id ? bn.get(p.branch_id) : '', p.phone, p.city, p.created_at.slice(0, 10), p.kyc_status, p.account_status, live.length, n2(tot), n2(unl), n2(tot - unl),
          n2(bs.reduce((s, b) => s + Number(b?.accrued || 0), 0)), n2(bs.reduce((s, b) => s + Number(b?.paid || 0), 0)), n2(bs.reduce((s, b) => s + outstanding(b), 0)), next,
          p.bank_name, p.bank_account_masked, p.bank_ifsc];
      }));
  };

  const accrualRegister = async () => {
    needRange(accFrom, accTo);
    const [acc, invs, ppl, pays] = await Promise.all([
      fetchAll<Accrual>((a, b) => api.from('accruals').select('*').gte('accrual_date', accFrom).lte('accrual_date', accTo).order('accrual_date').range(a, b)),
      investments(), people(),
      fetchAll<Pick<Payout, 'accrual_id' | 'code' | 'status'>>((a, b) => api.from('payouts').select('accrual_id, code, status').range(a, b))
    ]);
    const ib = new Map(invs.map(i => [i.id, i])), pb = new Map(pays.map(p => [p.accrual_id, p]));
    return csv(`accrual-register-${accFrom}-to-${accTo}`, ['Accrual date', 'Investment', 'Investor ID', 'Investor', 'Period', 'Kind', 'Period start', 'Period end', 'Days', 'Days in period', 'Amount', 'Payout', 'Payout status', 'Reason'],
      acc.map(a => { const i = ib.get(a.investment_id); const p = i ? ppl.get(i.investor_id) : undefined; const po = pb.get(a.id);
        return [a.accrual_date, i?.code, p?.code, nameOf(p), a.period_no, a.kind, a.period_start, a.period_end, a.days, a.days_in_period, n2(a.amount), po?.code, po?.status, a.reason]; }));
  };

  const payoutRegister = async () => {
    needRange(payFrom, payTo);
    const [pays, invs, ppl] = await Promise.all([
      fetchAll<Payout>((a, b) => { let qq = api.from('payouts').select('*').gte('due_date', payFrom).lte('due_date', payTo); if (payStatus) qq = qq.eq('status', payStatus); return qq.order('due_date').range(a, b); }),
      investments(), people()
    ]);
    const ib = new Map(invs.map(i => [i.id, i]));
    return csv(`payout-register-${payFrom}-to-${payTo}${payStatus ? '-' + payStatus : ''}`,
      ['Payout', 'Due date', 'Investment', 'Investor ID', 'Investor', 'Amount', 'Status', 'Batch reference', 'Payment reference', 'Paid on', 'Failure reason', 'Approved by', 'Sent by', 'Confirmed by', 'Bank', 'Account no.'],
      pays.map(p => { const v = ppl.get(p.investor_id); return [p.code, p.due_date, ib.get(p.investment_id)?.code, v?.code, nameOf(v), n2(p.amount), p.status, p.batch_ref, p.payment_ref, p.paid_on, p.failure_reason,
        nameOf(ppl.get(p.approved_by || '')), nameOf(ppl.get(p.sent_by || '')), nameOf(ppl.get(p.confirmed_by || '')), v?.bank_name, v?.bank_account_masked]; }));
  };

  const maturities = async () => {
    const until = new Date(Date.parse(t + 'T00:00:00Z') + matDays * 86400000).toISOString().slice(0, 10);
    const [invs, ppl] = await Promise.all([
      fetchAll<Investment>((a, b) => api.from('investments').select('*').in('status', ['active', 'redemption_requested', 'redemption_processing']).gte('maturity_date', t).lte('maturity_date', until).order('maturity_date').range(a, b)),
      people()
    ]);
    return csv(`upcoming-unlocks-${matDays}d`, ['Lock-in ends', 'Days left', 'Investment', 'Investor ID', 'Investor', 'Email', 'Phone', 'Plan', 'Principal', 'Lock-in months', 'Status'],
      invs.map(i => { const p = ppl.get(i.investor_id); return [i.maturity_date, i.maturity_date ? daysBetween(t, i.maturity_date) : '', i.code, p?.code, nameOf(p), p?.email, p?.phone, i.plan_name, n2(i.principal), i.lockin_months,
        investmentLabel(i, settings?.approaching_days ?? 60, t)]; }));
  };

  const branchSummary = async () => {
    const d = await rpc<Dashboard>('admin_dashboard');
    const rows: Cell[][] = (d.by_branch || []).map(b => [b.name, b.investors, n2(b.principal), n2(b.unlocked), n2(b.locked), n2(b.accrued), n2(b.paid),
      (b.by_rate || []).map(r => `${rateShort(r.rate)}: ${r.investors} investor${Number(r.investors) === 1 ? '' : 's'}, ${n2(r.principal)}`).join('; ')]);
    rows.push(['No branch', d.unassigned_investors, n2(d.unassigned_principal), '', '', '', '', '']);
    rows.push(['Total', d.total_investors, n2(d.principal_invested), n2(d.unlocked_principal), n2(d.locked_principal), n2(d.accrued_total), n2(d.paid_total), '']);
    return csv('branch-summary', ['Branch', 'Investors', 'Principal invested', 'Unlocked principal', 'Locked principal', 'Returns accrued', 'Returns paid', 'By monthly ROI'], rows);
  };

  const planVersions = async () => {
    const [plans, vers, ppl] = await Promise.all([
      api.from('plans').select('*').then(r => must(r) as Plan[]),
      fetchAll<PlanVersion>((a, b) => api.from('plan_versions').select('*').order('created_at').range(a, b)), people()
    ]);
    const pb = new Map(plans.map(p => [p.id, p]));
    return csv('plan-versions', ['Plan code', 'Plan name', 'Plan status', 'Version', 'Current', 'Rate % / month', 'Min amount', 'Max amount', 'Lock-in options (months)', 'Custom lock-in', 'Eligible from', 'Eligible to',
      'Payout lag days', 'Effective from', 'Change reason', 'Created by', 'Created at'],
      vers.map(v => { const p = pb.get(v.plan_id); return [p?.code, p?.name, p?.status, v.version, p?.current_version === v.version ? 'yes' : '', v.monthly_rate, n2(v.min_amount), n2(v.max_amount), v.lockin_options.join(' / '),
        v.allow_custom_lockin ? 'yes' : 'no', v.eligible_from, v.eligible_to, v.payout_lag_days, v.effective_from, v.change_reason,
        nameOf(ppl.get(v.created_by || '')), v.created_at]; }));
  };

  const ledger = async () => {
    needRange(ledFrom, ledTo);
    const [led, invs, ppl] = await Promise.all([
      fetchAll<LedgerEntry>((a, b) => api.from('ledger_entries').select('*').gte('occurred_on', ledFrom).lte('occurred_on', ledTo).order('occurred_on').order('created_at').range(a, b)), investments(), people()
    ]);
    const ib = new Map(invs.map(i => [i.id, i]));
    return csv(`ledger-${ledFrom}-to-${ledTo}`, ['Transaction', 'Date', 'Type', 'Investment', 'Investor ID', 'Investor', 'Amount', 'Status', 'Reference', 'Note', 'Recorded at'],
      led.map(l => { const p = ppl.get(l.investor_id || ''); return [l.code, l.occurred_on, LEDGER_TYPE[l.type] || l.type, ib.get(l.investment_id || '')?.code, p?.code, nameOf(p), n2(l.amount), l.status, l.reference, l.note, l.created_at]; }));
  };

  const audit = async () => {
    needRange(audFrom, audTo);
    const logs = await fetchAll<AuditLog>((a, b) => api.from('audit_logs').select('*').gte('at', audFrom).lt('at', addDay(audTo)).order('at').range(a, b));
    return csv(`audit-${audFrom}-to-${audTo}`, ['ID', 'Time (UTC)', 'Actor', 'Action', 'Entity', 'Record', 'Reason', 'Before', 'After'],
      logs.map(l => [l.id, l.at, l.actor_name, l.action, l.entity_type, l.entity_label, l.reason, l.before == null ? '' : JSON.stringify(l.before), l.after == null ? '' : JSON.stringify(l.after)]));
  };

  const monthly = dash.data?.monthly || [];
  const monthlyCsv = () => csv('monthly-summary', ['Month', 'New principal invested', 'Returns accrued (net)', 'Returns paid'], monthly.map(m => [m.month, n2(m.invested), n2(m.accrued), n2(m.paid)]));
  const tot = monthly.reduce((s, m) => ({ invested: s.invested + Number(m.invested), accrued: s.accrued + Number(m.accrued), paid: s.paid + Number(m.paid) }), { invested: 0, accrued: 0, paid: 0 });

  return (
    <>
      <PageHead crumbs={['Reports']} title="Reports" sub="Every report is generated from the live ledger, accrual, payout and audit records at the moment you download it." />
      <div className="card">
        <div className="card-h"><h3>Monthly summary</h3><div className="r">Last 8 months{monthly.length > 0 && <button className="btn sm" onClick={monthlyCsv}><Icon name="download" />CSV</button>}</div></div>
        {dash.error ? <div className="card-b"><ErrorNote msg={dash.error} retry={dash.reload} /></div> : !dash.data ? <div className="card-b"><Loading rows={3} /></div> : monthly.length ? (
          <div className="tbl"><table>
            <thead><tr><th>Month</th><th className="n">New principal invested</th><th className="n">Returns accrued (net)</th><th className="n">Returns paid</th></tr></thead>
            <tbody>
              {monthly.slice().reverse().map(m => (
                <tr key={m.month}><td>{monthLabel(m.month)} {m.month.slice(0, 4)}</td><td className="n">{money(m.invested)}</td><td className={'n' + (Number(m.accrued) < 0 ? ' neg' : '')}>{money(m.accrued)}</td><td className="n">{money(m.paid)}</td></tr>
              ))}
              <tr><td><b>Total</b></td><td className="n"><b>{money(tot.invested)}</b></td><td className="n"><b>{money(tot.accrued)}</b></td><td className="n"><b>{money(tot.paid)}</b></td></tr>
            </tbody>
          </table></div>
        ) : <div className="card-b"><Empty title="No activity yet">Monthly totals appear once investments are activated and returns accrue.</Empty></div>}
      </div>
      <div className="grid g-1-1">
        <ReportCard title="Portfolio" desc="Every investment with its contractual terms and live balances: accrued, paid, processing and outstanding." onCsv={portfolio} />
        <ReportCard title="Investor summary" desc="One row per investor: branch, KYC, account status, live, unlocked and locked principal, accrued, paid, outstanding and next unlock." onCsv={investorSummary} />
        <ReportCard title="Accrual register" desc="Every accrual entry in the period (by accrual date), including stubs and reversals, with its payout status." onCsv={accrualRegister}>
          <RangeInputs from={accFrom} to={accTo} setFrom={setAccFrom} setTo={setAccTo} />
        </ReportCard>
        <ReportCard title="Payout register" desc="Payouts due in the period with status, batch and bank references and who approved, sent and confirmed them." onCsv={payoutRegister}>
          <RangeInputs from={payFrom} to={payTo} setFrom={setPayFrom} setTo={setPayTo} />
          <div className="field"><label>Status</label>
            <select className="input" value={payStatus} onChange={e => setPayStatus(e.target.value)}>
              <option value="">All statuses</option><option value="accrued">Accrued</option><option value="approved">Approved</option><option value="processing">Processing</option>
              <option value="paid">Paid</option><option value="failed">Failed</option><option value="cancelled">Reversed</option>
            </select>
          </div>
        </ReportCard>
        <ReportCard title="Upcoming unlocks" desc="Investments whose lock-in ends in the next N days, with contact details." onCsv={maturities}>
          <div className="field"><label>Next (days)</label><input className="input" type="number" min={1} max={3650} value={matDays} onChange={e => setMatDays(Math.max(1, parseInt(e.target.value || '1', 10)))} /></div>
        </ReportCard>
        <ReportCard title="Branch summary" desc="Bangalore and Tumkur side by side: investors, principal, unlocked and locked principal, returns, and the split by monthly ROI." onCsv={branchSummary} />
        <ReportCard title="Plan version history" desc="Every plan version with its rate, limits, lock-in options, effective date and the reason for each change." onCsv={planVersions} />
        <ReportCard title="Transaction ledger" desc="The full append-only ledger for a date range, including reversing entries." onCsv={ledger}>
          <RangeInputs from={ledFrom} to={ledTo} setFrom={setLedFrom} setTo={setLedTo} />
        </ReportCard>
        <ReportCard title="Administrative activity" desc="Audit log entries for a date range, with reasons and before/after values." onCsv={audit}>
          <RangeInputs from={audFrom} to={audTo} setFrom={setAudFrom} setTo={setAudTo} />
        </ReportCard>
      </div>
    </>
  );
}

function needRange(from: string, to: string) {
  if (!from || !to) throw new Error('Choose both a start and an end date.');
  if (from > to) throw new Error('The start date must be on or before the end date.');
}

function addDay(iso: string) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}
