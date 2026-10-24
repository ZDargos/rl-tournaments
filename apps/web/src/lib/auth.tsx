import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';

export interface Me {
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
  preferences: { dmsEnabled: boolean; profilePublic: boolean; dmBlockedUntil: string | null };
  mutes: number[];
  invitations: any[];
}

export interface Meta {
  oauthConfigured: boolean;
  devLogin: boolean;
  discordEnabled: boolean;
  botInviteUrl: string | null;
  ranks: { id: string; label: string }[];
}

interface AuthState {
  me: Me | null;
  meta: Meta | null;
  loading: boolean;
  serverDown: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setSession: (token: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [serverDown, setServerDown] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMeta(await api<Meta>('/api/meta'));
      setServerDown(false);
    } catch {
      setServerDown(true);
    }
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>('/api/me'));
    } catch (e: any) {
      if (e?.status === 401) {
        setToken(null);
        setMe(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setMe(null);
    });
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* ignore */
    }
    setToken(null);
    setMe(null);
  }, []);

  const setSession = useCallback(
    async (token: string) => {
      setToken(token);
      await refresh();
    },
    [refresh],
  );

  return <Ctx.Provider value={{ me, meta, loading, serverDown, refresh, logout, setSession }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
