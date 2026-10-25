import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

/* A dropdown you can type into: type part of a name, code or phone number and pick from the short list.
   Replaces long <select> lists of investors, IBs and sub-investors. */

export interface SsOption { value: string; label: string; sub?: string }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function SearchSelect({ value, onChange, options, placeholder = 'Type a name, ID or phone number…', bad, empty, disabled }: {
  value: string; onChange: (v: string) => void; options: SsOption[]; placeholder?: string; bad?: boolean;
  /** an option for "nothing chosen", e.g. "Individual (nobody)" */ empty?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const chosen = options.find(o => o.value === value);

  const shown = useMemo(() => {
    const words = norm(q).split(' ').filter(Boolean);
    const digits = q.replace(/\D/g, '');
    const all = empty != null ? [{ value: '', label: empty }, ...options] : options;
    if (!words.length) return all.slice(0, 200);
    return all.filter(o => {
      const hay = norm(o.label + ' ' + (o.sub || ''));
      return words.every(w => hay.includes(w)) || (digits.length >= 3 && (o.label + (o.sub || '')).replace(/\D/g, '').includes(digits));
    }).slice(0, 200);
  }, [q, options, empty]);

  useEffect(() => { setHi(0); }, [q, open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { (list.current?.children[hi] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const pick = (v: string) => { onChange(v); setOpen(false); setQ(''); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { if (open && shown[hi]) { e.preventDefault(); pick(shown[hi].value); } }
    else if (e.key === 'Escape') { setOpen(false); setQ(''); }
  };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input className={'input ' + (bad ? 'bad' : '')} disabled={disabled}
        value={open ? q : chosen ? chosen.label : value === '' && empty != null ? empty : ''}
        placeholder={open && chosen ? chosen.label : placeholder}
        onFocus={() => { setOpen(true); setQ(''); }} onClick={() => setOpen(true)}
        onChange={e => { setQ(e.target.value); setOpen(true); }} onKeyDown={key} onBlur={() => { setOpen(false); setQ(''); }} autoComplete="off" />
      {open && (
        <div ref={list} role="listbox" style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, top: 'calc(100% + 4px)', maxHeight: 260, overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)', boxShadow: 'var(--shadow-lg)' }}>
          {shown.length ? shown.map((o, k) => (
            <div key={o.value || '__empty'} role="option" aria-selected={o.value === value}
              onMouseDown={e => { e.preventDefault(); pick(o.value); }} onMouseEnter={() => setHi(k)}
              style={{ padding: '8px 11px', cursor: 'pointer', fontSize: 13.5, background: k === hi ? 'var(--blue-soft)' : o.value === value ? 'var(--surface-2)' : undefined }}>
              <div style={{ fontWeight: o.value === value ? 600 : 400 }}>{o.label}</div>
              {o.sub && <div className="hint">{o.sub}</div>}
            </div>
          )) : <div className="hint" style={{ padding: '10px 11px' }}>No match for “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
