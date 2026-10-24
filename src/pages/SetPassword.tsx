import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, friendly } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Landing page for invitation and password-reset links. */
export function SetPassword() {
  const { session, ready } = useAuth();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw.length < 10) { setErr('Use at least 10 characters.'); return; }
    if (pw !== pw2) { setErr('The two passwords do not match.'); return; }
    setBusy(true);
    const { error } = await api.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setErr(friendly(error.message)); return; }
    nav('/', { replace: true });
  };

  return (
    <div className="login">
      <section className="login-r" style={{ gridColumn: '1 / -1' }}>
        <form className="login-box" onSubmit={save}>
          <div><h2>Choose your password</h2><p className="hint" style={{ fontSize: 13.5, marginTop: 4 }}>At least 10 characters. You will use it with your email to sign in.</p></div>
          {ready && !session ? (
            <p className="hint" style={{ color: 'var(--red)' }}>This link has expired or was already used. Ask for a new one from the sign-in page (Forgot password).</p>
          ) : (
            <>
              <div className="field"><label htmlFor="p1">New password</label><input className="input" id="p1" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></div>
              <div className="field"><label htmlFor="p2">Repeat password</label><input className="input" id="p2" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></div>
              {err && <p className="hint" role="alert" style={{ color: 'var(--red)' }}>{err}</p>}
              <button className="btn primary" style={{ padding: 13 }} disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
            </>
          )}
          <a href="/login" style={{ textAlign: 'center' }}>Back to sign in</a>
        </form>
      </section>
    </div>
  );
}
