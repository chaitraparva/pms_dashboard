import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, rpc, must, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { useAuth, useSettings } from '../lib/auth';
import { createIbLogin, resetUserPassword } from '../lib/adminApi';
import { uploadDocument, openDocument, deleteDocument } from '../lib/docs';
import { downloadCsv } from '../lib/csv';
import { money, date, dateTime, initials, isUnlocked, lockinText, rate, today, LEDGER_TYPE } from '../lib/format';
import type { AuditLog, Branch, Profile, Investment, Balance, LedgerEntry, DocumentRow, KycStatus, Payout } from '../lib/types';
import { DataTable, Col } from '../ui/DataTable';
import { Kpi, Empty, ErrorNote, Loading, PageHead, KycBadge, AcctBadge, InvBadge, LedgerBadge, Drawer, Modal, Field, useAction, Badge, PayBadge } from '../ui/kit';
import { Icon } from '../ui/Icon';

const LIVE = ['active', 'matured', 'redemption_requested', 'redemption_processing'];
const DOC_KINDS: [DocumentRow['kind'], string][] = [['kyc', 'KYC document'], ['agreement', 'Agreement'], ['statement', 'Statement'], ['proof', 'Proof of payment'], ['attachment', 'Attachment'], ['other', 'Other']];

/** Keeps only the last 4 characters of an identifier; values that are already masked are kept as typed. */
function maskId(v: string): string {
  const s = v.trim();
  if (!s || /[•*xX]{3,}/.test(s)) return s;
  const clean = s.replace(/\s+/g, '');
  if (clean.length <= 4) return clean;
  return '•'.repeat(Math.min(8, clean.length - 4)) + clean.slice(-4);
}

const outstandingOf = (b?: Balance) => (b ? Number(b.unapproved) + Number(b.approved) + Number(b.processing) : 0);
const fmtBytes = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

interface Row extends Profile { principal: number; unlocked: number; accrued: number; paid: number; next: string | null; branch: string; introducer: string }

export const loadBranches = async () => must(await api.from('branches').select('*').order('name')) as Branch[];

/* =============================== DIRECTORY =============================== */
export function Investors() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const q = useQuery(async () => {
    const [people, invs, bal, branches] = await Promise.all([
      fetchAll<Profile>((a, b) => api.from('profiles').select('*').eq('role', 'investor').order('created_at', { ascending: false }).range(a, b)),
      fetchAll<Pick<Investment, 'id' | 'investor_id' | 'principal' | 'status' | 'maturity_date' | 'lockin_end_date'>>((a, b) => api.from('investments').select('id,investor_id,principal,status,maturity_date,lockin_end_date').range(a, b)),
      fetchAll<Balance>((a, b) => api.from('investment_balances').select('*').range(a, b)),
      loadBranches()
    ]);
    const admins = await loadAdmins();
    const an = new Map([...admins, ...people].map(a => [a.id, a.full_name || a.email]));
    const bn = new Map(branches.map(b => [b.id, b.name]));
    const bm = new Map(bal.map(x => [x.investment_id, x]));
    const by = new Map<string, typeof invs>();
    invs.forEach(i => { const l = by.get(i.investor_id) || []; l.push(i); by.set(i.investor_id, l); });
    const rows = people.map<Row>(p => {
      const m = by.get(p.id) || [];
      const live = m.filter(i => LIVE.includes(i.status));
      return {
        ...p,
        branch: p.branch_id ? bn.get(p.branch_id) || '' : '',
        introducer: p.introduced_by ? an.get(p.introduced_by) || '' : '',
        principal: live.reduce((s, i) => s + Number(i.principal), 0),
        unlocked: live.filter(i => isUnlocked(i)).reduce((s, i) => s + Number(i.principal), 0),
        accrued: m.reduce((s, i) => s + Number(bm.get(i.id)?.accrued || 0), 0),
        paid: m.reduce((s, i) => s + Number(bm.get(i.id)?.paid || 0), 0),
        next: live.filter(i => !isUnlocked(i)).map(i => i.lockin_end_date).filter((x): x is string => !!x).sort()[0] || null
      };
    });
    return { rows, branches };
  }, []);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);

  const rows = q.data?.rows || [];
  const branches = q.data?.branches || [];
  const branchParam = sp.get('branch') || '';
  const cols: Col<Row>[] = useMemo(() => [
    { h: 'Investor', v: r => r.full_name, r: r => <><b>{r.full_name || '—'}</b><span className="sub">{r.code} · {r.phone || r.email}</span></> },
    { h: 'Branch', v: r => r.branch || 'zz', r: r => r.branch || <span className="muted">Not assigned</span> },
    { h: 'Under', v: r => r.introducer || 'zz', r: r => r.introducer || <span className="muted">Individual</span> },
    { h: 'Phone', v: r => r.phone, r: r => <span className="num">{r.phone || '—'}</span> },
    { h: 'Registered', v: r => r.created_at, r: r => date(r.created_at) },
    { h: 'Verification', v: r => r.kyc_status, r: r => <KycBadge k={r.kyc_status} /> },
    { h: 'Account', v: r => r.account_status, r: r => <AcctBadge s={r.account_status} /> },
    { h: 'Principal', n: true, v: r => r.principal, r: r => money(r.principal) },
    { h: 'Unlocked', n: true, v: r => r.unlocked, r: r => money(r.unlocked) },
    { h: 'Accrued', n: true, v: r => r.accrued, r: r => money(r.accrued) },
    { h: 'Paid', n: true, v: r => r.paid, r: r => <span className="pos">{money(r.paid)}</span> },
    { h: 'Next unlock', v: r => r.next || '9999', r: r => (r.next ? date(r.next) : <span className="muted">—</span>) }
  ], []);

  const exportCsv = () => downloadCsv(`investors-${today()}`,
    ['Investor ID', 'Name', 'Email', 'Branch', 'Under', 'Phone', 'City', 'Registered', 'KYC', 'Account', 'Principal (live)', 'Unlocked principal', 'Accrued', 'Paid', 'Next unlock'],
    rows.map(r => [r.code, r.full_name, r.email, r.branch, r.introducer, r.phone, r.city, r.created_at.slice(0, 10), r.kyc_status, r.account_status, r.principal, r.unlocked, r.accrued, r.paid, r.next || '']));

  return (
    <>
      <PageHead crumbs={['Investors']} title="Investors"
        sub={q.data ? `${rows.length} registered · ${rows.filter(r => r.kyc_status === 'pending').length} awaiting verification · ${rows.filter(r => !r.branch_id).length} without a branch` : 'Loading…'}
        actions={<>
          {sel.size > 0 && <button className="btn" onClick={() => setAssigning(true)}><Icon name="branch" />Assign branch ({sel.size})</button>}
          <button className="btn" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export CSV</button>
          <button className="btn accent" onClick={() => nav('/admin/investments?new=1')}><Icon name="plus" />Record investment</button>
        </>} />
      {q.error ? <ErrorNote msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !rows.length ? (
        <div className="card"><div className="card-b">
          <Empty title="No investors yet">
            <span>Add an investor to send them an invitation, or set a temporary password for them.</span>
            <button className="btn accent" style={{ marginTop: 8 }} onClick={() => nav('/admin/investments?new=1')}><Icon name="plus" />Record investment</button>
          </Empty>
        </div></div>
      ) : (
        <DataTable<Row> key={branchParam} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search name, ID, email, phone" sort={3}
          text={r => `${r.code} ${r.email} ${r.phone} ${r.city}`}
          filters={[['All', 'all'], ...branches.map(b => [b.name, 'b:' + b.code] as [string, string]), ['No branch', 'b:'], ['KYC pending', 'pending'], ['Suspended', 'suspended']]}
          filterFn={(r, f) => f === 'all' || (f.startsWith('b:') ? (f === 'b:' ? !r.branch_id : branches.find(b => b.code === f.slice(2))?.id === r.branch_id) : r.kyc_status === f || r.account_status === f)}
          initialFilter={branchParam ? 'b:' + (branchParam === 'none' ? '' : branchParam) : undefined}
          select={{ selected: sel, onChange: setSel }}
          href={r => (r.code ? '/admin/investors/' + r.code : null)} emptyTitle="No matching investors" />
      )}
      {assigning && <BranchDialog ids={[...sel]} label={`${sel.size} investor${sel.size === 1 ? '' : 's'}`} current={null} branches={branches} onClose={() => setAssigning(false)} onDone={() => { setSel(new Set()); setAssigning(false); }} />}
    </>
  );
}

/** Assign one or more investors to a branch (or remove the branch). Every change is audited. */
export function BranchDialog({ ids, label, current, branches, onClose, onDone }: { ids: string[]; label: string; current: string | null; branches: Branch[]; onClose: () => void; onDone?: () => void }) {
  const act = useAction();
  const [to, setTo] = useState(current || '');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const go = async () => {
    setTried(true); if (!reason.trim()) return;
    const r = await act.run(() => rpc<number>('admin_set_investor_branch', { p_ids: ids, p_branch: to || null, p_reason: reason.trim() }),
      ['Branch updated', `${label} · recorded in audit log`]);
    if (r !== undefined) { refreshAll(); (onDone || onClose)(); }
  };
  return (
    <Modal title={`Branch for ${label}`} sub="Branch totals on the Overview update straight away. Investments and their terms are not changed." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Save branch</button></>}>
      <Field label="Branch"><select className="input" value={to} onChange={e => setTo(e.target.value)}>
        <option value="">No branch</option>{branches.map(b => <option key={b.id} value={b.id}>{b.name}{b.status !== 'active' ? ' (inactive)' : ''}</option>)}
      </select></Field>
      <Field label="Reason (saved to audit log) *" err={tried && !reason.trim() ? 'Enter a reason.' : null}>
        <input className={'input ' + (tried && !reason.trim() ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Investor joined through the Tumkur office" />
      </Field>
    </Modal>
  );
}

/** The investors a person can be under (they receive the bonus). */
type AdminLite = Pick<Profile, 'id' | 'code' | 'full_name' | 'email' | 'account_status' | 'role' | 'can_introduce'>;
const loadAdmins = async () => {
  const cols = 'id, code, full_name, email, account_status, role, can_introduce';
  return fetchAll<AdminLite>((a, b) => api.from('profiles').select(cols).eq('role', 'investor').order('full_name').range(a, b));
};
const introLabel = (a: AdminLite) => (a.full_name || a.email) + (a.code ? ' · ' + a.code : '');

/* =============================== DETAIL =============================== */
interface DetailData {
  p: Profile; invs: Investment[]; bal: Map<string, Balance>; history: AuditLog[]; ledger: LedgerEntry[]; payouts: Payout[]; docs: DocumentRow[]; invCode: Record<string, string>; branches: Branch[]; admins: AdminLite[];
  introducer: AdminLite | null; brought: Profile[]; bonus: { earned: number; paid: number };
}

async function loadDetail(code: string): Promise<DetailData | null> {
  const p = must(await api.from('profiles').select('*').eq('code', code).maybeSingle()) as Profile | null;
  if (!p || !(p as Profile).id) return null;
  const [invs, history, ledger, docs, branches, pays, admins] = await Promise.all([
    fetchAll<Investment>((a, b) => api.from('investments').select('*').eq('investor_id', p.id).order('created_at', { ascending: false }).range(a, b)),
    api.from('audit_logs').select('*').eq('entity_id', p.id).order('at', { ascending: false }).limit(30),
    api.from('ledger_entries').select('*').eq('investor_id', p.id).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(12),
    api.from('documents').select('*').eq('owner_id', p.id).order('created_at', { ascending: false }),
    loadBranches(),
    api.from('payouts').select('*').eq('investor_id', p.id).order('due_date', { ascending: false }).limit(24),
    loadAdmins()
  ]);
  const ids = invs.map(i => i.id);
  const bal = ids.length ? must(await api.from('investment_balances').select('*').in('investment_id', ids)) as Balance[] : [];
  const invCode: Record<string, string> = {};
  invs.forEach(i => { invCode[i.id] = i.code; });
  const [intro, brought, bon] = await Promise.all([
    p.introduced_by ? api.from('profiles').select('id, code, full_name, email, account_status, role, can_introduce').eq('id', p.introduced_by).maybeSingle() : Promise.resolve({ data: null, error: null }),
    fetchAll<Profile>((a, b) => api.from('profiles').select('*').eq('introduced_by', p.id).eq('role', 'investor').order('full_name').range(a, b)),
    fetchAll<{ amount: number; status: string }>((a, b) => api.from('admin_bonuses').select('amount, status').eq('admin_id', p.id).range(a, b))
  ]);
  const tot = (f: (x: { status: string }) => boolean) => Math.round(bon.filter(f).reduce((x, y) => x + Number(y.amount), 0) * 100) / 100;
  return { p, invs, bal: new Map(bal.map(b => [b.investment_id, b])), history: must(history) as AuditLog[], ledger: must(ledger) as LedgerEntry[], payouts: must(pays) as Payout[], docs: must(docs) as DocumentRow[], invCode, branches, admins,
    introducer: (must(intro) as AdminLite | null) || null, brought, bonus: { earned: tot(x => x.status !== 'cancelled'), paid: tot(x => x.status === 'paid') } };
}

type Dialog = null | 'introduce' | 'kyc-verified' | 'kyc-rejected' | 'status' | 'edit' | 'upload' | 'branch' | 'password' | { del: DocumentRow };

export function InvestorDetail() {
  const { code = '' } = useParams();
  const nav = useNavigate();
  const s = useSettings();
  const { profile: me } = useAuth();
  const act = useAction();
  const [dlg, setDlg] = useState<Dialog>(null);
  const q = useQuery(() => loadDetail(code), [code]);

  if (q.error) return <><PageHead crumbs={['Investors', code]} title={code} /><ErrorNote msg={q.error} retry={q.reload} /></>;
  if (!q.data && q.loading) return <><PageHead crumbs={['Investors', code]} title={code} /><Loading rows={6} /></>;
  if (!q.data) return (
    <><PageHead crumbs={['Investors', 'Not found']} title="Investor not found" />
      <Empty title="Investor not found">No investor has the code {code}. <Link to="/admin/investors">Back to investors</Link></Empty></>
  );
  const { p, invs, bal, history, ledger, payouts, docs, invCode, branches, introducer, brought, bonus } = q.data;
  const live = invs.filter(i => LIVE.includes(i.status));
  const principal = live.reduce((x, i) => x + Number(i.principal), 0);
  const unlocked = live.filter(i => isUnlocked(i)).reduce((x, i) => x + Number(i.principal), 0);
  const branch = branches.find(b => b.id === p.branch_id) || null;
  const accrued = invs.reduce((x, i) => x + Number(bal.get(i.id)?.accrued || 0), 0);
  const paid = invs.reduce((x, i) => x + Number(bal.get(i.id)?.paid || 0), 0);
  const outstanding = invs.reduce((x, i) => x + outstandingOf(bal.get(i.id)), 0);
  const next = live.filter(i => !isUnlocked(i)).map(i => i.lockin_end_date).filter((x): x is string => !!x).sort()[0] || null;
  const self = me?.id === p.id;

  const openDoc = (d: DocumentRow) => act.run(() => openDocument(d.storage_path));

  return (
    <>
      <Link className="back" to="/admin/investors"><Icon name="back" /> All investors</Link>
      <PageHead crumbs={['Investors', p.full_name || p.code || '']} title={p.full_name}
        actions={<>
          <KycBadge k={p.kyc_status} /> <AcctBadge s={p.account_status} />
          {p.role === 'super_admin' && <Badge cls="b-navy">Super Admin</Badge>}
          {p.role === 'investor' && (p.is_ib || brought.length > 0 ? <Badge cls="b-navy">IB</Badge> : introducer ? <Badge cls="b-grey">Sub-investor</Badge> : <Badge cls="b-grey">Individual</Badge>)}
          {p.has_login && <Badge cls="b-blue">Login: {p.phone}</Badge>}
          <button className="btn" onClick={() => setDlg('edit')}>Edit details</button>
          {p.role === 'investor' && !brought.length && <button className="btn" disabled={act.busy} onClick={async () => {
            const r = await act.run(() => rpc('admin_set_ib', { p_id: p.id, p_value: !p.is_ib }), [p.is_ib ? 'IB status removed' : 'Marked as IB', p.full_name]);
            if (r !== undefined) refreshAll();
          }}>{p.is_ib ? 'Remove IB status' : 'Make IB'}</button>}
          {p.role === 'investor' && !p.has_login && <button className="btn" onClick={() => setDlg('introduce')}><Icon name="users" />Create login</button>}
          {(p.has_login || p.role === 'super_admin') && <button className="btn" onClick={() => setDlg('password')}>Reset password</button>}
          <button className="btn" onClick={() => nav('/admin/announcements?to=' + p.id)}><Icon name="announce" />Send notice</button>
          {!self && <button className={'btn ' + (p.account_status === 'active' ? 'danger' : '')} onClick={() => setDlg('status')}>{p.account_status === 'active' ? 'Suspend account' : 'Reactivate account'}</button>}
          {p.role === 'investor' && <button className="btn accent" disabled={p.account_status !== 'active'}
            title={p.account_status !== 'active' ? 'Account is suspended' : undefined}
            onClick={() => nav('/admin/investments?new=1&investor=' + encodeURIComponent(p.code || ''))}><Icon name="plus" />Record investment</button>}
        </>}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div className="avatar" style={{ width: 52, height: 52, fontSize: 17 }}>{initials(p.full_name || p.email)}</div>
          <div><h1>{p.full_name || p.email}</h1><p>{[p.code, p.email, branch ? branch.name + ' branch' : 'No branch', p.phone, p.city, p.role === 'investor' ? (introducer ? 'Under ' + (introducer.full_name || introducer.email) : 'Individual') : ''].filter(Boolean).join(' · ')}</p></div>
        </div>
      </PageHead>

      {p.kyc_status !== 'verified' && (
        <div className="note">
          <b>{p.kyc_status === 'rejected' ? 'Verification was rejected.' : 'Awaiting KYC verification.'}</b> Investments can only be recorded for verified investors.
          {' '}Review the documents below, then <a style={{ cursor: 'pointer' }} onClick={() => setDlg('kyc-verified')}>verify</a>
          {p.kyc_status === 'pending' && <> or <a style={{ cursor: 'pointer' }} onClick={() => setDlg('kyc-rejected')}>reject</a></>}.
        </div>
      )}

      <div className="kpis">
        <Kpi label="Principal (live)" value={money(principal)} sub={`${live.length} live investment${live.length === 1 ? '' : 's'}`} />
        <Kpi label="Unlocked principal" value={money(unlocked)} sub={next ? `Next unlock ${date(next)}` : 'Nothing in lock-in'} tip="Principal of investments whose lock-in has ended. A status only: nothing is paid out automatically." />
        <Kpi label="Accrued returns" value={money(accrued)} tip="Sum of accruals on all of this investor’s investments, net of reversals." />
        <Kpi label="Returns paid" value={money(paid)} cls="pos" sub="Confirmed with bank reference" />
        <Kpi label="Outstanding" value={money(outstanding)} sub="Accrued, not yet paid" subCls={outstanding ? 'warn' : ''} />
      </div>

      {introducer && introducer.role === 'investor' && (
        <div className="note info">Under <Link to={'/admin/investors/' + introducer.code}><b>{introducer.full_name || introducer.email}</b></Link> ({introducer.code}). The bonus on this person’s investments goes to them, and they see this person in their login.</div>
      )}
      {p.role === 'investor' && brought.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Sub-investors of {p.full_name || p.email} (IB)</h3>
            <div className="r">{brought.length} investor{brought.length === 1 ? '' : 's'} · bonus earned {money(bonus.earned)} · paid {money(bonus.paid)}</div></div>
          {brought.length ? (
            <div className="tbl"><table><thead><tr><th>Investor</th><th>Branch</th><th>Verification</th><th>Added</th></tr></thead>
              <tbody>{brought.map(x => (
                <tr key={x.id} style={{ cursor: 'pointer' }} onClick={() => nav('/admin/investors/' + x.code)}>
                  <td><b>{x.full_name || x.email}</b><span className="sub">{x.code} · {x.email}</span></td>
                  <td>{branches.find(b => b.id === x.branch_id)?.name || <span className="muted">—</span>}</td>
                  <td><KycBadge k={x.kyc_status} /></td><td>{date(x.created_at)}</td>
                </tr>))}</tbody></table></div>
          ) : <div className="card-b"><Empty title="Nobody yet">Use “Record investment”, choose “Under an investor” and pick {p.full_name || 'this investor'}. People appear here and in their login.</Empty></div>}
        </div>
      )}

      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>Investment portfolio</h3><div className="r">{invs.length} total</div></div>
          <div className="tbl">
            {invs.length ? (
              <table>
                <thead><tr><th>Investment</th><th>Plan</th><th className="n">Principal</th><th>Rate</th><th>Start</th><th>Maturity</th><th className="n">Accrued</th><th className="n">Paid</th><th>Status</th></tr></thead>
                <tbody>{invs.map(i => {
                  const b = bal.get(i.id);
                  return (
                    <tr key={i.id} className="click" onClick={() => nav('/admin/investments/' + i.code)}>
                      <td className="m">{i.code}</td>
                      <td>{i.plan_name} v{i.plan_version}<span className="sub">{lockinText(i.lockin_months)}</span></td>
                      <td className="n">{money(i.principal)}</td><td>{rate(i.monthly_rate)}</td><td>{date(i.start_date || i.expected_start)}</td><td>{date(i.maturity_date)}</td>
                      <td className="n">{money(b?.accrued || 0)}</td><td className="n pos">{money(b?.paid || 0)}</td>
                      <td><InvBadge i={i} approachingDays={s.approaching_days} /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            ) : <div className="card-b"><Empty title="No investments yet">{p.kyc_status === 'verified' ? 'Use “Record investment” once the investor’s funds are agreed.' : 'Verify KYC first, then record an investment.'}</Empty></div>}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Profile & verification</h3></div>
          <div className="card-b" style={{ display: 'grid', gap: 14 }}>
            <dl className="kv">
              <dt>Branch</dt><dd>{branch ? branch.name : <span className="muted">Not assigned</span>} <a style={{ cursor: 'pointer', marginLeft: 6 }} onClick={() => setDlg('branch')}>Change</a></dd>
              <dt>Registered</dt><dd>{date(p.created_at)}</dd>
              <dt>City</dt><dd>{p.city || '—'}</dd>
              <dt>Address</dt><dd>{p.address || '—'}</dd>
              <dt>ID number</dt><dd className="mono">{p.id_number_masked || '—'}</dd>
              <dt>Bank</dt><dd>{p.bank_name || '—'}</dd>
              <dt>Account</dt><dd className="mono">{p.bank_account_masked || '—'}</dd>
              <dt>IFSC / routing</dt><dd className="mono">{p.bank_ifsc || '—'}</dd>
              <dt>Email updates</dt><dd>{p.notify_email ? 'On' : 'Off'}</dd>
              <dt>Verification</dt><dd><KycBadge k={p.kyc_status} /></dd>
            </dl>
            {p.role === 'investor' && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {p.kyc_status !== 'rejected' && <button className="btn danger" onClick={() => setDlg('kyc-rejected')}>{p.kyc_status === 'verified' ? 'Revoke verification' : 'Reject KYC'}</button>}
                {p.kyc_status !== 'verified' && <button className="btn primary" onClick={() => setDlg('kyc-verified')}>Verify KYC</button>}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Payouts</h3><div className="r"><Link to="/admin/payouts">Approve and pay</Link></div></div>
        <div className="tbl">
          {payouts.length ? (
            <table>
              <thead><tr><th>Payout</th><th>Investment</th><th>Due</th><th className="n">Amount</th><th>Status</th><th>Reference</th></tr></thead>
              <tbody>{payouts.map(x => (
                <tr key={x.id}><td className="m">{x.code}</td><td className="m"><Link to={'/admin/investments/' + (invCode[x.investment_id] || '')}>{invCode[x.investment_id] || '—'}</Link></td>
                  <td>{date(x.due_date)}</td><td className="n">{money(x.amount)}</td><td><PayBadge s={x.status} /></td><td className="m">{x.payment_ref || x.batch_ref || '—'}</td></tr>
              ))}</tbody>
            </table>
          ) : <div className="card-b"><Empty title="No payouts yet">Monthly returns appear here once an investment starts accruing.</Empty></div>}
        </div>
      </div>

      <div className="grid g-1-1">
        <div className="card">
          <div className="card-h"><h3>Recent transactions</h3><div className="r"><Link to="/admin/transactions">Ledger</Link></div></div>
          <div className="tbl">
            {ledger.length ? (
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Investment</th><th className="n">Amount</th><th>Status</th></tr></thead>
                <tbody>{ledger.map(t => (
                  <tr key={t.id}><td>{date(t.occurred_on)}<span className="sub mono">{t.code}</span></td><td>{LEDGER_TYPE[t.type] || t.type}</td>
                    <td className="m">{t.investment_id ? invCode[t.investment_id] || '—' : '—'}</td>
                    <td className={'n ' + (Number(t.amount) < 0 ? 'neg' : '')}>{money(t.amount)}</td><td><LedgerBadge s={t.status} /></td></tr>
                ))}</tbody>
              </table>
            ) : <div className="card-b"><Empty title="No transactions">Entries appear when an investment is recorded for this investor.</Empty></div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Account history</h3><div className="r"><Link to="/admin/audit">Audit log</Link></div></div>
          <div className="card-b list">
            {history.length ? history.map(h => (
              <div key={h.id}>
                <div className="grow"><b>{h.action === 'investor.branch' ? `Branch: ${(h.before as { branch?: string } | null)?.branch || 'none'} → ${(h.after as { branch?: string } | null)?.branch || 'none'}` : h.action.replace(/[._]/g, ' ')}</b>
                  <span>{dateTime(h.at)} · {h.actor_name}{h.reason ? ' · ' + h.reason : ''}</span></div>
              </div>
            )) : <Empty title="No changes recorded">Branch, verification and account changes appear here.</Empty>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Documents</h3><div className="r"><button className="btn sm" onClick={() => setDlg('upload')}><Icon name="upload" />Upload</button></div></div>
        <div className="card-b list">
          {docs.length ? docs.map(d => (
            <div key={d.id}>
              <Icon name="doc" />
              <div className="grow"><b>{d.title}</b>
                <span>{(DOC_KINDS.find(k => k[0] === d.kind) || [d.kind, d.kind])[1]}{d.investment_id && invCode[d.investment_id] ? ' · ' + invCode[d.investment_id] : ''} · {fmtBytes(Number(d.size_bytes))} · uploaded {date(d.created_at)}</span></div>
              {d.visible_to_investor ? <Badge cls="b-blue">Visible to investor</Badge> : <Badge cls="b-grey">Internal</Badge>}
              <button className="btn sm" onClick={() => openDoc(d)}>Open</button>
              <button className="btn sm danger" onClick={() => setDlg({ del: d })}>Delete</button>
            </div>
          )) : <Empty title="No documents yet"><span>Upload KYC documents, agreements or statements for this investor.</span><button className="btn sm" style={{ marginTop: 6 }} onClick={() => setDlg('upload')}><Icon name="upload" />Upload document</button></Empty>}
        </div>
      </div>

      {(dlg === 'kyc-verified' || dlg === 'kyc-rejected') && <KycDialog p={p} to={dlg === 'kyc-verified' ? 'verified' : 'rejected'} onClose={() => setDlg(null)} />}
      {dlg === 'status' && <StatusDialog p={p} onClose={() => setDlg(null)} />}
      {dlg === 'introduce' && <IntroduceDialog p={p} count={brought.length} onClose={() => setDlg(null)} />}
      {dlg === 'branch' && <BranchDialog ids={[p.id]} label={p.full_name || p.email} current={p.branch_id} branches={branches} onClose={() => setDlg(null)} />}
      {dlg === 'edit' && <EditInvestor p={p} onClose={() => setDlg(null)} />}
      {dlg === 'password' && <ResetPassword p={p} onClose={() => setDlg(null)} />}
      {dlg === 'upload' && <UploadDoc p={p} invs={invs} onClose={() => setDlg(null)} />}
      {dlg && typeof dlg === 'object' && <DeleteDoc d={dlg.del} onClose={() => setDlg(null)} />}
    </>
  );
}

function KycDialog({ p, to, onClose }: { p: Profile; to: KycStatus; onClose: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState(to === 'verified' ? 'Documents reviewed and verified' : '');
  const [tried, setTried] = useState(false);
  const err = !reason.trim() ? (to === 'rejected' ? 'Tell the investor what needs attention — they see this message.' : 'Enter a short note for the audit log.') : null;
  const go = async () => {
    setTried(true); if (err) return;
    const r = await act.run(() => rpc('admin_set_kyc', { p_id: p.id, p_status: to, p_reason: reason.trim() }), [to === 'verified' ? 'Investor verified' : 'Verification rejected', p.full_name]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={to === 'verified' ? `Verify ${p.full_name}?` : `Reject verification for ${p.full_name}?`}
      sub={to === 'verified' ? 'Verified investors can have investments recorded for them.' : 'The investor is notified with your reason and cannot invest until verified.'}
      onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className={'btn ' + (to === 'verified' ? 'primary' : 'danger')} onClick={go} disabled={act.busy}>{to === 'verified' ? 'Verify investor' : 'Reject'}</button></>}>
      <Field label="Reason *" err={tried ? err : null}><input className={'input ' + (tried && err ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder={to === 'rejected' ? 'e.g. Address on ID does not match bank record' : ''} /></Field>
    </Modal>
  );
}

/** Gives a person a login: they sign in with their phone number and this password. */
function IntroduceDialog({ p, onClose }: { p: Profile; count: number; onClose: () => void }) {
  const act = useAction();
  const [pw, setPw] = useState('');
  const [tried, setTried] = useState(false);
  const bad = pw.length < 8 ? 'At least 8 characters.' : !p.phone ? 'Add a phone number first (Edit details).' : null;
  const go = async () => {
    setTried(true); if (bad) return;
    const r = await act.run(() => createIbLogin({ person_id: p.id, phone: p.phone, password: pw }), ['Login created', `${p.full_name} signs in with ${p.phone}`]);
    if (r) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Create a login for ${p.full_name || p.email}?`} sub={`They sign in as Investor with their phone number ${p.phone || '(none yet)'} and this password.`}
      onClose={onClose} foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Create login</button></>}>
      <Field label="Password *" err={tried ? bad : null} hint="Share it with them offline."><input className={'input mono ' + (tried && bad ? 'bad' : '')} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" /></Field>
    </Modal>
  );
}

function StatusDialog({ p, onClose }: { p: Profile; onClose: () => void }) {
  const act = useAction();
  const nv = p.account_status === 'active' ? 'suspended' : 'active';
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const go = async () => {
    setTried(true); if (!reason.trim()) return;
    const r = await act.run(() => rpc('admin_set_investor_status', { p_id: p.id, p_status: nv, p_reason: reason.trim() }), [nv === 'suspended' ? 'Account suspended' : 'Account reactivated', `${p.full_name} · recorded in audit log`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={(nv === 'suspended' ? 'Suspend ' : 'Reactivate ') + (p.full_name || p.email) + '?'}
      sub={nv === 'suspended' ? 'The investor will not be able to sign in. Accruals continue under their contract.' : 'The investor will be able to sign in again.'}
      onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className={'btn ' + (nv === 'suspended' ? 'danger' : 'primary')} onClick={go} disabled={act.busy}>{nv === 'suspended' ? 'Suspend account' : 'Reactivate'}</button></>}>
      <Field label="Reason (required, saved to audit log)" err={tried && !reason.trim() ? 'Enter a reason.' : null}>
        <input className={'input ' + (tried && !reason.trim() ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. KYC address mismatch" />
      </Field>
    </Modal>
  );
}

function ResetPassword({ p, onClose }: { p: Profile; onClose: () => void }) {
  const act = useAction();
  const [pw, setPw] = useState('');
  const [tried, setTried] = useState(false);
  const bad = pw.length < 10 ? 'Use at least 10 characters.' : null;
  const go = async () => {
    setTried(true); if (bad) return;
    const r = await act.run(() => resetUserPassword(p.id, pw), ['Password reset', `Share the new temporary password with ${p.full_name || p.email} securely.`]);
    if (r) onClose();
  };
  return (
    <Modal title={'Reset password for ' + (p.full_name || p.email)} sub="Sets a new temporary password. Their old password stops working straight away." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>Set password</button></>}>
      <Field label="New temporary password *" err={tried ? bad : null} hint="At least 10 characters. Ask them to change it from Profile & Security after signing in.">
        <input className={'input mono ' + (tried && bad ? 'bad' : '')} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" />
      </Field>
    </Modal>
  );
}

function EditInvestor({ p, onClose }: { p: Profile; onClose: () => void }) {
  const act = useAction();
  const aq = useQuery(loadAdmins, []);
  const init = { introduced_by: p.introduced_by || '', full_name: p.full_name, phone: p.phone, address: p.address, city: p.city, id_number_masked: p.id_number_masked, bank_name: p.bank_name, bank_account_masked: p.bank_account_masked, bank_ifsc: p.bank_ifsc };
  const [f, setF] = useState(init);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const changed = (Object.keys(f) as (keyof typeof f)[]).filter(k => f[k] !== init[k]);
  const errs = { name: !f.full_name.trim() ? 'Name cannot be empty.' : null, reason: !reason.trim() ? 'A reason is required for the audit log.' : null };
  const save = async () => {
    setTried(true);
    if (errs.name || errs.reason || !changed.length) return;
    const patch: Record<string, string> = {};
    changed.forEach(k => {
      const v = f[k].trim();
      patch[k] = k === 'introduced_by' ? f[k] : k === 'id_number_masked' || k === 'bank_account_masked' ? maskId(v) : k === 'bank_ifsc' ? v.toUpperCase() : v;
    });
    const r = await act.run(() => rpc('admin_update_investor', { p_id: p.id, p: patch, p_reason: reason.trim() }), ['Investor details saved', `${changed.length} field${changed.length === 1 ? '' : 's'} updated · recorded in audit log`]);
    if (r !== undefined) { refreshAll(); onClose(); }
  };
  return (
    <Drawer title={'Edit ' + (p.full_name || p.email)} sub="Email address is the sign-in identity and cannot be changed here." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={act.busy || !changed.length}>Save changes</button></>}>
      <div className="form">
        <Field label="Full name *" err={tried ? errs.name : null}><input className="input" value={f.full_name} onChange={set('full_name')} /></Field>
        {p.role === 'investor' && (
          <Field label="Under" hint="Receives the bonus. Unpaid bonuses move to the investor you choose.">
            <select className="input" value={f.introduced_by} onChange={set('introduced_by')}>
              <option value="">Individual (nobody)</option>
              {(aq.data || []).filter(a => a.id !== p.id && (a.account_status === 'active' || a.id === f.introduced_by)).map(a => <option key={a.id} value={a.id}>{introLabel(a)}</option>)}
            </select>
          </Field>
        )}
        <div className="f-row">
          <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
        </div>
        <Field label="Address"><textarea className="input" rows={2} value={f.address} onChange={set('address')} /></Field>
        <Field label="ID number" hint={f.id_number_masked !== init.id_number_masked && f.id_number_masked ? <>Stored as <span className="mono">{maskId(f.id_number_masked)}</span></> : 'Masked. Type a new number to replace it.'}>
          <input className="input mono" value={f.id_number_masked} onChange={set('id_number_masked')} autoComplete="off" />
        </Field>
        <div className="f-row">
          <Field label="Bank name"><input className="input" value={f.bank_name} onChange={set('bank_name')} /></Field>
          <Field label="IFSC / routing code"><input className="input mono" value={f.bank_ifsc} onChange={set('bank_ifsc')} /></Field>
        </div>
        <Field label="Bank account" hint={f.bank_account_masked !== init.bank_account_masked && f.bank_account_masked ? <>Stored as <span className="mono">{maskId(f.bank_account_masked)}</span></> : 'Masked. Type a new number to replace it.'}>
          <input className="input mono" value={f.bank_account_masked} onChange={set('bank_account_masked')} autoComplete="off" />
        </Field>
        <Field label="Reason for change *" err={tried ? errs.reason : null} hint="Saved to the audit log with the before and after values.">
          <input className={'input ' + (tried && errs.reason ? 'bad' : '')} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Investor submitted new cancelled cheque" />
        </Field>
        {tried && !changed.length && <p className="hint err">Nothing has changed yet.</p>}
      </div>
    </Drawer>
  );
}

function UploadDoc({ p, invs, onClose }: { p: Profile; invs: Investment[]; onClose: () => void }) {
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocumentRow['kind']>('kyc');
  const [inv, setInv] = useState('');
  const [visible, setVisible] = useState(true);
  const [tried, setTried] = useState(false);
  useEffect(() => { if (file && !title) setTitle(file.name.replace(/\.[^.]+$/, '')); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [file]);
  const err = !file ? 'Choose a file.' : file.size > 3 * 1024 * 1024 ? 'Files must be 3 MB or smaller.' : null;
  const go = async () => {
    setTried(true); if (err || !file) return;
    const r = await act.run(() => uploadDocument({ ownerId: p.id, investmentId: inv || null, kind, title: title.trim() || file.name, file, visible }), ['Document uploaded', visible ? 'The investor can see it in their documents.' : 'Internal only — the investor cannot see it.']);
    if (r) { refreshAll(); onClose(); }
  };
  return (
    <Modal title="Upload document" sub={`Stored privately in ${p.full_name || p.email}’s folder.`} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={act.busy}>{act.busy ? 'Uploading…' : 'Upload'}</button></>}>
      <Field label="File *" err={tried ? err : null} hint="PDF, image or office document, up to 20 MB."><input className="input" type="file" onChange={e => setFile(e.target.files?.[0] || null)} /></Field>
      <Field label="Title"><input className="input" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="f-row">
        <Field label="Kind"><select className="input" value={kind} onChange={e => setKind(e.target.value as DocumentRow['kind'])}>{DOC_KINDS.map(k => <option key={k[0]} value={k[0]}>{k[1]}</option>)}</select></Field>
        <Field label="Investment (optional)"><select className="input" value={inv} onChange={e => setInv(e.target.value)}><option value="">Not linked</option>{invs.map(i => <option key={i.id} value={i.id}>{i.code} · {i.plan_name}</option>)}</select></Field>
      </div>
      <label className="check"><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} /> Visible to the investor</label>
    </Modal>
  );
}

function DeleteDoc({ d, onClose }: { d: DocumentRow; onClose: () => void }) {
  const act = useAction();
  const go = async () => {
    const r = await act.run(async () => { await deleteDocument(d); return true; }, ['Document deleted', d.title]);
    if (r) { refreshAll(); onClose(); }
  };
  return (
    <Modal title={`Delete “${d.title}”?`} sub="The file is removed from storage. This cannot be undone." onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn danger" onClick={go} disabled={act.busy}>Delete</button></>} />
  );
}
