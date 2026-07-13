import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import api, { tokenStore, setAuthFailureHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef(null);

  const clearTimer = () => {
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  };

  const logout = useCallback(async ({ silent } = {}) => {
    clearTimer();
    if (!silent) {
      try { await api.post('/auth/logout'); } catch { /* ignore */ }
    }
    tokenStore.clear();
    setUser(null);
  }, []);

  /**
   * Proactively rotates the access token slightly before its 40-minute
   * expiry so the session never lapses while the user is active.
   */
  const scheduleRefresh = useCallback((expiresInSeconds) => {
    clearTimer();
    const lead = 60; // refresh 60s before expiry
    const delay = Math.max((expiresInSeconds - lead) * 1000, 5000);
    refreshTimer.current = setTimeout(async () => {
      try {
        const { data } = await api.post('/auth/refresh', { refreshToken: tokenStore.refresh });
        tokenStore.set(data);
        setUser(data.user);
        scheduleRefresh(data.expiresIn);
      } catch {
        logout({ silent: true });
      }
    }, delay);
  }, [logout]);

  const applySession = useCallback((data) => {
    tokenStore.set(data);
    setUser(data.user);
    scheduleRefresh(data.expiresIn);
  }, [scheduleRefresh]);

  const login = useCallback(async (identifier, password) => {
    const { data } = await api.post('/auth/login', { identifier, password });
    applySession(data);
    return data.user;
  }, [applySession]);

  // Restore an existing session on first load.
  useEffect(() => {
    setAuthFailureHandler(() => {
      tokenStore.clear();
      setUser(null);
    });

    (async () => {
      if (!tokenStore.refresh) {
        setLoading(false);
        return;
      }
      try {
        const { data } = await api.post('/auth/refresh', { refreshToken: tokenStore.refresh });
        applySession(data);
      } catch {
        tokenStore.clear();
      } finally {
        setLoading(false);
      }
    })();

    return clearTimer;
  }, [applySession]);

  const value = {
    user,
    loading,
    login,
    logout,
    setUser,
    isSuperAdmin: user?.role === 'super_admin',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
