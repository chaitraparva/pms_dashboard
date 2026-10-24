import { Fragment, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { date, dateTime, investmentLabel, LEDGER_TYPE, money, rate, today } from '../lib/format';
import { ErrorNote, Field, LedgerBadge, Loading, PageHead } from '../ui/kit';
import { Logo } from '../shell/Shell';
import { Icon } from '../ui/Icon';
import { BackLink } from './parts';
import { codeMap, financialYearStart, loadLedger, loadPortfolio } from './data';

/** Printable account statement for a chosen period, built from the investor's own rows. */
export function Statement() {
  const { profile, settings } = useAuth();
  const t = today();
  const [from, setFrom] = useState(() => financialYearStart(settings?.currency || 'INR', t));
  const [to, setTo] = useState(t);
  const q = useQuery(async () => {
    const [p, ledger] = await Promise.all([loadPortfolio(profile!.id), loadLedger(profile!.id)]);
    return { p, ledger };
  }, [profile?.id]);

  const bad = !from || !to || from > to;
  const me = profile!;
  const company = settings?.company_name || 'Investor statement';

  const body = () => {
    if (q.loading && !q.data) return <Loading />;
    if (q.error || !q.data) return <ErrorNote msg={q.error || 'Could not load your statement.'} retry={q.reload} />;
    const { p, ledger } = q.data;
    const codes = codeMap(p.investments);
    const inv = p.investments
      .filter(i => i.status !== 'cancelled' && (i.start_date || i.created_at.slice(0, 10)) <= to)
      .sort((a, b) => (a.start_date || a.created_at).localeCompare(b.start_date || b.created_at));
    const accIn = (id: string, lo: string | null, hi: string) => p.accruals.filter(a => a.investment_id === id && (!lo || a.accrual_date >= lo) && a.accrual_date <= hi).reduce((s, a) => s + Number(a.amount), 0);
    const paidIn = (id: string, lo: string | null, hi: string) => p.payouts.filter(x => x.investment_id === id && x.status === 'paid' && x.paid_on && (!lo || x.paid_on >= lo) && x.paid_on <= hi).reduce((s, x) => s + Number(x.amount), 0);
    const dayBefore = new Date(Date.parse(from + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const rows = inv.map(i => {
      const opening = accIn(i.id, null, dayBefore) - paidIn(i.id, null, dayBefore);
      const accrued = accIn(i.id, from, to);
      const paid = paidIn(i.id, from, to);
      return { i, opening, accrued, paid, closing: opening + accrued - paid };
    });
    const tot = (k: 'opening' | 'accrued' | 'paid' | 'closing') => rows.reduce((s, r) => s + r[k], 0);
    const lines = ledger.filter(l => l.occurred_on >= from && l.occurred_on <= to).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.code.localeCompare(b.code));
    const counted = lines.filter(l => l.status !== 'reversed' && l.status !== 'failed');
    const byType = Object.entries(counted.reduce<Record<string, number>>((m, l) => { m[l.type] = (m[l.type] || 0) + Number(l.amount); return m; }, {}));

    return (
      <div className="card">
        <div className="card-b" style={{ display: 'grid', gap: 22 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1, minWidth: 240 }}>
              <Logo name={company} url={settings?.logo_url} size={44} />
              <div><b style={{ fontSize: 17 }}>{company}</b>{settings?.tagline && <div className="hint">{settings.tagline}</div>}
                {(settings?.support_email || settings?.support_phone) && <div className="hint">{[settings?.support_email, settings?.support_phone].filter(Boolean).join(' · ')}</div>}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Account statement</h2>
              <div className="hint">{date(from)} – {date(to)}</div>
              <div className="hint">Generated {dateTime(new Date().toISOString())}</div>
            </div>
          </div>

          <div className="grid g-1-1">
            <dl className="kv" style={{ alignContent: 'start' }}>
              <dt>Investor</dt><dd>{me.full_name || me.email}</dd>
              <dt>Investor ID</dt><dd className="mono">{me.code || '—'}</dd>
              <dt>Email</dt><dd>{me.email}</dd>
              {me.phone && <><dt>Phone</dt><dd>{me.phone}</dd></>}
            </dl>
            <dl className="kv" style={{ alignContent: 'start' }}>
              <dt>Address</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{[me.address, me.city].filter(Boolean).join(', ') || '—'}</dd>
              {me.bank_name && <><dt>Bank account</dt><dd>{me.bank_name}{me.bank_account_masked ? ' · ' + me.bank_account_masked : ''}</dd></>}
            </dl>
          </div>

          <div>
            <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 8 }}>Summary by investment</h3>
            <div className="tbl">
              {rows.length ? (
                <table>
                  <thead><tr><th>Investment</th><th>Terms</th><th>Status</th><th className="n">Principal</th><th className="n">Unpaid returns at {date(from)}</th><th className="n">Accrued in period</th><th className="n">Paid in period</th><th className="n">Unpaid returns at {date(to)}</th></tr></thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.i.id}>
                        <td className="m">{r.i.code}<span className="sub">{r.i.plan_name}</span></td>
                        <td>{rate(r.i.monthly_rate)}<span className="sub">{date(r.i.start_date)} – {date(r.i.maturity_date)}</span></td>
                        <td>{investmentLabel(r.i, settings?.approaching_days ?? 60)}</td>
                        <td className="n">{money(r.i.principal)}</td><td className="n">{money(r.opening)}</td>
                        <td className="n">{money(r.accrued)}</td><td className="n">{money(r.paid)}</td><td className="n">{money(r.closing)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={3}><b>Total</b></td>
                      <td className="n"><b>{money(rows.filter(r => !['redeemed'].includes(r.i.status)).reduce((s, r) => s + Number(r.i.principal), 0))}</b><span className="sub">open investments</span></td>
                      <td className="n"><b>{money(tot('opening'))}</b></td><td className="n"><b>{money(tot('accrued'))}</b></td><td className="n"><b>{money(tot('paid'))}</b></td><td className="n"><b>{money(tot('closing'))}</b></td>
                    </tr>
                  </tbody>
                </table>
              ) : <p className="hint">You had no investments in this period.</p>}
            </div>
          </div>

          <div>
            <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 8 }}>Transactions in period</h3>
            <div className="tbl">
              {lines.length ? (
                <table>
                  <thead><tr><th>Date</th><th>Transaction</th><th>Type</th><th>Investment</th><th>Reference</th><th>Status</th><th className="n">Amount</th></tr></thead>
                  <tbody>
                    {lines.map(l => (
                      <tr key={l.id}>
                        <td>{date(l.occurred_on)}</td><td className="m">{l.code}</td>
                        <td>{LEDGER_TYPE[l.type] || l.type}{l.note && <span className="sub">{l.note}</span>}</td>
                        <td className="m">{l.investment_id ? codes[l.investment_id] || '—' : '—'}</td>
                        <td className="m">{l.reference || '—'}</td><td><LedgerBadge s={l.status} /></td>
                        <td className={'n ' + (Number(l.amount) < 0 ? 'neg' : '')}>{money(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="hint">No transactions in this period.</p>}
            </div>
          </div>

          {byType.length > 0 && (
            <div className="grid g-1-1">
              <div>
                <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 8 }}>Totals by type</h3>
                <dl className="kv">{byType.map(([k, v]) => <Fragment key={k}><dt>{LEDGER_TYPE[k] || k}</dt><dd>{money(v)}</dd></Fragment>)}</dl>
                <p className="hint" style={{ marginTop: 6 }}>Excludes reversed and failed entries.</p>
              </div>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 6 }}>
            <p className="hint">Returns are simple interest on your original principal at the monthly rate fixed in your agreement. “Unpaid returns” are returns accrued but not yet confirmed as paid; they are not money in your bank account.</p>
            {settings?.legal_footer && <p className="hint" style={{ whiteSpace: 'pre-wrap' }}>{settings.legal_footer}</p>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="no-print" style={{ display: 'grid', gap: 12 }}>
        <BackLink to="/portal/documents">Statements & documents</BackLink>
        <PageHead crumbs={['Statements & Documents', 'Account statement']} title="Account statement" sub="Choose a period, then print or save as PDF from your browser's print dialog."
          actions={<button className="btn primary" disabled={bad || !q.data} onClick={() => window.print()}><Icon name="print" />Print</button>} />
        <div className="card"><div className="card-b" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ width: 180 }}><Field label="From"><input className="input" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></Field></div>
          <div style={{ width: 180 }}><Field label="To"><input className="input" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></Field></div>
          <div className="chips" style={{ marginBottom: 4 }}>
            <button className="chip" onClick={() => { setFrom(financialYearStart(settings?.currency || 'INR', t)); setTo(t); }}>Financial year to date</button>
            <button className="chip" onClick={() => { setFrom(t.slice(0, 4) + '-01-01'); setTo(t); }}>Calendar year to date</button>
            <button className="chip" onClick={() => { setFrom('2000-01-01'); setTo(t); }}>All time</button>
          </div>
        </div></div>
      </div>
      {bad ? <ErrorNote msg="Choose a valid period: the start date must be on or before the end date." /> : body()}
    </>
  );
}
