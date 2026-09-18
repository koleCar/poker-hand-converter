import { createContext, useContext } from "react";
import { toHref, type RouteMatch } from "./routes";

/**
 * Router plumbing that is not a component.
 *
 * Split out from `router.tsx` so that file exports components only, which is
 * what React Fast Refresh needs to hot-reload the app shell.
 *
 * `history.pushState` does not emit an event, so `navigate()` fires one itself
 * and `<RouterProvider>` listens to both that and `popstate` (back/forward).
 */
export const NAV_EVENT = "app:navigate";

export interface AppLocation {
  pathname: string;
  search: string;
}

export function readLocation(): AppLocation {
  return { pathname: window.location.pathname, search: window.location.search };
}

export interface NavigateOptions {
  replace?: boolean;
  /** Defaults to true for pushes, false for replaces. */
  scroll?: boolean;
}

export function navigate(to: string, options: NavigateOptions = {}): void {
  const href = to.startsWith("http") ? to : toHref(to);
  const current = window.location.pathname + window.location.search;
  if (href === current) {
    return;
  }
  if (options.replace) {
    window.history.replaceState({}, "", href);
  } else {
    window.history.pushState({}, "", href);
  }
  window.dispatchEvent(new Event(NAV_EVENT));
  if (options.scroll ?? !options.replace) {
    window.scrollTo({ top: 0 });
  }
}

export const RouteContext = createContext<RouteMatch | null>(null);

export function useRoute(): RouteMatch {
  const match = useContext(RouteContext);
  if (!match) {
    throw new Error("useRoute() must be used inside <RouterProvider>.");
  }
  return match;
}
