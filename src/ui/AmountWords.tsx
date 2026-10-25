/* Shown under an amount box while typing: ₹1,00,000 · 1 lakh — so the zeros never have to be counted. */

const short = (n: number) => String(Math.round(n * 100) / 100);

export function amountWords(n: number): string {
  if (n >= 1e7) return short(n / 1e7) + ' crore';
  if (n >= 1e5) return short(n / 1e5) + ' lakh';
  if (n >= 1e3) return short(n / 1e3) + ' thousand';
  return '';
}

export function AmountWords({ v }: { v: string | number }) {
  const n = Number(String(v).replace(/,/g, '').trim());
  if (!String(v).trim() || !isFinite(n) || n <= 0) return null;
  const words = amountWords(n);
  return (
    <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: 'var(--blue)' }}>
      ₹{n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}{words && <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}> · {words}</span>}
    </div>
  );
}
