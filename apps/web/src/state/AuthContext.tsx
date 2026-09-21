import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission, PublicUser, Role } from '@teamspace/shared';
import { api, getAccessToken, onSessionExpired, setAccessToken } from '../api/client';

interface AuthState {
  user: PublicUser | null;
  permissions: Permission[];
  status: 'loading' | 'authenticated' | 'anonymous';
}

interface AuthContextValue extends AuthState {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Role-and-permission check used to gate navigation and controls. */
  can: (permission: Permission) => boolean;
  hasRole: (...roles: Role[]) => boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
  permissions: Permission[];
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({ user: null, permissions: [], status: 'loading' });

  /**
   * On a cold load there is no access token in memory, but the browser may
   * still hold a valid refresh cookie — so try to resume before deciding the
   * visitor is anonymous.
   */
  useEffect(() => {
    let cancelled = false;

    const resume = async (): Promise<void> => {
      try {
        const session = await api.post<SessionResponse>('/auth/refresh');
        if (cancelled) return;
        setAccessToken(session.accessToken);
        setState({ user: session.user, permissions: session.permissions, status: 'authenticated' });
      } catch {
        if (!cancelled) setState({ user: null, permissions: [], status: 'anonymous' });
      }
    };

    void resume();
    return () => {
      cancelled = true;
    };
  }, []);

  // A refresh failure anywhere in the app drops the session here too.
  useEffect(() => {
    onSessionExpired(() => setState({ user: null, permissions: [], status: 'anonymous' }));
  }, []);

  /**
   * Silent re-auth ahead of expiry, so a user reading a long page is not
   * interrupted. The API's access token TTL is 15 minutes; refreshing every
   * 12 leaves headroom for clock skew.
   */
  useEffect(() => {
    if (state.status !== 'authenticated') return undefined;
    const timer = setInterval(
      () => {
        void api.post<SessionResponse>('/auth/refresh').then(
          (session) => setAccessToken(session.accessToken),
          () => undefined,
        );
      },
      12 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [state.status]);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await api.post<SessionResponse>('/auth/login', { email, password });
    setAccessToken(session.accessToken);
    setState({ user: session.user, permissions: session.permissions, status: 'authenticated' });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAccessToken(null);
      setState({ user: null, permissions: [], status: 'anonymous' });
    }
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getAccessToken()) return;
    const session = await api.get<{ user: PublicUser; permissions: Permission[] }>('/auth/me');
    setState((previous) => ({ ...previous, user: session.user, permissions: session.permissions }));
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const permissionSet = new Set(state.permissions);
    return {
      ...state,
      signIn,
      signOut,
      refreshUser,
      can: (permission) => permissionSet.has(permission),
      hasRole: (...roles) => (state.user ? roles.includes(state.user.role) : false),
    };
  }, [state, signIn, signOut, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
