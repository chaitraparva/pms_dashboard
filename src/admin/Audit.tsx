import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, fetchAll } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { dateTime, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { AuditLog } from '../lib/types';
import { ErrorNote, Loading, PageHead, Drawer, Empty, IconBtn } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';

const AREAS: Record<string, string[]> = {
  plans: ['plan.'],
  investments: ['investment.', 'accrual.', 'job.'],
  payouts: ['payout.'],
  branches: ['branch.', 'investor.branch'],
  content: ['brochure.', 'property.', 'announcement.'],
  people: ['investor.', 'user.', 'admin.'],
  settings: ['settings.'],
  announcements: ['announcement.']
};
const inArea = (action: string, f: string) => (AREAS[f] || []).some(p => action.startsWith(p));
const json = (v: unknown) => (v == null ? '' : JSON.stringify(v, null, 2));
const record = (r: AuditLog) => [r.entity_type, r.entity_label].filter(Boolean).join(' · ');

export function Audit() {
  const q = useQuery(() => fetchAll<AuditLog>((a, b) => api.from('audit_logs').select('*').order('at', { ascending: false }).order('id', { ascending: false }).range(a, b)), []);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const rows = q.data || [];
  const id = params.get('id');
  const open = id ? rows.find(r => String(r.id) === id) : undefined;
  const close = () => nav('/admin/audit', { replace: true });

  const exportCsv = () => downloadCsv(`audit-log-${today()}`, ['ID', 'Time (UTC)', 'Actor', 'Action', 'Entity', 'Record', 'Reason', 'Before', 'After'],
    rows.map(r => [r.id, r.at, r.actor_name, r.action, r.entity_type, r.entity_label, r.reason, r.before == null ? '' : JSON.stringify(r.before), r.after == null ? '' : JSON.stringify(r.after)]));

  const cols: Col<AuditLog>[] = [
    { h: 'Time', v: r => r.at, r: r => <span className="num">{dateTime(r.at)}</span> },
    { h: 'Actor', v: r => r.actor_name || 'System' },
    { h: 'Action', v: r => r.action, r: r => <span className="mono">{r.action}</span> },
    { h: 'Record', v: r => record(r), r: r => <span className="mono">{r.entity_label || '—'}<span className="sub">{r.entity_type}</span></span> },
    { h: 'Reason', v: r => r.reason, r: r => r.reason || <span className="muted">—</span> }
  ];

  return (
    <>
      <PageHead crumbs={['Audit Logs']} title="Audit logs"
        sub="Append-only and read-only for everyone, including Super Admins. Every sensitive action records the actor, reason and before/after values."
        actions={<IconBtn icon="download" onClick={exportCsv} disabled={!rows.length}>Export CSV</IconBtn>} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <DataTable rows={rows} cols={cols} rowKey={r => String(r.id)} href={r => '/admin/audit?id=' + r.id}
          searchPh="Search actor, action, record, reason"
          filters={[['All', 'all'], ['Plans', 'plans'], ['Investments', 'investments'], ['Payouts', 'payouts'], ['Branches', 'branches'], ['Brochures & properties', 'content'], ['Investors & users', 'people'], ['Settings', 'settings'], ['Announcements', 'announcements']]}
          filterFn={(r, f) => f === 'all' || inArea(r.action, f)}
          sort={0} dir={-1} per={20}
          emptyTitle={rows.length ? 'No matching entries' : 'No audit entries yet'}
          empty={rows.length ? 'No audit entries match these filters.' : 'Entries are recorded automatically whenever an admin changes settings, plans, investors, investments, payouts, branches, brochures or properties.'} />
      )}
      {id && q.data && (
        <Drawer title={open ? open.action : 'Audit entry'} sub={open ? `${dateTime(open.at)} · ${open.actor_name || 'System'}` : undefined} onClose={close}
          foot={<button className="btn" onClick={close}>Close</button>}>
          {open ? (
            <div style={{ display: 'grid', gap: 16 }}>
              <dl className="kv">
                <dt>Entry</dt><dd className="mono">#{open.id}</dd>
                <dt>Time</dt><dd>{dateTime(open.at)}</dd>
                <dt>Actor</dt><dd>{open.actor_name || 'System'}</dd>
                <dt>Action</dt><dd className="mono">{open.action}</dd>
                <dt>Entity</dt><dd>{open.entity_type}</dd>
                <dt>Record</dt><dd className="mono">{open.entity_label || '—'}</dd>
                <dt>Reason</dt><dd>{open.reason || '—'}</dd>
              </dl>
              {(['before', 'after'] as const).map(k => (
                <div key={k} className="field">
                  <label>{k === 'before' ? 'Before' : 'After'}</label>
                  {open[k] == null ? <p className="hint">Not recorded for this action.</p> : (
                    <pre className="mono" style={{ margin: 0, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflow: 'auto' }}>{json(open[k])}</pre>
                  )}
                </div>
              ))}
              <p className="hint">This entry cannot be edited or deleted.</p>
            </div>
          ) : <Empty title="Entry not found">It may be outside the loaded range.</Empty>}
        </Drawer>
      )}
    </>
  );
}
