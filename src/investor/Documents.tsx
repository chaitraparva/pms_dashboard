import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, must } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { openDocument } from '../lib/docs';
import { date } from '../lib/format';
import { Empty, ErrorNote, Loading, PageHead, useAction } from '../ui/kit';
import { Icon } from '../ui/Icon';
import type { DocumentRow } from '../lib/types';
import { codeMap, loadInvestments } from './data';

const KIND: Record<string, string> = { agreement: 'Agreement', statement: 'Statement', kyc: 'KYC', proof: 'Proof', attachment: 'Attachment', other: 'Other' };
const TABS: [string, string, (d: DocumentRow) => boolean][] = [
  ['all', 'All', () => true],
  ['statements', 'Statements', d => d.kind === 'statement'],
  ['agreements', 'Investment agreements', d => d.kind === 'agreement'],
  ['other', 'Other documents', d => !['statement', 'agreement'].includes(d.kind)]
];

const size = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b ? b + ' B' : '');
const ext = (d: DocumentRow) => (d.mime.split('/')[1] || d.storage_path.split('.').pop() || '').toUpperCase().replace('VND.OPENXMLFORMATS-OFFICEDOCUMENT.', '').slice(0, 8);

export function Documents() {
  const { profile } = useAuth();
  const { run } = useAction();
  const [tab, setTab] = useState('all');
  const q = useQuery(async () => {
    const [inv, docs] = await Promise.all([
      loadInvestments(profile!.id),
      api.from('documents').select('*').eq('owner_id', profile!.id).eq('visible_to_investor', true).order('created_at', { ascending: false })
    ]);
    return { codes: codeMap(inv), docs: must(docs) as DocumentRow[] };
  }, [profile?.id]);
  const docs = q.data?.docs || [];
  const filt = TABS.find(t => t[0] === tab)![2];
  const shown = docs.filter(filt);

  return (
    <>
      <PageHead crumbs={['Statements & Documents']} title="Statements & documents" sub="Downloads use secure, time-limited links. Only documents shared with you appear here." />
      <div className="card setup-card">
        <div className="card-b" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <Icon name="report" />
          <div style={{ flex: 1, minWidth: 220 }}><b>Account statement</b><div className="hint">A printable statement of your investments, returns and transactions for any period, generated live from your account.</div></div>
          <Link className="btn primary" to="/portal/statement"><Icon name="print" />View statement</Link>
        </div>
      </div>
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {q.loading && !q.data ? <Loading /> : q.data && (
        <div className="card">
          <div className="tabs" style={{ padding: '0 12px' }} role="tablist">
            {TABS.map(([k, l, f]) => <button key={k} role="tab" aria-selected={k === tab} className={'tab ' + (k === tab ? 'on' : '')} onClick={() => setTab(k)}>{l}<span className="c">{docs.filter(f).length}</span></button>)}
          </div>
          <div className="card-b list">
            {shown.map(d => (
              <div key={d.id}>
                <Icon name="doc" />
                <div className="grow">
                  <b>{d.title}</b>
                  <span>{KIND[d.kind] || d.kind} · {d.investment_id ? q.data!.codes[d.investment_id] || 'Investment' : 'Account'} · {date(d.created_at)}{ext(d) ? ' · ' + ext(d) : ''}{size(d.size_bytes) ? ' · ' + size(d.size_bytes) : ''}</span>
                </div>
                <button className="btn sm" onClick={() => run(() => openDocument(d.storage_path))}><Icon name="download" />Open</button>
              </div>
            ))}
            {!shown.length && <Empty title={docs.length ? 'No documents in this category' : 'No documents yet'}>{docs.length ? 'Choose another tab to see your other documents.' : 'Your agreements and statements will appear here once the company shares them with you.'}</Empty>}
          </div>
        </div>
      )}
    </>
  );
}
