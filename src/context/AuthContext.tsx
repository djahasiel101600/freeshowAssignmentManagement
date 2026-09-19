/**
 * Authentication context.
 *
 * The receiver hands out an HttpOnly session cookie on login, so the browser
 * never stores a credential itself. This provider keeps the *current user* in
 * React state, exposes login/logout, and listens for the global
 * "session expired" event raised by the API client so a stale tab drops back to
 * the login screen instead of showing a wall of 401s.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AUTH_EXPIRED_EVENT, ApiError, api } from '../lib/api';
import type { AuthUser, BootstrapState } from '../types/auth';

interface AuthContextValue {
  user: AuthUser | null;
  isAdmin: boolean;
  loading: boolean;
  bootstrap: BootstrapState | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<{ user: AuthUser }>('/api/auth/me');
      setUser(result.user);
    } catch (error) {
      // 401 simply means "not signed in yet" — that is a normal state, not an error.
      if (!(error instanceof ApiError) || !error.isAuthError) {
        console.error('Could not resolve the current session:', error);
      }
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      try {
        const state = await api.get<BootstrapState>('/api/auth/bootstrap');
        if (!cancelled) setBootstrap(state);
      } catch (error) {
        console.error('Could not reach the receiver:', error);
      }
      await refresh();
      if (!cancelled) setLoading(false);
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.post<{ user: AuthUser }>('/api/auth/login', { username, password });
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAdmin: user?.role === 'admin',
      loading,
      bootstrap,
      login,
      logout,
      refresh,
    }),
    [user, loading, bootstrap, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}