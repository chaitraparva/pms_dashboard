import { useCallback, useEffect, useRef, useState } from 'react';

const listeners = new Set<() => void>();
/** Ask every mounted query to reload (call after any successful change). */
export function refreshAll() { listeners.forEach(f => f()); }

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fn().then(d => { if (n === seq.current) { setData(d); setError(null); } })
      .catch(e => { if (n === seq.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, deps);
  useEffect(() => { run(); }, [run]);
  useEffect(() => { listeners.add(run); return () => { listeners.delete(run); }; }, [run]);
  return { data, error, loading, reload: run };
}

/** Subscribe a plain function to refreshAll(); returns an unsubscribe function. */
export function onRefresh(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
