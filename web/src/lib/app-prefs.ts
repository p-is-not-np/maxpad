import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * THE INSTALL'S OTHER SETTINGS — every server pref that is not the theme,
 * style or prompt box (those repaint the document and have their own setters
 * in settings.ts).
 *
 * Fed from the same three sources as the theme (boot, `prefs.updated`, a
 * refetch on reconnect) through lib/app-theme's `applyPrefs`, so the ordering
 * rules there apply here too. Raw strings: each reader parses its own key and
 * falls back to its own default, which is what "nothing stored" means.
 */
let prefs: Record<string, string> = {};
const listeners = new Set<(p: Record<string, string>) => void>();

export function setAppPrefs(next: Record<string, string> | null | undefined): void {
  prefs = { ...(next ?? {}) };
  for (const fn of listeners) fn(prefs);
}

export function getAppPref(key: string): string | null {
  return prefs[key] ?? null;
}

export function useAppPref(key: string): string | null {
  const [value, setValue] = useState(() => getAppPref(key));
  useEffect(() => {
    const fn = (p: Record<string, string>) => setValue(p[key] ?? null);
    listeners.add(fn);
    fn(prefs);
    return () => {
      listeners.delete(fn);
    };
  }, [key]);
  return value;
}

/** Optimistic, and undone if the write fails — the theme picker's contract. */
export async function storeAppPref(key: string, value: string | null): Promise<void> {
  const before = prefs;
  const next = { ...prefs };
  if (value === null) delete next[key];
  else next[key] = value;
  setAppPrefs(next);
  try {
    await api.setPref(key, value);
  } catch (err) {
    setAppPrefs(before);
    throw err;
  }
}

/** An on/off pref whose absence means `fallback`. */
export function useAppToggle(key: string, fallback: boolean): boolean {
  const raw = useAppPref(key);
  return raw === null ? fallback : raw === 'on';
}
