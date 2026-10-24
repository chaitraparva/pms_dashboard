/* eslint-disable @typescript-eslint/no-explicit-any */
// The app's data API. Pages call `api.from(...)`, `rpc(...)`, `api.auth` and `api.storage`.
// Everything is sent to the server (/api/db), which keeps the data in the Neon database and
// applies the access rules for the signed-in user.
import type { FilterSpec, QuerySpec, Res } from './wire';

export const configured = true;

export interface Session { user: { id: string; email: string }; access_token: string }
const ok = <T,>(data: T, count?: number | null): Res<T> => ({ data, error: null, count });
const err = (e: unknown): Res<any> => ({ data: null, error: { message: e instanceof Error ? e.message : String(e) } });

/* ---------- session ---------- */
const SKEY = 'pms-session';
function readSession(): Session | null {
  try { const s = JSON.parse(localStorage.getItem(SKEY) || 'null'); return s && s.user && s.access_token ? s : null; } catch { return null; }
}
let session: Session | null = readSession();
const authListeners = new Set<(ev: string, s: Session | null) => void>();
function setSession(s: Session | null, ev: string) {
  session = s;
  try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch { /* private mode */ }
  authListeners.forEach(f => f(ev, s));
}

/* ---------- the server ---------- */
/** One call to /api/db. Returns the result, or throws with the server's message. */
export async function call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.access_token } : {}) }, body: JSON.stringify({ op, ...args }) });
  } catch { throw new Error('Cannot reach the server. Check your internet connection.'); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(j?.error?.message || 'Server error (' + r.status + '). Please try again.');
  if (j.error) throw new Error(j.error.message);
  return j.data as T;
}

/* ---------- query builder (sent to the server as a description, run there) ---------- */
class Query implements PromiseLike<Res> {
  private spec: QuerySpec;
  constructor(table: string) { this.spec = { table, op: 'select', cols: null, filters: [], orders: [], lim: null, rng: null, one: null, count: false, head: false, payload: null }; }
  private f(x: FilterSpec) { this.spec.filters.push(x); return this; }
  select(cols = '*', opts: { count?: string; head?: boolean } = {}) {
    this.spec.cols = cols.trim() === '*' ? null : cols.split(',').map(c => c.trim()).filter(Boolean);
    this.spec.count = !!opts.count; this.spec.head = !!opts.head; return this;
  }
  insert(v: any) { this.spec.op = 'insert'; this.spec.payload = v; return this; }
  update(v: any) { this.spec.op = 'update'; this.spec.payload = v; return this; }
  delete() { this.spec.op = 'delete'; return this; }
  eq(c: string, v: any) { return this.f({ t: 'eq', c, v }); }
  neq(c: string, v: any) { return this.f({ t: 'neq', c, v }); }
  in(c: string, vs: any[]) { return this.f({ t: 'in', c, v: vs || [] }); }
  is(c: string, v: any) { return this.f({ t: 'is', c, v }); }
  gt(c: string, v: any) { return this.f({ t: 'gt', c, v }); }
  gte(c: string, v: any) { return this.f({ t: 'gte', c, v }); }
  lt(c: string, v: any) { return this.f({ t: 'lt', c, v }); }
  lte(c: string, v: any) { return this.f({ t: 'lte', c, v }); }
  ilike(c: string, p: string) { return this.f({ t: 'ilike', c, v: p }); }
  like(c: string, p: string) { return this.ilike(c, p); }
  /** PostgREST "or" filter, e.g. `full_name.ilike.%ana%,email.ilike.%ana%`. */
  or(expr: string) { return this.f({ t: 'or', v: expr }); }
  order(col: string, opts: { ascending?: boolean } = {}) { this.spec.orders.push({ col, asc: opts.ascending !== false }); return this; }
  limit(n: number) { this.spec.lim = n; return this; }
  range(a: number, b: number) { this.spec.rng = [a, b]; return this; }
  single() { this.spec.one = 'single'; return this; }
  maybeSingle() { this.spec.one = 'maybe'; return this; }
  private exec(): Promise<Res> { return call<Res>('query', { spec: this.spec }); }
  then<A = Res, B = never>(onOk?: ((v: Res) => A | PromiseLike<A>) | null, onErr?: ((e: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.exec().catch(e => err(e)).then(onOk, onErr);
  }
}

/* ---------- storage (files are kept in the database, at most 3 MB each) ---------- */
const urlCache = new Map<string, string>();
const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
function bucket(name: string) {
  return {
    async upload(path: string, file: Blob, _o?: unknown): Promise<Res> {
      try {
        if (file.size > 3 * 1024 * 1024) throw new Error('Files must be 3 MB or smaller.');
        const url = await toDataUrl(file);
        await call('file_put', { bucket: name, path, mime: file.type || 'application/octet-stream', b64: url.slice(url.indexOf(',') + 1) });
        // public images (logo, property photos) are kept as data links so they show without signing in
        if (name === 'branding') urlCache.set(name + '/' + path, url);
        return ok({ path });
      } catch (e) { return err(e); }
    },
    async remove(paths: string[]): Promise<Res> { try { await call('file_del', { bucket: name, paths }); return ok(null); } catch (e) { return err(e); } },
    async createSignedUrl(path: string, _s?: number): Promise<Res<{ signedUrl: string } | null>> {
      try {
        const f = await call<{ mime: string; b64: string }>('file_get', { bucket: name, path });
        const bin = atob(f.b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return ok({ signedUrl: URL.createObjectURL(new Blob([bytes], { type: f.mime })) });
      } catch (e) { return err(e); }
    },
    getPublicUrl(path: string) { return { data: { publicUrl: urlCache.get(name + '/' + path) || '' } }; }
  };
}

/* ---------- auth ---------- */
const auth = {
  async getSession() {
    if (session) {
      const s = await call<{ user: Session['user'] } | null>('session').catch(e => (/sign in|expired|401/i.test(String(e)) ? null : undefined));
      if (s === null) setSession(null, 'SIGNED_OUT');
    }
    return { data: { session }, error: null };
  },
  async getUser() { return { data: { user: session?.user ?? null }, error: null }; },
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    try {
      const r = await call<{ token?: string; user?: Session['user']; error?: string }>('login', { email, password });
      if (!r.token || !r.user) return { data: { session: null }, error: { message: 'Invalid login credentials' } };
      const s: Session = { user: r.user, access_token: r.token };
      setSession(s, 'SIGNED_IN'); return { data: { session: s }, error: null };
    } catch (e) { return { data: { session: null }, error: { message: (e as Error).message } }; }
  },
  async signOut() { setSession(null, 'SIGNED_OUT'); return { error: null }; },
  onAuthStateChange(cb: (ev: string, s: Session | null) => void) { authListeners.add(cb); return { data: { subscription: { unsubscribe: () => { authListeners.delete(cb); } } } }; },
  async updateUser({ password }: { password?: string }) {
    try { if (!session) throw new Error('Not signed in.'); if (password) await call('password', { password }); authListeners.forEach(f => f('USER_UPDATED', session)); return { data: {}, error: null }; }
    catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  },
  async resetPasswordForEmail(_e: string, _o?: unknown) { return { data: null, error: { message: 'Password resets are done by the Super Admin. Ask them to set a new password for you.' } }; },
  mfa: {
    async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; },
    async listFactors() { return { data: { totp: [] as { id: string; status: string; friendly_name?: string }[] }, error: null }; },
    async enroll(_o?: unknown): Promise<any> { return { data: null, error: { message: 'Two-factor sign-in is not available in this version.' } }; },
    async challengeAndVerify(_o?: unknown) { return { data: null, error: { message: 'Two-factor sign-in is not available in this version.' } }; },
    async unenroll(_o?: unknown) { return { data: null, error: null }; }
  }
};

/* ---------- "realtime": pages refresh after their own actions and the notification bell checks every minute ---------- */
function channel(_name: string) {
  const ch = { on(_t: string, _f: unknown, _h: () => void) { return ch; }, subscribe() { return ch; }, unsubscribe() { /* nothing to stop */ } };
  return ch;
}

export const api = {
  from: (table: string) => new Query(table),
  async rpc(fn: string, args: Record<string, unknown> = {}): Promise<Res> {
    try { return ok(await call('rpc', { fn, args })); } catch (e) { return err(e); }
  },
  auth,
  storage: { from: bucket },
  channel,
  removeChannel(ch: { unsubscribe: () => void }) { ch.unsubscribe(); }
};

/** Call a database function and throw a readable error if it fails. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await api.rpc(fn, args);
  if (error) throw new Error(friendly(error.message));
  return data as T;
}

export function friendly(msg: string): string {
  if (/not signed in/i.test(msg)) return 'Your session has expired. Please sign in again.';
  return msg.replace(/^ERROR:\s*/, '');
}

/** Throw on a query error; return the data otherwise. */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(friendly(res.error.message));
  return (res.data ?? ([] as unknown)) as T;
}

/** Fetch every row of a query in pages of 1000 (kept for compatibility with the existing pages). */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, cap = 50000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(friendly(error.message));
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
