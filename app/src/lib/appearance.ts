/**
 * The window's appearance and language (R2.8): the theme (dark, light or the
 * system's), the density (comfortable or compact lists and tables) and the
 * language (English or Croatian).
 *
 * `settings.json` (the Rust side, `settings.rs`) is the source of truth. A
 * copy lives in `localStorage` under `rail.appearance`, read by
 * `public/appearance.js` - a classic script in `<head>`, so it runs before
 * the first paint - which sets `data-theme`, `data-density` and `lang` on
 * `<html>` before any style or component loads: no dark flash before a light
 * theme, no English flash before Croatian. When the settings arrive over IPC
 * they win and the copy follows (the copy only differs after `settings.json`
 * was edited by hand, or on the first start, where both are the defaults).
 *
 * The same attributes the web uses: `data-theme="dark" | "light"` is what
 * `@rail/ui/tokens/theme-light.css` keys on; "system" follows
 * `prefers-color-scheme` while chosen. `data-density` is what
 * `@rail/ui/tokens/density.css` keys on.
 */
import { useSyncExternalStore } from "react";

import { setFormatLocale } from "../i18n/format";
import type { Locale } from "../i18n/types";
import type { Density, Settings, Theme } from "./ipc";

export interface Appearance {
  theme: Theme;
  density: Density;
  locale: Locale;
}

/** A fresh install's, and `settings.rs`' defaults. */
export const DEFAULT_APPEARANCE: Appearance = { theme: "system", density: "comfortable", locale: "en" };

/** The copy's key; `public/appearance.js` reads the same one. */
export const STORAGE_KEY = "rail.appearance";

const THEMES: readonly Theme[] = ["system", "dark", "light"];
const DENSITIES: readonly Density[] = ["comfortable", "compact"];
const LOCALES: readonly Locale[] = ["en", "hr"];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Whatever the copy holds, as a valid appearance (the defaults for anything else). */
export function parseAppearance(value: unknown): Appearance {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    theme: pick(record.theme, THEMES, DEFAULT_APPEARANCE.theme),
    density: pick(record.density, DENSITIES, DEFAULT_APPEARANCE.density),
    locale: pick(record.locale, LOCALES, DEFAULT_APPEARANCE.locale),
  };
}

function readCopy(): Appearance {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    return parseAppearance(text === null ? null : JSON.parse(text));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeCopy(value: Appearance): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A webview without storage: the next start paints the defaults first.
  }
}

const systemLight = window.matchMedia("(prefers-color-scheme: light)");
let current: Appearance = readCopy();
const listeners = new Set<() => void>();

function paint(): void {
  const root = document.documentElement;
  const resolved = current.theme === "system" ? (systemLight.matches ? "light" : "dark") : current.theme;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-density", current.density);
  root.setAttribute("lang", current.locale);
  setFormatLocale(current.locale);
}

systemLight.addEventListener("change", () => {
  if (current.theme === "system") paint();
});

paint();

/** Change some of it: painted at once, copied for the next start, announced. */
export function setAppearance(change: Partial<Appearance>): void {
  const next = { ...current, ...change };
  if (next.theme === current.theme && next.density === current.density && next.locale === current.locale) {
    return;
  }
  current = next;
  paint();
  writeCopy(current);
  for (const listener of listeners) listener();
}

/** What the settings say (on start, and after every change saved in Settings). */
export function adoptSettings(settings: Pick<Settings, "theme" | "density" | "locale">): void {
  setAppearance(parseAppearance(settings));
}

export function getAppearance(): Appearance {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance);
}

/** A list row's height in the current density (`--density-row` of `@rail/ui/tokens/density.css`). */
export function rowHeight(): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--density-row"));
  return Number.isFinite(value) && value > 0 ? value : 40;
}

/**
 * The same, for a virtualised list: read again when the density changes,
 * so the list positions its rows where the stylesheet draws them.
 */
export function useRowHeight(): number {
  // Subscribed, so a new density renders again; the value is the
  // stylesheet's, which `data-density` (painted before listeners run) sets.
  // Reading one custom property of a clean style tree is cheap.
  useAppearance();
  return rowHeight();
}
