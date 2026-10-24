/* What the browser sends to the server for one table query (see src/lib/api.ts and server/query.ts). */
export type FilterSpec =
  | { t: 'eq' | 'neq' | 'is' | 'gt' | 'gte' | 'lt' | 'lte' | 'ilike'; c: string; v: unknown }
  | { t: 'in'; c: string; v: unknown[] }
  | { t: 'or'; v: string };
export interface QuerySpec {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  cols: string[] | null;
  filters: FilterSpec[];
  orders: { col: string; asc: boolean }[];
  lim: number | null;
  rng: [number, number] | null;
  one: 'single' | 'maybe' | null;
  count: boolean;
  head: boolean;
  payload: unknown;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Res<T = any> = { data: T; error: { message: string } | null; count?: number | null };
