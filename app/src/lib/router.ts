/**
 * The six screens of guideline §6, as hash routes (`#/hands`), plus the
 * first-run screen (`#/setup`, R1.4), which is not in the sidebar. A hash
 * keeps the router a few lines long and needs nothing from the Tauri asset
 * protocol; a real router can replace it when screens get sub-routes (R2.7).
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

function current(): Route {
  const id = window.location.hash.replace(/^#\/?/, "");
  return isRoute(id) ? id : DEFAULT_SCREEN;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current);
}

export function screenHref(route: Route): string {
  return `#/${route}`;
}

/** Go to a route (a new history entry, as a link would). */
export function go(route: Route): void {
  window.location.hash = screenHref(route);
}
