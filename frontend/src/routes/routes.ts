/**
 * Route table for the app.
 *
 * Deliberately tiny: the app has three real screens, so a hand-rolled matcher
 * costs ~40 lines and no runtime dependency, where `react-router` would add a
 * router runtime to a bundle that currently ships only React + supabase-js.
 * The shared-hand page is a public landing surface, so bytes matter there.
 */

export type RouteName = "converter" | "replayer" | "shared-hand" | "not-found";

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
  /** App-relative pathname, with the deploy base prefix already removed. */
  pathname: string;
  search: URLSearchParams;
}

/** "" when the app is deployed at the domain root, "/sub" otherwise. */
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

/** Browser pathname -> app-relative pathname. */
export function toAppPath(pathname: string): string {
  if (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`))) {
    return pathname.slice(BASE.length) || "/";
  }
  return pathname || "/";
}

/** App-relative pathname -> href usable in `<a href>` / `history.pushState`. */
export function toHref(path: string): string {
  return `${BASE}${path}`;
}

export const paths = {
  converter: () => "/",
  replayer: () => "/replay",
  sharedHand: (slug: string) => `/h/${encodeURIComponent(slug)}`,
};

/** Absolute URL for a share slug — what actually gets copied to the clipboard. */
export function sharedHandUrl(slug: string): string {
  const origin =
    typeof window === "undefined" ? "https://poker-hand-converter.vercel.app" : window.location.origin;
  return `${origin}${toHref(paths.sharedHand(slug))}`;
}

/** Older/alternate spellings kept linkable; they redirect to the canonical path. */
const ALIASES: Record<string, string> = {
  "/convert": "/",
  "/converter": "/",
  "/replayer": "/replay",
};

const PATTERNS: Array<{ name: RouteName; segments: string[] }> = [
  { name: "converter", segments: [] },
  { name: "replayer", segments: ["replay"] },
  { name: "shared-hand", segments: ["h", ":slug"] },
];

function split(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** Returns the canonical path when `pathname` is an alias, otherwise null. */
export function aliasTarget(pathname: string): string | null {
  return ALIASES[normalize(pathname)] ?? null;
}

function normalize(pathname: string): string {
  const trimmed = toAppPath(pathname).replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.toLowerCase();
}

export function matchRoute(pathname: string, search: string): RouteMatch {
  const normalized = normalize(pathname);
  const target = ALIASES[normalized] ?? normalized;
  const segments = split(target);
  const query = new URLSearchParams(search);

  for (const pattern of PATTERNS) {
    if (pattern.segments.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.segments.length; i += 1) {
      const expected = pattern.segments[i];
      if (expected.startsWith(":")) {
        params[expected.slice(1)] = decodeURIComponent(segments[i]);
        continue;
      }
      if (expected !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { name: pattern.name, params, pathname: target, search: query };
    }
  }

  return { name: "not-found", params: {}, pathname: target, search: query };
}
