import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, type Session } from './api';
import { configureFormat } from './format';
import type { Profile, Settings } from './types';

export interface Branding { company_name: string; tagline: string; logo_url: string | null; primary_color: string; support_email: string; legal_footer: string }

interface AuthState {
  ready: boolean;
  session: Session | null;
  profile: Profile | null;
  settings: Settings | null;
  branding: Branding | null;
  /** true when the account has 2FA set up but this session has not passed it yet */
  needsMfa: boolean;
  reloadProfile: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
};
/** Settings are always loaded once signed in. */
export const useSettings = () => useAuth().settings!;

export function applyBrand(b: { primary_color?: string; company_name?: string } | null) {
  if (!b) return;
  if (b.primary_color && /^#[0-9a-fA-F]{6}$/.test(b.primary_color)) document.documentElement.style.setProperty('--navy', b.primary_color);
  document.title = (b.company_name || 'Investor Portal') + ' · Portfolio';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);

  const loadBranding = useCallback(async () => {
    const { data } = await api.rpc('public_branding');
    if (data) { setBranding(data as Branding); applyBrand(data as Branding); }
  }, []);

  const reloadSettings = useCallback(async () => {
    const { data } = await api.from('settings').select('*').eq('id', 1).maybeSingle();
    if (data) { setSettings(data as Settings); configureFormat(data as Settings); applyBrand(data as Settings); }
  }, []);

  const reloadProfile = useCallback(async () => {
    const { data: u } = await api.auth.getUser();
    if (!u.user) { setProfile(null); return; }
    const { data } = await api.from('profiles').select('*').eq('id', u.user.id).maybeSingle();
    setProfile((data as Profile) || null);
  }, []);

  const loadFor = useCallback(async (s: Session | null) => {
    setSession(s);
    if (!s) { setProfile(null); setSettings(null); setNeedsMfa(false); return; }
    const { data: aal } = await api.auth.mfa.getAuthenticatorAssuranceLevel();
    setNeedsMfa(!!aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2');
    await Promise.all([reloadProfile(), reloadSettings()]);
  }, [reloadProfile, reloadSettings]);

  useEffect(() => {
    let alive = true;
    loadBranding();
    api.auth.getSession().then(async ({ data }) => { await loadFor(data.session); if (alive) setReady(true); });
    const { data: sub } = api.auth.onAuthStateChange((ev, s) => {
      if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT' || ev === 'MFA_CHALLENGE_VERIFIED' || ev === 'USER_UPDATED') {
        // defer: never await data calls inside this callback
        setTimeout(() => { loadFor(s); }, 0);
      } else if (ev === 'TOKEN_REFRESHED') setSession(s);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadFor, loadBranding]);

  const signOut = useCallback(async () => { await api.auth.signOut(); setProfile(null); setSession(null); }, []);

  return <Ctx.Provider value={{ ready, session, profile, settings, branding, needsMfa, reloadProfile, reloadSettings, signOut }}>{children}</Ctx.Provider>;
}
