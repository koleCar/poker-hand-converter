/**
 * The six screens of guideline §6, as hash routes (`#/hands`), plus the
 * first-run screen (`#/setup`, R1.4), which is not in the sidebar. A hash
 * keeps the router a few lines long and needs nothing from the Tauri asset
 * protocol. A screen may take one parameter after its name: the Hands
 * screen's open hand (`#/hands/<hand key>`, R2.7a).
 */
import { useSyncExternalStore } from "react";

export const SCREENS = ["today", "hands", "reports", "players", "hud", "settings"] as const;

export type Screen = (typeof SCREENS)[number];

/** The first-run screen: shown on first launch, reachable from Settings. */
export const SETUP = "setup";

export type Route = Screen | typeof SETUP;

export const DEFAULT_SCREEN: Screen = "today";

function isRoute(id: string): id is Route {
  return id === SETUP || (SCREENS as readonly string[]).includes(id);
}

/** The hash after `#/`, split at its first slash. */
function parts(): [string, string | null] {
  const path = window.location.hash.replace(/^#\/?/, "");
  const slash = path.indexOf("/");
  return slash < 0 ? [path, null] : [path.slice(0, slash), path.slice(slash + 1)];
}

function current(): Route {
  const [id] = parts();
  return isRoute(id) ? id : DEFAULT_SCREEN;
}

/** The route's parameter, decoded; `null` when it has none. */
function currentParam(): string | null {
  const [id, param] = parts();
  if (!isRoute(id) || !param) {
    return null;
  }
  try {
    return decodeURIComponent(param);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current);
}

/** The current route's parameter (`#/hands/<key>`: the key). */
export function useRouteParam(): string | null {
  return useSyncExternalStore(subscribe, currentParam);
}

export function screenHref(route: Route, param?: string | null): string {
  return param ? `#/${route}/${encodeURIComponent(param)}` : `#/${route}`;
}

/** Go to a route (a new history entry, as a link would). */
export function go(route: Route, param?: string | null): void {
  window.location.hash = screenHref(route, param);
}

/**
 * Change the current route's parameter without a new history entry (the
 * Hands screen moving its selection through the list: Back leaves the
 * screen, not each hand looked at).
 */
export function replaceParam(route: Route, param: string | null): void {
  const href = screenHref(route, param);
  if (window.location.hash !== href) {
    window.location.replace(href);
  }
}
