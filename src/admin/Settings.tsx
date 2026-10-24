import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, rpc, must, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useAuth, useSettings } from '../lib/auth';
import { createUser } from '../lib/adminApi';
import { uploadLogo } from '../lib/docs';
import { date, dateTime, initials, money, monthlyReturn } from '../lib/format';
import type { Profile, Settings as SettingsRow, AuditLog } from '../lib/types';
import { Empty, ErrorNote, Loading, PageHead, Badge, AcctBadge, Drawer, Modal, Field, useAction } from '../ui/kit';
import { Icon } from '../ui/Icon';

type Tab = 'company' | 'money' | 'lockin' | 'terms' | 'admins';
const TABS: [Tab, string][] = [['company', 'Company & branding'], ['money', 'Money & dates'], ['lockin', 'Lock-in & controls'], ['terms', 'Terms'], ['admins', 'Administrators']];
const CURRENCIES: [string, string][] = [['INR', 'INR · Indian rupee (₹)'], ['AED', 'AED · UAE dirham'], ['USD', 'USD · US dollar ($)'], ['EUR', 'EUR · Euro (€)'], ['GBP', 'GBP · Pound sterling (£)'], ['SGD', 'SGD · Singapore dollar']];
const LOCALES = ['en-IN', 'en-AE', 'ar-AE', 'en-US', 'en-GB', 'en-SG', 'de-DE', 'fr-FR'];
const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Riyadh', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'UTC'];

type Editable = Pick<SettingsRow, 'company_name' | 'tagline' | 'primary_color' | 'currency' | 'locale' | 'timezone' | 'approaching_days' | 'request_window_days' |
  'default_payout_lag_days' | 'four_eyes' | 'allow_custom_lockin' | 'lockin_options' | 'default_terms' | 'default_risk_disclosure' | 'support_email' | 'support_phone' | 'legal_footer'>;
const KEYS: (keyof Editable)[] = ['company_name', 'tagline', 'primary_color', 'currency', 'locale', 'timezone', 'approaching_days', 'request_window_days', 'default_payout_lag_days',
  'four_eyes', 'allow_custom_lockin', 'lockin_options', 'default_terms', 'default_risk_disclosure', 'support_email', 'support_phone', 'legal_footer'];
const pick = (s: SettingsRow): Editable => {
  const o = {} as Record<string, unknown>;
  KEYS.forEach(k => { o[k] = k === 'lockin_options' ? (s.lockin_options || []).slice().sort((a, b) => a - b) : s[k]; });
  return o as unknown as Editable;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function Settings() {
  const s = useSettings();
  const { reloadSettings } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.find(x => x[0] === sp.get('tab'))?.[0] || 'company') as Tab;
  const setTab = (t: Tab) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const act = useAction();
  const [f, setF] = useState<Editable>(() => pick(s));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [newLock, setNewLock] = useState('');
  useEffect(() => { setF(pick(s)); setTried(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [s.updated_at]);

  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setF(x => ({ ...x, [k]: v }));
  const txt = (k: keyof Editable) => (e: { target: { value: string } }) => set(k, e.target.value as never);
  const num = (k: 'approaching_days' | 'request_window_days' | 'default_payout_lag_days') => (e: { target: { value: string } }) => set(k, (e.target.value === '' ? NaN : Number(e.target.value)) as never);
  const orig = pick(s);
  const changed = KEYS.filter(k => !same(f[k], orig[k]));

  const errs: Record<string, string | null> = {
    primary_color: !/^#[0-9a-fA-F]{6}$/.test(f.primary_color) ? 'Use a hex colour like #0F2147.' : null,
    support_email: f.support_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.support_email.trim()) ? 'Enter a valid email address.' : null,
    locale: (() => { try { new Intl.NumberFormat(f.locale); return null; } catch { return 'Unknown locale code.'; } })(),
    timezone: (() => { try { new Intl.DateTimeFormat('en', { timeZone: f.timezone }); return null; } catch { return 'Unknown time zone. Use an IANA name like Asia/Kolkata.'; } })(),
    approaching_days: !(Number.isInteger(f.approaching_days) && f.approaching_days >= 1 && f.approaching_days <= 365) ? 'Whole days from 1 to 365.' : null,
    request_window_days: !(Number.isInteger(f.request_window_days) && f.request_window_days >= 0 && f.request_window_days <= 365) ? 'Whole days from 0 to 365.' : null,
    default_payout_lag_days: !(Number.isInteger(f.default_payout_lag_days) && f.default_payout_lag_days >= 0 && f.default_payout_lag_days <= 60) ? 'Whole days from 0 to 60.' : null,
    lockin_options: !f.lockin_options.length ? 'Keep at least one lock-in option.' : null
  };
  const bad = Object.values(errs).some(Boolean);
  const e = (k: string) => (tried || changed.includes(k as keyof Editable) ? errs[k] : null);

  const save = async () => {
    setTried(true);
    if (bad || !changed.length) return;
    const p: Record<string, unknown> = {};
    changed.forEach(k => { p[k] = typeof f[k] === 'string' ? (f[k] as string).trim() : f[k]; });
    const r = await act.run(() => rpc('admin_save_settings', { p, p_reason: reason.trim() || 'Settings updated' }), ['Settings saved', `${changed.length} change${changed.length === 1 ? '' : 's'} · recorded in the audit log`]);
    if (r !== undefined) { setReason(''); await reloadSettings(); refreshAll(); }
  };

  const addLock = () => {
    const n = Number(newLock);
    if (!Number.isInteger(n) || n < 1 || n > 120) return;
    if (!f.lockin_options.includes(n)) set('lockin_options', [...f.lockin_options, n].sort((a, b) => a - b));
    setNewLock('');
  };

  return (
    <>
      <PageHead crumbs={['Settings']} title="Settings" sub={`Brand, product rules and administrators. Changes are audited. Last updated ${dateTime(s.updated_at)}.`} />
      <div className="card">
        <div className="tabs" style={{ padding: '0 12px' }} role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>
              {l}{k !== 'admins' && KEYS.some(x => changed.includes(x) && tabOf(x) === k) && <span className="c">edited</span>}
            </button>
          ))}
        </div>

        {tab === 'company' && <div className="card-b form">
          <LogoRow />
          <div className="f-row">
            <Field label="Company name" err={null} hint={!f.company_name.trim() ? 'Shown on the sign-in page, statements and emails.' : undefined}><input className="input" value={f.company_name} onChange={txt('company_name')} /></Field>
            <Field label="Tagline"><input className="input" value={f.tagline} onChange={txt('tagline')} placeholder="e.g. Private investment portfolios" /></Field>
          </div>
          <div className="f-row">
            <Field label="Primary colour" err={e('primary_color')}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="color" aria-label="Pick colour" value={/^#[0-9a-fA-F]{6}$/.test(f.primary_color) ? f.primary_color : '#0F2147'} onChange={txt('primary_color')} style={{ width: 44, height: 38, padding: 2, border: '1px solid var(--line-strong)', borderRadius: 7, background: 'var(--surface)' }} />
                <input className={'input mono ' + (e('primary_color') ? 'bad' : '')} value={f.primary_color} onChange={txt('primary_color')} />
              </div>
            </Field>
            <div />
          </div>
          <div className="f-row">
            <Field label="Support email" err={e('support_email')}><input className={'input ' + (e('support_email') ? 'bad' : '')} type="email" value={f.support_email} onChange={txt('support_email')} /></Field>
            <Field label="Support phone"><input className="input" value={f.support_phone} onChange={txt('support_phone')} /></Field>
          </div>
          <Field label="Legal footer" hint="Shown at the bottom of the sign-in page and statements (registration number, regulator, address…)."><textarea className="input" rows={3} value={f.legal_footer} onChange={txt('legal_footer')} /></Field>
        </div>}

        {tab === 'money' && <div className="card-b form">
          <div className="f-row">
            <Field label="Currency" hint="Changes how amounts are displayed. Existing amounts are not converted.">
              <select className="input" value={f.currency} onChange={txt('currency')}>
                {CURRENCIES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                {!CURRENCIES.some(c => c[0] === f.currency) && <option value={f.currency}>{f.currency}</option>}
              </select>
            </Field>
            <Field label="Number & date locale" err={e('locale')} hint="e.g. en-IN groups numbers as 1,00,000.">
              <input className={'input ' + (e('locale') ? 'bad' : '')} list="st-locales" value={f.locale} onChange={txt('locale')} />
              <datalist id="st-locales">{LOCALES.map(x => <option key={x} value={x} />)}</datalist>
            </Field>
          </div>
          <div className="f-row">
            <Field label="Business time zone" err={e('timezone')} hint="Decides what “today” is for accruals, maturities and payouts.">
              <input className={'input ' + (e('timezone') ? 'bad' : '')} list="st-zones" value={f.timezone} onChange={txt('timezone')} />
              <datalist id="st-zones">{ZONES.map(x => <option key={x} value={x} />)}</datalist>
            </Field>
            <Field label="Preview">
              <input className="input" readOnly value={(() => { try { return new Intl.NumberFormat(f.locale, { style: 'currency', currency: f.currency }).format(100000); } catch { return '—'; } })()} />
            </Field>
          </div>
          <div className="f-row">
            <Field label="“Unlocking soon” threshold (days)" err={e('approaching_days')} hint="How many days before a lock-in ends it shows as unlocking soon, on badges, reminders and the overview."><input className={'input ' + (e('approaching_days') ? 'bad' : '')} type="number" min={1} max={365} value={Number.isNaN(f.approaching_days) ? '' : f.approaching_days} onChange={num('approaching_days')} /></Field>
            <div />
          </div>
          <div className="f-row">
            <Field label="Default payout lag (days after accrual)" err={e('default_payout_lag_days')} hint="Default for new plans. Each plan version can override it."><input className={'input ' + (e('default_payout_lag_days') ? 'bad' : '')} type="number" min={0} max={60} value={Number.isNaN(f.default_payout_lag_days) ? '' : f.default_payout_lag_days} onChange={num('default_payout_lag_days')} /></Field>
            <div />
          </div>
        </div>}

        {tab === 'lockin' && <div className="card-b form">
          <Field label="Lock-in options (months)" err={e('lockin_options')} hint="Offered when you create or edit a plan. Existing plans and investments are not changed.">
            <div className="chips">
              {f.lockin_options.map(m => (
                <span key={m} className="chip on" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{m} months
                  <button type="button" aria-label={`Remove ${m} months`} onClick={() => set('lockin_options', f.lockin_options.filter(x => x !== m))} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          </Field>
          <div className="f-row">
            <Field label="Add a lock-in option" hint="1 to 120 months.">
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" inputMode="numeric" value={newLock} onChange={ev => setNewLock(ev.target.value.replace(/\D/g, ''))} onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); addLock(); } }} placeholder="e.g. 24" />
                <button type="button" className="btn" onClick={addLock}>Add</button>
              </div>
            </Field>
            <div />
          </div>
          <label className="check"><input type="checkbox" checked={f.allow_custom_lockin} onChange={ev => set('allow_custom_lockin', ev.target.checked)} /> Allow custom lock-in durations</label>
          <p className="hint" style={{ marginTop: -8 }}>When on, a plan can allow any lock-in from 1 to 120 months in addition to the options above.</p>
          <label className="check"><input type="checkbox" checked={f.four_eyes} onChange={ev => set('four_eyes', ev.target.checked)} /> Four-eyes control: require a second Super Admin</label>
          <div className="note info">
            With four-eyes on, the admin who performed a step cannot perform the approving step: confirming a deposit you recorded, confirming payouts you sent to the bank,
            and approving an amendment you recorded. It only applies when there is more than one active Super Admin.
          </div>
        </div>}

        {tab === 'terms' && <div className="card-b form">
          <Field label="Default terms" hint="Pre-filled on new plans, and used for any investment whose plan version has no terms of its own.">
            <textarea className="input" rows={8} value={f.default_terms} onChange={txt('default_terms')} />
          </Field>
          <Field label="Default risk disclosure" hint="Shown to investors with every investment. Pre-filled on new plans.">
            <textarea className="input" rows={6} value={f.default_risk_disclosure} onChange={txt('default_risk_disclosure')} />
          </Field>
        </div>}

        {tab === 'admins' && <Admins />}

        {tab !== 'admins' && (
          <div className="card-b" style={{ borderTop: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="st-reason">Reason for change (saved to audit log)</label>
              <input id="st-reason" className="input" value={reason} onChange={ev => setReason(ev.target.value)} placeholder="Settings updated" />
            </div>
            <span className="hint">{changed.length ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}` : 'No changes'}</span>
            <button className="btn ghost" disabled={!changed.length || act.busy} onClick={() => { setF(pick(s)); setTried(false); }}>Discard</button>
            <button className="btn primary" disabled={!changed.length || act.busy} onClick={save}>{act.busy ? 'Saving…' : 'Save changes'}</button>
            {tried && bad && <p className="hint err" style={{ width: '100%' }}>Some fields need attention{(() => { const t = KEYS.filter(k => errs[k]).map(tabOf).filter((x, i, a) => a.indexOf(x) === i); return t.length ? ' on: ' + t.map(x => TABS.find(y => y[0] === x)?.[1]).join(', ') : ''; })()}.</p>}
          </div>
        )}
      </div>

      {tab !== 'admins' && <AccrualJob />}
    </>
  );
}

function tabOf(k: keyof Editable): Tab {
  if (['company_name', 'tagline', 'primary_color', 'support_email', 'support_phone', 'legal_footer'].includes(k)) return 'company';
  if (['currency', 'locale', 'timezone', 'approaching_days', 'request_window_days', 'default_payout_lag_days'].includes(k)) return 'money';
  if (['lockin_options', 'allow_custom_lockin', 'four_eyes'].includes(k)) return 'lockin';
  return 'terms';
}

function LogoRow() {
  const s = useSettings();
  const { reloadSettings } = useAuth();
  const act = useAction();
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const r = await act.run(async () => { const url = await uploadLogo(file); await rpc('admin_save_settings', { p: { logo_url: url }, p_reason: 'Logo updated' }); return true; }, ['Logo updated', 'Shown on the sign-in page and in the sidebar.']);
    if (r) await reloadSettings();
  };
  const remove = async () => {
    const r = await act.run(async () => { await rpc('admin_save_settings', { p: { logo_url: '' }, p_reason: 'Logo removed' }); return true; }, ['Logo removed']);
    if (r) await reloadSettings();
  };
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      {s.logo_url
        ? <img className="logo" src={s.logo_url} alt="Company logo" style={{ width: 52, height: 52, borderRadius: 12, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)' }} />
        : <div className="logo" style={{ width: 52, height: 52, fontSize: 22, borderRadius: 12 }}>{(s.company_name || 'P').trim().charAt(0).toUpperCase()}</div>}
      <label className="btn sm" style={{ cursor: 'pointer' }}>
        <Icon name="upload" />{act.busy ? 'Uploading…' : s.logo_url ? 'Replace logo' : 'Upload logo'}
        <input type="file" accept="image/*" style={{ display: 'none' }} disabled={act.busy} onChange={ev => { pickFile(ev.target.files?.[0]); ev.target.value = ''; }} />
      </label>
      {s.logo_url && <button className="btn sm ghost" onClick={remove} disabled={act.busy}>Remove</button>}
      <span className="hint">PNG, SVG or JPG up to 2 MB. Saved immediately.</span>
    </div>
  );
}

/* =============================== ADMINISTRATORS =============================== */
type Lite = Pick<Profile, 'id' | 'full_name' | 'email' | 'code' | 'account_status' | 'created_at' | 'role' | 'kyc_status'>;

function Admins() {
  const { profile: me } = useAuth();
  const [dlg, setDlg] = useState<null | 'add' | 'promote' | { demote: Lite }>(null);
  const q = useQuery(async () => {
    const admins = must(await api.from('profiles').select('id,full_name,email,code,account_status,created_at,role,kyc_status').eq('role', 'super_admin').order('created_at')) as Lite[];
    return admins;
  }, []);
  return (
    <div className="card-b" style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <p className="hint" style={{ flex: 1, minWidth: 220 }}>Super Admins can see every investor and approve money movements. You cannot change your own role.</p>
        <button className="btn" onClick={() => setDlg('promote')}>Promote an investor</button>
        <button className="btn accent" onClick={() => setDlg('add')}><Icon name="plus" />Add administrator</button>
      </div>
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading rows={2} /> : (
        <div className="list">
          {q.data.map(a => (
            <div key={a.id}>
              <div className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{initials(a.full_name || a.email)}</div>
              <div className="grow"><b>{a.full_name || a.email}{a.id === me?.id ? ' (you)' : ''}</b><span>{a.code} · {a.email} · since {date(a.created_at)}</span></div>
              <AcctBadge s={a.account_status} />
              <Badge cls="b-navy">Super Admin</Badge>
              {a.id !== me?.id && <button className="btn sm danger" onClick={() => setDlg({ demote: a })}>Remove admin role</button>}
            </div>
          ))}
          {q.data.length === 1 && <div><div className="grow"><span>You are the only administrator. Four-eyes approvals take effect once a second Super Admin is added.</span></div></div>}
        </div>
      )}
      {dlg === 'add' && <AddAdmin onClose={() => setDlg(null)} />}
      {dlg === 'promote' && <Promote onClose={() => setDlg(null)} />}
      {dlg && typeof dlg === 'object' && <RoleDialog who={dlg.demote} to="investor" onClose={() => setDlg(null)} />}
    </div>
  );
}

function AddAdmin({ onClose }: { onClose: () => void }) {
  const act = useAction();
  const [mode, setMode] = useState<'invite' | 'password'>('password');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [tried, setTried] = useState(false);
  const errs = { name: !name.trim() ? 'Enter a name.' : null, email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Enter a valid email address.' : null, pw: mode === 'password' && pw.length < 10 ? 'Use at least 10 characters.' : null };
  const go = async () => {
    setTried(true); if (errs.name || errs.email || errs.pw) return;
    const r = await act.run(() => createUser({ mode, role: 'super_admin', email: email.trim().toLowerCase(), full_name: name.trim(), password: mode === 'password' ? pw : undefined }),
      ['Administrator added', mode === 'invite' ? `${email.trim()} will receive an invitation.` : 'Share the temporary password securely.']);
    if (r) { refreshAll(); onClose(); }
  };
  return (
    <Drawer title="Add administrator" sub="Creates a new Super Admin login with full access." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>{mode === 'invite' ? 'Create and send invite' : 'Create administrator'}</button></>}>
      <div className="form">
        <div className="field">
          <label>How will they sign in?</label>
          <div className="chips">
            <button type="button" className={'chip ' + (mode === 'password' ? 'on' : '')} onClick={() => setMode('password')}>Temporary password</button>
          </div>
          <p className="hint">{mode === 'invite' ? 'We email a secure link to choose a password.' : 'You set a password now and share it securely. They should change it from Profile & Security after signing in.'}</p>
        </div>
        <Field label="Full name *" err={tried ? errs.name : null}><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Email *" err={tried ? errs.email : null}><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        {mode === 'password' && <Field label="Temporary password *" err={tried ? errs.pw : null} hint="At least 10 characters."><input className="input mono" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" /></Field>}
        <div className="note">Administrators can move money: record and activate investments and confirm payouts. Ask them to change their temporary password after signing in.</div>
      </div>
    </Drawer>
  );
}

function Promote({ onClose }: { onClose: () => void }) {
  const q = useQuery(() => fetchAll<Lite>((a, b) => api.from('profiles').select('id,full_name,email,code,account_status,created_at,role,kyc_status').eq('role', 'investor').eq('account_status', 'active').order('full_name').range(a, b)), []);
  const [id, setId] = useState('');
  const who = q.data?.find(x => x.id === id);
  if (who) return <RoleDialog who={who} to="super_admin" onClose={onClose} />;
  return (
    <Modal title="Promote an investor to Super Admin" sub="Choose an existing, active account." onClose={onClose}
      foot={<button className="btn ghost" onClick={onClose}>Cancel</button>}>
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading rows={1} /> : q.data.length ? (
        <Field label="Account">
          <select className="input" value={id} onChange={e => setId(e.target.value)}>
            <option value="">Choose…</option>
            {q.data.map(p => <option key={p.id} value={p.id}>{p.full_name || p.email} · {p.code} · {p.email}</option>)}
          </select>
        </Field>
      ) : <Empty title="No active investor accounts">Use “Add administrator” to create a new login instead.</Empty>}
    </Modal>
  );
}

function RoleDialog({ who, to, onClose }: { who: Lite; to: 'super_admin' | 'investor'; onClose: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const go = async () => {
    setTried(true); if (!reason.trim()) return;
    const r = await act.run(() => rpc('admin_set_role', { p_id: who.id, p_role: to, p_reason: reason.trim() }),
      [to === 'super_admin' ? 'Administrator added' : 'Admin role removed', `${who.full_name || who.email} · recorded in the audit log`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={to === 'super_admin' ? `Make ${who.full_name || who.email} a Super Admin?` : `Remove admin role from ${who.full_name || who.email}?`}
      sub={to === 'super_admin' ? 'They will get full access to every investor, plan and money movement, and receive a new ADM code.' : 'They become an investor account and lose access to the admin dashboard immediately.'}
      onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className={'btn ' + (to === 'super_admin' ? 'primary' : 'danger')} onClick={go} disabled={act.busy}>{to === 'super_admin' ? 'Promote' : 'Remove role'}</button></>}>
      <Field label="Reason (required, saved to audit log)" err={tried && !reason.trim() ? 'Enter a reason.' : null}>
        <input className={'input ' + (tried && !reason.trim() ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder={to === 'super_admin' ? 'e.g. New operations manager' : 'e.g. Left the company'} />
      </Field>
    </Modal>
  );
}

/* =============================== SCHEDULED JOB =============================== */
function AccrualJob() {
  const s = useSettings();
  const act = useAction();
  const [last, setLast] = useState<{ as_of: string; created: number } | null>(null);
  const q = useQuery(async () => {
    const rows = must(await api.from('audit_logs').select('*').eq('action', 'job.accrual.run').order('at', { ascending: false }).limit(1)) as AuditLog[];
    return rows[0] || null;
  }, []);
  const run = async () => {
    const r = await act.run(() => rpc<{ as_of: string; created: number }>('admin_run_accruals'));
    if (r) {
      setLast(r);
      refreshAll();
    }
  };
  const lastRun = q.data;
  const lastAfter = lastRun?.after as { created?: number } | null | undefined;
  return (
    <div className="card">
      <div className="card-h"><h3>Scheduled job · monthly accruals</h3><div className="r"><Badge cls="b-green">Hourly</Badge></div></div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
          Accruals run automatically every hour. On each investment’s monthly anniversary the job posts one accrual of
          principal × rate (for example {money(100000)} at 2% earns {money(monthlyReturn(100000, 2))}), queues its payout and notifies the investor.
          Each period can be accrued only once, so running it again never creates duplicates. “Today” follows the business time zone ({s.timezone}).
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={run} disabled={act.busy}><Icon name="refresh" />{act.busy ? 'Running…' : 'Run accruals now'}</button>
          {last && <span className={last.created ? 'pos' : 'muted'} style={{ fontSize: 13 }}>{last.created ? `${last.created} new accrual${last.created === 1 ? '' : 's'} created` : 'No new accruals — everything due was already posted'} (as of {date(last.as_of)}).</span>}
          {!last && lastRun && <span className="hint">Last manual run {dateTime(lastRun.at)} by {lastRun.actor_name}{lastAfter && typeof lastAfter.created === 'number' ? ` · ${lastAfter.created} created` : ''}.</span>}
          <Link to="/admin/accruals" style={{ marginLeft: 'auto', fontSize: 13 }}>View accruals</Link>
        </div>
      </div>
    </div>
  );
}
