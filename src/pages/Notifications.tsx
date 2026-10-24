import { useNavigate } from 'react-router-dom';
import { api, must, rpc } from '../lib/api';
import { useAuth } from '../lib/auth';
import { refreshAll, useQuery } from '../lib/useQuery';
import { dateTime } from '../lib/format';
import { Empty, ErrorNote, Loading, PageHead } from '../ui/kit';
import type { Notification } from '../lib/types';

export function Notifications() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const q = useQuery(async () => must(await api.from('notifications').select('*').eq('user_id', profile!.id).order('created_at', { ascending: false }).limit(300)) as Notification[], [profile?.id]);
  const unread = (q.data || []).filter(n => !n.read_at).length;
  const markAll = async () => { await rpc('mark_notifications_read', { p_ids: null }); refreshAll(); };
  const open = async (n: Notification) => { if (!n.read_at) await rpc('mark_notifications_read', { p_ids: [n.id] }); refreshAll(); if (n.link) nav(n.link); };
  return (
    <>
      <PageHead crumbs={['Notifications']} title="Notifications" sub={`${unread} unread`} actions={unread > 0 ? <button className="btn" onClick={markAll}>Mark all as read</button> : undefined} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {q.loading && !q.data ? <Loading /> : (
        <div className="card"><div className="card-b list">
          {(q.data || []).map(n => (
            <div key={n.id} onClick={() => open(n)} style={{ cursor: 'pointer' }}>
              <span className={'dot ' + (n.read_at ? '' : 'unread')} />
              <div className="grow"><b style={n.read_at ? { fontWeight: 400 } : undefined}>{n.title}</b><span>{n.body}{n.body ? ' · ' : ''}{dateTime(n.created_at)}</span></div>
            </div>
          ))}
          {q.data && !q.data.length && <Empty title="No notifications yet">Updates about your account will appear here.</Empty>}
        </div></div>
      )}
    </>
  );
}
