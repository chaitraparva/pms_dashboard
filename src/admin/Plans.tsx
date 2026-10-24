import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, rpc, must, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useSettings } from '../lib/auth';
import { money, moneyShort, date, dateShort, dateTime, lockinText, rate, rateShort, today, monthlyReturn, STANDARD_RATES } from '../lib/format';
import type { Plan, PlanVersion, PlanStatus, Investment, Profile, EarlyRedemption, Settings } from '../lib/types';
import { DataTable } from '../ui/DataTable';
import { Empty, ErrorNote, Loading, PageHead, InvBadge, Badge, Drawer, Modal, Field, useAction } from '../ui/kit';
import { Icon } from '../ui/Icon';

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const PLAN_BADGE: Record<PlanStatus, [string, string]> = { active: ['Active', 'b-green'], inactive: ['Inactive', 'b-amber'], archived: ['Archived', 'b-grey'], draft: ['Draft', 'b-grey'] };
const PlanBadge = ({ s }: { s: PlanStatus }) => <Badge cls={PLAN_BADGE[s][1]}>{PLAN_BADGE[s][0]}</Badge>;

const lockins = (v: PlanVersion) => v.lockin_options.slice().sort((a, b) => a - b).map(lockinText).join(' or ') + (v.allow_custom_lockin ? ' + custom' : '');

interface Flag { investment_id: string; code: string; investor: string; reason: string }

type InvLite = Pick<Investment, 'id' | 'plan_id' | 'principal' | 'status'>;
interface ListData { plans: Plan[]; versions: PlanVersion[]; invs: InvLite[] }

async function loadPlans(): Promise<ListData> {
  const [plans, versions, invs] = await Promise.all([
    fetchAll<Plan>((a, b) => api.from('plans').select('*').order('created_at').range(a, b)),
    fetchAll<PlanVersion>((a, b) => api.from('plan_versions').select('*').order('version').range(a, b)),
    fetchAll<InvLite>((a, b) => api.from('investments').select('id,plan_id,principal,status').range(a, b))
  ]);
  return { plans, versions, invs };
}

/* =============================== LIST =============================== */
export function Plans() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [creating, setCreating] = useState(sp.get('new') === '1');
  const [filter, setFilter] = useState<'all' | PlanStatus>('all');
  const q = useQuery(loadPlans, []);
  const flags = useQuery(() => rpc<Flag[]>('admin_review_flags').then(r => r || []), []);
  const [standard, setStandard] = useState(false);
  const close = () => { setCreating(false); if (sp.get('new')) { sp.delete('new'); setSp(sp, { replace: true }); } };

  const cards = useMemo(() => {
    if (!q.data) return [];
    return q.data.plans.map(p => {
      const cur = q.data!.versions.find(v => v.plan_id === p.id && v.version === p.current_version);
      const live = q.data!.invs.filter(i => i.plan_id === p.id && LIVE.includes(i.status));
      return { p, cur, live: live.length, principal: live.reduce((s, i) => s + Number(i.principal), 0), total: q.data!.invs.filter(i => i.plan_id === p.id).length };
    });
  }, [q.data]);
  const shown = cards.filter(c => filter === 'all' ? c.p.status !== 'archived' : c.p.status === filter);
  const counts = (s: PlanStatus) => cards.filter(c => c.p.status === s).length;
  const missing = STANDARD_RATES.filter(r => !cards.some(c => c.p.status !== 'archived' && c.cur && Number(c.cur.monthly_rate) === r));

  return (
    <>
      <PageHead crumbs={['Investment Plans']} title="Investment Plans"
        sub="Rates are configurable. Editing a plan creates a new version; existing investments keep the terms they signed."
        actions={<>
          {q.data && missing.length > 0 && <button className="btn" onClick={() => setStandard(true)}><Icon name="plus" />Add {missing.map(rateShort).join(', ')} plan{missing.length === 1 ? '' : 's'}</button>}
          <button className="btn accent" onClick={() => setCreating(true)}><Icon name="plus" />New plan</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !cards.length ? (
        <div className="card"><div className="card-b">
          <Empty title="No plans yet">
            <span>A plan sets the monthly rate, investment range and lock-in options offered to investors.</span>
            <button className="btn accent" style={{ marginTop: 8 }} onClick={() => setCreating(true)}><Icon name="plus" />Create your first plan</button>
          </Empty>
        </div></div>
      ) : (
        <>
          <div className="chips">
            {([['all', 'Current'], ['active', 'Active'], ['draft', 'Draft'], ['inactive', 'Inactive'], ['archived', 'Archived']] as const).map(([k, l]) => (
              <button key={k} className={'chip ' + (filter === k ? 'on' : '')} onClick={() => setFilter(k)}>{l}{k !== 'all' ? ` · ${counts(k)}` : ''}</button>
            ))}
          </div>
          {shown.length ? (
            <div className="grid g-1-1-1">
              {shown.map(({ p, cur, live, principal }) => (
                <div key={p.id} className="card" style={{ cursor: 'pointer' }} onClick={() => nav('/admin/plans/' + p.code)} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') nav('/admin/plans/' + p.code); }}>
                  <div className="card-h"><h3>{p.name}</h3><span className="mono muted">{p.code} · v{p.current_version}</span><div className="r"><PlanBadge s={p.status} /></div></div>
                  <div className="card-b" style={{ display: 'grid', gap: 14 }}>
                    {cur ? <>
                      <div><div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.02em' }} className="num">{rateShort(cur.monthly_rate)}</div><div className="hint">per month · simple interest on principal</div></div>
                      {p.description && <p className="muted" style={{ fontSize: 13 }}>{p.description}</p>}
                      <dl className="kv">
                        <dt>Introducer bonus</dt><dd>{Number(cur.bonus_rate || 0) > 0 ? `${rateShort(cur.bonus_rate || 0)} · investor gets ${rateShort(Number(cur.monthly_rate) - Number(cur.bonus_rate || 0))}` : 'None'}</dd>
                        <dt>Investment range</dt><dd>{moneyShort(cur.min_amount)} – {moneyShort(cur.max_amount)}</dd>
                        <dt>Lock-in</dt><dd>{lockins(cur)}</dd>
                        <dt>Eligible</dt><dd>{dateShort(cur.eligible_from)} – {cur.eligible_to ? date(cur.eligible_to) : 'open-ended'}</dd>
                        <dt>Live investments</dt><dd>{live} · {moneyShort(principal)}</dd>
                      </dl>
                      {cur.effective_from > today() && <div className="note info">v{cur.version} takes effect {date(cur.effective_from)}.</div>}
                    </> : <p className="hint">No version found.</p>}
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty title="No plans in this view">Choose another filter above.</Empty>}
          <p className="hint">Rates are set by your company and are not guaranteed returns.</p>
        </>
      )}
      {flags.data && flags.data.length > 0 && (
        <DataTable<Flag> title="Investments to review" right={`${flags.data.length} flagged · terms are never changed automatically`} rows={flags.data} rowKey={r => r.investment_id}
          searchPh="Search investment or investor" per={8} href={r => '/admin/investments/' + r.code}
          cols={[{ h: 'Investment', v: r => r.code, m: true }, { h: 'Investor', v: r => r.investor }, { h: 'Why it is flagged', v: r => r.reason }]} />
      )}
      {standard && <StandardPlans rates={missing} onClose={() => setStandard(false)} />}
      {creating && <PlanForm onClose={close} onSaved={code => { close(); if (code) nav('/admin/plans/' + code); }} />}
    </>
  );
}

/* =============================== FORM =============================== */
interface FormState {
  name: string; code: string; description: string; monthly_rate: string; bonus_rate: string; min_amount: string; max_amount: string;
  lockins: number[]; allow_custom_lockin: boolean; eligible_from: string; eligible_to: string;
  early_redemption: EarlyRedemption; early_fee_pct: string; payout_lag_days: string; terms: string; risk_disclosure: string; effective_from: string;
}

function initForm(s: Settings, plan?: Plan, cur?: PlanVersion): FormState {
  if (plan && cur) return {
    name: plan.name, code: plan.code, description: plan.description, monthly_rate: String(Number(cur.monthly_rate)), bonus_rate: String(Number(cur.bonus_rate || 0)), min_amount: String(Number(cur.min_amount)), max_amount: String(Number(cur.max_amount)),
    lockins: cur.lockin_options.slice(), allow_custom_lockin: cur.allow_custom_lockin, eligible_from: cur.eligible_from, eligible_to: cur.eligible_to || '',
    early_redemption: cur.early_redemption, early_fee_pct: String(Number(cur.early_fee_pct)), payout_lag_days: String(cur.payout_lag_days),
    terms: cur.terms, risk_disclosure: cur.risk_disclosure, effective_from: today()
  };
  return {
    name: '', code: '', description: '', monthly_rate: '', bonus_rate: '0', min_amount: '', max_amount: '', lockins: (s.lockin_options || []).slice(), allow_custom_lockin: false,
    eligible_from: today(), eligible_to: '', early_redemption: 'not_permitted', early_fee_pct: '0', payout_lag_days: String(s.default_payout_lag_days),
    terms: s.default_terms, risk_disclosure: s.default_risk_disclosure, effective_from: today()
  };
}

function StandardPlans({ rates, onClose }: { rates: number[]; onClose: () => void }) {
  const act = useAction();
  const [activate, setActivate] = useState(true);
  const go = async () => {
    const r = await act.run(() => rpc<number>('admin_create_standard_plans', { p_activate: activate }), ['Plans created', 'Edit the minimum and maximum amounts, terms and risk disclosure on each plan.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Add the ${rates.map(rateShort).join(', ')} monthly plan${rates.length === 1 ? '' : 's'}?`} onClose={onClose}
      sub="Each plan pays simple monthly interest on the original principal, with 6-month and 1-year lock-ins. Existing plans and investments are not changed."
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Create plans</button></>}>
      <div className="note info">{money(100000)} earns {rates.map(r => `${money(monthlyReturn(100000, r))} a month at ${rateShort(r)}`).join(', ')}.</div>
      <p className="hint">The investment range starts open (from 1 upwards). Set your real minimum and maximum on each plan afterwards; that creates a new version and is recorded in the audit log.</p>
      <label className="check"><input type="checkbox" checked={activate} onChange={e => setActivate(e.target.checked)} /> Open the plans for new investments straight away</label>
    </Modal>
  );
}

function PlanForm({ plan, cur, onClose, onSaved }: { plan?: Plan; cur?: PlanVersion; onClose: () => void; onSaved: (code: string) => void }) {
  const s = useSettings();
  const act = useAction();
  const editing = !!plan;
  const [f, setF] = useState<FormState>(() => initForm(s, plan, cur));
  const [reason, setReason] = useState('');
  const [custom, setCustom] = useState('');
  const [tried, setTried] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF(x => ({ ...x, [k]: v }));
  const inp = (k: keyof FormState) => (e: { target: { value: string } }) => set(k, e.target.value as never);

  const r = Number(f.monthly_rate), br = Number(f.bonus_rate || 0), mn = Number(f.min_amount), mx = Number(f.max_amount), lag = Number(f.payout_lag_days);
  const options = [...new Set([...(s.lockin_options || []), ...f.lockins])].sort((a, b) => a - b);
  const errs: Record<string, string | null> = {
    name: !f.name.trim() ? 'Enter a plan name.' : null,
    code: f.code.trim() && !/^[A-Za-z0-9-]{2,20}$/.test(f.code.trim()) ? 'Letters, digits and dashes only (2–20).' : null,
    rate: !(r > 0 && r <= 100) || !/^\d+(\.\d{1,4})?$/.test(f.monthly_rate.trim()) ? 'Enter a rate above 0 and up to 100, with at most 4 decimals.' : null,
    bonus: !/^\d+(\.\d{1,4})?$/.test((f.bonus_rate || '0').trim()) ? 'Enter a number, at most 4 decimals (0 for no bonus).' : r > 0 && br >= r ? 'The bonus must be less than the monthly ROI.' : null,
    min: !(mn > 0) ? 'Enter a minimum above zero.' : null,
    max: !(mx > 0) || mx < mn ? 'Maximum must be at least the minimum.' : null,
    lock: !f.lockins.length ? 'Choose at least one lock-in.' : null,
    elig: f.eligible_to && f.eligible_to < f.eligible_from ? 'End date must be on or after the start date.' : null,
    lag: !(Number.isInteger(lag) && lag >= 0 && lag <= 60) ? 'Whole days between 0 and 60.' : null,
    eff: !f.effective_from ? 'Choose a date.' : null,
    reason: editing && !reason.trim() ? 'A reason is required. It is saved to the version history and audit log.' : null
  };
  const bad = Object.values(errs).some(Boolean);
  const e = (k: string) => (tried ? errs[k] : null);

  const addCustom = () => {
    const n = Number(custom);
    if (!Number.isInteger(n) || n < 1 || n > 120) return;
    if (!f.lockins.includes(n)) set('lockins', [...f.lockins, n].sort((a, b) => a - b));
    setCustom('');
  };
  const toggle = (m: number) => set('lockins', f.lockins.includes(m) ? f.lockins.filter(x => x !== m) : [...f.lockins, m].sort((a, b) => a - b));

  const save = async () => {
    setTried(true);
    if (bad) return;
    const version = {
      monthly_rate: r, bonus_rate: br, min_amount: mn, max_amount: mx, lockin_options: f.lockins, allow_custom_lockin: s.allow_custom_lockin && f.allow_custom_lockin,
      eligible_from: f.eligible_from, eligible_to: f.eligible_to || null, early_redemption: 'not_permitted',
      early_fee_pct: 0, payout_lag_days: lag, terms: f.terms, risk_disclosure: f.risk_disclosure, effective_from: f.effective_from
    };
    if (editing && plan) {
      const v = await act.run(() => rpc<number>('admin_update_plan', { p_plan: plan.id, p_name: f.name.trim(), p_description: f.description.trim(), p_version: version, p_reason: reason.trim() }),
        [`${f.name.trim()} v${plan.current_version + 1} saved`, 'Existing investments keep their contractual terms.']);
      if (v !== undefined) { refreshAll(); onSaved(plan.code); }
    } else {
      const id = await act.run(() => rpc<string>('admin_create_plan', { p_code: f.code.trim(), p_name: f.name.trim(), p_description: f.description.trim(), p_version: version }),
        ['Plan created as draft', 'Activate it when you are ready to record investments on it.']);
      if (id) {
        refreshAll();
        const { data } = await api.from('plans').select('code').eq('id', id).maybeSingle();
        onSaved((data as { code: string } | null)?.code || '');
      }
    }
  };

  return (
    <Drawer title={editing ? `Edit ${plan!.name}` : 'New investment plan'} sub={editing ? `Saving creates version v${plan!.current_version + 1}.` : 'Saved as a draft until you activate it.'} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={act.busy}>{editing ? `Save version v${plan!.current_version + 1}` : 'Create plan'}</button></>}>
      <div className="form">
        {editing && <div className="note lock"><b>Existing investments keep their terms.</b> Investments already on this plan stay at their contractual rate and lock-in. This version applies only to investments recorded after it takes effect.</div>}
        <div className="f-row">
          <Field label="Plan name *" err={e('name')}><input className={'input ' + (e('name') ? 'bad' : '')} value={f.name} onChange={inp('name')} placeholder="e.g. Growth Plan" /></Field>
          {editing
            ? <Field label="Plan ID"><input className="input mono" value={f.code} readOnly /></Field>
            : <Field label="Plan ID" err={e('code')} hint="Leave blank to number it automatically."><input className="input mono" value={f.code} onChange={inp('code')} placeholder="PLN-001" /></Field>}
        </div>
        <Field label="Description"><input className="input" value={f.description} onChange={inp('description')} /></Field>
        <div className="f-row">
          <Field label="Monthly ROI (% per month) *" err={e('rate')} hint={cur ? `Currently ${Number(cur.monthly_rate).toFixed(2)}%. Up to 4 decimals.` : 'Up to 4 decimals.'}>
            <input className={'input ' + (e('rate') ? 'bad' : '')} inputMode="decimal" value={f.monthly_rate} onChange={inp('monthly_rate')} placeholder="e.g. 2.50" />
          </Field>
          <Field label="Effective from *" err={e('eff')} hint="New investments use this version from this date."><input className="input" type="date" value={f.effective_from} onChange={inp('effective_from')} /></Field>
        </div>
        <div className="f-row">
          <Field label="Introducer bonus (% per month) *" err={e('bonus')} hint={`Taken out of the monthly ROI and paid to whoever introduced the investor. 0 = no bonus.${cur ? ` Currently ${Number(cur.bonus_rate || 0)}%.` : ''}`}>
            <input className={'input ' + (e('bonus') ? 'bad' : '')} inputMode="decimal" value={f.bonus_rate} onChange={inp('bonus_rate')} placeholder="e.g. 1.5" />
          </Field>
          <Field label="Investor gets (% per month)" hint="Monthly ROI minus the bonus. This is what the investor sees.">
            <input className="input" readOnly value={r > 0 && br < r ? String(Math.round((r - br) * 10000) / 10000) : '—'} />
          </Field>
        </div>
        <div className="note info">{money(100000)} at this rate earns <b>{r > 0 ? money(monthlyReturn(100000, r)) : '—'}</b> per full month{r > 0 && br > 0 && br < r ? <>: <b>{money(monthlyReturn(100000, r - br))}</b> to the investor and <b>{money(monthlyReturn(100000, r) - monthlyReturn(100000, r - br))}</b> bonus to the introducer</> : ''}.</div>
        <div className="f-row">
          <Field label={`Minimum investment (${s.currency}) *`} err={e('min')}><input className={'input ' + (e('min') ? 'bad' : '')} inputMode="decimal" value={f.min_amount} onChange={inp('min_amount')} /></Field>
          <Field label={`Maximum investment (${s.currency}) *`} err={e('max')}><input className={'input ' + (e('max') ? 'bad' : '')} inputMode="decimal" value={f.max_amount} onChange={inp('max_amount')} /></Field>
        </div>
        <Field label="Lock-in options *" err={e('lock')} hint={options.length ? 'Tap to include or exclude.' : 'Add lock-in durations in Settings → Lock-in & controls.'}>
          <div className="chips">
            {options.map(m => <button key={m} type="button" className={'chip ' + (f.lockins.includes(m) ? 'on' : '')} onClick={() => toggle(m)}>{m} months</button>)}
          </div>
        </Field>
        {s.allow_custom_lockin && (
          <>
            <div className="f-row">
              <Field label="Add another lock-in (months)" hint="1 to 120 months.">
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" inputMode="numeric" value={custom} onChange={ev => setCustom(ev.target.value.replace(/\D/g, ''))} onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); addCustom(); } }} />
                  <button type="button" className="btn sm" onClick={addCustom}>Add</button>
                </div>
              </Field>
              <div className="field" style={{ alignContent: 'end' }}>
                <label className="check"><input type="checkbox" checked={f.allow_custom_lockin} onChange={ev => set('allow_custom_lockin', ev.target.checked)} /> Allow any custom lock-in on this plan</label>
              </div>
            </div>
          </>
        )}
        <div className="f-row">
          <Field label="Eligible from"><input className="input" type="date" value={f.eligible_from} onChange={inp('eligible_from')} /></Field>
          <Field label="Eligible to" err={e('elig')} hint="Leave blank for open-ended."><input className="input" type="date" value={f.eligible_to} onChange={inp('eligible_to')} /></Field>
        </div>
        <div className="f-row">
          <Field label="Payout within (days of accrual)" err={e('lag')}><input className="input" inputMode="numeric" value={f.payout_lag_days} onChange={inp('payout_lag_days')} /></Field>
          <Field label="Calculation method"><input className="input" value="Simple interest on original principal" readOnly /></Field>
        </div>
        <Field label="Terms" hint={!editing && s.default_terms ? 'Pre-filled from your default terms in Settings.' : 'Shown to investors on every investment on this version.'}>
          <textarea className="input" rows={4} value={f.terms} onChange={inp('terms')} />
        </Field>
        <Field label="Risk disclosure"><textarea className="input" rows={3} value={f.risk_disclosure} onChange={inp('risk_disclosure')} /></Field>
        {editing && (
          <Field label="Reason for change (required, saved to audit log) *" err={e('reason')}>
            <input className={'input ' + (e('reason') ? 'bad' : '')} value={reason} onChange={ev => setReason(ev.target.value)} placeholder="e.g. Approved by investment committee, minute IC-2026-14" />
          </Field>
        )}
        {tried && bad && <p className="hint err">Check the highlighted fields.</p>}
      </div>
    </Drawer>
  );
}

/* =============================== DETAIL =============================== */
interface DetailData { plan: Plan; versions: PlanVersion[]; invs: Investment[]; names: Record<string, string> }

async function loadPlan(code: string): Promise<DetailData | null> {
  const plan = must(await api.from('plans').select('*').eq('code', code).maybeSingle()) as Plan | null;
  if (!plan || !plan.id) return null;
  const [versions, invs] = await Promise.all([
    fetchAll<PlanVersion>((a, b) => api.from('plan_versions').select('*').eq('plan_id', plan.id).order('version', { ascending: false }).range(a, b)),
    fetchAll<Investment>((a, b) => api.from('investments').select('*').eq('plan_id', plan.id).order('created_at', { ascending: false }).range(a, b))
  ]);
  const created = (plan as Plan & { created_by?: string | null; updated_by?: string | null });
  const ids = [...new Set([...invs.map(i => i.investor_id), ...versions.map(v => v.created_by), created.created_by, created.updated_by].filter((x): x is string => !!x))];
  const names: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 200) {
    const rows = must(await api.from('profiles').select('id,full_name,email,code').in('id', ids.slice(i, i + 200))) as Pick<Profile, 'id' | 'full_name' | 'email' | 'code'>[];
    rows.forEach(r => { names[r.id] = r.full_name || r.email; });
  }
  return { plan, versions, invs, names };
}

export function PlanDetail() {
  const { code = '' } = useParams();
  const nav = useNavigate();
  const s = useSettings();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const q = useQuery(() => loadPlan(code), [code]);

  if (q.error) return <><PageHead crumbs={['Investment Plans', code]} title={code} /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data && q.loading) return <><PageHead crumbs={['Investment Plans', code]} title={code} /><Loading rows={5} /></>;
  if (!q.data) return <><PageHead crumbs={['Investment Plans', 'Not found']} title="Plan not found" /><Empty title="Plan not found">No plan has the code {code}. <Link to="/admin/plans">Back to plans</Link></Empty></>;
  const { plan, versions, invs, names } = q.data;
  const cur = versions.find(v => v.version === plan.current_version) || versions[0];
  const pl = plan as Plan & { created_by?: string | null; updated_by?: string | null };
  const live = invs.filter(i => LIVE.includes(i.status));

  return (
    <>
      <Link className="back" to="/admin/plans"><Icon name="back" /> All plans</Link>
      <PageHead crumbs={['Investment Plans', plan.name]} title={plan.name}
        actions={<>
          {plan.status === 'draft' && <button className="btn primary" onClick={() => setStatus('active')}>Activate</button>}
          {plan.status === 'active' && <button className="btn" onClick={() => setStatus('inactive')}>Deactivate</button>}
          {plan.status === 'inactive' && <button className="btn" onClick={() => setStatus('active')}>Activate</button>}
          {plan.status !== 'archived' && <button className="btn" onClick={() => setStatus('archived')}>Archive</button>}
          {plan.status === 'archived' && <button className="btn" onClick={() => setStatus('inactive')}>Restore</button>}
          {plan.status !== 'archived' && cur && <button className="btn primary" onClick={() => setEditing(true)}>Edit plan</button>}
        </>}>
        <h1>{plan.name} <PlanBadge s={plan.status} /></h1>
        <p className="mono">{plan.code} · current version v{plan.current_version} · {invs.length} investment{invs.length === 1 ? '' : 's'} across {versions.length} version{versions.length === 1 ? '' : 's'}</p>
      </PageHead>

      {plan.status === 'draft' && <div className="note info"><b>Draft.</b> No investments can be recorded until you activate this plan.</div>}

      <div className="grid g-1-1">
        <div className="card">
          <div className="card-h"><h3>Current terms · v{cur?.version}</h3><div className="r">effective {date(cur?.effective_from)}</div></div>
          <div className="card-b">
            {cur ? (
              <dl className="kv">
                <dt>Monthly ROI</dt><dd>{rate(cur.monthly_rate)}</dd>
                <dt>Introducer bonus</dt><dd>{Number(cur.bonus_rate || 0) > 0 ? <>{rate(cur.bonus_rate || 0)} <span className="muted">· investor gets {rate(Number(cur.monthly_rate) - Number(cur.bonus_rate || 0))}</span></> : <span className="muted">None</span>}</dd>
                <dt>Calculation method</dt><dd>Simple interest on original principal</dd>
                <dt>Compounding</dt><dd>None</dd>
                <dt>Minimum investment</dt><dd>{money(cur.min_amount)}</dd>
                <dt>Maximum investment</dt><dd>{money(cur.max_amount)}</dd>
                <dt>Lock-in options</dt><dd>{lockins(cur)}</dd>
                <dt>Maturity convention</dt><dd>Start + lock-in calendar months</dd>
                <dt>Accrual schedule</dt><dd>Monthly on start-date anniversary</dd>
                <dt>Payout schedule</dt><dd>Within {cur.payout_lag_days} day{cur.payout_lag_days === 1 ? '' : 's'} of accrual</dd>
                <dt>Eligible to invest</dt><dd>{date(cur.eligible_from)} – {cur.eligible_to ? date(cur.eligible_to) : 'open-ended'}</dd>
                <dt>Live principal</dt><dd>{money(live.reduce((x, i) => x + Number(i.principal), 0))} · {live.length} live</dd>
                <dt>Created by</dt><dd>{(pl.created_by && names[pl.created_by]) || '—'} · {date(plan.created_at)}</dd>
                <dt>Last modified by</dt><dd>{(pl.updated_by && names[pl.updated_by]) || '—'} · {date(plan.updated_at)}</dd>
              </dl>
            ) : <p className="hint">No version found.</p>}
            {cur && cur.effective_from > today() && <div className="note info" style={{ marginTop: 12 }}>v{cur.version} takes effect on {date(cur.effective_from)}. Until then new investments use the previous version in force.</div>}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div className="card">
            <div className="card-h"><h3>Version history</h3></div>
            <div className="tbl">
              <table>
                <thead><tr><th>Version</th><th>Rate</th><th>Amounts</th><th>Effective</th><th>Reason</th><th className="n">Investments</th></tr></thead>
                <tbody>{versions.map(v => (
                  <tr key={v.id}>
                    <td className="m">v{v.version}</td>
                    <td>{Number(v.monthly_rate).toFixed(2)}%<span className="sub">bonus {Number(v.bonus_rate || 0)}% · {v.lockin_options.join(', ')} mo</span></td>
                    <td>{moneyShort(v.min_amount)} – {moneyShort(v.max_amount)}</td>
                    <td>{date(v.effective_from)}</td>
                    <td>{v.change_reason}<span className="sub">{(v.created_by && names[v.created_by]) || '—'} · {dateTime(v.created_at)}</span></td>
                    <td className="n">{invs.filter(i => i.plan_version === v.version).length}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Terms & risk disclosure</h3></div>
            <div className="card-b" style={{ display: 'grid', gap: 10, fontSize: 13, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>
              <p>{cur?.terms || <span className="muted">No plan-specific terms. Your default terms from Settings are used{s.default_terms ? '' : ' (none set yet)'}.</span>}</p>
              <p><b style={{ color: 'var(--fg)' }}>Risk disclosure.</b> {cur?.risk_disclosure || <span className="muted">Default risk disclosure from Settings is used{s.default_risk_disclosure ? '' : ' (none set yet)'}.</span>}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Investments on this plan</h3>
          {plan.status === 'active' && <div className="r"><button className="btn sm" onClick={() => nav('/admin/investments?new=1')}><Icon name="plus" />Record investment</button></div>}</div>
        <div className="tbl">
          {invs.length ? (
            <table>
              <thead><tr><th>Investment</th><th>Investor</th><th>Version</th><th>Contract rate</th><th className="n">Principal</th><th>Start</th><th>Maturity</th><th>Status</th></tr></thead>
              <tbody>{invs.map(i => (
                <tr key={i.id} className="click" onClick={() => nav('/admin/investments/' + i.code)}>
                  <td className="m">{i.code}</td><td>{names[i.investor_id] || '—'}</td><td className="m">v{i.plan_version}</td><td>{rate(i.monthly_rate)}</td>
                  <td className="n">{money(i.principal)}</td><td>{i.start_date ? date(i.start_date) : <span className="muted">Not funded</span>}</td><td>{date(i.maturity_date)}</td>
                  <td><InvBadge i={i} approachingDays={s.approaching_days} /></td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div className="card-b"><Empty title="No investments yet">{plan.status === 'active' ? 'Investments recorded on this plan appear here.' : 'Activate the plan to start recording investments on it.'}</Empty></div>}
        </div>
      </div>

      {editing && cur && <PlanForm plan={plan} cur={cur} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {status && <StatusDialog plan={plan} to={status} onClose={() => setStatus(null)} />}
    </>
  );
}

function StatusDialog({ plan, to, onClose }: { plan: Plan; to: PlanStatus; onClose: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const verb = to === 'active' ? 'Activate' : to === 'inactive' ? (plan.status === 'archived' ? 'Restore' : 'Deactivate') : to === 'archived' ? 'Archive' : 'Move to draft';
  const go = async () => {
    setTried(true); if (!reason.trim()) return;
    const r = await act.run(() => rpc('admin_set_plan_status', { p_plan: plan.id, p_status: to, p_reason: reason.trim() }), [`${plan.name} is now ${PLAN_BADGE[to][0].toLowerCase()}`, 'Recorded in the audit log.']);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`${verb} ${plan.name}?`}
      sub={to === 'active' ? 'Investments can be recorded on this plan.' : to === 'archived' ? 'The plan is hidden and cannot be edited. Existing investments are not affected.' : 'No new investments can be recorded on this plan. Existing investments are not affected.'}
      onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>{verb}</button></>}>
      <Field label="Reason (required, saved to audit log)" err={tried && !reason.trim() ? 'Enter a reason.' : null}>
        <input className={'input ' + (tried && !reason.trim() ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder={to === 'archived' ? 'e.g. Plan withdrawn' : 'e.g. Approved by investment committee'} />
      </Field>
    </Modal>
  );
}
