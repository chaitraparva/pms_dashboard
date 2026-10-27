import { useState } from 'react';
import { api, rpc, must } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { date, today } from '../lib/format';
import { uploadBrochureFile, BROCHURE_TYPES } from '../lib/docs';
import type { Branch, Brochure } from '../lib/types';
import { Badge, ErrorNote, Loading, PageHead, Drawer, Modal, Field, IconBtn, useAction } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';
import { BrochureFile } from '../investor/Brochures';
import { DateInput } from '../ui/DateInput';

type PlanLite = { id: string; code: string; name: string; status: string };

async function load() {
  const [bros, plans, branches, views] = await Promise.all([
    api.from('brochures').select('*').order('created_at', { ascending: false }),
    api.from('plans').select('id, code, name, status').order('name'),
    api.from('branches').select('*').order('name'),
    api.from('brochure_views').select('brochure_id, acknowledged_at')
  ]);
  const seen: Record<string, { seen: number; ack: number }> = {};
  (must(views) as { brochure_id: string; acknowledged_at: string | null }[]).forEach(v => {
    const s = (seen[v.brochure_id] ||= { seen: 0, ack: 0 });
    s.seen++; if (v.acknowledged_at) s.ack++;
  });
  return { bros: must(bros) as Brochure[], plans: must(plans) as PlanLite[], branches: must(branches) as Branch[], seen };
}

const STATUS: Record<Brochure['status'], [string, string]> = { draft: ['Draft', 'b-grey'], published: ['Published', 'b-navy'], archived: ['Archived', 'b-red'] };
const size = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

export function Brochures() {
  const q = useQuery(load, []);
  const [edit, setEdit] = useState<Brochure | 'new' | null>(null);
  const [preview, setPreview] = useState<Brochure | null>(null);
  const { busy, run } = useAction();

  const d = q.data;
  const planName = (id: string | null) => id ? d?.plans.find(p => p.id === id)?.name || 'a plan' : '';
  const branchName = (id: string | null) => id ? d?.branches.find(b => b.id === id)?.name || 'a branch' : '';
  const audience = (b: Brochure) => [b.branch_id ? branchName(b.branch_id) + ' branch' : 'All investors', b.plan_id ? 'in ' + planName(b.plan_id) : ''].filter(Boolean).join(' ');

  const setStatus = async (b: Brochure, status: Brochure['status'], ok: string) => {
    const reason = status === 'archived' ? window.prompt('Why is this brochure being archived? (kept in the audit log)', 'Superseded') : '';
    if (reason === null) return;
    const n = await run(() => rpc<number>('admin_set_brochure_status', { p_id: b.id, p_status: status, p_reason: reason }), [ok]);
    if (n !== undefined) refreshAll();
  };

  const cols: Col<Brochure>[] = [
    { h: 'Brochure', v: r => r.title, r: r => <><b>{r.title}</b><span className="sub">{r.code} · {r.file_name ? `${r.file_name} (${size(r.size_bytes)})` : 'No file uploaded yet'}</span></> },
    { h: 'Audience', v: r => audience(r) },
    { h: 'Shown', v: r => r.publish_on, r: r => <>{date(r.starts_on || r.publish_on)}<span className="sub">{r.ends_on ? 'until ' + date(r.ends_on) : 'no end date'}</span></> },
    { h: 'Opened', v: r => d?.seen[r.id]?.seen || 0, r: r => r.status === 'draft' ? '—' : <>{d?.seen[r.id]?.seen || 0} investors<span className="sub">{d?.seen[r.id]?.ack || 0} closed it</span></> },
    { h: 'Status', v: r => r.status, r: r => <Badge cls={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge> },
    {
      h: '', r: r => <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {r.storage_path && <button className="btn sm" onClick={() => setPreview(r)}>Preview</button>}
        <button className="btn sm" onClick={() => setEdit(r)}>Edit</button>
        {r.status !== 'published' && <button className="btn sm primary" disabled={busy || !r.storage_path} title={r.storage_path ? '' : 'Upload the file first'} onClick={() => setStatus(r, 'published', 'Brochure published')}>Publish</button>}
        {r.status === 'published' && <button className="btn sm" disabled={busy} onClick={() => setStatus(r, 'draft', 'Brochure unpublished')}>Unpublish</button>}
        {r.status !== 'archived' && <button className="btn sm ghost" disabled={busy} onClick={() => setStatus(r, 'archived', 'Brochure archived')}>Archive</button>}
      </div>
    }
  ];

  return (
    <>
      <PageHead crumbs={['Brochures']} title="Brochures"
        sub="Upload PDF or image brochures. Investors see the newest published brochure once after signing in, and every brochure under Latest announcements."
        actions={<IconBtn icon="plus" className="accent" onClick={() => setEdit('new')} disabled={!d}>Upload brochure</IconBtn>} />
      <div className="note info">Files are kept in private storage. Investors open them through short-lived links, and only if the brochure is published for their branch or plan. Archiving hides a brochure from investors but keeps its record and file.</div>
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!d && !q.error ? <Loading /> : d && (
        <DataTable rows={d.bros} cols={cols} rowKey={r => r.id} searchPh="Search title or code" text={r => r.code + ' ' + r.description}
          filters={[['All', 'all'], ['Drafts', 'draft'], ['Published', 'published'], ['Archived', 'archived']]} filterFn={(r, f) => f === 'all' || r.status === f}
          emptyTitle={d.bros.length ? 'Nothing matches' : 'No brochures yet'}
          empty={d.bros.length ? 'No brochures match this filter.' : 'Use "Upload brochure" to add your first brochure, then publish it.'} />
      )}
      {edit && d && <BrochureForm b={edit === 'new' ? null : edit} plans={d.plans} branches={d.branches} onClose={() => setEdit(null)} />}
      {preview && <Modal wide title={preview.title} sub={`${audience(preview)} · ${STATUS[preview.status][0]}`} onClose={() => setPreview(null)}
        foot={<button className="btn" onClick={() => setPreview(null)}>Close</button>}>
        <BrochureFile b={{ storage_path: preview.storage_path || '', mime: preview.mime, title: preview.title }} />
      </Modal>}
    </>
  );
}

function BrochureForm({ b, plans, branches, onClose }: { b: Brochure | null; plans: PlanLite[]; branches: Branch[]; onClose: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({
    title: b?.title || '', description: b?.description || '', plan_id: b?.plan_id || '', branch_id: b?.branch_id || '',
    publish_on: b?.publish_on || today(), starts_on: b?.starts_on || '', ends_on: b?.ends_on || ''
  });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF(x => ({ ...x, ...p }));

  const save = async (publish: boolean) => {
    if (!f.title.trim()) return setErr('Enter a title.');
    if (publish && !file && !b?.storage_path) return setErr('Choose the brochure file before publishing.');
    if (f.starts_on && f.ends_on && f.ends_on < f.starts_on) return setErr('The end date must be after the start date.');
    setErr(null);
    const ok = await run(async () => {
      const up = file ? await uploadBrochureFile(file) : {};
      const id = await rpc<string>('admin_save_brochure', { p_id: b?.id || null, p: { ...f, title: f.title.trim(), ...up } });
      if (publish) await rpc<number>('admin_set_brochure_status', { p_id: id, p_status: 'published', p_reason: '' });
      return true;
    }, [publish ? 'Brochure published' : 'Brochure saved', publish ? 'Investors will see it the next time they sign in.' : b?.status === 'published' ? 'Changes are live.' : 'Saved as a draft.']);
    if (ok) { refreshAll(); onClose(); }
  };

  return (
    <Drawer title={b ? 'Edit brochure' : 'Upload brochure'} sub={b ? `${b.code} · uploading a new file shows it to investors again` : 'Saved as a draft until you publish it.'} onClose={onClose}
      foot={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => save(false)} disabled={busy}>{b?.status === 'published' ? 'Save changes' : 'Save draft'}</button>
        {b?.status !== 'published' && <button className="btn primary" onClick={() => save(true)} disabled={busy}>{busy ? 'Working…' : 'Save and publish'}</button>}
      </>}>
      <div className="form">
        {err && <p className="hint" style={{ color: 'var(--red)' }}>{err}</p>}
        <Field label="Title"><input className="input" value={f.title} maxLength={160} onChange={e => set({ title: e.target.value })} /></Field>
        <Field label="Short description" hint="Shown above the brochure and in Latest announcements.">
          <textarea className="input" rows={3} value={f.description} onChange={e => set({ description: e.target.value })} />
        </Field>
        <Field label={b?.storage_path ? `File · current: ${b.file_name}` : 'File'} hint="PDF, PNG, JPG or WebP, up to 3 MB.">
          <input className="input" type="file" accept={BROCHURE_TYPES.join(',')} onChange={e => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label="Branch">
          <select className="input" value={f.branch_id} onChange={e => set({ branch_id: e.target.value })}>
            <option value="">All branches</option>{branches.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="ROI plan" hint="Optional: show only to investors with an investment in this plan.">
          <select className="input" value={f.plan_id} onChange={e => set({ plan_id: e.target.value })}>
            <option value="">All plans</option>{plans.filter(p => p.status !== 'archived' || p.id === f.plan_id).map(p => <option key={p.id} value={p.id}>{p.name} · {p.code}</option>)}
          </select>
        </Field>
        <div className="grid g-1-1" style={{ gap: 12 }}>
          <Field label="Show from" hint="Leave empty to show as soon as it is published."><DateInput className="input" value={f.starts_on} onChange={e => set({ starts_on: e.target.value })} /></Field>
          <Field label="Show until" hint="Optional."><DateInput className="input" value={f.ends_on} onChange={e => set({ ends_on: e.target.value })} /></Field>
        </div>
      </div>
    </Drawer>
  );
}
