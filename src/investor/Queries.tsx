import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, refreshAll } from '../lib/useQuery';
import { dateTime } from '../lib/format';
import type { Query } from '../lib/types';
import { Badge, Empty, ErrorNote, Field, Loading, PageHead, useAction } from '../ui/kit';
import { Icon } from '../ui/Icon';

/* Ask a query: the investor writes to the company, the Super Admin answers in their login. */

export const QStatus = ({ s }: { s: string }) => s === 'answered' ? <Badge cls="b-green">Answered</Badge> : s === 'closed' ? <Badge cls="b-grey">Closed</Badge> : <Badge cls="b-amber">Waiting for reply</Badge>;

/** The conversation, with a box to write back. */
export function QueryThread({ q, me, onSent, admin = false }: { q: Query; me: 'investor' | 'admin'; onSent: () => void; admin?: boolean }) {
  const act = useAction();
  const [text, setText] = useState('');
  const send = async (close = false) => {
    if (!text.trim()) return;
    const r = await act.run(() => rpc('reply_query', { p_id: q.id, p_message: text.trim(), p_close: close }), [me === 'admin' ? 'Reply sent' : 'Message sent', me === 'admin' ? 'The investor is notified.' : 'The company is notified.']);
    if (r !== undefined) { setText(''); refreshAll(); onSent(); }
  };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {(q.messages || []).map((m, k) => (
        <div key={k} style={{ justifySelf: m.from === me ? 'end' : 'start', maxWidth: '85%', background: m.from === 'admin' ? 'var(--blue-soft, #EEF2FF)' : 'var(--surface-2, #F4F5F7)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px' }}>
          <div className="hint" style={{ marginBottom: 4 }}>{m.from === 'admin' ? 'Company' : 'Investor'} · {dateTime(m.at)}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
        </div>
      ))}
      {q.status !== 'closed' || admin ? (
        <div className="form">
          <Field label={me === 'admin' ? 'Your answer' : 'Write back'}><textarea className="input" rows={3} value={text} onChange={e => setText(e.target.value)} /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {admin && <button className="btn" disabled={act.busy || !text.trim()} onClick={() => send(true)}>Answer and close</button>}
            <button className="btn primary" disabled={act.busy || !text.trim()} onClick={() => send(false)}>{me === 'admin' ? 'Send answer' : 'Send'}</button>
          </div>
        </div>
      ) : <p className="hint">This query is closed. Ask a new one if you need anything else.</p>}
    </div>
  );
}

export function Queries() {
  const { profile } = useAuth();
  const act = useAction();
  const [sp, setSp] = useSearchParams();
  const q = useQuery(() => fetchAll<Query>((a, b) => api.from('queries').select('*').eq('investor_id', profile!.id).order('updated_at', { ascending: false }).range(a, b)), [profile?.id]);
  const [open, setOpen] = useState<string | null>(sp.get('open'));
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => { const o = sp.get('open'); if (o) { setOpen(o); const n = new URLSearchParams(sp); n.delete('open'); setSp(n, { replace: true }); } }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async () => {
    setTried(true); if (!subject.trim() || !message.trim()) return;
    const id = await act.run(() => rpc<string>('ask_query', { p_subject: subject.trim(), p_message: message.trim() }), ['Query sent', 'The company will answer here.']);
    if (id) { setSubject(''); setMessage(''); setTried(false); refreshAll(); q.reload(); setOpen(id); }
  };
  const list = q.data || [];
  const cur = list.find(x => x.id === open);
  return (
    <>
      <PageHead crumbs={['Ask a query']} title="Ask a query" sub="For example, “This month’s money hasn’t come yet”. The company answers here and you get a notification." />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : (
        <div className="grid g-2-1">
          <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
            {cur && (
              <div className="card">
                <div className="card-h"><h3>{cur.subject}</h3><div className="r"><QStatus s={cur.status} /> <a style={{ cursor: 'pointer', marginLeft: 8 }} onClick={() => setOpen(null)}>Close</a></div></div>
                <div className="card-b"><QueryThread q={cur} me="investor" onSent={q.reload} /></div>
              </div>
            )}
            <div className="card">
              <div className="card-h"><h3>My queries</h3></div>
              {list.length ? (
                <div className="tbl"><table><thead><tr><th>Query</th><th>Subject</th><th>Last update</th><th>Status</th></tr></thead>
                  <tbody>{list.map(x => (
                    <tr key={x.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(x.id)}>
                      <td className="mono">{x.code}</td><td><b>{x.subject}</b><span className="sub">{(x.messages || []).slice(-1)[0]?.text.slice(0, 80)}</span></td><td>{dateTime(x.updated_at)}</td><td><QStatus s={x.status} /></td>
                    </tr>))}</tbody></table></div>
              ) : <div className="card-b"><Empty title="No queries yet">Ask anything about your investments, returns or withdrawals.</Empty></div>}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>New query</h3></div>
            <div className="card-b">
              <div className="form">
                <Field label="Subject *" err={tried && !subject.trim() ? 'Enter a subject.' : null}><input className="input" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. This month’s ROI not received" /></Field>
                <Field label="Your question *" err={tried && !message.trim() ? 'Write your question.' : null}><textarea className="input" rows={5} value={message} onChange={e => setMessage(e.target.value)} /></Field>
                <button className="btn primary" onClick={ask} disabled={act.busy}><Icon name="announce" />Send to the company</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
