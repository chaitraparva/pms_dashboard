import { useState } from 'react';
import { ATTACH_ACCEPT, attachmentProblem, openAttachment } from '../lib/docs';
import type { Attachment } from '../lib/types';
import { Field, useToast } from './kit';
import { Icon } from './Icon';

const fmtBytes = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

/** Choose proof files (images or documents, 3 MB each). Files are uploaded when the form is sent. */
export function FilePicker({ label, files, onChange, max = 5, err, hint }: { label: string; files: File[]; onChange: (f: File[]) => void; max?: number; err?: string | null; hint?: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const add = (list: FileList | null) => {
    const picked = Array.from(list || []);
    const badOne = picked.map(attachmentProblem).find(Boolean) || null;
    setProblem(badOne);
    const okFiles = picked.filter(f => !attachmentProblem(f));
    onChange([...files, ...okFiles].slice(0, max));
    setKey(k => k + 1); // lets the same file be chosen again after removing it
  };
  return (
    <Field label={label} err={err || problem} hint={hint || `Images, PDF, Word or Excel · up to ${max} file${max === 1 ? '' : 's'}, 3 MB each.`}>
      <div style={{ display: 'grid', gap: 6 }}>
        {files.map((f, i) => (
          <div key={f.name + i} className="attach-row">
            <Icon name="doc" /><span className="grow">{f.name}<span className="sub">{fmtBytes(f.size)}</span></span>
            <button type="button" className="btn sm ghost" onClick={() => onChange(files.filter((_, k) => k !== i))} aria-label={'Remove ' + f.name}>Remove</button>
          </div>
        ))}
        {files.length < max && (
          <input key={key} className={'input ' + (err ? 'bad' : '')} type="file" accept={ATTACH_ACCEPT} multiple={max > 1} onChange={e => add(e.target.files)} />
        )}
      </div>
    </Field>
  );
}

/** Opens attached proof files (only for people allowed to see the request). */
export function AttachmentLinks({ items, empty = '—' }: { items?: Attachment[] | null; empty?: string }) {
  const toast = useToast();
  if (!items || !items.length) return <span className="muted">{empty}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(a => (
        <button key={a.path} type="button" className="btn sm" title={a.name}
          onClick={e => { e.stopPropagation(); openAttachment(a).catch(x => toast('Could not open the file', x instanceof Error ? x.message : String(x), 'err')); }}>
          <Icon name="doc" />{a.name.length > 22 ? a.name.slice(0, 20) + '…' : a.name}
        </button>
      ))}
    </span>
  );
}
