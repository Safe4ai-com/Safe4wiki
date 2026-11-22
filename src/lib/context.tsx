import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, exportedWiki, serverAvailable } from './api.js';

type Theme = 'light' | 'dark';
type RepoId = { owner: string; repo: string };
type Settings = { models: Record<string, object>; default: string; chatModel: string; maxPages: number };
type Dialog = { type: string; props: Record<string, unknown> };
type AppState = {
  server: boolean | null;
  exported: RepoId | null;
  settings: Settings | null;
  reloadSettings: () => Promise<void>;
  theme: Theme;
  toggleTheme: () => void;
  dialog: Dialog | null;
  openDialog: (type: string, props?: Dialog['props']) => void;
  closeDialog: () => void;
  toast: string;
  showToast: (text: string) => void;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));

  useEffect(() => { serverAvailable().then(setServer); }, []);

  const reloadSettings = useCallback(async () => {
    try { setSettings(await api.get('/api/settings')); } catch { setSettings(null); }
  }, []);
  useEffect(() => { if (server) reloadSettings(); }, [server, reloadSettings]);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try { localStorage.setItem('rw-theme', next); } catch { /* ignore */ }
    setTheme(next);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((text: string) => {
    setToast(text);
  }, []);

  const value: AppState = {
    server,
    exported: exportedWiki(),
    settings,
    reloadSettings,
    theme,
    toggleTheme,
    dialog,
    openDialog: (type, props = {}) => setDialog({ type, props }),
    closeDialog: () => setDialog(null),
    toast,
    showToast,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const app = useContext(AppContext);
  if (!app) throw new Error('Safe4wiki components require the application provider.');
  return app;
}
