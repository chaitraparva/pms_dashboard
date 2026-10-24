import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, rpc, must, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useAuth, useSettings } from '../lib/auth';
import { uploadDocument, openDocument, deleteDocument } from '../lib/docs';
import { downloadCsv } from '../lib/csv';
import { recordInvestmentFull } from '../lib/adminApi';
import { money, date, dateShort, dateTime, rate, today, addMonths, daysBetween, investmentLabel, isUnlocked, lockinText, rateShort, LEDGER_TYPE } from '../lib/format';
import type { Investment, Balance, Branch, Profile, Plan, Accrual, Payout, LedgerEntry } from '../lib/types';
import { DataTable, Col } from '../ui/DataTable';
import { Kpi, Empty, ErrorNote, Loading, PageHead, InvBadge, PayBadge, LedgerBadge, Badge, Drawer, Modal, Field, useAction } from '../ui/kit';
import { Icon } from '../ui/Icon';

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
type Lite = Pick<Profile, 'id' | 'full_name' | 'code' | 'email'> & { branch_id?: string | null; introduced_by?: string | null; role?: string };

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const outstandingOf = (b?: Balance) => (b ? Number(b.unapproved) + Number(b.approved) + Number(b.processing) : 0);

async function namesFor(ids: (string | null | undefined)[]): Promise<Record<string, Lite>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const out: Record<string, Lite> = {};
  for (let i = 0; i < list.length; i += 200) {
    const rows = must(await api.from('profiles').select('id,full_name,code,email').in('id', list.slice(i, i + 200))) as Lite[];
    rows.forEach(r => { out[r.id] = r; });
  }
  return out;
}

/* =============================== REGISTER =============================== */
interface Row extends Investment { investor: Lite | undefined; bal: Balance | undefined; label: string; outstanding: number; branch: string; branchCode: string; bonusTo: Lite | undefined }

export function Investments() {
  const s = useSettings();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [open, setOpen] = useState(sp.get('new') === '1');
  useEffect(() => { if (sp.get('new') === '1') setOpen(true); }, [sp]);
  const close = () => {
    setOpen(false);
    if (sp.get('new') || sp.get('investor')) { sp.delete('new'); sp.delete('investor'); setSp(sp, { replace: true }); }
  };

  const q = useQuery(async () => {
    const [invs, bal, people, branches] = await Promise.all([
      fetchAll<Investment>((a, b) => api.from('investments').select('*').order('created_at', { ascending: false }).range(a, b)),
      fetchAll<Balance>((a, b) => api.from('investment_balances').select('*').range(a, b)),
      fetchAll<Lite>((a, b) => api.from('profiles').select('id,full_name,code,email,branch_id,introduced_by').range(a, b)),
      api.from('branches').select('*').order('name').then(r => must(r) as Branch[])
    ]);
    const bm = new Map(bal.map(x => [x.investment_id, x]));
    const pm = new Map(people.map(x => [x.id, x]));
    const bn = new Map(branches.map(b => [b.id, b]));
    return {
      branches,
      rows: invs.map<Row>(i => {
        const who = pm.get(i.investor_id);
        const br = who?.branch_id ? bn.get(who.branch_id) : undefined;
        return { ...i, investor: who, bal: bm.get(i.id), label: investmentLabel(i, s.approaching_days), outstanding: outstandingOf(bm.get(i.id)), branch: br?.name || '', branchCode: br?.code || '', bonusTo: who?.introduced_by ? pm.get(who.introduced_by) : undefined };
      })
    };
  }, [s.approaching_days]);

  const all = q.data?.rows || [];
  const branches = q.data?.branches || [];
  const fRate = sp.get('rate') || '';
  const fBranch = sp.get('branch') || '';
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const rates = [...new Set(all.map(r => Number(r.monthly_rate)))].sort((a, b) => a - b);
  const rows = all.filter(r => (!fRate || Number(r.monthly_rate) === Number(fRate)) && (!fBranch || (fBranch === 'none' ? !r.branchCode : r.branchCode === fBranch)));
  const t = today();
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'Investment', v: r => r.code, r: r => <><b className="mono">{r.code}</b><span className="sub">{r.agreement_ref || '—'}</span></> },
    { h: 'Investor', v: r => r.investor?.full_name || '', r: r => <>{r.investor?.full_name || '—'}<span className="sub">{r.investor?.code}{r.branch ? ' · ' + r.branch : ''}</span></> },
    { h: 'Plan', v: r => r.plan_name, r: r => <>{r.plan_name}{r.plan_id && <> <span className="muted mono">v{r.plan_version}</span></>}<span className="sub">{rate(r.monthly_rate)}</span></> },
    { h: 'Bonus to', v: r => r.bonusTo?.full_name || '', r: r => Number(r.admin_bonus || 0) > 0
      ? (r.bonusTo ? <>{r.bonusTo.full_name || r.bonusTo.email}<span className="sub">{rate(r.admin_bonus_rate || 0)} · {money(r.admin_bonus)} / month</span></> : <span className="muted">Individual<span className="sub">{rate(r.admin_bonus_rate || 0)} unassigned</span></span>)
      : <span className="muted">—</span> },
    { h: 'Principal', n: true, v: r => Number(r.principal), r: r => money(r.principal) },
    { h: 'Lock-in', v: r => r.lockin_months, r: r => lockinText(r.lockin_months) },
    { h: 'Start', v: r => r.start_date || '9999', r: r => (r.start_date ? date(r.start_date) : <span className="muted">Not funded</span>) },
    { h: 'Maturity', v: r => r.maturity_date || '9999', r: r => (r.maturity_date ? <>{date(r.maturity_date)}{LIVE.includes(r.status) && <span className="sub">{Math.max(0, daysBetween(t, r.maturity_date))} days</span>}</> : '—') },
    { h: 'Accrued', n: true, v: r => Number(r.bal?.accrued || 0), r: r => money(r.bal?.accrued || 0) },
    { h: 'Paid', n: true, v: r => Number(r.bal?.paid || 0), r: r => <span className="pos">{money(r.bal?.paid || 0)}</span> },
    { h: 'Outstanding', n: true, v: r => r.outstanding, r: r => money(r.outstanding) },
    { h: 'Status', v: r => r.label, r: r => <InvBadge i={r} approachingDays={s.approaching_days} /> }
  ], [s.approaching_days, t]);

  const livePrincipal = rows.filter(r => LIVE.includes(r.status)).reduce((x, r) => x + Number(r.principal), 0);
  const exportCsv = () => downloadCsv(`investments-${today()}`,
    ['Investment', 'Investor ID', 'Investor', 'Branch', 'Plan', 'Version', 'Rate %/month', 'Investor rate %', 'Bonus %', 'Bonus / month', 'Bonus to', 'Principal', 'Monthly return', 'Lock-in months', 'Start', 'Maturity', 'Accrued', 'Paid', 'Outstanding', 'Status', 'Agreement ref', 'Deposit ref'],
    rows.map(r => [r.code, r.investor?.code, r.investor?.full_name, r.branch, r.plan_name, r.plan_version, r.monthly_rate, r.investor_rate ?? r.monthly_rate, r.admin_bonus_rate ?? 0, r.admin_bonus ?? 0, r.bonusTo ? r.bonusTo.full_name || r.bonusTo.email : '', r.principal, r.monthly_return, r.lockin_months, r.start_date, r.maturity_date,
      r.bal?.accrued ?? 0, r.bal?.paid ?? 0, r.outstanding, r.label, r.agreement_ref, r.deposit_ref]));

  return (
    <>
      <PageHead crumbs={['Investments']} title="Investment register"
        sub={q.data ? `${rows.length} investments · ${money(livePrincipal)} live principal` : 'Loading…'}
        actions={<>
          <button className="btn" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export CSV</button>
          <button className="btn accent" onClick={() => setOpen(true)}><Icon name="plus" />Record investment</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !all.length ? (
        <div className="card"><div className="card-b">
          <Empty title="No investments yet">
            <span>Record an investment for a verified investor on an active plan. It becomes active when you confirm the deposit.</span>
            <button className="btn accent" style={{ marginTop: 8 }} onClick={() => setOpen(true)}><Icon name="plus" />Record investment</button>
          </Empty>
        </div></div>
      ) : (
        <DataTable<Row> key={sp.get('f') || ''} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search ID, investor, plan, reference" per={12}
          text={r => `${r.investor?.code || ''} ${r.investor?.email || ''} ${r.deposit_ref} ${r.agreement_ref} ${r.branch}`}
          filters={[['All', 'all'], ['Pending funding', 'Pending funding'], ['Locked', 'locked'], ['Unlocking soon', 'Unlocking soon'], ['Unlocked', 'Unlocked'], ['Closed', 'Closed'], ['Cancelled', 'Cancelled']]}
          filterFn={(r, f) => f === 'all' || r.label === f || (f === 'locked' && LIVE.includes(r.status) && !isUnlocked(r))}
          initialFilter={sp.get('f') === 'unlocked' ? 'Unlocked' : sp.get('f') === 'locked' ? 'locked' : undefined}
          tools={<>
            <select className="input" style={{ width: 'auto' }} value={fRate} onChange={e => setParam('rate', e.target.value)} aria-label="Monthly ROI">
              <option value="">All ROI rates</option>{rates.map(r => <option key={r} value={String(r)}>{rateShort(r)} monthly</option>)}
            </select>
            <select className="input" style={{ width: 'auto' }} value={fBranch} onChange={e => setParam('branch', e.target.value)} aria-label="Branch">
              <option value="">All branches</option>{branches.map(b => <option key={b.id} value={b.code}>{b.name}</option>)}<option value="none">No branch</option>
            </select>
          </>}
          href={r => '/admin/investments/' + r.code} emptyTitle="No matching investments" />
      )}
      {open && <RecordInvestment preInvestor={sp.get('investor') || ''} onClose={close} onDone={code => { close(); if (code) nav('/admin/investments/' + code); }} />}
    </>
  );
}

/* =============================== RECORD DRAWER =============================== */
type Found = { id: string; code: string; full_name: string; phone: string; has_login: boolean; ib_id: string | null; ib_name: string | null; people: number } | null;
const LOCKS: [string, string][] = [['0', 'No lock-in'], ['6', '6 months'], ['12', '12 months'], ['custom', 'Custom']];
const genPw = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)]; return 'Parva@' + s; };

/** Super Admin records an investment in one step: who (by phone), individual or under another investor, the ROI and bonus typed in,
 *  lock-in, principal and start date. A new person gets their login (phone number + password) at the same time. */
function RecordInvestment({ preInvestor, onClose, onDone }: { preInvestor: string; onClose: () => void; onDone: (code: string) => void }) {
  const act = useAction();
  const t = today();
  const opts = useQuery(async () => {
    const [all, pre] = await Promise.all([
      fetchAll<Lite & { phone?: string }>((a, b) => api.from('profiles').select('id,full_name,code,email,phone,branch_id').eq('role', 'investor').order('full_name').range(a, b)),
      preInvestor ? api.from('profiles').select('id,full_name,code,phone').eq('code', preInvestor).maybeSingle() : Promise.resolve({ data: null, error: null })
    ]);
    return { all, pre: (pre.data as { full_name: string; phone: string } | null) || null };
  }, [preInvestor]);

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'individual' | 'under'>('individual');
  const [ib, setIb] = useState('');
  const [roi, setRoi] = useState('');
  const [bonus, setBonus] = useState('');
  const [lock, setLock] = useState('12');
  const [customLock, setCustomLock] = useState('');
  const [amount, setAmount] = useState('');
  const [start, setStart] = useState(t);
  const [pw, setPw] = useState(genPw);
  const [ref, setRef] = useState('');
  const [notes, setNotes] = useState('');
  const [found, setFound] = useState<Found>(null);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<null | { code: string; phone: string; pw: string | null }>(null);

  useEffect(() => { if (opts.data?.pre && !phone) { setPhone(opts.data.pre.phone || ''); setName(opts.data.pre.full_name || ''); } }, [opts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // look the phone number up as it is typed: an existing person keeps their record, login and the investor they are under
  const digits = phone.replace(/\D/g, '').slice(-10);
  useEffect(() => {
    if (digits.length !== 10) { setFound(null); return; }
    let live = true;
    rpc<Found>('admin_lookup_phone', { p_phone: digits }).then(r => { if (!live) return; setFound(r); if (r) { setName(r.full_name); if (r.ib_id) { setKind('under'); setIb(r.ib_id); } } }).catch(() => {});
    return () => { live = false; };
  }, [digits]);

  const under = kind === 'under';
  const months = lock === 'custom' ? Number(customLock) : Number(lock);
  const r = Number(roi), b = under && ib ? Number(bonus || 0) : 0, amt = Number(amount);
  const upRow = opts.data?.all.find(x => x.id === ib);
  const needPw = !found || !found.has_login;
  const errs: Record<string, string | null> = {
    phone: digits.length !== 10 ? 'Enter a 10-digit phone number.' : null,
    name: !name.trim() ? 'Enter the name.' : null,
    ib: under && !ib ? 'Choose the investor this person is under.' : found && found.ib_id && under && ib && found.ib_id !== ib ? `${found.full_name} is already under ${found.ib_name}.` : null,
    roi: !(r > 0 && r <= 100) || !/^\d+(\.\d{1,4})?$/.test(roi.trim()) ? 'Enter the monthly ROI, e.g. 0.25, 2.3, 4.3 or 6.' : null,
    bonus: under && (!/^\d+(\.\d{1,4})?$/.test((bonus || '0').trim()) || (r > 0 && b >= r)) ? 'The bonus must be 0 or more and less than the ROI.' : null,
    lock: !(Number.isInteger(months) && months >= 0 && months <= 120) ? 'Enter the lock-in in months (0 to 120).' : null,
    amount: !(amt > 0) || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? 'Enter the principal (at most 2 decimals).' : null,
    start: !start ? 'Enter the start date.' : null,
    pw: needPw && pw.length < 8 ? 'At least 8 characters.' : null
  };
  const bad = Object.values(errs).some(Boolean);
  const e = (k: string) => (tried ? errs[k] : null);
  const invRate = r > 0 && b < r ? Math.round((r - b) * 10000) / 10000 : 0;
  const mine = amt > 0 && invRate ? Math.round(amt * invRate) / 100 : 0;
  const upMonthly = amt > 0 && b > 0 ? Math.round((Math.round(amt * r) / 100 - mine) * 100) / 100 : 0;

  const save = async () => {
    setTried(true);
    if (bad) return;
    const res = await act.run(() => recordInvestmentFull({
      p_name: name.trim(), p_phone: phone.trim(), p_ib: under ? ib : null, p_rate: roi.trim(), p_bonus: under ? (bonus.trim() || '0') : '0', p_lockin_months: months,
      p_principal: amt, p_start_date: start, p_reference: ref.trim(), p_notes: notes.trim(), p_password: needPw ? pw : ''
    }), ['Investment recorded', `${name.trim()} · ${money(amt)} at ${rateShort(r)} a month`]);
    if (res) { refreshAll(); setDone({ code: res.code, phone: phone.trim(), pw: needPw ? pw : null }); }
  };

  if (done) return (
    <Drawer title="Investment recorded" sub={done.pw ? 'Share the login details with the investor offline.' : 'Added to the investor’s account.'} onClose={() => onDone(done.code)}
      foot={<button className="btn primary" onClick={() => onDone(done.code)}>Open investment</button>}>
      <div className="form">
        <dl className="kv">
          <dt>Investor</dt><dd>{name}</dd>
          <dt>Investment</dt><dd className="mono">{done.code} · {money(amt)} at {rateShort(r)}</dd>
          {under && upRow && <><dt>Under</dt><dd>{upRow.full_name} · bonus {rateShort(b)} ({money(upMonthly)} / month), shown to them now</dd></>}
          {done.pw && <><dt>Login (phone)</dt><dd className="mono">{done.phone}</dd><dt>Password</dt><dd className="mono">{done.pw}</dd></>}
        </dl>
      </div>
    </Drawer>
  );

  return (
    <Drawer title="Record investment" sub="The person is found by phone number, or added with their own login." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={act.busy || !opts.data}>{act.busy ? 'Saving…' : 'Record investment'}</button></>}>
      {opts.error ? <ErrorNote msg={opts.error} retry={opts.reload} /> : !opts.data ? <Loading rows={3} /> : (
        <div className="form">
          <div className="f-row">
            <Field label="Phone number *" err={e('phone')} hint={found ? <>Existing investor: <b>{found.full_name}</b> ({found.code}){found.ib_name ? ` · under ${found.ib_name}` : ' · individual'}</> : 'The investor signs in with this number.'}>
              <input className={'input num ' + (e('phone') ? 'bad' : '')} inputMode="tel" value={phone} onChange={ev => setPhone(ev.target.value)} placeholder="e.g. 98450 12345" />
            </Field>
            <Field label="Name *" err={e('name')}><input className={'input ' + (e('name') ? 'bad' : '')} value={name} onChange={ev => setName(ev.target.value)} disabled={!!found} /></Field>
          </div>
          <Field label="Investor type *" err={e('ib')}>
            <div className="chips">
              <button type="button" className={'chip ' + (!under ? 'on' : '')} disabled={!!found?.ib_id} onClick={() => { setKind('individual'); setIb(''); }}>Individual</button>
              <button type="button" className={'chip ' + (under ? 'on' : '')} onClick={() => setKind('under')}>Under an investor</button>
            </div>
            {under && (
              <select className={'input ' + (e('ib') ? 'bad' : '')} style={{ marginTop: 8 }} value={ib} onChange={ev => setIb(ev.target.value)} disabled={!!found?.ib_id}>
                <option value="">Choose the investor…</option>
                {opts.data.all.filter(x => x.id !== found?.id).map(x => <option key={x.id} value={x.id}>{x.full_name} · {x.code}{x.phone ? ' · ' + x.phone : ''}</option>)}
              </select>
            )}
            <p className="hint">{under ? 'The person goes under this investor. That investor sees them and earns the bonus below from now on.' : 'Nobody earns a bonus on this investment.'}</p>
          </Field>
          <div className="f-row">
            <Field label="Monthly ROI (% per month) *" err={e('roi')} hint="Any rate, e.g. 0.25, 2.3, 3.3, 4.3, 6.">
              <input className={'input num ' + (e('roi') ? 'bad' : '')} inputMode="decimal" value={roi} onChange={ev => setRoi(ev.target.value)} placeholder="e.g. 6" />
            </Field>
            <Field label={under && upRow ? `Bonus to ${upRow.full_name} (% per month)` : 'Bonus (% per month)'} err={e('bonus')} hint={under ? (r > 0 && b < r ? `Investor gets ${invRate}%${upRow ? `, ${upRow.full_name} gets ${b}%` : ''}.` : 'Taken out of the ROI.') : 'Only when under an investor.'}>
              <input className={'input num ' + (e('bonus') ? 'bad' : '')} inputMode="decimal" value={under ? bonus : ''} onChange={ev => setBonus(ev.target.value)} disabled={!under} placeholder={under ? 'e.g. 2' : '—'} />
            </Field>
          </div>
          <Field label="Lock-in period *" err={e('lock')}>
            <div className="chips">
              {LOCKS.map(([v, l]) => <button key={v} type="button" className={'chip ' + (lock === v ? 'on' : '')} onClick={() => setLock(v)}>{l}</button>)}
            </div>
            {lock === 'custom' && <input className="input num" style={{ marginTop: 8 }} inputMode="numeric" value={customLock} onChange={ev => setCustomLock(ev.target.value)} placeholder="Months, e.g. 3" />}
          </Field>
          <div className="f-row">
            <Field label="Principal (INR) *" err={e('amount')}><input className={'input num ' + (e('amount') ? 'bad' : '')} inputMode="decimal" value={amount} onChange={ev => setAmount(ev.target.value)} placeholder="e.g. 500000" /></Field>
            <Field label="Start date *" err={e('start')} hint="Returns accrue monthly from this date."><input className="input" type="date" value={start} onChange={ev => setStart(ev.target.value)} /></Field>
          </div>
          {needPw && (
            <Field label="Login password *" err={e('pw')} hint={`They sign in as Investor with ${digits.length === 10 ? phone : 'this phone number'} and this password. Share it offline.`}>
              <input className={'input mono ' + (e('pw') ? 'bad' : '')} value={pw} onChange={ev => setPw(ev.target.value)} autoComplete="new-password" />
            </Field>
          )}
          <div className="f-row">
            <Field label="Reference" hint="Bank / UTR or agreement number (optional)."><input className="input mono" value={ref} onChange={ev => setRef(ev.target.value)} /></Field>
            <Field label="Notes (internal)"><input className="input" value={notes} onChange={ev => setNotes(ev.target.value)} /></Field>
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <div className="card-h"><h3>Summary</h3></div>
            <div className="card-b">
              <dl className="kv">
                <dt>Monthly ROI</dt><dd>{r > 0 ? rate(r) : '—'}</dd>
                <dt>Investor gets</dt><dd>{invRate ? <>{rate(invRate)}{amt > 0 && <> · <b>{money(mine)}</b> / month</>}</> : '—'}</dd>
                <dt>Bonus</dt><dd>{under && b > 0 ? <>{rate(b)}{amt > 0 && <> · <b>{money(upMonthly)}</b> / month</>} <span className="muted">to {upRow?.full_name}</span></> : <span className="muted">None</span>}</dd>
                <dt>First return</dt><dd>{start ? date(addMonths(start, 1)) : '—'}</dd>
                <dt>Lock-in ends</dt><dd>{start && months > 0 ? date(addMonths(start, months)) : months === 0 ? 'No lock-in' : '—'}</dd>
              </dl>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* =============================== DETAIL =============================== */
interface Amendment {
  id: string; investment_id: string; description: string; effective_date: string; document_path: string | null;
  requested_by: string | null; approved_by: string | null; approved_at: string | null; created_at: string;
}
interface DetailData {
  i: Investment; investor: Lite | undefined; bal: Balance | null; accruals: Accrual[]; payouts: Payout[]; ledger: LedgerEntry[];
  amendments: Amendment[]; plan: Plan | null; names: Record<string, Lite>; introducedBy: string | null;
}

async function loadInvestment(code: string): Promise<DetailData | null> {
  const i = must(await api.from('investments').select('*').eq('code', code).maybeSingle()) as Investment | null;
  if (!i || !i.id) return null;
  const [bal, accruals, payouts, ledger, amend, plan] = await Promise.all([
    api.from('investment_balances').select('*').eq('investment_id', i.id).maybeSingle(),
    fetchAll<Accrual>((a, b) => api.from('accruals').select('*').eq('investment_id', i.id).order('period_no').order('created_at').range(a, b)),
    fetchAll<Payout>((a, b) => api.from('payouts').select('*').eq('investment_id', i.id).order('due_date').range(a, b)),
    fetchAll<LedgerEntry>((a, b) => api.from('ledger_entries').select('*').eq('investment_id', i.id).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).range(a, b)),
    api.from('contract_amendments').select('*').eq('investment_id', i.id).order('created_at', { ascending: false }),
    api.from('plans').select('*').eq('id', i.plan_id).maybeSingle()
  ]);
  const amendments = must(amend) as Amendment[];
  const ip = must(await api.from('profiles').select('introduced_by').eq('id', i.investor_id).maybeSingle()) as { introduced_by?: string | null } | null;
  const introducedBy = ip?.introduced_by || null;
  const names = await namesFor([i.investor_id, introducedBy, i.created_by, i.activated_by, ...amendments.flatMap(a => [a.requested_by, a.approved_by])]);
  return { i, investor: names[i.investor_id], bal: must(bal) as Balance | null, accruals, payouts, ledger, amendments, plan: must(plan) as Plan | null, names, introducedBy };
}

type Dialog = null | 'fund' | 'cancel' | 'amend';

export function InvestmentDetail() {
  const { code = '' } = useParams();
  const s = useSettings();
  const { profile: me } = useAuth();
  const act = useAction();
  const [dlg, setDlg] = useState<Dialog>(null);
  const q = useQuery(() => loadInvestment(code), [code]);

  if (q.error) return <><PageHead crumbs={['Investments', code]} title={code} /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data && q.loading) return <><PageHead crumbs={['Investments', code]} title={code} /><Loading rows={6} /></>;
  if (!q.data) return <><PageHead crumbs={['Investments', 'Not found']} title="Investment not found" /><Empty title="Investment not found">No investment has the code {code}. <Link to="/admin/investments">Back to the register</Link></Empty></>;
  const { i, investor, bal, accruals, payouts, ledger, amendments, plan, names, introducedBy } = q.data;
  const t = today();
  const pending = i.status === 'pending_funding';
  const closed = i.status === 'redeemed' || i.status === 'cancelled';
  const outstanding = outstandingOf(bal || undefined);
  const paidCount = payouts.filter(p => p.status === 'paid').length;
  const daysLeft = i.maturity_date ? daysBetween(t, i.maturity_date) : null;
  const nm = (id: string | null | undefined) => (id && names[id] ? names[id].full_name || names[id].email : '—');

  /* lock-in progress */
  const total = i.start_date && i.maturity_date ? Math.max(1, daysBetween(i.start_date, i.maturity_date)) : 0;
  const elapsed = i.start_date ? Math.min(total, Math.max(0, daysBetween(i.start_date, t))) : 0;
  const pctDone = total ? Math.round((elapsed / total) * 100) : 0;

  /* accrual schedule: every period 1..lock-in */
  const base = i.start_date || i.expected_start;
  const periods = i.lockin_months > 0 ? i.lockin_months : accruals.filter(a => a.kind === 'regular').length + 1; // no lock-in: what has accrued plus the next month
  const schedule = base ? Array.from({ length: periods }, (_, n) => {
    const k = n + 1;
    const acc = accruals.find(a => a.period_no === k && a.kind !== 'reversal');
    const rev = acc ? accruals.find(a => a.reverses_id === acc.id) : undefined;
    const pay = acc ? payouts.find(p => p.accrual_id === acc.id) : undefined;
    const from = acc ? acc.period_start : addMonths(base, k - 1);
    const to = acc ? acc.period_end : addDays(addMonths(base, k), -1);
    const on = acc ? acc.accrual_date : addMonths(base, k);
    return { k, acc, rev, pay, from, to, on };
  }) : [];
  const shownSchedule = closed ? schedule.filter(r => r.acc) : schedule;

  const openAmendDoc = (path: string) => act.run(() => openDocument(path));
  const approve = async (a: Amendment) => {
    const r = await act.run(() => rpc('admin_approve_amendment', { p_amendment: a.id }), ['Amendment approved', 'Recorded in the audit log.']);
    if (r !== undefined) refreshAll();
  };

  return (
    <>
      <Link className="back" to="/admin/investments"><Icon name="back" /> Investment register</Link>
      <PageHead crumbs={['Investments', i.code]} title={i.code}
        actions={pending ? <>
          <button className="btn danger" onClick={() => setDlg('cancel')}>Cancel</button>
          <button className="btn primary" onClick={() => setDlg('fund')}>Confirm deposit & activate</button>
        </> : !closed ? <button className="btn" onClick={() => setDlg('amend')}>Record amendment</button> : undefined}>
        <h1>{i.code} · {investor ? <Link to={'/admin/investors/' + investor.code}>{investor.full_name || investor.email}</Link> : '—'} <InvBadge i={i} approachingDays={s.approaching_days} /></h1>
        <p>{i.plan_name}{i.plan_id ? ` v${i.plan_version}` : ''} · {i.lockin_months ? lockinText(i.lockin_months) + ' lock-in' : 'No lock-in'} · {i.start_date
          ? `started ${date(i.start_date)}${i.maturity_date ? ` · matures ${date(i.maturity_date)}${daysLeft != null && daysLeft > 0 && !closed ? ` (${daysLeft} days)` : ''}` : ''}`
          : i.status === 'cancelled' ? `cancelled${i.cancelled_reason ? ': ' + i.cancelled_reason : ''}` : 'awaiting deposit confirmation'}</p>
      </PageHead>

      {pending && (
        <div className="note info">
          <b>Awaiting funding.</b> Confirm the deposit once the funds show in the company bank account. Terms are already frozen from {i.plan_name} v{i.plan_version}.
          {s.four_eyes && i.created_by === me?.id && <> Four-eyes control is on: another Super Admin must confirm the deposit, because you recorded this investment.</>}
        </div>
      )}

      <div className="kpis">
        <Kpi label="Principal" value={money(i.principal)} sub="Original, never changes" />
        <Kpi label="Investor monthly return" value={money(i.monthly_return)}
          sub={Number(i.admin_bonus || 0) > 0 ? `${rate(i.investor_rate ?? i.monthly_rate)} · + ${money(i.admin_bonus)} (${rate(i.admin_bonus_rate || 0)}) to ${introducedBy ? nm(introducedBy) : 'nobody'}` : `${rate(i.monthly_rate)} × principal`} />
        <Kpi label="Accrued to date" value={money(bal?.accrued || 0)} sub={i.lockin_months ? `${bal?.periods_accrued || 0} of ${i.lockin_months} periods` : `${bal?.periods_accrued || 0} months so far`} tip="Sum of accrual entries, net of reversals." />
        <Kpi label="Paid (confirmed)" value={money(bal?.paid || 0)} cls="pos" sub={`${paidCount} payout${paidCount === 1 ? '' : 's'}`} />
        <Kpi label="Outstanding" value={money(outstanding)} sub={Number(bal?.processing || 0) ? `${money(bal!.processing)} processing` : 'Accrued, not yet paid'} subCls={outstanding ? 'warn' : ''} />
      </div>

      <div className="grid g-2-1">
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div className="card">
            <div className="card-h"><h3>Lock-in progress</h3><div className="r">{i.start_date ? `${pctDone}% elapsed` : 'Not started'}</div></div>
            <div className="card-b" style={{ display: 'grid', gap: 14 }}>
              {i.start_date && i.maturity_date ? (
                <div className="track">
                  <div className="bar"><div className={'fill ' + (pctDone >= 100 ? 'done' : '')} style={{ width: pctDone + '%' }} /></div>
                  <div className="lbls"><span>Start {dateShort(i.start_date)}</span><span>{isUnlocked(i) ? 'Principal unlocked' : `${pctDone}% of lock-in`}</span><span>Maturity {date(i.maturity_date)}</span></div>
                </div>
              ) : <p className="hint">{i.status === 'cancelled' ? 'This investment was cancelled before funding.' : 'The lock-in starts on the date the deposit is confirmed.'}</p>}
              <dl className="kv">
                <dt>Start date</dt><dd>{i.start_date ? date(i.start_date) : <span className="muted">Expected {date(i.expected_start)}</span>}</dd>
                <dt>Lock-in end</dt><dd>{date(i.lockin_end_date)}</dd>
                <dt>Maturity</dt><dd>{date(i.maturity_date)}</dd>
                <dt>Lock-in period</dt><dd>{lockinText(i.lockin_months)}</dd>
                <dt>Principal</dt><dd>{closed ? (i.status === 'cancelled' ? 'Cancelled' : 'Closed') : !i.lockin_end_date ? 'Not started' : isUnlocked(i) ? 'Unlocked' : 'Locked'}</dd>
                {daysLeft != null && !closed && <><dt>Days to unlock</dt><dd>{Math.max(0, daysLeft)}</dd></>}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Monthly accruals and payouts</h3><div className="r">Period = start-date anniversary</div></div>
            <div className="tbl">
              {shownSchedule.length ? (
                <table>
                  <thead><tr><th>#</th><th>Period</th><th className="n">Amount</th><th>Accrual</th><th>Accrues on</th><th>Payout</th><th>Reference</th></tr></thead>
                  <tbody>{shownSchedule.map(r => (
                    <tr key={r.k}>
                      <td className="m">{r.k}</td>
                      <td>{dateShort(r.from)} – {dateShort(r.to)}{r.acc?.kind === 'stub' && <span className="sub">{r.acc.days} of {r.acc.days_in_period} days (pro-rata)</span>}</td>
                      <td className={'n ' + (r.acc ? '' : 'muted')}>{money(r.acc ? r.acc.amount : i.monthly_return)}{r.rev && <span className="sub neg">{money(r.rev.amount)} reversed</span>}</td>
                      <td>{r.rev ? <Badge cls="b-red">Reversed</Badge> : r.acc ? <Badge cls="b-green">Accrued</Badge> : pending ? <Badge cls="b-grey">Projected</Badge> : <Badge cls="b-grey">Scheduled</Badge>}</td>
                      <td>{date(r.on)}</td>
                      <td>{r.pay ? <><PayBadge s={r.pay.status} /><span className="sub">{r.pay.status === 'paid' ? 'paid ' + dateShort(r.pay.paid_on) : 'due ' + dateShort(r.pay.due_date)}</span></> : <span className="muted">—</span>}</td>
                      <td className="m">{r.pay?.payment_ref || r.pay?.batch_ref || '—'}{r.pay?.failure_reason && <span className="sub">{r.pay.failure_reason}</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className="card-b"><Empty title="No accruals">{closed ? 'No returns were accrued on this investment.' : 'The schedule appears once a start date is known.'}</Empty></div>}
            </div>
            {pending && base && <div className="card-b"><p className="hint">Projected from the expected start date. Final dates follow the deposit confirmation date.</p></div>}
          </div>

          <div className="card">
            <div className="card-h"><h3>Ledger entries</h3><div className="r">{ledger.length} entries</div></div>
            <div className="tbl">
              {ledger.length ? (
                <table>
                  <thead><tr><th>Transaction</th><th>Date</th><th>Type</th><th className="n">Amount</th><th>Status</th><th>Reference</th></tr></thead>
                  <tbody>{ledger.map(l => (
                    <tr key={l.id}>
                      <td className="m">{l.code}</td><td>{date(l.occurred_on)}</td><td>{LEDGER_TYPE[l.type] || l.type}{l.note && <span className="sub">{l.note}</span>}</td>
                      <td className={'n ' + (Number(l.amount) < 0 ? 'neg' : '')}>{money(l.amount)}</td><td><LedgerBadge s={l.status} /></td><td className="m">{l.reference || '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className="card-b"><Empty title="No ledger entries">Entries appear as the investment moves through its lifecycle.</Empty></div>}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div className="card">
            <div className="card-h"><h3>Contractual terms snapshot</h3><div className="r mono">{i.plan_name} v{i.plan_version}</div></div>
            <div className="card-b">
              <dl className="kv">
                <dt>Plan rate</dt><dd>{rate(i.monthly_rate)}</dd>
                {Number(i.admin_bonus || 0) > 0 && <><dt>Investor ROI</dt><dd>{rate(i.investor_rate ?? i.monthly_rate)} <span className="muted">(shown to the investor)</span></dd>
                  <dt>Bonus</dt><dd>{rate(i.admin_bonus_rate || 0)} · {money(i.admin_bonus)} / month</dd>
                  <dt>Bonus goes to</dt><dd>{introducedBy ? <b>{nm(introducedBy)}</b> : <span className="muted">Individual: no bonus.</span>}</dd></>}
                <dt>Method</dt><dd>Simple interest</dd>
                <dt>Plan</dt><dd>{plan ? <><Link to={'/admin/plans/' + plan.code}>{i.plan_name}</Link> · v{i.plan_version}</> : i.plan_name}</dd>
                <dt>Lock-in</dt><dd>{lockinText(i.lockin_months)}</dd>
                <dt>Principal</dt><dd>{money(i.principal)}</dd>
                <dt>Investor monthly return</dt><dd>{money(i.monthly_return)}</dd>
                {i.lockin_months > 0 && <><dt>Total over lock-in</dt><dd>{money(Math.round(Number(i.monthly_return) * i.lockin_months * 100) / 100)}</dd></>}
                <dt>Payout lag</dt><dd>{i.payout_lag_days} day{i.payout_lag_days === 1 ? '' : 's'} after accrual</dd>
                <dt>Agreement</dt><dd className="mono">{i.agreement_ref || '—'}</dd>
                <dt>Deposit reference</dt><dd className="mono">{i.deposit_ref || '—'}</dd>
                <dt>Recorded by</dt><dd>{nm(i.created_by)} · {dateTime(i.created_at)}</dd>
                <dt>Activated by</dt><dd>{i.activated_by ? `${nm(i.activated_by)} · ${dateTime(i.activated_at)}` : '—'}</dd>
              </dl>
              {plan && plan.current_version > i.plan_version && <div className="note lock" style={{ marginTop: 12 }}>Plan is now on v{plan.current_version}. This investment keeps its v{i.plan_version} terms.</div>}
              {i.notes && <p className="hint" style={{ marginTop: 12 }}>Notes: {i.notes}</p>}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Contract amendments</h3>{!closed && <div className="r"><button className="btn sm" onClick={() => setDlg('amend')}>Record amendment</button></div>}</div>
            <div className="card-b list">
              {amendments.length ? amendments.map(a => (
                <div key={a.id}>
                  <div className="grow"><b>{a.description}</b><span>Effective {date(a.effective_date)} · requested by {nm(a.requested_by)}{a.approved_at ? ` · approved by ${nm(a.approved_by)} ${dateShort(a.approved_at)}` : ''}</span></div>
                  {a.document_path && <button className="btn sm" onClick={() => openAmendDoc(a.document_path!)}>Open</button>}
                  {a.approved_at ? <Badge cls="b-green">Approved</Badge> : (
                    <button className="btn sm primary" disabled={act.busy} onClick={() => approve(a)}
                      title={s.four_eyes && a.requested_by === me?.id ? 'Four-eyes: another Super Admin must approve this amendment.' : undefined}>Approve</button>
                  )}
                </div>
              )) : <Empty title="No amendments">Use only for a signed, legally effective change to this investor’s terms.</Empty>}
              {s.four_eyes && amendments.some(a => !a.approved_at && a.requested_by === me?.id) && <p className="hint">Four-eyes is on: another Super Admin must approve amendments you recorded.</p>}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Terms & risk disclosure</h3></div>
            <div className="card-b" style={{ display: 'grid', gap: 10, fontSize: 13, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>
              <p>{i.terms || <span className="muted">No terms text was recorded with this investment.</span>}</p>
              <p><b style={{ color: 'var(--fg)' }}>Risk disclosure.</b> {i.risk_disclosure || <span className="muted">None recorded.</span>}</p>
            </div>
          </div>
        </div>
      </div>

      {dlg === 'fund' && <FundDialog i={i} meId={me?.id} onClose={() => setDlg(null)} />}
      {dlg === 'cancel' && <CancelDialog i={i} onClose={() => setDlg(null)} />}
      {dlg === 'amend' && <AmendDialog i={i} onClose={() => setDlg(null)} />}
    </>
  );
}

function FundDialog({ i, meId, onClose }: { i: Investment; meId?: string; onClose: () => void }) {
  const s = useSettings();
  const act = useAction();
  const t = today();
  const [start, setStart] = useState(i.expected_start && i.expected_start <= t ? i.expected_start : t);
  const [ref, setRef] = useState(i.deposit_ref);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const errs = { start: !start ? 'Choose the date funds were received.' : start > t ? 'Start date must be today or earlier.' : null, ref: !ref.trim() ? 'Enter the bank reference for the deposit.' : null };
  const back = start && start < t ? Math.max(0, (() => { let k = 0; while (k < i.lockin_months && addMonths(start, k + 1) <= t) k++; return k; })()) : 0;
  const go = async () => {
    setTried(true); if (errs.start || errs.ref) return;
    const r = await act.run(() => rpc('admin_activate_investment', { p_id: i.id, p_start_date: start, p_deposit_ref: ref.trim(), p_reason: note.trim() }),
      [`${i.code} is active`, back ? `${back} past month${back === 1 ? '' : 's'} accrued automatically.` : 'The investor can now see it.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Confirm deposit for ${i.code}?`} sub="Only confirm once the funds show in the company bank account. The start date fixes maturity and the accrual schedule." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Confirm & activate</button></>}>
      <dl className="kv"><dt>Principal</dt><dd>{money(i.principal)}</dd><dt>Maturity</dt><dd>{start && !errs.start ? date(addMonths(start, i.lockin_months)) : '—'}</dd></dl>
      <Field label="Start date (funds received) *" err={tried ? errs.start : null} hint="Today or earlier.">
        <input className={'input ' + (tried && errs.start ? 'bad' : '')} type="date" max={t} value={start} onChange={e => setStart(e.target.value)} />
      </Field>
      <Field label="Bank reference (UTR) *" err={tried ? errs.ref : null}>
        <input className={'input mono ' + (tried && errs.ref ? 'bad' : '')} value={ref} onChange={e => setRef(e.target.value)} />
      </Field>
      <Field label="Note (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
      {back > 0 && <div className="note info">This start date is in the past. On confirmation, the {back} month{back === 1 ? '' : 's'} already completed will be accrued automatically, and their payouts queued.</div>}
      {s.four_eyes && i.created_by === meId && <div className="note">Four-eyes is on: another Super Admin must confirm the deposit, because you recorded this investment. If you are the only active admin, the system allows it.</div>}
    </Modal>
  );
}

function CancelDialog({ i, onClose }: { i: Investment; onClose: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const go = async () => {
    setTried(true); if (!reason.trim()) return;
    const r = await act.run(() => rpc('admin_cancel_investment', { p_id: i.id, p_reason: reason.trim() }), [`${i.code} cancelled`, 'The pending deposit entry was reversed.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Cancel ${i.code}?`} sub="Only investments awaiting funding can be cancelled. The pending deposit is reversed in the ledger." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Keep investment</button><button className="btn danger" onClick={go} disabled={act.busy}>Cancel investment</button></>}>
      <Field label="Reason (required, saved to audit log)" err={tried && !reason.trim() ? 'Enter a reason.' : null}>
        <input className={'input ' + (tried && !reason.trim() ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Investor withdrew before transferring funds" />
      </Field>
    </Modal>
  );
}

function AmendDialog({ i, onClose }: { i: Investment; onClose: () => void }) {
  const s = useSettings();
  const act = useAction();
  const [desc, setDesc] = useState('');
  const [eff, setEff] = useState(today());
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  const errs = { desc: !desc.trim() ? 'Describe the amendment.' : null, eff: !eff ? 'Choose the effective date.' : null };
  const go = async () => {
    setTried(true); if (errs.desc || errs.eff) return;
    const r = await act.run(async () => {
      const doc = file ? await uploadDocument({ ownerId: i.investor_id, investmentId: i.id, kind: 'agreement', title: `Amendment · ${i.code} · ${eff}`, file, visible: true }) : null;
      try {
        return await rpc<string>('admin_record_amendment', { p_id: i.id, p_description: desc.trim(), p_effective: eff, p_document_path: doc ? doc.storage_path : null });
      } catch (err) {
        if (doc) await deleteDocument(doc).catch(() => undefined);
        throw err;
      }
    }, ['Amendment recorded', s.four_eyes ? 'Another Super Admin must approve it.' : 'Approve it to make it effective.']);
    if (r) { refreshAll(); onClose(); }
  };
  return (
    <Modal title="Record contract amendment" sub="Use only for a signed, legally effective change to this investor’s terms. Announcements never change contracts." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Submit for approval</button></>}>
      <Field label="What changes *" err={tried ? errs.desc : null}>
        <textarea className={'input ' + (tried && errs.desc ? 'bad' : '')} rows={3} value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Lock-in end date extended to 30 Jun 2027 by signed addendum" />
      </Field>
      <Field label="Effective date *" err={tried ? errs.eff : null}><input className="input" type="date" value={eff} onChange={e => setEff(e.target.value)} /></Field>
      <Field label="Signed amendment (optional)" hint="Stored privately and shown to the investor in their documents."><input className="input" type="file" onChange={e => setFile(e.target.files?.[0] || null)} /></Field>
      <div className="note">The investment’s recorded terms stay unchanged in the system; the amendment is the legal record of the change.{s.four_eyes ? ' A second Super Admin must approve it.' : ''}</div>
    </Modal>
  );
}
