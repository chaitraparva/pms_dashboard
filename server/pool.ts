// The database connection. On Vercel this is your Neon database (DATABASE_URL, set by the Neon integration).
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';

export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
let pool: PoolLike | null = null;
/** Neon on Vercel. For a local PostgreSQL server (testing on your computer), set PMS_PG_DRIVER=pg in .env. */
export async function getPool(): Promise<PoolLike> {
  if (pool) return pool;
  const url = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!url) throw Object.assign(new Error('DATABASE_URL is not set. Connect your Neon database to this Vercel project.'), { status: 500 });
  if (process.env.PMS_PG_DRIVER === 'pg') {
    const pg = await import('pg');
    pool = new pg.default.Pool({ connectionString: url, max: 3 }) as unknown as PoolLike;
    return pool;
  }
  if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket;
  pool = new NeonPool({ connectionString: url, max: 3 }) as unknown as PoolLike;
  return pool;
}
