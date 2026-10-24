import { FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, friendly } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo } from '../shell/Shell';

/** Sign-in details filled in when a role is chosen. */

export function Login() {
  const { session, profile, branding, needsMfa, ready } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<'signin' | 'reset' | 'mfa'>('signin');
  const [resetNote, setResetNote] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [as, setAs] = useState<'super_admin' | 'investor'>('super_admin');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: string; ok?: boolean } | null>(null);

  useEffect(() => { if (session && needsMfa) setMode('mfa'); }, [session, needsMfa]);

  if (ready && session && profile && !needsMfa) return <Navigate to={profile.role === 'super_admin' ? '/admin' : '/portal'} replace />;

  const signIn = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    const { data, error } = await api.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (!error && data.session) {
      try { sessionStorage.removeItem('pms-parva-seen'); } catch { /* ignore */ }
      // the chosen role must match the account, so an investor cannot land on the admin sign-in by mistake
      const { data: p } = await api.from('profiles').select('role').eq('id', data.session.user.id).maybeSingle();
      if (p && p.role !== as) {
        await api.auth.signOut(); setBusy(false);
        setMsg({ t: `This is ${p.role === 'super_admin' ? 'a Super Admin' : 'an Investor'} account. Choose “${p.role === 'super_admin' ? 'Super Admin' : 'Investor'}” above and sign in again.` });
        return;
      }
    }
    setBusy(false);
    if (error) setMsg({ t: /invalid/i.test(error.message) ? (as === 'investor' ? 'Phone number or password is incorrect.' : 'Email or password is incorrect.') : friendly(error.message) });
  };
  /** Forgot password: the Super Admin is emailed (and notified in the app) and sets a new temporary password. */
  const sendReset = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    if (as === 'investor' && email.replace(/\D/g, '').length < 10) { setMsg({ t: 'Enter your 10-digit phone number.' }); return; }
    setBusy(true);
    const { error } = await api.auth.resetPasswordForEmail(email.trim(), { message: resetNote.trim() });
    setBusy(false);
    if (error) { setMsg({ t: friendly(error.message) }); return; }
    setMsg({ t: `Request sent. If this ${as === 'investor' ? 'phone number' : 'email'} has an account, the Super Admin has been emailed and will set a new temporary password and share it with you.${branding?.support_email ? ` Questions: ${branding.support_email}` : ''}`, ok: true });
  };
  const verifyMfa = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const { data: f, error: fe } = await api.auth.mfa.listFactors();
      if (fe) throw fe;
      const factor = f.totp.find(x => x.status === 'verified');
      if (!factor) throw new Error('No authenticator is set up on this account.');
      const { error } = await api.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
      if (error) throw error;
      nav('/', { replace: true });
    } catch (err) {
      setMsg({ t: err instanceof Error ? (/invalid/i.test(err.message) ? 'That code is not valid. Try the current code.' : friendly(err.message)) : 'Could not verify.' });
    } finally { setBusy(false); }
  };

  const company = branding?.company_name || 'Investor Portal';
  return (
    <div className="login">
      <section className="login-l">
        <div className="brand" style={{ padding: 0 }}><Logo name={company} url={branding?.logo_url} /><div className="brand-txt"><b>{company}</b><small>Portfolio Management System</small></div></div>
        <div style={{ display: 'grid', gap: 14, marginTop: 40, position: 'relative', zIndex: 1 }}>
          <h1>{branding?.tagline || 'Every investment, return and maturity in one place.'}</h1>
          <p>Monthly simple-interest plans with contractual lock-ins, transparent accruals and confirmed payouts.</p>
        </div>
        <a className="login-parva" href="https://www.parvarealty.ae/" target="_blank" rel="noopener noreferrer">
          <span className="pb-tag">PARVA REALTY · DUBAI</span>
          <b>Explore premium Dubai properties</b>
          <span>Mercedes-Benz Places, Portofino Felicita, Sunset Bay Grand and more ›</span>
        </a>
        <div className="hint" style={{ color: 'var(--on-navy-2)', position: 'relative', zIndex: 1 }}>{branding?.legal_footer}</div>
      </section>
      <section className="login-r">
        {mode === 'signin' && (
          <form className="login-box" onSubmit={signIn}>
            <div><h2>Sign in</h2><p className="hint" style={{ fontSize: 13.5, marginTop: 4 }}>Super Admin signs in with email. Investors sign in with their phone number.</p></div>
            <div className="role-pick" role="radiogroup" aria-label="I am a">
              {(['super_admin', 'investor'] as const).map(r => (
                <button key={r} type="button" role="radio" aria-checked={as === r} className={'role ' + (as === r ? 'on' : '')} onClick={() => { setAs(r); setEmail(''); setPw(''); setMsg(null); }}>
                  <b>{r === 'super_admin' ? 'Super Admin' : 'Investor'}</b><span>{r === 'super_admin' ? 'Records investors, investments, withdrawals and payouts' : 'Your investments, returns, requests and withdrawals'}</span>
                </button>
              ))}
            </div>
            <div className="field"><label htmlFor="em">{as === 'investor' ? 'Phone number' : 'Email'}</label><input className="input" id="em" type={as === 'investor' ? 'tel' : 'email'} inputMode={as === 'investor' ? 'tel' : undefined} required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder={as === 'investor' ? 'e.g. 98450 10000' : undefined} /></div>
            <div className="field"><label htmlFor="pw">Password</label><input className="input" id="pw" type="password" required autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><a style={{ cursor: 'pointer' }} onClick={() => { setMode('reset'); setMsg(null); setResetNote(''); }}>Forgot password?</a></div>
            {msg && <p className="hint" role="alert" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.t}</p>}
            <button className="btn primary" style={{ padding: 13 }} type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <div className="divider">Security</div>
            <p className="hint">All accounts and first passwords are set by the Super Admin. Change your password any time from Profile & Security after signing in.{branding?.support_email ? ` Need help? ${branding.support_email}` : ''}</p>
          </form>
        )}
        {mode === 'reset' && (
          <form className="login-box" onSubmit={sendReset}>
            <div><h2>Forgot password</h2><p className="hint" style={{ fontSize: 13.5, marginTop: 4 }}>The Super Admin gets an email, sets a new temporary password for you and shares it with you.</p></div>
            <div className="role-pick" role="radiogroup" aria-label="I am a">
              {(['super_admin', 'investor'] as const).map(r => (
                <button key={r} type="button" role="radio" aria-checked={as === r} className={'role ' + (as === r ? 'on' : '')} onClick={() => { setAs(r); setEmail(''); setMsg(null); }}>
                  <b>{r === 'super_admin' ? 'Super Admin' : 'Investor'}</b><span>{r === 'super_admin' ? 'Signs in with email' : 'Signs in with phone number'}</span>
                </button>
              ))}
            </div>
            <div className="field"><label htmlFor="em2">{as === 'investor' ? 'Phone number' : 'Email'}</label><input className="input" id="em2" type={as === 'investor' ? 'tel' : 'email'} inputMode={as === 'investor' ? 'tel' : undefined} required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder={as === 'investor' ? 'e.g. 98450 10000' : undefined} /></div>
            <div className="field"><label htmlFor="rn">Message to the Super Admin (optional)</label><input className="input" id="rn" maxLength={500} value={resetNote} onChange={e => setResetNote(e.target.value)} placeholder="e.g. Please call me on this number" /></div>
            {msg && <p className="hint" role="status" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.t}</p>}
            <button className="btn primary" style={{ padding: 13 }} type="submit" disabled={busy || !!msg?.ok}>{busy ? 'Sending…' : 'Email the Super Admin'}</button>
            <a style={{ cursor: 'pointer', textAlign: 'center' }} onClick={() => { setMode('signin'); setMsg(null); setResetNote(''); }}>Back to sign in</a>
          </form>
        )}
        {mode === 'mfa' && (
          <form className="login-box" onSubmit={verifyMfa}>
            <div><h2>Two-factor check</h2><p className="hint" style={{ fontSize: 13.5, marginTop: 4 }}>Enter the 6-digit code from your authenticator app.</p></div>
            <div className="field"><label htmlFor="otp">Code</label><input className="input mono" id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></div>
            {msg && <p className="hint" role="alert" style={{ color: 'var(--red)' }}>{msg.t}</p>}
            <button className="btn primary" style={{ padding: 13 }} type="submit" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify'}</button>
            <a style={{ cursor: 'pointer', textAlign: 'center' }} onClick={() => api.auth.signOut()}>Use a different account</a>
          </form>
        )}
      </section>
    </div>
  );
}
