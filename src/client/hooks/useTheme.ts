import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'pipali-theme';

/**
 * Hook to manage theme (light/dark mode)
 *
 * Supports:
 * - System preference via prefers-color-scheme
 * - Manual toggle via user selection
 * - Persistence via localStorage
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Get stored preference or default to system
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
      return stored || 'system';
    }
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  // Get the actual theme based on system preference
  const getResolvedTheme = useCallback((currentTheme: Theme): 'light' | 'dark' => {
    if (currentTheme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return currentTheme;
  }, []);

  // Apply theme to document
  const applyTheme = useCallback((currentTheme: Theme) => {
    const root = document.documentElement;
    const resolved = getResolvedTheme(currentTheme);

    // Remove both classes first
    root.classList.remove('light', 'dark');

    // Only add class if not using system preference
    if (currentTheme !== 'system') {
      root.classList.add(currentTheme);
    }

    setResolvedTheme(resolved);
  }, [getResolvedTheme]);

  // Set theme and persist
  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    applyTheme(newTheme);
  }, [applyTheme]);

  // Toggle between light and dark
  const toggleTheme = useCallback(() => {
    const current = getResolvedTheme(theme);
    const newTheme: Theme = current === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
  }, [theme, getResolvedTheme, setTheme]);

  // Apply theme on mount and watch for system preference changes
  useEffect(() => {
    applyTheme(theme);

    // Watch for system preference changes when using 'system' theme
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, applyTheme]);

  return {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
    isDark: resolvedTheme === 'dark',
  };
}
