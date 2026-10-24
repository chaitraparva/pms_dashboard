import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, must } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { openDocument } from '../lib/docs';
import { date, dateShort, addMonths, investmentLabel, isUnlocked, LEDGER_TYPE, lockinText, money, ordinal, pct, rate, rateShort } from '../lib/format';
import { Badge, Empty, ErrorNote, InvBadge, Kpi, LedgerBadge, Loading, PageHead, PayBadge, useAction } from '../ui/kit';
import { DataTable } from '../ui/DataTable';
import { Icon } from '../ui/Icon';
import type { Accrual, DocumentRow, Investment, Payout } from '../lib/types';
import { addDays, bal, codeMap, daysLeft, isLive, loadLedger, loadPortfolio, nextAccrual, projectedRemaining, unpaid } from './data';
import { BackLink, maturityText, Prose, Steps, Tracker, useApproaching } from './parts';

const VIEWS: [string, string][] = [['All', 'all'], ['Unlocked', 'unlocked'], ['Locked', 'locked'], ['Pending funding', 'pending_funding'], ['Closed', 'closed']];
const inView = (i: Investment, f: string) => f === 'all' || (f === 'unlocked' ? isUnlocked(i) : f === 'locked' ? isLive(i) && !isUnlocked(i)
  : f === 'closed' ? ['redeemed', 'cancelled'].includes(i.status) : i.status === f);

export function Investments() {
  const { profile } = useAuth();
  const approaching = useApproaching();
  const [sp, setSp] = useSearchParams();
  const view = VIEWS.some(v => v[1] === sp.get('view')) ? sp.get('view')! : 'all';
  const [layout, setLayout] = useState<'table' | 'cards'>('table');
  const nav = useNavigate();
  const q = useQuery(async () => {
    const [p, led] = await Promise.all([loadPortfolio(profile!.id), loadLedger(profile!.id)]);
    return { ...p, history: led.filter(l => ['deposit', 'allocation', 'principal_redemption', 'refund'].includes(l.type)) };
  }, [profile?.id]);
  const inv = q.data?.investments || [];
  const live = inv.filter(isLive);
  const total = live.reduce((s, i) => s + Number(i.principal), 0);
  const unlocked = live.filter(i => isUnlocked(i));
  const unlockedSum = unlocked.reduce((s, i) => s + Number(i.principal), 0);
  const shown = inv.filter(i => inView(i, view));
  const codes = codeMap(inv);
  const title = view === 'unlocked' ? 'Unlocked principal' : view === 'locked' ? 'Locked principal' : 'My investments';
  const crumbs = view === 'unlocked' || view === 'locked' ? ['My Investments', title] : ['My Investments'];

  return (
    <>
      {view !== 'all' && <BackLink to="/portal">Overview</BackLink>}
      <PageHead crumbs={crumbs} title={title}
        sub={q.data ? (view === 'unlocked'
          ? `${unlocked.length} investment${unlocked.length === 1 ? '' : 's'} whose lock-in has ended · ${money(unlockedSum)}`
          : view === 'locked' ? `${live.length - unlocked.length} investment${live.length - unlocked.length === 1 ? '' : 's'} still in lock-in · ${money(total - unlockedSum)}`
          : `${inv.length} investment${inv.length === 1 ? '' : 's'} · ${money(total)} total principal invested`) : undefined}
        actions={inv.length ? <div className="chips">
          <button className={'chip ' + (layout === 'table' ? 'on' : '')} onClick={() => setLayout('table')}>Table</button>
          <button className={'chip ' + (layout === 'cards' ? 'on' : '')} onClick={() => setLayout('cards')}>Cards</button>
        </div> : undefined} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {view === 'unlocked' && q.data && (
        <div className="note info">Unlocked principal is the principal of investments whose lock-in period has ended. It stays recorded in your name. It is not a return, and it is not paid out or reinvested automatically.</div>
      )}
      {q.loading && !q.data ? <Loading /> : q.data && !inv.length ? (
        <div className="card"><div className="card-b"><Empty title="You have no investments yet">Your advisor will record your investment once funds are received.</Empty></div></div>
      ) : q.data && layout === 'table' ? (
        <DataTable key={view} rows={inv} rowKey={i => i.id} href={i => '/portal/investments/' + i.code} searchPh="Search by investment or plan" sort={1} per={20}
          filters={VIEWS} filterFn={inView} initialFilter={view}
          emptyTitle={view === 'unlocked' ? 'No unlocked principal yet' : 'Nothing here'}
          empty={view === 'unlocked' ? 'An investment appears here once its lock-in period has ended.' : 'No investments match this filter.'}
          cols={[
            { h: 'Investment', v: i => i.code, m: true, r: i => <>{i.code}<span className="sub">{i.plan_name}</span></> },
            { h: 'Investment date', v: i => i.start_date || i.expected_start || '', r: i => <>{date(i.start_date || i.expected_start)}{!i.start_date && i.expected_start && <span className="sub">expected</span>}</> },
            { h: 'Principal', n: true, v: i => Number(i.principal), r: i => money(i.principal) },
            { h: 'Monthly ROI', v: i => Number(i.monthly_rate), r: i => rateShort(i.monthly_rate) },
            { h: 'Lock-in', v: i => i.lockin_months, r: i => lockinText(i.lockin_months) },
            { h: 'Maturity date', v: i => i.maturity_date || '', r: i => date(i.maturity_date) },
            { h: 'Days left', n: true, v: i => (i.maturity_date ? daysLeft(i) : null), r: i => (i.maturity_date ? String(daysLeft(i)) : '—') },
            { h: 'Accrued', n: true, v: i => Number(bal(q.data!, i.id).accrued), r: i => money(bal(q.data!, i.id).accrued) },
            { h: 'Paid', n: true, v: i => Number(bal(q.data!, i.id).paid), r: i => <span className="pos">{money(bal(q.data!, i.id).paid)}</span> },
            { h: 'Status', v: i => investmentLabel(i, approaching), r: i => <InvBadge i={i} approachingDays={approaching} /> }
          ]} />
      ) : q.data ? (
        <>
          <div className="chips" style={{ marginBottom: 12 }}>
            {VIEWS.map(v => <button key={v[1]} className={'chip ' + (view === v[1] ? 'on' : '')} onClick={() => setSp(v[1] === 'all' ? {} : { view: v[1] })}>{v[0]}</button>)}
          </div>
          {!shown.length && <div className="card"><div className="card-b"><Empty title="Nothing here">No investments match this filter.</Empty></div></div>}
          <div className="inv-cards">
            {shown.map(i => {
              const b = bal(q.data!, i.id);
              return (
                <div key={i.id} className="card" style={{ cursor: 'pointer' }} onClick={() => nav('/portal/investments/' + i.code)}>
                  <div className="card-h"><h3 className="mono">{i.code}</h3><div className="r"><InvBadge i={i} approachingDays={approaching} /></div></div>
                  <div className="card-b" style={{ display: 'grid', gap: 14 }}>
                    <div><div className="num" style={{ fontSize: 24, fontWeight: 700 }}>{money(i.principal)}</div><div className="hint">{i.plan_name} · {rate(i.monthly_rate)} · {lockinText(i.lockin_months)} lock-in</div></div>
                    <Tracker i={i} compact />
                    <dl className="kv"><dt>Monthly return</dt><dd>{money(i.monthly_return)}</dd><dt>Accrued</dt><dd>{money(b.accrued)}</dd><dt>Received</dt><dd className="pos">{money(b.paid)}</dd></dl>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {q.data && view === 'all' && q.data.history.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Investment history</h3><div className="r"><Link to="/portal/transactions">All transactions</Link></div></div>
          <div className="tbl"><table>
            <thead><tr><th>Date</th><th>Event</th><th>Investment</th><th className="n">Amount</th><th>Status</th><th>Reference</th></tr></thead>
            <tbody>
              {q.data.history.map(l => (
                <tr key={l.id}>
                  <td>{date(l.occurred_on)}</td><td>{LEDGER_TYPE[l.type] || l.type}{l.note && <span className="sub">{l.note}</span>}</td>
                  <td className="m">{l.investment_id ? <Link to={'/portal/investments/' + codes[l.investment_id]}>{codes[l.investment_id]}</Link> : '—'}</td>
                  <td className="n">{money(l.amount)}</td><td><LedgerBadge s={l.status} /></td><td className="m">{l.reference || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </>
  );
}

interface Row { k: number; from: string; to: string; on: string; amount: number; acc: Accrual | null; pay: Payout | null; reversed: boolean }

/** Month-by-month schedule: real accruals and payouts where they exist, otherwise the scheduled month. */
function schedule(i: Investment, accruals: Accrual[], payouts: Payout[]): Row[] {
  if (!i.start_date) return [];
  const mine = accruals.filter(a => a.investment_id === i.id);
  const reversedIds = new Set(mine.filter(a => a.kind === 'reversal' && a.reverses_id).map(a => a.reverses_id!));
  const payBy = Object.fromEntries(payouts.filter(p => p.investment_id === i.id).map(p => [p.accrual_id, p]));
  const rows: Row[] = [];
  for (let k = 1; k <= i.lockin_months; k++) {
    const acc = mine.find(a => a.period_no === k && a.kind !== 'reversal') || null;
    const from = acc ? acc.period_start : addMonths(i.start_date, k - 1);
    const end = addMonths(i.start_date, k);
    rows.push({ k, from, to: acc ? acc.period_end : addDays(end, -1), on: acc ? acc.accrual_date : end, amount: acc ? Number(acc.amount) : Number(i.monthly_return), acc, pay: acc ? payBy[acc.id] || null : null, reversed: acc ? reversedIds.has(acc.id) : false });
  }
  return rows;
}

export function InvestmentDetail() {
  const { code } = useParams();
  const { profile, settings } = useAuth();
  const approaching = useApproaching();
  const nav = useNavigate();
  const { run } = useAction();
  const q = useQuery(async () => {
    const p = await loadPortfolio(profile!.id);
    const i = p.investments.find(x => x.code === code);
    const docs = i ? must(await api.from('documents').select('*').eq('investment_id', i.id).order('created_at', { ascending: false })) as DocumentRow[] : [];
    return { p, i, docs };
  }, [profile?.id, code]);

  if (q.loading && !q.data) return <><PageHead crumbs={['My Investments', code || '']} title={code || ''} /><Loading /></>;
  if (q.error) return <><PageHead crumbs={['My Investments', code || '']} title={code || ''} /><ErrorNote msg={q.error} retry={q.reload} /></>;
  const i = q.data?.i;
  if (!q.data || !i) return (
    <>
      <PageHead crumbs={['My Investments', 'Not found']} title="Investment not found" />
      <Empty title="Investment not found">We couldn't find that investment in your account. <Link to="/portal/investments">Back to my investments</Link></Empty>
    </>
  );
  const { p, docs } = q.data;
  const b = bal(p, i.id);
  const rows = schedule(i, p.accruals, p.payouts);
  const next = nextAccrual(i, b);
  const unlocked = isUnlocked(i);
  const left = daysLeft(i);
  const stub = p.accruals.filter(a => a.investment_id === i.id && a.kind === 'stub');

  return (
    <>
      <BackLink to="/portal/investments">My investments</BackLink>
      <PageHead crumbs={['My Investments', i.code]} title={i.code}
        actions={<button className="btn" onClick={() => nav('/portal/statement')}><Icon name="download" />Account statement</button>}>
        <h1><span className="mono">{i.code}</span> · {i.plan_name} <InvBadge i={i} approachingDays={approaching} /></h1>
        <p>{money(i.principal)} at {rate(i.monthly_rate)}, simple interest on the original principal</p>
      </PageHead>

      {i.status === 'pending_funding' && <div className="note info"><b>Awaiting funds.</b> This investment becomes active once your deposit is confirmed. Your start date, maturity date and monthly schedule are fixed at that point.</div>}
      {i.status === 'cancelled' && <div className="note">This investment was cancelled{i.cancelled_reason ? ': ' + i.cancelled_reason : '.'}</div>}

      {i.start_date && (
        <div className="card"><div className="card-b" style={{ display: 'grid', gap: 20 }}>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div className="hint">{left ? 'Lock-in ends in' : 'Lock-in ended on ' + date(i.lockin_end_date)}</div>
              <div className="countdown num">{left ? `${left} days` : '—'}</div>
            </div>
            {i.status === 'redeemed' ? (
              <div className="note" style={{ flex: 1, minWidth: 260 }}><b>Closed.</b> This investment has been settled. Its history is kept under Transactions.</div>
            ) : unlocked ? (
              <div className="note ok" style={{ flex: 1, minWidth: 260 }}><b>Principal unlocked.</b> The {lockinText(i.lockin_months)} lock-in ended on {date(i.lockin_end_date)}. Your principal of {money(i.principal)} now counts as unlocked principal. Nothing is paid out or reinvested automatically.</div>
            ) : (
              <div className="note lock" style={{ flex: 1, minWidth: 260 }}><b>Principal locked.</b> Your agreement has a {lockinText(i.lockin_months)} lock-in. The principal unlocks on <b>{date(i.lockin_end_date)}</b>.</div>
            )}
          </div>
          <div className="grid g-1-1-1" style={{ fontSize: 13 }}>
            <div><div className="hint">Start date</div><b>{date(i.start_date)}</b></div>
            <div><div className="hint">Lock-in period</div><b>{lockinText(i.lockin_months)}</b></div>
            <div><div className="hint">Maturity date</div><b>{date(i.maturity_date)}</b></div>
          </div>
          <Tracker i={i} />
          <Steps i={i} />
        </div></div>
      )}

      <div className="kpis">
        <Kpi label="Monthly return" value={money(i.monthly_return)} sub={`${pct(i.monthly_rate)} × ${money(i.principal)}`} />
        <Kpi label="Returns accrued" value={money(b.accrued)} sub={`${b.periods_accrued} of ${i.lockin_months} months`} />
        <Kpi label="Returns received" value={money(b.paid)} cls="pos" sub="Confirmed payments" />
        <Kpi label="Accrued, not yet paid" value={money(unpaid(b))} sub={Number(b.processing) ? money(b.processing) + ' processing' : Number(b.approved) ? money(b.approved) + ' approved' : 'Awaiting payout'} subCls="warn" />
        <Kpi label="Projected remaining" value={money(projectedRemaining(i, b))} sub={next ? `Projected · next accrual ${dateShort(next.date)}` : 'Projected'} subCls="warn" tip="Months not yet accrued at your contract's monthly return. An estimate, not a guarantee." />
      </div>

      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>Month-by-month schedule</h3><div className="r">Payout day: {i.start_date ? ordinal(+i.start_date.slice(8, 10)) + ' of each month*' : 'set at activation'}</div></div>
          <div className="tbl">
            {rows.length ? (
              <table>
                <thead><tr><th>Month</th><th>Period</th><th className="n">Return</th><th>Accrues on</th><th>Status</th><th>Reference</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.k}>
                      <td className="m">{r.k}</td>
                      <td>{dateShort(r.from)} – {dateShort(r.to)}</td>
                      <td className={'n ' + (r.acc ? '' : 'muted')}>{money(r.amount)}</td>
                      <td>{date(r.on)}</td>
                      <td>{r.reversed ? <Badge cls="b-grey">Reversed</Badge> : r.pay ? <PayBadge s={r.pay.status} /> : r.acc ? <Badge cls="b-grey">Accrued</Badge>
                        : i.status === 'active' ? <Badge cls="b-violet sq">Scheduled</Badge> : <Badge cls="b-grey">Not accrued</Badge>}{r.acc?.kind === 'stub' && <span className="sub">Pro-rata {r.acc.days}/{r.acc.days_in_period} days</span>}</td>
                      <td className="m">{r.pay?.status === 'paid' ? <>{r.pay.payment_ref}<span className="sub">{date(r.pay.paid_on)}</span></> : r.pay ? <span className="sub">Due {date(r.pay.due_date)}</span> : '—'}</td>
                    </tr>
                  ))}
                  {stub.filter(s => s.period_no > i.lockin_months).map(s => (
                    <tr key={s.id}><td className="m">{s.period_no}</td><td>{dateShort(s.period_start)} – {dateShort(s.period_end)}</td><td className="n">{money(s.amount)}</td><td>{date(s.accrual_date)}</td><td><Badge cls="b-grey">Pro-rata</Badge></td><td className="m">—</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="card-b"><Empty title="No schedule yet">The monthly schedule appears once your deposit is confirmed and the investment starts.</Empty></div>}
          </div>
          {rows.length > 0 && <div className="card-b"><p className="hint">Scheduled rows are projections from your contract terms; they become accruals on the date shown and are paid after confirmation. *Or the last day of shorter months.</p></div>}
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div className="card">
            <div className="card-h"><h3>Your contractual terms</h3><div className="r mono">{i.plan_name} v{i.plan_version}</div></div>
            <div className="card-b">
              <dl className="kv">
                <dt>Principal</dt><dd>{money(i.principal)}</dd>
                <dt>Monthly ROI</dt><dd>{rate(i.monthly_rate)}</dd>
                <dt>Monthly return</dt><dd>{money(i.monthly_return)}</dd>
                <dt>Method</dt><dd>Simple interest, original principal</dd>
                <dt>Start date</dt><dd>{date(i.start_date || i.expected_start)}{!i.start_date && i.expected_start ? ' (expected)' : ''}</dd>
                <dt>Lock-in period</dt><dd>{lockinText(i.lockin_months)}</dd>
                <dt>Lock-in end</dt><dd>{date(i.lockin_end_date)}</dd>
                <dt>Maturity date</dt><dd>{date(i.maturity_date)}</dd>
                <dt>Payout timing</dt><dd>{i.payout_lag_days} day{i.payout_lag_days === 1 ? '' : 's'} after accrual</dd>
                <dt>Principal status</dt><dd>{i.status === 'redeemed' ? 'Closed' : !i.lockin_end_date ? '—' : unlocked ? 'Unlocked' : 'Locked'}</dd>
                <dt>Agreement reference</dt><dd className="mono">{i.agreement_ref || '—'}</dd>
                <dt>Deposit reference</dt><dd className="mono">{i.deposit_ref || '—'}</dd>
              </dl>
              <p className="hint" style={{ marginTop: 10 }}>These terms were fixed when your investment was recorded and do not change if the plan is updated later.</p>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Documents</h3><div className="r"><Link to="/portal/documents">All documents</Link></div></div>
            <div className="card-b list">
              {docs.map(d => (
                <div key={d.id}><Icon name="doc" /><div className="grow"><b>{d.title}</b><span>{d.kind[0].toUpperCase() + d.kind.slice(1)} · {date(d.created_at)}</span></div>
                  <button className="btn sm" onClick={() => run(() => openDocument(d.storage_path))}><Icon name="download" />Open</button></div>
              ))}
              {!docs.length && <Empty title="No documents yet">Your signed agreement and statements will appear here once shared.</Empty>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid g-1-1">
        <div className="card"><div className="card-h"><h3>Agreement terms</h3></div><div className="card-b"><Prose text={i.terms} empty="No additional terms were recorded with this investment." /></div></div>
        <div className="card"><div className="card-h"><h3>Risk disclosure</h3></div><div className="card-b"><Prose text={i.risk_disclosure} empty="No risk disclosure was recorded with this investment." /></div></div>
      </div>
      <div className="note info"><b>When the lock-in ends.</b> {maturityText(i)}</div>
      {settings?.support_email && <p className="hint">Questions about this investment? Contact {settings.support_email}{settings.support_phone ? ' · ' + settings.support_phone : ''}.</p>}
    </>
  );
}

