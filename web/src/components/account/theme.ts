"use client";

/**
 * The theme preference: System, Light or Dark.
 *
 * The mechanism is the root layout's inline `THEME_SCRIPT`: it reads
 * `localStorage["rail.theme"]` once per document, before the first paint, and
 * writes `data-theme` on `<html>` (the stored choice, else the OS preference).
 * This is the switch on top of it: choosing Light or Dark stores the word and
 * writes the attribute at once; System removes the key and follows
 * `prefers-color-scheme` - live, through {@link useFollowSystemTheme}, so a
 * phone that turns dark at sunset takes the page with it.
 *
 * A tiny external store rather than React state, so the user menu's switch
 * and Settings' switch always agree without a provider.
 */

import { useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_KEY = "rail.theme";
const CHANGE_EVENT = "rail:theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

/** The browser bar's colours, as the root layout's `theme-color` tags have them. */
const BAR = { light: "#f6f8fb", dark: "#0b0f14" } as const;

function apply(preference: ThemePreference): void {
  const resolved = preference === "system" ? systemTheme() : preference;
  document.documentElement.setAttribute("data-theme", resolved);
  // Each `theme-color` tag carries a media query: an explicit choice points
  // both at its colour, System gives each its own back. (The shell's More
  // sheet does the same; both share the `rail:theme` event.)
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.getAttribute("media") ?? "";
    meta.setAttribute("content", preference === "system" ? BAR[media.includes("light") ? "light" : "dark"] : BAR[resolved]);
  });
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Storage off: the choice lasts until the page is reloaded.
  }
  apply(preference);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // Another tab chose: take its choice here too.
    if (event.key === THEME_KEY || event.key === null) {
      apply(readPreference());
      onChange();
    }
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored preference; "system" on the server render. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, readPreference, () => "system");
}

/**
 * While the preference is System, follow the OS when it switches. Mounted
 * once, by the always-present user menu.
 */
export function useFollowSystemTheme(): void {
  const preference = useThemePreference();
  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia(LIGHT_QUERY);
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);
}
