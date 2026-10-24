// Visual pieces shared by several investor pages (ported from the approved prototype).
import { Link } from 'react-router-dom';
import { date, dateShort, isUnlocked, money, today } from '../lib/format';
import { useAuth } from '../lib/auth';
import { InvBadge } from '../ui/kit';
import { Icon } from '../ui/Icon';
import type { Investment } from '../lib/types';
import { daysLeft, elapsedPct } from './data';

export const useApproaching = () => useAuth().settings?.approaching_days ?? 60;

/** Lock-in progress bar from start to maturity. */
export function Tracker({ i, compact }: { i: Investment; compact?: boolean }) {
  const approaching = useApproaching();
  const p = elapsedPct(i);
  const left = daysLeft(i);
  const d = compact ? dateShort : date;
  return (
    <div className="track">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <b style={{ fontWeight: 600 }}><span className="mono">{i.code}</span> · {i.plan_name}</b>
        <InvBadge i={i} approachingDays={approaching} />
      </div>
      {i.start_date ? (
        <>
          <div className="bar" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={`${p}% of the lock-in elapsed`}>
            <div className={'fill ' + (p >= 100 ? 'done' : '')} style={{ width: p + '%' }} />
          </div>
          <div className="lbls"><span>{d(i.start_date)}</span><span>{left ? `${left} days left · ${p}%` : 'Unlocked'}</span><span>{d(i.maturity_date)}</span></div>
        </>
      ) : (
        <div className="hint">Dates are set once your deposit is confirmed.</div>
      )}
    </div>
  );
}

const STEP_LABELS = ['Investment recorded', 'Deposit confirmed · lock-in starts', 'Lock-in in progress', 'Lock-in completed · principal unlocked'];

/** The lifecycle strip: recorded, started, in lock-in, unlocked. */
export function Steps({ i }: { i: Investment }) {
  const t = today();
  const reached = [true, !!i.start_date, !!i.start_date && t > i.start_date, isUnlocked(i, t) || i.status === 'redeemed'];
  const now = reached.lastIndexOf(true);
  return (
    <div className="steps" aria-label="Investment lifecycle">
      {STEP_LABELS.map((l, ix) => (
        <div key={l} className={ix < now || (ix === now && ix === STEP_LABELS.length - 1) ? 'done' : ix === now ? 'now' : ''}>
          <i>{ix < now || (ix === now && ix === STEP_LABELS.length - 1) ? '✓' : ''}</i>{l}
        </div>
      ))}
    </div>
  );
}

/** What happens when the lock-in ends, from the investment's own dates. */
export function maturityText(i: Investment): string {
  if (!i.lockin_end_date) return 'Your lock-in end date is fixed when your deposit is confirmed.';
  const when = isUnlocked(i) ? `Your lock-in ended on ${date(i.lockin_end_date)}` : `Your lock-in ends on ${date(i.lockin_end_date)}`;
  return `${when}. From that date your principal of ${money(i.principal)} is shown as unlocked principal and monthly returns under this agreement stop accruing. Unlocked principal stays recorded in your name; it is not paid out or reinvested automatically.`;
}

export const BackLink = ({ to, children }: { to: string; children: string }) => (
  <Link className="back" to={to}><Icon name="back" />{children}</Link>
);

/** Readable multi-paragraph text (terms, disclosures, announcement bodies). */
export const Prose = ({ text, empty }: { text: string; empty: string }) =>
  text.trim() ? <div style={{ whiteSpace: 'pre-wrap', color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.6, maxWidth: '80ch' }}>{text}</div> : <p className="hint">{empty}</p>;
