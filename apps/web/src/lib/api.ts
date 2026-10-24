/**
 * API client. The website is static (GitHub Pages); all data and every permission check live on the
 * backend. The only thing stored in the browser is our own session token (never a Discord token).
 */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:8787';

const TOKEN_KEY = 'rlt.session';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: any) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  // Unsafe requests carry an idempotency key, so a retried click never acts twice.
  if (method !== 'GET' && opts.idempotent !== false) headers['Idempotency-Key'] = newKey();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError('Cannot reach the tournament server. It may be offline or restarting; try again in a minute.', 0, 'network');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    const e = data?.error;
    throw new ApiError(e?.message ?? `Request failed (${res.status}).`, res.status, e?.code ?? 'error', e?.details);
  }
  return data as T;
}

/** Download a CSV export with the session token (cannot use a plain link because of the header). */
export async function downloadCsv(path: string) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`Export failed (${res.status}).`, res.status, 'export_failed');
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const loginUrl = (returnTo: string) => `${API_URL}/auth/discord/login?returnTo=${encodeURIComponent(returnTo)}`;
