import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { date, daysBetween, isUnlocked, lockinText, money, today } from '../lib/format';
import { Empty, ErrorNote, InvBadge, Loading, PageHead } from '../ui/kit';
import { daysLeft, isLive, loadInvestments } from './data';
import { maturityText, Steps, Tracker, useApproaching } from './parts';

export function LockIn() {
  const { profile } = useAuth();
  const approaching = useApproaching();
  const q = useQuery(() => loadInvestments(profile!.id), [profile?.id]);
  const t = today();
  const live = (q.data || []).filter(i => isLive(i) && i.start_date);
  const pending = (q.data || []).filter(i => i.status === 'pending_funding');

  return (
    <>
      <PageHead crumbs={['Lock-in & Maturity']} title="Lock-in & maturity" sub="Dates are calculated from your start date plus your lock-in (6 months or 1 year) in calendar months. They never change if a plan is edited." />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {q.loading && !q.data ? <Loading /> : q.data && !live.length ? (
        <div className="card"><div className="card-b">
          <Empty title={q.data.length ? 'No investments in lock-in' : 'You have no investments yet'}>
            {q.data.length ? (pending.length ? 'Lock-in dates are set once your deposit is confirmed.' : 'None of your investments are currently live.') : 'Your advisor will record your investment once funds are received.'}
          </Empty>
        </div></div>
      ) : null}
      {live.map(i => {
        const unlocked = isUnlocked(i, t);
        const until = Math.max(0, daysBetween(t, i.lockin_end_date!));
        return (
          <div key={i.id} className="card">
            <div className="card-h"><h3><span className="mono">{i.code}</span> · {i.plan_name}</h3><div className="r"><InvBadge i={i} approachingDays={approaching} /></div></div>
            <div className="card-b" style={{ display: 'grid', gap: 20 }}>
              <div className="grid g-1-2" style={{ alignItems: 'center' }}>
                <div>
                  <div className="hint">{unlocked ? 'Principal unlocked on' : 'Principal unlocks in'}</div>
                  <div className="countdown num">{unlocked ? date(i.lockin_end_date) : `${until} days`}</div>
                  {!unlocked && <div className="hint">{date(i.lockin_end_date)}</div>}
                </div>
                <dl className="kv">
                  <dt>Principal</dt><dd>{money(i.principal)}</dd>
                  <dt>Start date</dt><dd>{date(i.start_date)}</dd>
                  <dt>Lock-in period</dt><dd>{lockinText(i.lockin_months)}</dd>
                  <dt>Lock-in end date</dt><dd>{date(i.lockin_end_date)}</dd>
                  <dt>Maturity date</dt><dd>{date(i.maturity_date)}</dd>
                  <dt>Days remaining</dt><dd>{daysLeft(i)}</dd>
                  <dt>Principal status</dt><dd>{unlocked ? 'Unlocked' : 'Locked'}</dd>
                </dl>
              </div>
              <Tracker i={i} />
              <Steps i={i} />
              {unlocked
                ? <div className="note ok"><b>Principal unlocked.</b> {money(i.principal)} is included in your <Link to="/portal/investments?view=unlocked">unlocked principal</Link>. It is not paid out or reinvested automatically.</div>
                : <div className="note lock">This principal is locked until <b>{date(i.lockin_end_date)}</b> under the {lockinText(i.lockin_months)} lock-in in your agreement.</div>}
              <p style={{ fontSize: 13 }} className="hint">{maturityText(i)}</p>
            </div>
          </div>
        );
      })}
    </>
  );
}
