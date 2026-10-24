import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Load data and keep it fresh. `versionPath` is polled cheaply; the full payload reloads only on change. */
export function useLive<T>(path: string | null, versionPath?: string | null, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const version = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    version.current = null;
    void load();
  }, [load]);

  useEffect(() => {
    if (!path || !versionPath) return;
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const v = await api<{ version: number }>(versionPath);
        const key = JSON.stringify(v);
        if (version.current && version.current !== key && !stopped) await load();
        version.current = key;
      } catch {
        /* keep last data; errors surface on the next full load */
      }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [path, versionPath, intervalMs, load]);

  return { data, error, loading, reload: load, setData };
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
