import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, must, rpc, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { refreshAll, useQuery } from '../lib/useQuery';
import { date, dateTime } from '../lib/format';
import { Badge, Drawer, Empty, ErrorNote, Loading, PageHead } from '../ui/kit';
import type { Announcement, Notification } from '../lib/types';
import { Prose } from './parts';
import { BrochureModal, loadMyBrochures } from './Brochures';
import { Icon } from '../ui/Icon';
import type { MyBrochure } from '../lib/types';

/** Unread = the investor's 'announcement' notification for it has not been read. */
export function Announcements() {
  const { profile, settings } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const [bro, setBro] = useState<MyBrochure | null>(null);
  const bq = useQuery(loadMyBrochures, []);
  const bros = bq.data || [];
  const q = useQuery(async () => {
    const [anns, ns] = await Promise.all([
      fetchAll<Announcement>((a, b) => api.from('announcements').select('*').eq('status', 'published').order('published_at', { ascending: false }).range(a, b)),
      api.from('notifications').select('*').eq('user_id', profile!.id).eq('kind', 'announcement')
    ]);
    const notes = must(ns) as Notification[];
    return { anns, byAnn: Object.fromEntries(notes.filter(n => n.source_id).map(n => [n.source_id!, n])) as Record<string, Notification> };
  }, [profile?.id]);

  const open = async (a: Announcement) => {
    setOpenId(a.id);
    const n = q.data?.byAnn[a.id];
    if (n && !n.read_at) {
      try { await rpc('mark_notifications_read', { p_ids: [n.id] }); refreshAll(); } catch { /* reading still works; the badge stays until next time */ }
    }
  };

  // ?open=<announcement id> (from the overview) opens it directly
  const pre = sp.get('open');
  useEffect(() => {
    if (!pre || !q.data) return;
    const a = q.data.anns.find(x => x.id === pre);
    if (a) open(a);
    setSp({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pre, q.data]);

  const anns = q.data?.anns || [];
  const unread = (a: Announcement) => { const n = q.data?.byAnn[a.id]; return !!n && !n.read_at; };
  const nUnread = anns.filter(unread).length;
  const current = anns.find(a => a.id === openId) || null;
  const markAll = async () => {
    const ids = anns.filter(unread).map(a => q.data!.byAnn[a.id].id);
    if (!ids.length) return;
    try { await rpc('mark_notifications_read', { p_ids: ids }); } finally { refreshAll(); }
  };

  return (
    <>
      <PageHead crumbs={['Announcements']} title="Announcements"
        sub={`Notices from ${settings?.company_name || 'the company'}. Announcements are informational and don't change your agreement.${nUnread ? ` ${nUnread} unread.` : ''}`}
        actions={nUnread ? <button className="btn" onClick={markAll}>Mark all as read</button> : undefined} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {bros.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Brochures</h3><div className="r">{bros.length} current</div></div>
          <div className="card-b list">
            {bros.map(b => (
              <div key={b.id} style={{ cursor: 'pointer' }} onClick={() => setBro(b)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setBro(b); }}>
                <Icon name="brochure" />
                <div className="grow"><b>{b.title}</b><span>{b.plan_name ? b.plan_name + ' · ' : ''}Published {date(b.publish_on)}{b.description ? ' · ' + b.description.slice(0, 90) : ''}</span></div>
                {!b.acknowledged && <Badge cls="b-blue">New</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}
      {bro && <BrochureModal b={bro} onClose={() => setBro(null)} />}
      {q.loading && !q.data ? <Loading /> : q.data && !anns.length ? (
        bros.length ? null : <div className="card"><div className="card-b"><Empty title="No announcements yet">Notices and brochures from the company will appear here.</Empty></div></div>
      ) : anns.map(a => {
        const u = unread(a);
        return (
          <div key={a.id} className="card" style={{ cursor: 'pointer', ...(u ? { borderColor: 'var(--blue)' } : {}) }} onClick={() => open(a)}
            role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(a); } }}>
            <div className="card-b" style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {u && <span className="dot unread" aria-label="Unread" />}
                <h3 style={{ fontSize: 16, fontWeight: u ? 650 : 600 }}>{a.title}</h3>
                <Badge cls="b-blue">{a.category}</Badge>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 12.5 }}>{date(a.published_at)}</span>
              </div>
              <p style={{ color: 'var(--fg-2)', maxWidth: '80ch', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{a.body}</p>
              <div><span className="hint">{u ? 'Unread · ' : ''}Read more</span></div>
            </div>
          </div>
        );
      })}
      {current && (
        <Drawer title={current.title} sub={<>{current.category} · {dateTime(current.published_at)}</>} onClose={() => setOpenId(null)}
          foot={<button className="btn primary" onClick={() => setOpenId(null)}>Close</button>}>
          <Prose text={current.body} empty="This announcement has no further details." />
        </Drawer>
      )}
    </>
  );
}
