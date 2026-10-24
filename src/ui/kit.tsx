import { ButtonHTMLAttributes, createContext, KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon } from './Icon';
import { INV_BADGE, LEDGER_BADGE, PAY_BADGE, investmentLabel } from '../lib/format';
import type { Investment } from '../lib/types';

/* ---------- badges, tips, KPI tiles ---------- */
export const Badge = ({ cls, children }: { cls: string; children: ReactNode }) => <span className={'badge ' + cls}>{children}</span>;
export const PayBadge = ({ s }: { s: string }) => <Badge cls={(PAY_BADGE[s] || [s, 'b-grey'])[1]}>{(PAY_BADGE[s] || [s])[0]}</Badge>;
export const LedgerBadge = ({ s }: { s: string }) => <Badge cls={(LEDGER_BADGE[s] || [s, 'b-grey'])[1]}>{(LEDGER_BADGE[s] || [s])[0]}</Badge>;
export const InvBadge = ({ i, approachingDays }: { i: Investment; approachingDays: number }) => {
  const l = investmentLabel(i, approachingDays);
  return <Badge cls={INV_BADGE[l] || 'b-grey'}>{l}</Badge>;
};
export const KycBadge = ({ k }: { k: string }) =>
  k === 'verified' ? <Badge cls="b-green">Verified</Badge> : k === 'rejected' ? <Badge cls="b-red">KYC rejected</Badge> : <Badge cls="b-amber">KYC pending</Badge>;
export const AcctBadge = ({ s }: { s: string }) => (s === 'active' ? <Badge cls="b-blue">Active</Badge> : <Badge cls="b-red">Suspended</Badge>);
export const Tip = ({ t }: { t: string }) => <span className="tip" tabIndex={0} data-tip={t}>i</span>;

export function Kpi({ label, value, sub, tip, cls, subCls, onClick }: { label: string; value: ReactNode; sub?: ReactNode; tip?: string; cls?: string; subCls?: string; onClick?: () => void }) {
  const click = onClick ? { onClick, role: 'link', tabIndex: 0, onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } } : {};
  return (
    <div className={'kpi' + (onClick ? ' click' : '')} {...click}>
      <div className="kpi-l">{label}{tip && <Tip t={tip} />}</div>
      <div className={'kpi-v ' + (cls || '')} title={typeof value === 'string' ? value : undefined}>{value}</div>
      {sub != null && sub !== '' && <div className={'kpi-s ' + (subCls || '')}>{sub}</div>}
      {onClick && <span className="kpi-go" aria-hidden="true">›</span>}
    </div>
  );
}

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => <div className="empty"><b>{title}</b>{children}</div>;
export const ErrorNote = ({ msg, retry }: { msg: string; retry?: () => void }) => (
  <div className="note" style={{ background: 'var(--red-soft)', color: 'var(--red)' }} role="alert">
    <div>{msg} {retry && <a style={{ cursor: 'pointer', marginLeft: 6 }} onClick={retry}>Try again</a>}</div>
  </div>
);
export const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div style={{ display: 'grid', gap: 10 }} aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ height: i === 0 ? 28 : 54 }} />)}
  </div>
);

/** Page header with breadcrumbs pushed to the top bar. */
export function PageHead({ crumbs, title, sub, actions, children }: { crumbs: string[]; title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  useCrumbs(crumbs);
  return (
    <div className="ph">
      <div>{children}{!children && <><h1>{title}</h1>{sub && <p>{sub}</p>}</>}</div>
      {actions && <div className="acts">{actions}</div>}
    </div>
  );
}

/* ---------- breadcrumbs context (rendered by the Shell) ---------- */
export const CrumbCtx = createContext<(c: string[]) => void>(() => {});
export function useCrumbs(c: string[]) {
  const set = useContext(CrumbCtx);
  const key = c.join('\u0001');
  useEffect(() => { set(c); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key, set]);
}

/* ---------- toasts ---------- */
type ToastKind = 'ok' | 'warn' | 'err' | 'info';
interface ToastItem { id: number; title: string; sub?: string; kind: ToastKind }
const ToastCtx = createContext<(title: string, sub?: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const n = useRef(0);
  const push = useCallback((title: string, sub?: string, kind: ToastKind = 'ok') => {
    const id = ++n.current;
    setItems(x => [...x, { id, title, sub, kind }]);
    setTimeout(() => setItems(x => x.filter(t => t.id !== id)), kind === 'err' ? 7000 : 4200);
  }, []);
  const C: Record<ToastKind, [string, string]> = { ok: ['var(--green)', '✓'], warn: ['var(--amber)', '!'], err: ['var(--red)', '×'], info: ['var(--blue)', 'i'] };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map(t => (
          <div key={t.id} className="toast" role="status">
            <span className="ti" style={{ background: C[t.kind][0] }}>{C[t.kind][1]}</span>
            <div><b>{t.title}</b>{t.sub && <span>{t.sub}</span>}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- drawer & modal ---------- */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, [onClose]);
}
export function Drawer({ title, sub, onClose, children, foot }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  useEscape(onClose);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input,textarea,select')?.focus(); }, []);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dh"><div><h3>{title}</h3>{sub && <p className="hint">{sub}</p>}</div><button className="x" onClick={onClose} aria-label="Close">×</button></div>
        <div className="db">{children}</div>
        <div className="df">{foot}</div>
      </aside>
    </>
  );
}
export function Modal({ title, sub, onClose, children, foot, wide }: { title: string; sub?: ReactNode; onClose: () => void; children?: ReactNode; foot: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh">{wide && <button className="x" onClick={onClose} aria-label="Close">×</button>}<h3>{title}</h3>{sub && <p className="hint">{sub}</p>}</div>
        {children && <div className="mb">{children}</div>}
        <div className="mf">{foot}</div>
      </div>
    </>
  );
}

/** Runs an async action with a busy flag and shows a toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: [string, string?]): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok[0], ok[1]);
      return r;
    } catch (e) {
      toast('Could not complete', e instanceof Error ? e.message : String(e), 'err');
      return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

/* ---------- form field ---------- */
export function Field({ label, hint, children, err }: { label: string; hint?: ReactNode; children: ReactNode; err?: string | null }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {err ? <p className="hint" style={{ color: 'var(--red)' }}>{err}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export const IconBtn = ({ icon, children, ...p }: { icon?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className={'btn ' + (p.className || '')}>{icon && <Icon name={icon} />}{children}</button>
);

/** Page-level tabs that group related admin pages under one menu item. */
export function SubTabs({ tabs }: { tabs: { to: string; label: string; count?: number }[] }) {
  return (
    <nav className="tabs subtabs" aria-label="Section">
      {tabs.map(t => <NavLink key={t.to} to={t.to} end className={({ isActive }) => 'tab' + (isActive ? ' on' : '')}>{t.label}{t.count ? <span className="ct">{t.count}</span> : null}</NavLink>)}
    </nav>
  );
}
