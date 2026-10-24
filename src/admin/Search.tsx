import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, must } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useSettings } from '../lib/auth';
import { money, date, initials, LEDGER_TYPE } from '../lib/format';
import type { Profile, Investment, LedgerEntry } from '../lib/types';
import { Empty, ErrorNote, Loading, PageHead, KycBadge, InvBadge, LedgerBadge } from '../ui/kit';
import { Icon } from '../ui/Icon';

type Lite = Pick<Profile, 'id' | 'full_name' | 'code' | 'email'>;
const LIMIT = 25;

/** Removes characters that have a meaning inside a PostgREST or() filter or a LIKE pattern. */
function clean(q: string): string {
  return q.replace(/[,()*:"\\%]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function runSearch(raw: string) {
  const q = clean(raw);
  if (!q) return null;
  const like = `%${q}%`;
  const [people, invs, ledger] = await Promise.all([
    api.from('profiles').select('*').eq('role', 'investor')
      .or(`full_name.ilike.${like},email.ilike.${like},code.ilike.${like},phone.ilike.${like}`).order('full_name').limit(LIMIT),
    api.from('investments').select('*').or(`code.ilike.${like},agreement_ref.ilike.${like},deposit_ref.ilike.${like}`).order('created_at', { ascending: false }).limit(LIMIT),
    api.from('ledger_entries').select('*').or(`code.ilike.${like},reference.ilike.${like}`).order('occurred_on', { ascending: false }).limit(LIMIT)
  ]);
  const P = must(people) as Profile[];
  const I = must(invs) as Investment[];
  const L = must(ledger) as LedgerEntry[];

  const pIds = [...new Set([...I.map(i => i.investor_id), ...L.map(l => l.investor_id)].filter((x): x is string => !!x))];
  const iIds = [...new Set([...L.map(l => l.investment_id)].filter((x): x is string => !!x))];
  const [pp, ii] = await Promise.all([
    pIds.length ? api.from('profiles').select('id,full_name,code,email').in('id', pIds) : null,
    iIds.length ? api.from('investments').select('id,code').in('id', iIds) : null
  ]);
  const names: Record<string, Lite> = {};
  if (pp) (must(pp) as Lite[]).forEach(p => { names[p.id] = p; });
  const codes: Record<string, string> = {};
  if (ii) (must(ii) as { id: string; code: string }[]).forEach(x => { codes[x.id] = x.code; });
  return { P, I, L, names, codes };
}

export function Search() {
  const s = useSettings();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const term = (sp.get('q') || '').trim();
  const [input, setInput] = useState(term);
  useEffect(() => { setInput(term); }, [term]);
  const q = useQuery(() => runSearch(term), [term]);

  const submit = (e: FormEvent) => { e.preventDefault(); const v = input.trim(); if (v) setSp({ q: v }); };
  const d = q.data;
  const total = d ? d.P.length + d.I.length + d.L.length : 0;
  const more = (n: number) => (n >= LIMIT ? `first ${LIMIT}` : `${n}`);

  return (
    <>
      <PageHead crumbs={['Search']} title="Search" sub={term ? (d ? `${total} result${total === 1 ? '' : 's'} for “${term}”` : `Searching for “${term}”…`) : 'Find investors, investments and transactions.'} />
      <form onSubmit={submit} className="card"><div className="toolbar" style={{ borderBottom: 0 }}>
        <label className="search" style={{ flex: 1 }}><Icon name="search" /><input value={input} onChange={e => setInput(e.target.value)} placeholder="Name, email, phone, INVR-…, INV-…, TXN-…, RDM-…, bank reference" aria-label="Search" autoFocus /></label>
        <button className="btn primary">Search</button>
      </div></form>

      {!term ? (
        <Empty title="Type something to search">Try an investor name, an investor code like INVR-1001, an investment code, an agreement or bank reference.</Empty>
      ) : q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !d ? <Loading rows={4} /> : !total ? (
        <Empty title={`No results for “${term}”`}>Check the spelling, or search by code (INVR-…, INV-…, TXN-…, RDM-…) or bank reference.</Empty>
      ) : (
        <div className="grid g-1-1">
          {d.P.length > 0 && (
            <div className="card">
              <div className="card-h"><h3>Investors</h3><div className="r">{more(d.P.length)}</div></div>
              <div className="card-b list">
                {d.P.map(p => (
                  <div key={p.id} style={{ cursor: 'pointer' }} onClick={() => nav('/admin/investors/' + p.code)}>
                    <div className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{initials(p.full_name || p.email)}</div>
                    <div className="grow"><b>{p.full_name || p.email}</b><span>{[p.code, p.email, p.phone].filter(Boolean).join(' · ')}</span></div>
                    <KycBadge k={p.kyc_status} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.I.length > 0 && (
            <div className="card">
              <div className="card-h"><h3>Investments</h3><div className="r">{more(d.I.length)}</div></div>
              <div className="card-b list">
                {d.I.map(i => (
                  <div key={i.id} style={{ cursor: 'pointer' }} onClick={() => nav('/admin/investments/' + i.code)}>
                    <div className="grow"><b><span className="mono">{i.code}</span> · {d.names[i.investor_id]?.full_name || '—'}</b>
                      <span>{money(i.principal)} · {i.plan_name} v{i.plan_version}{i.agreement_ref ? ' · ' + i.agreement_ref : ''}{i.deposit_ref ? ' · ' + i.deposit_ref : ''}</span></div>
                    <InvBadge i={i} approachingDays={s.approaching_days} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.L.length > 0 && (
            <div className="card">
              <div className="card-h"><h3>Transactions</h3><div className="r">{more(d.L.length)} · <Link to="/admin/transactions">Ledger</Link></div></div>
              <div className="card-b list">
                {d.L.map(l => {
                  const ic = l.investment_id ? d.codes[l.investment_id] : '';
                  return (
                    <div key={l.id} style={{ cursor: ic ? 'pointer' : undefined }} onClick={() => { if (ic) nav('/admin/investments/' + ic); }}>
                      <div className="grow"><b><span className="mono">{l.code}</span> · {LEDGER_TYPE[l.type] || l.type}{ic ? ' · ' + ic : ''}</b>
                        <span>{date(l.occurred_on)}{l.investor_id && d.names[l.investor_id] ? ' · ' + d.names[l.investor_id].full_name : ''}{l.reference ? ' · ' + l.reference : ''}</span></div>
                      <span className={'num ' + (Number(l.amount) < 0 ? 'neg' : '')}>{money(l.amount)}</span>
                      <LedgerBadge s={l.status} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
