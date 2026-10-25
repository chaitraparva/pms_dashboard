/* eslint-disable @typescript-eslint/no-explicit-any */
// The one API endpoint (/api/db). Every request:
//   1. loads the company's data from Neon (kept warm in memory while nothing has changed),
//   2. runs one query or action with the signed-in user's rights (rules in src/lib/localdb.ts),
//   3. saves the tables that changed, in one transaction. If someone else saved in between, it reloads and runs again.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from '../src/lib/localdb.js';
import { runQuery } from './query.js';
import { getPool, type PoolLike } from './pool.js';
import { appUrl, sendMail } from './mail.js';

type Row = Record<string, any>;
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/* ---------- environment ---------- */
const env = (k: string) => (process.env[k] || '').trim();
function secret(): string {
  const s = env('PMS_SECRET');
  if (s.length < 32) throw new HttpError(500, 'Server setting PMS_SECRET is missing or shorter than 32 characters. Add it in Vercel → Settings → Environment Variables.');
  return s;
}

/* ---------- database ---------- */
let schemaReady = false;
async function ensureSchema(pool: PoolLike) {
  if (schemaReady) return;
  // several first requests can arrive at once: a lock makes them create the tables one after another
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(724001)');
    await c.query(`create table if not exists pms_meta (id int primary key, version bigint not null, data jsonb not null, updated_at timestamptz not null default now())`);
    await c.query(`create table if not exists pms_tables (name text primary key, data jsonb not null, updated_at timestamptz not null default now())`);
    await c.query(`create table if not exists pms_files (key text primary key, mime text not null, data bytea not null, size int not null, created_at timestamptz not null default now())`);
    await c.query('commit');
  } catch (e) { await c.query('rollback').catch(() => undefined); throw e; } finally { c.release(); }
  schemaReady = true;
}
interface Snapshot { version: number; meta: string; tables: Record<string, string> }
let cache: Snapshot | null = null;

async function loadSnapshot(pool: PoolLike): Promise<Snapshot> {
  const m = await pool.query('select version from pms_meta where id = 1');
  if (!m.rows.length) return firstRun(pool);
  const version = Number(m.rows[0].version);
  if (cache && cache.version === version) return cache;
  const meta = await pool.query('select version, data from pms_meta where id = 1');
  const t = await pool.query('select name, data from pms_tables');
  const tables: Record<string, string> = {};
  t.rows.forEach((r: Row) => { tables[r.name] = JSON.stringify(r.data); });
  cache = { version: Number(meta.rows[0].version), meta: JSON.stringify(meta.rows[0].data), tables };
  return cache;
}
/** The very first request creates the company with one Super Admin (from the server settings). No sample data. */
async function firstRun(pool: PoolLike): Promise<Snapshot> {
  const email = env('PMS_ADMIN_EMAIL'), password = env('PMS_ADMIN_PASSWORD');
  if (!email || !password) throw new HttpError(500, 'First start: add PMS_ADMIN_EMAIL and PMS_ADMIN_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.');
  const S = await db.freshStore({ email, password, name: env('PMS_ADMIN_NAME') || 'Super Admin' });
  const meta = JSON.stringify({ v: S.v, seq: S.seq, users: S.users });
  const c = await pool.connect();
  try {
    await c.query('begin');
    const ins = await c.query('insert into pms_meta (id, version, data) values (1, 1, $1) on conflict (id) do nothing returning id', [meta]);
    if (ins.rows.length) for (const [name, rows] of Object.entries(S.tables)) await c.query('insert into pms_tables (name, data) values ($1, $2) on conflict (name) do update set data = excluded.data, updated_at = now()', [name, JSON.stringify(rows)]);
    await c.query('commit');
  } catch (e) { await c.query('rollback').catch(() => undefined); throw e; } finally { c.release(); }
  cache = null;
  return loadSnapshot(pool);
}
function open(s: Snapshot): db.Store {
  const meta = JSON.parse(s.meta);
  const tables: Record<string, Row[]> = {};
  db.TABLES.forEach(t => { tables[t] = s.tables[t] ? JSON.parse(s.tables[t]) : []; });
  return { v: meta.v, seq: meta.seq || {}, users: meta.users || [], tables };
}
/** Saves what changed. Returns false when someone else saved first (the request is then run again on fresh data). */
async function commit(pool: PoolLike, base: Snapshot, S: db.Store): Promise<boolean> {
  const meta = JSON.stringify({ v: S.v, seq: S.seq, users: S.users });
  const tables: Record<string, string> = {};
  const changed: string[] = [];
  db.TABLES.forEach(t => { tables[t] = JSON.stringify(S.tables[t] || []); if (tables[t] !== (base.tables[t] ?? '[]')) changed.push(t); });
  if (!changed.length && meta === base.meta) return true;
  const c = await pool.connect();
  try {
    await c.query('begin');
    const v = await c.query('select version from pms_meta where id = 1 for update');
    if (Number(v.rows[0]?.version) !== base.version) { await c.query('rollback'); return false; }
    for (const t of changed) await c.query('insert into pms_tables (name, data) values ($1, $2) on conflict (name) do update set data = excluded.data, updated_at = now()', [t, tables[t]]);
    await c.query('update pms_meta set version = version + 1, data = $1, updated_at = now() where id = 1', [meta]);
    await c.query('commit');
    cache = { version: base.version + 1, meta, tables: { ...base.tables, ...Object.fromEntries(changed.map(t => [t, tables[t]])) } };
    return true;
  } catch (e) { await c.query('rollback').catch(() => undefined); throw e; } finally { c.release(); }
}

/* ---------- sign-in tokens (signed with PMS_SECRET, valid 30 days) ---------- */
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function sign(uid: string): string {
  const body = b64u(JSON.stringify({ u: uid, t: Date.now() }));
  return body + '.' + b64u(createHmac('sha256', secret()).update(body).digest());
}
function readToken(h: string | undefined): string | null {
  const tok = (h || '').replace(/^Bearer\s+/i, '');
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', secret()).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return Date.now() - p.t < 30 * 864e5 ? String(p.u) : null; } catch { return null; }
}

/* ---------- files (brochures, documents, logo) ---------- */
const MAX_FILE = 3 * 1024 * 1024;
function mayReadFile(bucket: string, path: string): boolean {
  if (db.isAdmin()) return true;
  const u = db.uid(); if (!u) return false;
  if (bucket === 'branding') return true;
  if (bucket === 'documents') return db.T('documents').some(d => d.storage_path === path && d.owner_id === u && d.visible_to_investor)
    || path.startsWith(u + '/') || db.attachmentVisible(path); // own uploads, and files attached to requests the user may see
  if (bucket === 'brochures') return db.T('brochures').some(b => b.storage_path === path && db.brochureVisible(b.id, u));
  return false;
}

/* ---------- one action ---------- */
const FNS: Record<string, (a: any) => Promise<unknown>> = {
  createAccount: a => db.createAccount(a),
  adminResetPassword: a => db.adminResetPassword(String(a.userId), String(a.password)),
  createIB: a => db.createIB(a),
  adminSetLogin: a => db.adminSetLogin(String(a.userId), String(a.password)),
  adminRecordInvestment: a => db.adminRecordInvestments(a),
  adminApproveInvestmentRequest: a => db.adminApproveInvestmentRequest(a)
};
async function act(pool: PoolLike, body: Row, uid: string | null): Promise<{ out: unknown; uid: string | null; after?: () => Promise<unknown> }> {
  switch (body.op) {
    case 'session': {
      const p = uid ? db.T('profiles').find(x => x.id === uid) : null;
      return { out: p ? { user: { id: p.id, email: db.userEmail(p.id) } } : null, uid };
    }
    case 'login': {
      const id = await db.checkLogin(String(body.email || ''), String(body.password || ''));
      if (!id) return { out: { error: 'Invalid login credentials' }, uid };
      return { out: { token: sign(id), user: { id, email: db.userEmail(id) } }, uid: id };
    }
    case 'password': {
      // signed in (Profile & Security): the current password must be given
      if (!uid) throw new HttpError(401, 'Not signed in.');
      await db.changePassword(uid, String(body.current || ''), String(body.password || '')); return { out: true, uid };
    }
    case 'forgot_password': {
      // always the same answer, so nobody can find out which phone numbers or emails have an account
      const mail = db.forgotPassword(String(body.email || ''), String(body.message || ''), appUrl());
      return { out: { ok: true }, uid, after: mail ? () => sendMail(mail) : undefined };
    }
    case 'change_password': {
      // from the sign-in page: phone number (or email) + current password + new password
      const id = await db.checkLogin(String(body.email || ''), String(body.current || ''));
      if (!id) throw new Error('Phone number / email or current password is incorrect.');
      db.setCurrentUser(id);
      await db.changePassword(id, String(body.current || ''), String(body.password || ''));
      return { out: true, uid };
    }
    case 'query': return { out: runQuery(body.spec), uid };
    case 'rpc': return { out: db.rpcCall(String(body.fn), body.args || {}), uid };
    case 'fn': {
      const f = FNS[String(body.name)]; if (!f) throw new HttpError(400, 'Unknown action.');
      return { out: await f(body.args || {}), uid };
    }
    case 'file_put': {
      // the Super Admin uploads anywhere; a signed-in investor only adds proof files to their own folder (never replaces one)
      const admin = db.isAdmin();
      const path = String(body.path || ''), mime = String(body.mime || 'application/octet-stream');
      if (!admin) {
        if (!uid || !db.me() || db.me()!.account_status !== 'active') throw new HttpError(403, 'Sign in to upload files.');
        if (body.bucket !== 'documents' || !path.startsWith(uid + '/') || path.includes('..')) throw new HttpError(403, 'You can only upload proof files to your own requests.');
        if (!db.ATTACH_MIME.includes(mime)) throw new HttpError(415, 'Attach an image, PDF, Word or Excel file.');
      }
      const buf = Buffer.from(String(body.b64 || ''), 'base64');
      if (!buf.length) throw new HttpError(400, 'The file is empty.');
      if (buf.length > MAX_FILE) throw new HttpError(413, 'Files must be 3 MB or smaller.');
      const r = await pool.query('insert into pms_files (key, mime, data, size) values ($1, $2, $3, $4) on conflict (key) do ' + (admin ? 'update set mime = excluded.mime, data = excluded.data, size = excluded.size' : 'nothing') + ' returning key',
        [body.bucket + '/' + path, mime, buf, buf.length]);
      if (!admin && !r.rows.length) throw new HttpError(409, 'A file with this name already exists. Upload it again.');
      return { out: { path }, uid };
    }
    case 'file_get': {
      if (!mayReadFile(String(body.bucket), String(body.path))) throw new HttpError(403, 'This file is not available to you.');
      const r = await pool.query('select mime, data from pms_files where key = $1', [body.bucket + '/' + body.path]);
      if (!r.rows.length) throw new HttpError(404, 'File not found.');
      return { out: { mime: r.rows[0].mime, b64: Buffer.from(r.rows[0].data).toString('base64') }, uid };
    }
    case 'file_del': {
      if (!db.isAdmin()) throw new HttpError(403, 'Only the Super Admin can delete files.');
      await pool.query('delete from pms_files where key = any($1)', [(body.paths || []).map((p: string) => body.bucket + '/' + p)]);
      return { out: true, uid };
    }
    default: throw new HttpError(400, 'Unknown request.');
  }
}

/** The data engine works on one store at a time, so requests that reach the same server instance take turns. */
let queue: Promise<void> = Promise.resolve();
function turn(): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>(r => { release = r; });
  const before = queue; queue = before.then(() => mine);
  return before.then(() => release);
}

/** Runs one request against the latest data; retried when another request saved in between. */
export async function handle(body: Row, auth: string | undefined): Promise<unknown> {
  const done = await turn();
  try { return await handleOne(body, auth); } finally { done(); }
}
async function handleOne(body: Row, auth: string | undefined): Promise<unknown> {
  const pool = await getPool();
  try { await ensureSchema(pool); }
  catch (e) {
    console.error(e);
    // the database's own reason helps fix the setting; connection strings and passwords are never shown
    const why = String((e as Error)?.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string]').replace(/password=\S+/gi, 'password=[hidden]').slice(0, 200);
    throw new HttpError(503, 'Cannot connect to the database. Check DATABASE_URL in Vercel and that your Neon database is running. (' + why + ')');
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = await loadSnapshot(pool);
    const S = open(base);
    db.attach(S);
    let uid = readToken(auth);
    if (uid && !S.users.some(u => u.id === uid)) uid = null;
    db.setCurrentUser(uid);
    db.catchUp();
    let res: { out: unknown; uid: string | null; after?: () => Promise<unknown> };
    try { res = await act(pool, body, uid); }
    catch (e) {
      if (e instanceof HttpError) throw e;
      // a rule said no (e.g. "Enter the amount"): nothing is saved, the message goes back to the screen
      return { error: { message: e instanceof Error ? e.message : String(e) } };
    } finally { db.setCurrentUser(null); }
    if (await commit(pool, base, db.current())) {
      // emails go out only once the change is saved (never twice when a request is run again)
      if (res.after) await res.after().catch(e => console.error(e));
      return { data: res.out };
    }
  }
  throw new HttpError(503, 'The system is busy. Please try again.');
}

/* ---------- Node / Vercel entry ---------- */
async function readBody(req: IncomingMessage & { body?: any }): Promise<Row> {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export default async function handler(req: IncomingMessage & { body?: any }, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: { message: 'Use POST.' } })); return; }
  try {
    const body = await readBody(req);
    const out = await handle(body, req.headers.authorization);
    res.statusCode = 200; res.end(JSON.stringify(out));
  } catch (e) {
    const known = e instanceof HttpError || typeof (e as { status?: unknown })?.status === 'number';
    if (!known) console.error(e);
    res.statusCode = known ? (e as { status: number }).status : 500;
    res.end(JSON.stringify({ error: { message: known ? (e as Error).message : 'Server error. Please try again.' } }));
  }
}
