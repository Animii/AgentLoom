import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

const CHANGE = 'agentloom-navigation';
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(CHANGE, listener);
  };
}
const snapshot = () => window.location.search;

export function updateUrl(
  changes: Record<string, string | null>,
  mode: 'push' | 'replace' = 'push',
) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (url.href === window.location.href) return;
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  window.dispatchEvent(new Event(CHANGE));
}

export function useUrlState<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly string[],
  mode: 'push' | 'replace' = 'push',
) {
  const search = useSyncExternalStore(subscribe, snapshot, () => '');
  const raw = new URLSearchParams(search).get(key);
  const value = (
    raw !== null && (!allowed || allowed.includes(raw)) ? raw : fallback
  ) as T;
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const current = new URLSearchParams(window.location.search).get(
        key,
      ) as T | null;
      const result =
        typeof next === 'function' ? next(current ?? fallback) : next;
      updateUrl({ [key]: result === fallback ? null : result }, mode);
    },
    [key, fallback, mode],
  );
  return [value, setValue] as const;
}

export function useUrlSelection(key: string, fallback: string | null = null) {
  const [value, setValue] = useUrlState<string>(key, fallback ?? '');
  const select = useCallback(
    (next: SetStateAction<string | null>) => {
      setValue(
        (current) =>
          (typeof next === 'function' ? next(current || null) : next) ?? '',
      );
    },
    [setValue],
  );
  return [value || null, select] as const;
}
