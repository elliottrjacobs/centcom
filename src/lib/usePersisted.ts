import { useCallback, useSyncExternalStore } from 'react';

/**
 * localStorage-backed state shared across components: every hook using the same
 * key sees the same value, which is what the sidebar's expand map needs.
 */
const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function read<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let value = fallback;
  try {
    const raw = localStorage.getItem(`centcom.${key}`);
    if (raw !== null) value = JSON.parse(raw) as T;
  } catch {
    /* unavailable or corrupt: fall back */
  }
  cache.set(key, value);
  return value;
}

export function usePersisted<T>(key: string, fallback: T): [T, (next: T) => void] {
  const value = useSyncExternalStore(
    (l) => {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(l);
      return () => set.delete(l);
    },
    () => read(key, fallback),
  );
  const update = useCallback(
    (next: T) => {
      cache.set(key, next);
      try {
        localStorage.setItem(`centcom.${key}`, JSON.stringify(next));
      } catch {
        /* storage full or blocked: keep in-memory value */
      }
      listeners.get(key)?.forEach((l) => l());
    },
    [key],
  );
  return [value, update];
}
