import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rpc, fetchAll } from '../lib/api';
import { useQuery, refreshAll } from '../lib/useQuery';
import { money, date, rate, today } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { AdminBonus } from '../lib/types';
import { Badge, Kpi, ErrorNote, Loading, PageHead, Modal, Field, IconBtn, useAction } from '../ui/kit';
import { DataTable, Col } from '../ui/DataTable';

type Person = { id: string; code: string | null; full_name: string; email: string; role: string; can_introduce?: boolean };
type Inv = { id: string; code: string; plan_name: string; principal: number };
interface Row extends AdminBonus { admin?: Person; investor?: Person; inv?: Inv }

type Tab = 'accrued' | 'paid' | 'cancelled' | 'all';
const TABS: [Tab, string][] = [['accrued', 'Unpaid'], ['paid', 'Paid'], ['cancelled', 'Cancelled'], ['all', 'All']];
const nameOf = (p?: Person) => (p ? p.full_name || p.email : '—');
const StatusBadge = ({ s }: { s: string }) => s === 'paid' ? <Badge cls="b-green">Paid</Badge> : s === 'cancelled' ? <Badge cls="b-grey">Cancelled</Badge> : <Badge cls="b-amber">Unpaid</Badge>;

async function load() {
  const [bon, invs, people] = await Promise.all([
    fetchAll<AdminBonus>((a, b) => api.from('admin_bonuses').select('*').order('accrual_date', { ascending: false }).range(a, b)),
    fetchAll<Inv>((a, b) => api.from('investments').select('id, code, plan_name, principal').range(a, b)),
    fetchAll<Person>((a, b) => api.from('profiles').select('id, code, full_name, email, role, can_introduce').range(a, b))
  ]);
  const invBy = new Map(invs.map(i => [i.id, i])), pplBy = new Map(people.map(p => [p.id, p]));
  const all_ids = new Set(bon.map(b => b.admin_id).filter(Boolean) as string[]);
  const rows: Row[] = bon.map(b => ({ ...b, admin: b.admin_id ? pplBy.get(b.admin_id) : undefined, investor: pplBy.get(b.investor_id), inv: invBy.get(b.investment_id) }));
  return { rows, admins: people.filter(p => p.role === 'super_admin' || (p.role === 'investor' && (p.can_introduce || all_ids.has(p.id)))) };
}

/** Bonus: part of the monthly rate goes to the investor this person is under. Super Admins only. */
export function Bonuses() {
  const q = useQuery(load, []);
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>('accrued');
  const [admin, setAdmin] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const [ref, setRef] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const t = today();

  const all = q.data?.rows || [];
  const mine = useMemo(() => all.filter(r => !admin || (admin === 'none' ? !r.admin_id : r.admin_id === admin)), [all, admin]);
  const rows = useMemo(() => mine.filter(r => tab === 'all' || r.status === tab), [mine, tab]);
  const count = (k: Tab) => (k === 'all' ? mine.length : mine.filter(r => r.status === k).length);
  const sum = (rs: Row[]) => Math.round(rs.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
  const chosen = rows.filter(r => sel.has(r.id) && r.status === 'accrued' && r.admin_id);

  const perAdmin = useMemo(() => {
    const m = new Map<string, { name: string; unpaid: number; paid: number; investors: Set<string> }>();
    all.filter(r => r.status !== 'cancelled').forEach(r => {
      const k = r.admin_id || 'none';
      const x = m.get(k) || { name: r.admin_id ? nameOf(r.admin) : 'Individual', unpaid: 0, paid: 0, investors: new Set<string>() };
      if (r.status === 'paid') x.paid += Number(r.amount); else x.unpaid += Number(r.amount);
      x.investors.add(r.investor_id); m.set(k, x);
    });
    return [...m.entries()].map(([id, x]) => ({ id, ...x })).sort((a, b) => b.unpaid + b.paid - a.unpaid - a.paid);
  }, [all]);

  const pay = async () => {
    if (!ref.trim()) { setErr('Enter the bank / UTR reference for this payment.'); return; }
    const n = await run(() => rpc<number>('admin_pay_bonuses', { p_ids: chosen.map(r => r.id), p_ref: ref.trim() }),
      ['Bonus marked paid', `${chosen.length} bonus${chosen.length === 1 ? '' : 'es'} · ${money(sum(chosen))}`]);
    if (n === undefined) return;
    setPaying(false); setSel(new Set()); refreshAll();
  };

  const exportCsv = () => downloadCsv(`ib-bonus-${tab}-${t}`,
    ['Bonus', 'Paid to', 'Investor ID', 'Investor', 'Investment', 'Plan', 'Principal', 'Period', 'Accrued on', 'Bonus rate', 'Amount', 'Status', 'Reference', 'Paid on'],
    rows.map(r => [r.code, r.admin_id ? nameOf(r.admin) : '', r.investor?.code, nameOf(r.investor), r.inv?.code, r.inv?.plan_name, r.inv ? Number(r.inv.principal).toFixed(2) : '', r.period_no, r.accrual_date,
      r.rate, Number(r.amount).toFixed(2), r.status, r.payment_ref, r.paid_on]));

  const cols: Col<Row>[] = [
    { h: 'Bonus', m: true, v: r => r.code },
    { h: 'Paid to', v: r => r.admin_id ? nameOf(r.admin) : '', r: r => r.admin_id ? <>{nameOf(r.admin)}<span className="sub">{r.admin?.code}</span></> : <span className="muted">—</span> },
    { h: 'Investor', v: r => nameOf(r.investor), r: r => r.investor?.code ? <><Link to={`/admin/investors/${r.investor.code}`}>{nameOf(r.investor)}</Link><span className="sub">{r.investor.code}</span></> : nameOf(r.investor) },
    { h: 'Investment', v: r => r.inv?.code, r: r => r.inv ? <><Link className="mono" to={`/admin/investments/${r.inv.code}`}>{r.inv.code}</Link><span className="sub">{money(r.inv.principal)} · {r.inv.plan_name}</span></> : '—' },
    { h: 'Period', v: r => r.period_no, r: r => '#' + r.period_no },
    { h: 'Accrued', v: r => r.accrual_date, r: r => date(r.accrual_date) },
    { h: 'Rate', v: r => Number(r.rate), r: r => rate(r.rate) },
    { h: 'Amount', n: true, v: r => Number(r.amount), r: r => money(r.amount) },
    { h: 'Reference', v: r => r.payment_ref || '', r: r => r.payment_ref ? <span className="mono">{r.payment_ref}{r.paid_on && <span className="sub">Paid {date(r.paid_on)}</span>}</span> : <span className="muted">—</span> },
    { h: 'Status', v: r => r.status, r: r => <StatusBadge s={r.status} /> }
  ];

  return (
    <>
      <PageHead crumbs={['Bonus']} title="Bonus"
        sub={<>Part of each investment’s monthly ROI goes to the investor the person is under. You type the bonus % when you record each investment. The total paid out is the same as the plan rate. Investors only ever see their own share.</>}
        actions={<IconBtn icon="download" onClick={exportCsv} disabled={!rows.length}>Export CSV</IconBtn>} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {!q.data && !q.error ? <Loading /> : q.data && (
        <>
          <div className="kpis k4">
            <Kpi label="Unpaid bonus" value={money(sum(mine.filter(r => r.status === 'accrued')))} sub={`${count('accrued')} month${count('accrued') === 1 ? '' : 's'}`} />
            <Kpi label="Paid bonus" cls="pos" value={money(sum(mine.filter(r => r.status === 'paid')))} sub={`${count('paid')} month${count('paid') === 1 ? '' : 's'}`} />
            <Kpi label="People earning" value={perAdmin.filter(a => a.id !== 'none').length} sub="with at least one bonus" />
            <Kpi label="Nobody set" value={money(perAdmin.find(a => a.id === 'none')?.unpaid || 0)} sub='Choose “Under” on the person’s page' subCls={perAdmin.some(a => a.id === 'none' && a.unpaid) ? 'warn' : ''} />
          </div>
          {perAdmin.length > 0 && (
            <div className="card">
              <div className="card-h"><h3>By investor</h3></div>
              <div className="tbl"><table><thead><tr><th>Paid to</th><th className="n">People</th><th className="n">Unpaid</th><th className="n">Paid</th><th className="n">Total</th></tr></thead>
                  <tbody>{perAdmin.map(a => (
                    <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => { setAdmin(a.id === admin ? '' : a.id); setSel(new Set()); }}>
                      <td>{a.id === 'none' ? <span className="muted">{a.name}</span> : <b>{a.name}</b>}{admin === a.id && <span className="sub">Filtered</span>}</td>
                      <td className="n">{a.investors.size}</td><td className="n">{money(a.unpaid)}</td><td className="n pos">{money(a.paid)}</td><td className="n">{money(a.unpaid + a.paid)}</td>
                    </tr>))}</tbody></table></div>
            </div>
          )}
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="card">
              <div className="tabs" style={{ padding: '0 12px' }} role="tablist">
                {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => { setTab(k); setSel(new Set()); }}>{l}<span className="c">{count(k)}</span></button>)}
              </div>
            </div>
            <DataTable key={tab + admin} rows={rows} cols={cols} rowKey={r => r.id} searchPh="Search bonus, admin, investor, investment"
              text={r => `${r.investor?.code || ''} ${r.admin?.code || ''}`} sort={5} dir={-1} per={20}
              select={tab === 'accrued' ? { selected: sel, onChange: setSel, can: r => r.status === 'accrued' && !!r.admin_id } : undefined}
              tools={<>
                <select className="input" style={{ width: 'auto' }} value={admin} onChange={e => { setAdmin(e.target.value); setSel(new Set()); }}>
                  <option value="">Everyone</option>
                  {q.data.admins.map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}
                  <option value="none">Nobody set</option>
                </select>
                {tab === 'accrued' && <span className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>{chosen.length ? `${chosen.length} selected · ${money(sum(chosen))}` : 'None selected'}</span>}
                {tab === 'accrued' && <button className="btn primary sm" disabled={!chosen.length} onClick={() => { setPaying(true); setRef(''); setErr(null); }}>Mark paid</button>}
              </>}
              emptyTitle={all.length ? 'No bonuses here' : 'No bonus yet'}
              empty={all.length ? 'Try another tab or person.' : 'A bonus is added every month an investment accrues its return.'} />
          </div>
        </>
      )}
      {paying && (
        <Modal title={`Mark ${chosen.length} bonus${chosen.length === 1 ? '' : 'es'} as paid?`} sub="Only confirm after the transfer has gone through." onClose={() => setPaying(false)}
          foot={<><button className="btn ghost" onClick={() => setPaying(false)}>Cancel</button><button className="btn primary" onClick={pay} disabled={busy}>{busy ? 'Saving…' : 'Mark paid'}</button></>}>
          <div className="form">
            <dl className="kv">
              <dt>Admins</dt><dd>{[...new Set(chosen.map(r => nameOf(r.admin)))].join(', ')}</dd>
              <dt>Total</dt><dd>{money(sum(chosen))}</dd>
            </dl>
            <Field label="Bank / UTR reference (required)" err={err}>
              <input className={'input mono' + (err ? ' bad' : '')} value={ref} onChange={e => { setRef(e.target.value); setErr(null); }} placeholder="e.g. NEFT UTR" />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
