import { api, friendly } from './api';
import type { DocumentRow } from './types';

const safe = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(-120);

/** Admin: upload a file into the investor's private folder and register it. */
export async function uploadDocument(opts: { ownerId: string; investmentId?: string | null; kind: DocumentRow['kind']; title: string; file: File; visible: boolean }): Promise<DocumentRow> {
  if (opts.file.size > 3 * 1024 * 1024) throw new Error('Files must be 3 MB or smaller.');
  const path = `${opts.ownerId}/${crypto.randomUUID()}-${safe(opts.file.name)}`;
  const up = await api.storage.from('documents').upload(path, opts.file, { contentType: opts.file.type || 'application/octet-stream', upsert: false });
  if (up.error) throw new Error(friendly(up.error.message));
  const { data, error } = await api.from('documents').insert({
    owner_id: opts.ownerId, investment_id: opts.investmentId || null, kind: opts.kind, title: opts.title || opts.file.name,
    storage_path: path, mime: opts.file.type, size_bytes: opts.file.size, visible_to_investor: opts.visible,
    uploaded_by: (await api.auth.getUser()).data.user?.id
  }).select('*').single();
  if (error) { await api.storage.from('documents').remove([path]); throw new Error(friendly(error.message)); }
  return data as DocumentRow;
}

/** Opens a short-lived signed link (60 seconds) to a private document. */
export async function openDocument(path: string): Promise<void> {
  const w = window.open('', '_blank');
  const { data, error } = await api.storage.from('documents').createSignedUrl(path, 60);
  if (error || !data) { w?.close(); throw new Error(friendly(error?.message || 'Document not available.')); }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}

export async function deleteDocument(d: DocumentRow): Promise<void> {
  const { error } = await api.from('documents').delete().eq('id', d.id);
  if (error) throw new Error(friendly(error.message));
  await api.storage.from('documents').remove([d.storage_path]);
}

/** Admin: upload the company logo to the public branding bucket; returns its public URL. */
export async function uploadLogo(file: File): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error('Choose an image file (PNG, SVG or JPG).');
  if (file.size > 2 * 1024 * 1024) throw new Error('Logo must be 2 MB or smaller.');
  const path = `logo-${Date.now()}-${safe(file.name)}`;
  const { error } = await api.storage.from('branding').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(friendly(error.message));
  return api.storage.from('branding').getPublicUrl(path).data.publicUrl;
}

/* ---------- brochures (private bucket "brochures") ---------- */
export const BROCHURE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/** Admin: upload a brochure file; returns the storage details to save with the brochure. */
export async function uploadBrochureFile(file: File): Promise<{ storage_path: string; file_name: string; mime: string; size_bytes: number }> {
  if (!BROCHURE_TYPES.includes(file.type)) throw new Error('Choose a PDF, PNG, JPG or WebP file.');
  if (file.size > 3 * 1024 * 1024) throw new Error('Brochures must be 3 MB or smaller.');
  const path = `${new Date().getFullYear()}/${crypto.randomUUID()}-${safe(file.name)}`;
  const { error } = await api.storage.from('brochures').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(friendly(error.message));
  return { storage_path: path, file_name: file.name, mime: file.type, size_bytes: file.size };
}

/** A short-lived signed link to a brochure (only works for brochures the signed-in user may see). */
export async function brochureUrl(path: string, seconds = 600): Promise<string> {
  const { data, error } = await api.storage.from('brochures').createSignedUrl(path, seconds);
  if (error || !data) throw new Error(friendly(error?.message || 'Brochure not available.'));
  return data.signedUrl;
}

export async function openBrochure(path: string): Promise<void> {
  const w = window.open('', '_blank');
  try {
    const url = await brochureUrl(path, 120);
    if (w) w.location.href = url; else window.location.href = url;
  } catch (e) { w?.close(); throw e; }
}

/** Admin: upload a property photo to the public branding bucket (marketing images only); returns its public URL. */
export async function uploadPropertyImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > 3 * 1024 * 1024) throw new Error('Images must be 3 MB or smaller.');
  const path = `properties/${Date.now()}-${safe(file.name)}`;
  const { error } = await api.storage.from('branding').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(friendly(error.message));
  return api.storage.from('branding').getPublicUrl(path).data.publicUrl;
}
