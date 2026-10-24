import { FormEvent, useState } from 'react';
import { api, rpc, friendly } from '../lib/api';
import { useAuth } from '../lib/auth';
import { KycBadge, PageHead, useToast } from '../ui/kit';
import { date } from '../lib/format';

/** Shared by both dashboards: contact details and password. */
export function ProfileSecurity() {
  const { profile, reloadProfile, settings } = useAuth();
  const toast = useToast();
  const p = profile!;
  const [phone, setPhone] = useState(p.phone);
  const [address, setAddress] = useState(p.address);
  const [city, setCity] = useState(p.city);
  const [notifyEmail, setNotifyEmail] = useState(p.notify_email);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState('');
  const saveProfile = async (e: FormEvent) => {
    e.preventDefault(); setBusy('profile');
    try { await rpc('update_my_profile', { p_phone: phone, p_address: address, p_city: city, p_notify_email: notifyEmail }); await reloadProfile(); toast('Profile saved'); }
    catch (err) { toast('Could not save', (err as Error).message, 'err'); } finally { setBusy(''); }
  };
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 10) { toast('Password too short', 'Use at least 10 characters.', 'warn'); return; }
    setBusy('pw');
    const { error } = await api.auth.updateUser({ password: pw });
    setBusy('');
    if (error) toast('Could not change password', friendly(error.message), 'err'); else { setPw(''); toast('Password changed'); }
  };
  return (
    <>
      <PageHead crumbs={['Profile & Security']} title="Profile & Security" sub={`${p.code} · ${p.email} · member since ${date(p.created_at)}`} actions={p.role === 'investor' ? <KycBadge k={p.kyc_status} /> : undefined} />
      <div className="grid g-1-1">
        <div className="card"><div className="card-h"><h3>Contact details</h3></div><div className="card-b">
          <form className="form" onSubmit={saveProfile}>
            <div className="f-row"><div className="field"><label>Full name</label><input className="input" value={p.full_name} disabled /></div><div className="field"><label>Email</label><input className="input" value={p.email} disabled /></div></div>
            <div className="f-row"><div className="field"><label htmlFor="ph">Phone</label><input className="input" id="ph" value={phone} onChange={e => setPhone(e.target.value)} /></div><div className="field"><label htmlFor="ct">City</label><input className="input" id="ct" value={city} onChange={e => setCity(e.target.value)} /></div></div>
            <div className="field"><label htmlFor="ad">Address</label><textarea className="input" id="ad" rows={2} value={address} onChange={e => setAddress(e.target.value)} /></div>
            <label className="check"><input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} /> Email me important updates</label>
            {p.role === 'investor' && <p className="hint">Name, email and bank details can only be changed by {settings?.company_name || 'the administrator'} for your protection{settings?.support_email ? ` (${settings.support_email})` : ''}.</p>}
            <div><button className="btn primary" disabled={busy === 'profile'}>{busy === 'profile' ? 'Saving…' : 'Save details'}</button></div>
          </form>
          {p.role === 'investor' && (
            <dl className="kv" style={{ marginTop: 18 }}>
              <dt>Bank</dt><dd>{p.bank_name || '—'}</dd><dt>Account</dt><dd className="mono">{p.bank_account_masked || '—'}</dd>
              <dt>IFSC / routing</dt><dd className="mono">{p.bank_ifsc || '—'}</dd><dt>ID number</dt><dd className="mono">{p.id_number_masked || '—'}</dd>
            </dl>
          )}
        </div></div>
        <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
          <div className="card"><div className="card-h"><h3>Change password</h3></div><div className="card-b">
            <form className="form" onSubmit={changePw}>
              <div className="field"><label htmlFor="np">New password</label><input className="input" id="np" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /><p className="hint">At least 10 characters.</p></div>
              <div><button className="btn" disabled={busy === 'pw'}>{busy === 'pw' ? 'Saving…' : 'Change password'}</button></div>
            </form>
          </div></div>
        </div>
      </div>
    </>
  );
}
