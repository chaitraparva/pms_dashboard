import { useEffect, useRef, useState } from 'react';

/* A date box you can type into as DD-MM-YYYY (e.g. type 10042023 → 10-04-2023), or pick from the calendar button.
   The value is stored as YYYY-MM-DD, like a normal date input, so it drops in where <input type="date"> was. */

type Ev = { target: { value: string } };
const toText = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');
/** Turns what was typed into DD-MM-YYYY as the person types: digits only, dashes added for them. */
function shape(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  return d.length > 4 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d;
}
/** DD-MM-YYYY → YYYY-MM-DD, or '' when it is not a real date. */
function toIso(text: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (!m) return '';
  const [, dd, mm, yy] = m, dt = new Date(Date.UTC(+yy, +mm - 1, +dd));
  return dt.getUTCFullYear() === +yy && dt.getUTCMonth() === +mm - 1 && dt.getUTCDate() === +dd ? `${yy}-${mm}-${dd}` : '';
}

export function DateInput({ value, onChange, min, max, className = 'input', disabled, width, ...rest }: {
  value: string; onChange: (e: Ev) => void; min?: string; max?: string; className?: string; disabled?: boolean; width?: string; 'aria-label'?: string;
}) {
  const [text, setText] = useState(toText(value || ''));
  const [bad, setBad] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  // follow changes made from outside (a reset, the calendar, a default date)
  useEffect(() => { if (toIso(text) !== (value || '')) { setText(toText(value || '')); setBad(null); } }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const type = (raw: string) => {
    const t = shape(raw); setText(t);
    if (!t) { setBad(null); onChange({ target: { value: '' } }); return; }
    // an unfinished or wrong date counts as empty, so the form never keeps the old date by mistake
    const none = (msg: string | null) => { setBad(msg); if (value) onChange({ target: { value: '' } }); };
    if (t.length < 10) { none(null); return; }
    const iso = toIso(t);
    if (!iso) { none('Not a real date. Use DD-MM-YYYY.'); return; }
    if (min && iso < min) { none('Must be on or after ' + toText(min) + '.'); return; }
    if (max && iso > max) { none('Must be on or before ' + toText(max) + '.'); return; }
    setBad(null); onChange({ target: { value: iso } });
  };
  const openCal = () => {
    const el = pick.current; if (!el || disabled) return;
    try { (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { el.focus(); el.click(); }
  };

  return (
    <div style={{ position: 'relative', width }}>
      <input {...rest} className={className + (bad ? ' bad' : '')} inputMode="numeric" placeholder="DD-MM-YYYY" value={text} disabled={disabled}
        onChange={e => type(e.target.value)} onBlur={() => { if (text && text.length < 10) setBad('Type the full date: DD-MM-YYYY.'); }} style={{ paddingRight: 38 }} autoComplete="off" />
      <button type="button" onClick={openCal} disabled={disabled} title="Open calendar" aria-label="Open calendar"
        style={{ position: 'absolute', right: 4, top: 4, bottom: 4, width: 30, border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--fg-2)', display: 'grid', placeItems: 'center' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>
      </button>
      {/* the browser's own calendar, opened by the button */}
      <input ref={pick} type="date" tabIndex={-1} aria-hidden="true" value={value || ''} min={min} max={max}
        onChange={e => { setText(toText(e.target.value)); setBad(null); onChange({ target: { value: e.target.value } }); }}
        style={{ position: 'absolute', right: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }} />
      {bad && <p className="hint" style={{ color: 'var(--red)', marginTop: 4 }}>{bad}</p>}
    </div>
  );
}
