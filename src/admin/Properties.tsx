// "Parva Properties": the catalog investors see under Explore Properties.
// parvarealty.ae publishes no listings API or feed, so the Super Admin enters each
// property with its official link instead of the app scraping the website.
import { useState } from 'react';
import { api, rpc, must } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, refreshAll } from '../lib/useQuery';
import { date } from '../lib/format';
import { uploadPropertyImage } from '../lib/docs';
import type { Property } from '../lib/types';
import { Badge, ErrorNote, Loading, PageHead, Drawer, Field, IconBtn, useAction } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';
import { PropertyGrid } from '../investor/Properties';

const load = async () => must(await api.from('properties').select('*').order('sort_order').order('created_at', { ascending: false })) as Property[];
const STATUS: Record<Property['status'], [string, string]> = { draft: ['Draft', 'b-grey'], published: ['Published', 'b-navy'], archived: ['Archived', 'b-red'] };
const isHttps = (u: string) => /^https:\/\/[^\s]+$/i.test(u.trim());

export function Properties() {
  const { settings, reloadSettings } = useAuth();
  const q = useQuery(load, []);
  const [edit, setEdit] = useState<Property | 'new' | null>(null);
  const { busy, run } = useAction();
  const [site, setSite] = useState(settings?.property_site_url || 'https://parvarealty.ae/');
  const [who, setWho] = useState<'all' | 'unlocked'>(settings?.show_properties_to || 'all');
  const siteUrl = settings?.property_site_url || 'https://parvarealty.ae/';

  const saveSettings = async () => {
    if (!isHttps(site)) return;
    const ok = await run(() => rpc('admin_save_settings', { p: { property_site_url: site.trim(), show_properties_to: who }, p_reason: 'Explore Properties settings' }), ['Saved']);
    if (ok !== undefined) await reloadSettings();
  };
  const setStatus = async (p: Property, status: Property['status']) => {
    const ok = await run(() => rpc('admin_save_property', { p_id: p.id, p: { ...p, status } }), [status === 'published' ? 'Property published' : status === 'archived' ? 'Property archived' : 'Property moved to drafts']);
    if (ok !== undefined) refreshAll();
  };

  const rows = q.data || [];
  const cols: Col<Property>[] = [
    { h: 'Property', v: r => r.title, r: r => <><b>{r.title}</b><span className="sub">{[r.property_type, r.location].filter(Boolean).join(' · ') || '—'}</span></> },
    { h: 'Price', v: r => r.price_text, r: r => r.price_text || '—' },
    { h: 'Official link', v: r => r.url, r: r => <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{r.url.replace(/^https:\/\//, '').slice(0, 48)}</a> },
    { h: 'Order', v: r => r.sort_order },
    { h: 'Updated', v: r => r.updated_at, r: r => date(r.updated_at) },
    { h: 'Status', v: r => r.status, r: r => <Badge cls={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge> },
    {
      h: '', r: r => <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={() => setEdit(r)}>Edit</button>
        {r.status !== 'published' && <button className="btn sm primary" disabled={busy} onClick={() => setStatus(r, 'published')}>Publish</button>}
        {r.status === 'published' && <button className="btn sm" disabled={busy} onClick={() => setStatus(r, 'draft')}>Unpublish</button>}
        {r.status !== 'archived' && <button className="btn sm ghost" disabled={busy} onClick={() => setStatus(r, 'archived')}>Archive</button>}
      </div>
    }
  ];
  const published = rows.filter(r => r.status === 'published');

  return (
    <>
      <PageHead crumbs={['Parva Properties']} title="Parva Properties"
        sub="The properties investors see under Explore Properties. Each one links to its page on the official Parva Realty website."
        actions={<IconBtn icon="plus" className="accent" onClick={() => setEdit('new')}>Add property</IconBtn>} />
      <div className="note info">Parva Realty's website does not offer a public listings feed, so properties are entered here by hand with the official link, photo and price exactly as published on the website. If no property is published, investors see a single link to the website's current listings. Viewing a property never moves an investor's principal.</div>

      <div className="card"><div className="card-h"><h3>Explore Properties settings</h3></div><div className="card-b form">
        <div className="grid g-1-1" style={{ gap: 12 }}>
          <Field label="Official listings page" err={isHttps(site) ? null : 'Enter an https:// link.'}>
            <input className="input" value={site} onChange={e => setSite(e.target.value)} />
          </Field>
          <Field label="Show Explore Properties to">
            <select className="input" value={who} onChange={e => setWho(e.target.value as 'all' | 'unlocked')}>
              <option value="all">All investors (featured for those with unlocked principal)</option>
              <option value="unlocked">Only investors with unlocked principal</option>
            </select>
          </Field>
        </div>
        <div><button className="btn primary" disabled={busy || !isHttps(site) || (site.trim() === siteUrl && who === (settings?.show_properties_to || 'all'))} onClick={saveSettings}>Save settings</button></div>
      </div></div>

      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <DataTable rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search name or location" text={r => r.location + ' ' + r.description}
          filters={[['All', 'all'], ['Published', 'published'], ['Drafts', 'draft'], ['Archived', 'archived']]} filterFn={(r, f) => f === 'all' || r.status === f}
          emptyTitle={rows.length ? 'Nothing matches' : 'No properties yet'}
          empty={rows.length ? 'No properties match this filter.' : 'Use "Add property" to list a property from parvarealty.ae with its official link.'} />
      )}

      <div className="card"><div className="card-h"><h3>What investors see</h3></div><div className="card-b">
        <PropertyGrid items={published} siteUrl={siteUrl} />
      </div></div>

      {edit && <PropertyForm p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function PropertyForm({ p, onClose }: { p: Property | null; onClose: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({
    title: p?.title || '', location: p?.location || '', property_type: p?.property_type || '', price_text: p?.price_text || '',
    description: p?.description || '', image_url: p?.image_url || '', url: p?.url || '', sort_order: p?.sort_order ?? 0, status: p?.status || 'draft'
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (x: Partial<typeof f>) => setF(v => ({ ...v, ...x }));

  const pick = async (file?: File) => {
    if (!file) return;
    const url = await run(() => uploadPropertyImage(file), ['Image uploaded']);
    if (url) set({ image_url: url });
  };
  const save = async (status?: Property['status']) => {
    if (!f.title.trim()) return setErr('Enter the property name.');
    if (!isHttps(f.url)) return setErr('Enter the property\'s https:// link on the official website.');
    if (f.image_url && !isHttps(f.image_url)) return setErr('Image links must start with https://');
    setErr(null);
    const ok = await run(() => rpc<string>('admin_save_property', { p_id: p?.id || null, p: { ...f, status: status || f.status } }), ['Property saved']);
    if (ok) { refreshAll(); onClose(); }
  };

  return (
    <Drawer title={p ? 'Edit property' : 'Add property'} sub="Copy the details exactly as shown on the official website." onClose={onClose}
      foot={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy} onClick={() => save()}>Save</button>
        {f.status !== 'published' && <button className="btn primary" disabled={busy} onClick={() => save('published')}>Save and publish</button>}
      </>}>
      <div className="form">
        {err && <p className="hint" style={{ color: 'var(--red)' }}>{err}</p>}
        <Field label="Property name"><input className="input" value={f.title} maxLength={160} onChange={e => set({ title: e.target.value })} /></Field>
        <Field label="Official link" hint="The property's page on parvarealty.ae (https://…)."><input className="input" value={f.url} placeholder="https://parvarealty.ae/…" onChange={e => set({ url: e.target.value })} /></Field>
        <div className="grid g-1-1" style={{ gap: 12 }}>
          <Field label="Location"><input className="input" value={f.location} onChange={e => set({ location: e.target.value })} /></Field>
          <Field label="Type"><input className="input" value={f.property_type} placeholder="Apartment, villa, plot…" onChange={e => set({ property_type: e.target.value })} /></Field>
        </div>
        <Field label="Price" hint="As written on the website, for example the starting price. Leave empty if it is not published.">
          <input className="input" value={f.price_text} onChange={e => set({ price_text: e.target.value })} />
        </Field>
        <Field label="Description"><textarea className="input" rows={3} value={f.description} onChange={e => set({ description: e.target.value })} /></Field>
        <Field label="Image" hint="Upload the photo, or paste the https:// link of the image used on the official website.">
          <input className="input" value={f.image_url} placeholder="https://…" onChange={e => set({ image_url: e.target.value })} />
          <input className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => pick(e.target.files?.[0])} style={{ marginTop: 6 }} />
          {f.image_url && isHttps(f.image_url) && <img src={f.image_url} alt="" referrerPolicy="no-referrer" style={{ marginTop: 8, maxWidth: '100%', maxHeight: 160, borderRadius: 10, objectFit: 'cover' }} />}
        </Field>
        <Field label="Display order" hint="Lower numbers are shown first."><input className="input" type="number" value={f.sort_order} onChange={e => set({ sort_order: parseInt(e.target.value || '0', 10) })} /></Field>
      </div>
    </Drawer>
  );
}
