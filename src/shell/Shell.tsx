import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { CrumbCtx } from '../ui/kit';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { dateShort, initials } from '../lib/format';
import { onRefresh, refreshAll } from '../lib/useQuery';
import type { Notification } from '../lib/types';

export interface NavItem { group?: string; to?: string; label?: string; icon?: string; count?: number; also?: string[] }

export function Logo({ name, url, size }: { name: string; url: string | null | undefined; size?: number }) {
  const s = size ? { width: size, height: size } : undefined;
  if (url) return <img className="logo" src={url} alt="" style={{ ...s, objectFit: 'contain', background: '#fff' }} />;
  return <div className="logo" style={s}>{(name || 'P').trim().charAt(0).toUpperCase()}</div>;
}

export function Shell({ roleLabel, nav, searchPh, onSearch, base }: { roleLabel: string; nav: NavItem[]; searchPh: string; onSearch: (q: string) => void; base: string }) {
  const { profile, settings, signOut } = useAuth();
  const navTo = useNavigate();
  const loc = useLocation();
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('pms-side') === '1'; } catch { return false; } });
  const [mob, setMob] = useState(false);
  const [pop, setPop] = useState<'' | 'bell' | 'user'>('');
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [q, setQ] = useState('');

  const loadNotifs = useCallback(async () => {
    if (!profile) return;
    const { data } = await api.from('notifications').select('*').eq('user_id', profile.id).order('created_at', { ascending: false }).limit(30);
    setNotifs((data as Notification[]) || []);
  }, [profile]);

  // live bell: realtime when available, polling as a fallback
  useEffect(() => {
    if (!profile) return;
    loadNotifs();
    const ch = api.channel('notif-' + profile.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${profile.id}` }, () => { loadNotifs(); refreshAll(); })
      .subscribe();
    const t = setInterval(loadNotifs, 60000);
    const off = onRefresh(loadNotifs);
    return () => { clearInterval(t); off(); api.removeChannel(ch); };
  }, [profile, loadNotifs]);

  useEffect(() => { setMob(false); setPop(''); window.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => {
    const f = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.popover,[data-pop]')) setPop(''); };
    document.addEventListener('click', f);
    return () => document.removeEventListener('click', f);
  }, []);

  const unread = notifs.filter(n => !n.read_at).length;
  const markAll = async () => { await api.rpc('mark_notifications_read', { p_ids: null }); loadNotifs(); refreshAll(); };
  const openN = async (n: Notification) => {
    if (!n.read_at) await api.rpc('mark_notifications_read', { p_ids: [n.id] });
    setPop(''); loadNotifs();
    if (n.link) navTo(n.link);
  };
  const company = settings?.company_name || 'Your company';
  const toggleCollapse = () => setCollapsed(c => { try { localStorage.setItem('pms-side', c ? '0' : '1'); } catch { /* ignore */ } return !c; });

  return (
    <CrumbCtx.Provider value={setCrumbs}>
      <div className={'shell ' + (collapsed ? 'collapsed ' : '') + (mob ? 'mob-open' : '')}>
        <aside className="sidebar">
          <div className="brand"><Logo name={company} url={settings?.logo_url} /><div className="brand-txt"><b>{company}</b><small>{roleLabel}</small></div></div>
          <nav>
            {nav.map((n, i) => n.group ? <div key={i} className="nav-grp">{n.group}</div> : (
              <NavLink key={n.to} to={n.to!} end={n.to === base} className={({ isActive }) => 'nav-a' + (isActive || n.also?.some(x => loc.pathname.startsWith(x)) ? ' on' : '')} title={n.label}>
                <Icon name={n.icon!} /><span>{n.label}</span>{!!n.count && <em className="ct">{n.count}</em>}
              </NavLink>
            ))}
          </nav>
          <div className="side-foot"><div className="avatar">{initials(profile?.full_name || profile?.email || '')}</div><div className="who"><b>{profile?.full_name || profile?.email}</b><small>{profile?.code} · {roleLabel}</small></div></div>
        </aside>
        <div className="scrim mob-scrim" onClick={() => setMob(false)} />
        <div className="main">
          <header className="topbar">
            <button className="icon-btn mobile-only" onClick={() => setMob(true)} aria-label="Open menu"><Icon name="menu" /></button>
            <button className="icon-btn desk-only" onClick={toggleCollapse} aria-label="Collapse sidebar" title="Collapse sidebar"><Icon name="collapse" /></button>
            <div className="crumbs">{crumbs.map((c, i) => <span key={i}>{i > 0 && ' / '}{i === crumbs.length - 1 ? <b>{c}</b> : c}</span>)}</div>
            <form className="gsearch" onSubmit={e => { e.preventDefault(); if (q.trim()) onSearch(q.trim()); }} role="search">
              <Icon name="search" /><input value={q} onChange={e => setQ(e.target.value)} placeholder={searchPh} aria-label="Search" />
            </form>
            <div style={{ position: 'relative' }} data-pop>
              <button className="icon-btn" onClick={() => setPop(pop === 'bell' ? '' : 'bell')} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}><Icon name="bell" />{unread > 0 && <em>{unread > 99 ? '99+' : unread}</em>}</button>
              {pop === 'bell' && (
                <div className="popover">
                  <div className="ph2"><b>Notifications</b>{unread > 0 && <a style={{ cursor: 'pointer' }} onClick={markAll}>Mark all as read</a>}</div>
                  <div className="pl list">
                    {notifs.slice(0, 8).map(n => (
                      <div key={n.id} onClick={() => openN(n)} style={{ cursor: 'pointer' }}>
                        <span className={'dot ' + (n.read_at ? '' : 'unread')} />
                        <div className="grow"><b style={n.read_at ? { fontWeight: 400 } : undefined}>{n.title}</b><span>{n.body}{n.body ? ' · ' : ''}{dateShort(n.created_at)}</span></div>
                      </div>
                    ))}
                    {!notifs.length && <div><div className="grow"><span>You are all caught up.</span></div></div>}
                  </div>
                  <div className="pf"><a style={{ cursor: 'pointer' }} onClick={() => { setPop(''); navTo(base + '/notifications'); }}>View all notifications</a></div>
                </div>
              )}
            </div>
            <div style={{ position: 'relative' }} data-pop>
              <button className="avatar" onClick={() => setPop(pop === 'user' ? '' : 'user')} aria-label="Account">{initials(profile?.full_name || profile?.email || '')}</button>
              {pop === 'user' && (
                <div className="popover" style={{ width: 240 }}>
                  <div className="ph2"><div><b>{profile?.full_name || 'Account'}</b><div className="hint">{profile?.email}</div></div></div>
                  <div className="pl" style={{ padding: 6 }}>
                    <a className="nav-a" style={{ color: 'var(--fg)', cursor: 'pointer' }} onClick={() => navTo(base + '/profile')}><Icon name="user" /><span>Profile & security</span></a>
                    <a className="nav-a" style={{ color: 'var(--fg)', cursor: 'pointer' }} onClick={async () => { await signOut(); navTo('/login'); }}><Icon name="logout" /><span>Sign out</span></a>
                  </div>
                </div>
              )}
            </div>
          </header>
          <main className="content"><Outlet /></main>
        </div>
      </div>
    </CrumbCtx.Provider>
  );
}

