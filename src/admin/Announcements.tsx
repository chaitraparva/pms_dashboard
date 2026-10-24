import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, rpc, fetchAll, must } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { date, dateTime } from '../lib/format';
import type { Announcement } from '../lib/types';
import { Badge, ErrorNote, Loading, PageHead, Drawer, Field, IconBtn, useAction, useToast } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';

type Person = { id: string; code: string | null; full_name: string; email: string; account_status: string };
type PlanLite = { id: string; code: string; name: string; status: string };
type Audience = Announcement['audience'];

const CATEGORIES = ['General notice', 'Payout schedule', 'Plan update', 'Maturity', 'Compliance'];
const AUDIENCES: [Audience, string][] = [['all', 'All investors'], ['selected', 'Selected investors'], ['plan', 'Investors in a plan'], ['maturing', 'Maturing within N days']];
const nameOf = (p?: Person) => (p ? p.full_name || p.email : '');

interface Draft { id: string | null; title: string; category: string; body: string; audience: Audience; planId: string; days: number; ids: string[]; published: boolean; publishedAt: string | null; recipients: number }
const blank = (): Draft => ({ id: null, title: '', category: CATEGORIES[0], body: '', audience: 'all', planId: '', days: 60, ids: [], published: false, publishedAt: null, recipients: 0 });

async function load() {
  const [anns, people, plans] = await Promise.all([
    fetchAll<Announcement>((a, b) => api.from('announcements').select('*').order('created_at', { ascending: false }).range(a, b)),
    fetchAll<Person>((a, b) => api.from('profiles').select('id, code, full_name, email, account_status').eq('role', 'investor').order('full_name').range(a, b)),
    api.from('plans').select('id, code, name, status').order('name').then(r => must(r) as PlanLite[])
  ]);
  return { anns, people, plans };
}

export function Announcements() {
  const q = useQuery(load, []);
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft | null>(null);

  const plans = q.data?.plans || [];
  const planBy = useMemo(() => new Map(plans.map(p => [p.id, p])), [plans]);
  const audLabel = (a: Announcement) => a.audience === 'all' ? 'All investors'
    : a.audience === 'selected' ? `${a.audience_investor_ids.length} selected investor${a.audience_investor_ids.length === 1 ? '' : 's'}`
      : a.audience === 'plan' ? 'Investors in ' + (planBy.get(a.audience_plan_id || '')?.name || 'a plan')
        : `Maturing within ${a.audience_days ?? 60} days`;

  // ?to=<profile id> opens the composer for one investor; ?open=<announcement id> opens an existing one
  const to = params.get('to'), openId = params.get('open');
  useEffect(() => {
    if (!q.data) return;
    if (to) {
      setDraft({ ...blank(), audience: 'selected', ids: [to] });
      setParams({}, { replace: true });
    } else if (openId) {
      const a = q.data.anns.find(x => x.id === openId);
      if (a) setDraft({
        id: a.id, title: a.title, category: a.category, body: a.body, audience: a.audience, planId: a.audience_plan_id || '', days: a.audience_days ?? 60,
        ids: a.audience_investor_ids || [], published: a.status === 'published', publishedAt: a.published_at, recipients: a.recipients
      });
    }
  }, [q.data, to, openId, setParams]);

  const close = () => { setDraft(null); if (params.get('open')) nav('/admin/announcements', { replace: true }); };

  const rows = q.data?.anns || [];
  const cols: Col<Announcement>[] = [
    { h: 'Announcement', v: r => r.title, r: r => <><b>{r.title}</b><span className="sub">{r.body.length > 90 ? r.body.slice(0, 90) + '…' : r.body || '—'}</span></> },
    { h: 'Category', v: r => r.category },
    { h: 'Audience', v: r => audLabel(r), r: r => <>{audLabel(r)}{r.status === 'published' && <span className="sub">{r.recipients} recipient{r.recipients === 1 ? '' : 's'}</span>}</> },
    { h: 'Date', v: r => r.published_at || r.updated_at, r: r => r.published_at ? <>{date(r.published_at)}<span className="sub">Published</span></> : <>{date(r.updated_at)}<span className="sub">Last edited</span></> },
    { h: 'Status', v: r => r.status, r: r => r.status === 'published' ? <Badge cls="b-navy">Published</Badge> : <Badge cls="b-grey">Draft</Badge> },
    { h: '', r: r => <button className={'btn sm ' + (r.status === 'draft' ? 'primary' : '')} onClick={() => nav('/admin/announcements?open=' + r.id)}>{r.status === 'draft' ? 'Edit & publish' : 'View'}</button> }
  ];

  return (
    <>
      <PageHead crumbs={['Announcements']} title="Announcements"
        sub="Published announcements appear in the targeted investors' dashboards and notification bell immediately."
        actions={<IconBtn icon="plus" className="accent" onClick={() => setDraft(blank())} disabled={!q.data}>New announcement</IconBtn>} />
      <div className="note info">Announcements are <b>informational</b>. They never change an investor's contract. Contract changes go through Investments → Record amendment.</div>
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <DataTable rows={rows} cols={cols} rowKey={r => r.id} href={r => '/admin/announcements?open=' + r.id} searchPh="Search title, category"
          text={r => r.body} filters={[['All', 'all'], ['Drafts', 'draft'], ['Published', 'published']]} filterFn={(r, f) => f === 'all' || r.status === f}
          sort={3} dir={-1}
          emptyTitle={rows.length ? 'Nothing matches' : 'No announcements yet'}
          empty={rows.length ? 'No announcements match this filter.' : 'Use "New announcement" to notify all investors, investors in a plan, those with upcoming maturities, or a hand-picked list.'} />
      )}
      {draft && q.data && <Composer key={draft.id || 'new'} initial={draft} people={q.data.people} plans={plans} onClose={close} />}
    </>
  );
}

function Composer({ initial, people, plans, onClose }: { initial: Draft; people: Person[]; plans: PlanLite[]; onClose: () => void }) {
  const { settings } = useAuth();
  const toast = useToast();
  const { busy, run } = useAction();
  const [d, setD] = useState<Draft>(initial);
  const [err, setErr] = useState<{ title?: string; body?: string; aud?: string }>({});
  const [count, setCount] = useState<number | null>(null);
  const [countErr, setCountErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const ro = d.published;
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }));
  const peopleBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people]);

  const payload = () => ({
    title: d.title.trim(), body: d.body, category: d.category, audience: d.audience,
    audience_plan_id: d.audience === 'plan' ? d.planId : '', audience_days: d.audience === 'maturing' ? String(d.days || 60) : '',
    audience_investor_ids: d.audience === 'selected' ? d.ids : []
  });

  useEffect(() => {
    if (ro) return;
    let alive = true;
    const h = setTimeout(() => {
      rpc<number>('admin_audience_count', { p: payload() })
        .then(n => { if (alive) { setCount(n); setCountErr(null); } })
        .catch(e => { if (alive) setCountErr(e instanceof Error ? e.message : String(e)); });
    }, 300);
    return () => { alive = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ro, d.audience, d.planId, d.days, d.ids.join(',')]);

  const validate = (publishing: boolean) => {
    const e: typeof err = {};
    if (!d.title.trim()) e.title = 'A title is required.';
    if (publishing && !d.body.trim()) e.body = 'Write the message before publishing.';
    if (d.audience === 'plan' && !d.planId) e.aud = 'Choose a plan.';
    if (d.audience === 'selected' && !d.ids.length) e.aud = 'Select at least one investor.';
    if (d.audience === 'maturing' && !(d.days >= 0 && d.days <= 3650)) e.aud = 'Enter a number of days.';
    if (publishing && !e.aud && count === 0) e.aud = 'This audience has no active investors right now.';
    setErr(e);
    return !e.title && !e.body && !e.aud;
  };

  const save = async () => {
    if (!validate(false)) return;
    const id = await run(() => rpc<string>('admin_save_announcement', { p_id: d.id, p: payload() }), ['Saved as draft', "Investors can't see it until you publish it."]);
    if (id) { set({ id }); refreshAll(); }
  };
  const publish = async () => {
    if (!validate(true)) return;
    const n = await run(async () => {
      const id = await rpc<string>('admin_save_announcement', { p_id: d.id, p: payload() });
      set({ id });
      return rpc<number>('admin_publish_announcement', { p_id: id });
    });
    if (n === undefined) { refreshAll(); return; }
    toast('Announcement published', `Sent to ${n} investor${n === 1 ? '' : 's'}`);
    refreshAll();
    onClose();
  };

  const s = search.trim().toLowerCase();
  const matches = people.filter(p => !s || `${p.full_name} ${p.email} ${p.code || ''}`.toLowerCase().includes(s));
  const toggle = (id: string) => set({ ids: d.ids.includes(id) ? d.ids.filter(x => x !== id) : [...d.ids, id] });
  const activePlans = plans.filter(p => p.status !== 'archived' || p.id === d.planId);

  return (
    <Drawer title={ro ? d.title : d.id ? 'Edit draft announcement' : 'New announcement'}
      sub={ro ? `Published ${dateTime(d.publishedAt)} to ${d.recipients} investor${d.recipients === 1 ? '' : 's'}. Published announcements cannot be edited.` : 'Save a draft, or publish to the chosen audience.'}
      onClose={onClose}
      foot={ro ? <button className="btn" onClick={onClose}>Close</button> : <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>Save draft</button>
        <button className="btn primary" onClick={publish} disabled={busy}>{busy ? 'Working…' : count != null ? `Publish to ${count} investor${count === 1 ? '' : 's'}` : 'Publish'}</button>
      </>}>
      <div className="form">
        <Field label="Title" err={err.title}>
          <input className={'input' + (err.title ? ' bad' : '')} value={d.title} readOnly={ro} onChange={e => { set({ title: e.target.value }); setErr({ ...err, title: undefined }); }} maxLength={160} />
        </Field>
        <Field label="Category" hint="Type anything, or pick a suggestion.">
          <input className="input" list="ann-categories" value={d.category} readOnly={ro} maxLength={60} placeholder="General notice" onChange={e => set({ category: e.target.value })} />
          <datalist id="ann-categories">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Message" err={err.body}>
          <textarea className={'input' + (err.body ? ' bad' : '')} rows={7} value={d.body} readOnly={ro} onChange={e => { set({ body: e.target.value }); setErr({ ...err, body: undefined }); }} />
        </Field>
        <Field label="Audience" err={err.aud}>
          <div className="chips">
            {AUDIENCES.map(([k, l]) => <button key={k} type="button" disabled={ro} className={'chip ' + (d.audience === k ? 'on' : '')} onClick={() => { set({ audience: k }); setErr({ ...err, aud: undefined }); }}>{l}</button>)}
          </div>
        </Field>
        {d.audience === 'plan' && (
          <Field label="Plan">
            <select className="input" value={d.planId} disabled={ro} onChange={e => { set({ planId: e.target.value }); setErr({ ...err, aud: undefined }); }}>
              <option value="">Choose a plan…</option>
              {activePlans.map(p => <option key={p.id} value={p.id}>{p.name} · {p.code}{p.status !== 'active' ? ` (${p.status})` : ''}</option>)}
            </select>
          </Field>
        )}
        {d.audience === 'maturing' && (
          <Field label="Maturing within (days)" hint={`Active investments maturing between today and this many days from now. The dashboard threshold is ${settings?.approaching_days ?? 60} days.`}>
            <input className="input" type="number" min={0} max={3650} value={d.days} readOnly={ro} onChange={e => set({ days: Math.max(0, parseInt(e.target.value || '0', 10)) })} />
          </Field>
        )}
        {d.audience === 'selected' && (
          <Field label={`Investors (${d.ids.length} selected)`}>
            {!ro && <input className="input" placeholder="Search name, email or investor ID" value={search} onChange={e => setSearch(e.target.value)} />}
            {d.ids.length > 0 && (
              <div className="chips">
                {d.ids.map(id => <button key={id} type="button" className="chip on" disabled={ro} onClick={() => toggle(id)} title={ro ? undefined : 'Remove'}>{nameOf(peopleBy.get(id)) || id}{ro ? '' : ' ×'}</button>)}
              </div>
            )}
            {!ro && (
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '4px 10px' }}>
                {matches.length ? matches.slice(0, 200).map(p => (
                  <label key={p.id} className="check" style={{ padding: '6px 0' }}>
                    <input type="checkbox" checked={d.ids.includes(p.id)} onChange={() => { toggle(p.id); setErr({ ...err, aud: undefined }); }} />
                    <span>{nameOf(p)} <span className="muted">· {p.code || p.email}{p.account_status !== 'active' ? ' · suspended' : ''}</span></span>
                  </label>
                )) : <p className="hint" style={{ padding: '8px 0' }}>{people.length ? 'No investors match this search.' : 'No investors registered yet.'}</p>}
                {matches.length > 200 && <p className="hint" style={{ padding: '6px 0' }}>Showing the first 200. Refine the search to find others.</p>}
              </div>
            )}
          </Field>
        )}
        {!ro && (
          <div className="note info">
            {countErr ? countErr : count == null ? 'Counting recipients…' : <>Resolves to <b>{count} active investor{count === 1 ? '' : 's'}</b> right now. Suspended accounts are skipped.</>}
          </div>
        )}
      </div>
    </Drawer>
  );
}
