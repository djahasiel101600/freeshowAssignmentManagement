import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

const STORAGE_KEY = 'freeshow-theme';

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readPreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'system';
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme: Theme =
        preference === 'system' ? getSystemTheme() : preference;
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.style.colorScheme = theme;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [preference]);

  const setTheme = useCallback((next: ThemePreference) => {
    setPreference(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return {
    preference,
    theme: preference === 'system' ? getSystemTheme() : preference,
    setTheme,
  };
}