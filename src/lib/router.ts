import { startupHash } from './navigation';
import { useSyncExternalStore } from 'react';
import { href, parse, type Route } from './routes';

/**
 * Hash routing: works identically under Vite, the embedded server, and Electron,
 * with no server-side fallback rules to get wrong. The routes themselves live in `routes.ts`.
 */
export { href, parse, routeForPath, type ProjectTab, type Route } from './routes';

let savedStart:unknown;
try { savedStart=JSON.parse(localStorage.getItem('centcom.navigation.startPage') ?? 'null'); } catch { /* default */ }
const initialHash=startupHash(window.location.hash,savedStart);
if(initialHash!==window.location.hash)window.history.replaceState(null,'',initialHash);
let current: Route = parse(initialHash);
const listeners = new Set<() => void>();

window.addEventListener('hashchange', () => {
  current = parse(window.location.hash);
  listeners.forEach((l) => l());
});

export function navigate(r: Route, opts: { replace?: boolean } = {}) {
  const h = href(r);
  if (h === window.location.hash) return;
  if (opts.replace) window.history.replaceState(null, '', h);
  else window.location.hash = h;
  if (opts.replace) {
    current = parse(h);
    listeners.forEach((l) => l());
  }
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
