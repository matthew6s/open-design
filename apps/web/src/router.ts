// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'project'; projectId: string; fileName: string | null };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home' };
  if (parts[0] === 'projects' && parts[1]) {
    const projectId = decodeURIComponent(parts[1]);
    if (parts[2] === 'files' && parts[3]) {
      return {
        kind: 'project',
        projectId,
        fileName: decodeURIComponent(parts.slice(3).join('/')),
      };
    }
    return { kind: 'project', projectId, fileName: null };
  }
  return { kind: 'home' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') return '/';
  const id = encodeURIComponent(route.projectId);
  if (route.fileName) {
    const file = route.fileName
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return `/projects/${id}/files/${file}`;
  }
  return `/projects/${id}`;
}

const NAV_INDEX_KEY = '__openDesignNavIndex';
const NAV_MAX_KEY = '__openDesignNavMax';

function readStoredNumber(key: string, fallback: number): number {
  const value = Number(window.sessionStorage.getItem(key));
  return Number.isFinite(value) ? value : fallback;
}

function writeStoredNumber(key: string, value: number): void {
  window.sessionStorage.setItem(key, String(value));
}

function ensureNavState(): number {
  const state = window.history.state;
  if (state && typeof state.openDesignNavIndex === 'number') {
    writeStoredNumber(NAV_INDEX_KEY, state.openDesignNavIndex);
    writeStoredNumber(
      NAV_MAX_KEY,
      Math.max(readStoredNumber(NAV_MAX_KEY, state.openDesignNavIndex), state.openDesignNavIndex),
    );
    return state.openDesignNavIndex;
  }
  const index = readStoredNumber(NAV_INDEX_KEY, 0);
  window.history.replaceState({ ...(state ?? {}), openDesignNavIndex: index }, '', window.location.href);
  writeStoredNumber(NAV_INDEX_KEY, index);
  writeStoredNumber(NAV_MAX_KEY, Math.max(readStoredNumber(NAV_MAX_KEY, index), index));
  return index;
}

export function getNavigationAvailability(): { canGoBack: boolean; canGoForward: boolean } {
  const index = ensureNavState();
  const max = readStoredNumber(NAV_MAX_KEY, index);
  return {
    canGoBack: index > 0,
    canGoForward: index < max,
  };
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const target = buildPath(route);
  const current = window.location.pathname;
  if (target === current) return;
  const currentIndex = ensureNavState();
  if (opts.replace) {
    window.history.replaceState({ ...(window.history.state ?? {}), openDesignNavIndex: currentIndex }, '', target);
  } else {
    const nextIndex = currentIndex + 1;
    window.history.pushState({ openDesignNavIndex: nextIndex }, '', target);
    writeStoredNumber(NAV_INDEX_KEY, nextIndex);
    writeStoredNumber(NAV_MAX_KEY, nextIndex);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
