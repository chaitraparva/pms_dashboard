/* Typing an amount in AED: the amount is converted to INR at the AED rate in Settings (1 AED = ₹rate) and saved in INR,
   like every amount. Used when recording investments and in withdrawal requests. */

export type AmtCur = 'INR' | 'AED';

/** The INR amount for what was typed (rounded to the paisa). */
export const toInr = (text: string, cur: AmtCur, rate: number): number => {
  const v = Number(String(text).replace(/,/g, '').trim());
  if (cur !== 'AED') return v;
  return rate > 0 ? Math.round(v * rate * 100) / 100 : NaN;
};
const fmt = (n: number, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** ₹ INR / AED buttons. AED needs the AED rate set in Settings. */
export function CurChips({ cur, onChange, rate }: { cur: AmtCur; onChange: (c: AmtCur) => void; rate: number }) {
  return (
    <div className="chips" role="radiogroup" aria-label="Amount in">
      {(['INR', 'AED'] as const).map(c => <button key={c} type="button" role="radio" aria-checked={cur === c} disabled={c === 'AED' && !(rate > 0)}
        className={'chip ' + (cur === c ? 'on' : '')} onClick={() => onChange(c)}>{c === 'INR' ? '₹ INR' : 'AED'}</button>)}
    </div>
  );
}

/** Under an amount typed in AED: "= ₹2,63,000.00 at 1 AED = ₹26.30 (saved in INR)". */
export function AedNote({ text, cur, rate }: { text: string; cur: AmtCur; rate: number }) {
  if (cur !== 'AED') return null;
  if (!(rate > 0)) return <p className="hint" style={{ color: 'var(--red)' }}>Set the AED rate in Settings first.</p>;
  const v = Number(String(text).replace(/,/g, '').trim());
  if (!(v > 0)) return <p className="hint">Type the amount in AED. It is saved in INR at 1 AED = ₹{rate}.</p>;
  return <p className="hint">= <b>₹{fmt(Math.round(v * rate * 100) / 100)}</b> at 1 AED = ₹{rate} (saved in INR)</p>;
}
