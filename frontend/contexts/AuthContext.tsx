import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiLogin, apiRegister, type DbUser } from '@/lib/api';

export type AuthUser = DbUser & {
  displayName?: string;
};

const AUTH_STORAGE_KEY = '@findphotos_auth_user';

type AuthContextValue = {
  user: AuthUser | null;
  initializing: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  guestLogin: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Restore stored session on mount
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          setUser({ ...parsed, displayName: parsed.name });
        }
      } catch {
        // ignore
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      initializing,
      login: async (email, password) => {
        const dbUser = await apiLogin(email.trim(), password);
        const authUser: AuthUser = { ...dbUser, displayName: dbUser.name };
        setUser(authUser);
        await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authUser));
      },
      register: async (name, email, password) => {
        const dbUser = await apiRegister(name.trim(), email.trim(), password);
        const authUser: AuthUser = { ...dbUser, displayName: dbUser.name };
        setUser(authUser);
        await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authUser));
      },
      logout: async () => {
        setUser(null);
        await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
      },
      guestLogin: () => {
        const guestUser: AuthUser = {
          id: 1,
          name: 'Demo Photographer',
          email: 'photographer@test.com',
          displayName: 'Demo Photographer',
        };
        setUser(guestUser);
        AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(guestUser)).catch(() => {});
      },
    }),
    [initializing, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
}
