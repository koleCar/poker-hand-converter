/**
 * The six screens of guideline §6, as hash routes (`#/hands`). A hash keeps
 * the router a few lines long and needs nothing from the Tauri asset
 * protocol; a real router can replace it when screens get sub-routes (R2.7).
 */
import { useSyncExternalStore } from "react";

export const SCREENS = ["today", "hands", "reports", "players", "hud", "settings"] as const;

export type Screen = (typeof SCREENS)[number];

export const DEFAULT_SCREEN: Screen = "today";

function isScreen(id: string): id is Screen {
  return (SCREENS as readonly string[]).includes(id);
}

function current(): Screen {
  const id = window.location.hash.replace(/^#\/?/, "");
  return isScreen(id) ? id : DEFAULT_SCREEN;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useScreen(): Screen {
  return useSyncExternalStore(subscribe, current);
}

export function screenHref(screen: Screen): string {
  return `#/${screen}`;
}
