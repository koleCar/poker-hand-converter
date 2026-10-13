/**
 * Signing the Rail desktop app in through this browser (docs/RAIL-PLAN.md
 * R1.7, amendment A6). Used by `/auth/desktop` only.
 *
 * The app opens `/auth/desktop?v=1&pub=<key>&state=<state>&t=<unix time>`.
 * Neither value is secret - `pub` is the public half of a key pair the app
 * keeps in memory, `state` names the attempt - so they may sit in the address
 * bar. What the page does with them:
 *
 *  1. checks their shape and age here (`t` comes from the same computer's
 *     clock, so ten minutes means ten minutes);
 *  2. keeps them in `sessionStorage` and drops them from the address, so a
 *     Google sign-in round trip (`/auth/callback?next=/auth/desktop`) finds
 *     them again in this tab;
 *  3. after the user clicks "Sign in to Rail", sends them to the Edge
 *     Function `desktop-handoff` with the user's own access token
 *     (`functions.invoke` attaches it). What comes back is ciphertext only
 *     the app can open;
 *  4. redirects to `rail://auth/callback?state=..&payload=..` and marks the
 *     state used, so a reload or the back button cannot send it twice.
 *
 * Nothing here ever holds the one-time token in the clear.
 */

import { getBrowserSupabase } from "../supabase/browser";

/** How long the app waits; the page refuses an older request. */
export const DESKTOP_REQUEST_TTL_MS = 10 * 60 * 1000;
/** Clock tolerance the other way (a request "from the future"). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_KEY = "rail.desktopSignIn.request";
const USED_KEY = "rail.desktopSignIn.used";

export interface DesktopRequest {
  pub: string;
  state: string;
  /** When the app made it, ms since the epoch. */
  issuedAt: number;
}

export type DesktopRequestResult =
  | { kind: "ok"; request: DesktopRequest }
  /** No request at all (the page was opened by hand, or in another tab). */
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "used" };

/** The shape and age of a request, from the query string. Pure. */
export function parseDesktopRequest(params: URLSearchParams, now: number): DesktopRequestResult {
  if (!params.has("pub") && !params.has("state")) {
    return { kind: "none" };
  }
  const pub = params.get("pub") ?? "";
  const state = params.get("state") ?? "";
  const t = params.get("t") ?? "";
  if (params.get("v") !== "1" || !B64_32.test(pub) || !B64_32.test(state) || !/^\d{1,12}$/.test(t)) {
    return { kind: "invalid" };
  }
  const request = { pub, state, issuedAt: Number(t) * 1000 };
  return checkAge(request, now);
}

function checkAge(request: DesktopRequest, now: number): DesktopRequestResult {
  if (request.issuedAt > now + FUTURE_TOLERANCE_MS) {
    return { kind: "invalid" };
  }
  if (now - request.issuedAt > DESKTOP_REQUEST_TTL_MS) {
    return { kind: "expired" };
  }
  return { kind: "ok", request };
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function usedStates(): string[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(USED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The request this tab is working on: from the address bar if it carries
 * one (which then moves to sessionStorage and leaves the address), else
 * the one kept from before a sign-in round trip.
 */
export function takeDesktopRequest(now: number = Date.now()): DesktopRequestResult {
  const store = storage();
  const url = new URL(window.location.href);
  let result = parseDesktopRequest(url.searchParams, now);
  if (result.kind !== "none") {
    // Out of the address bar (and the history entry), into this tab.
    window.history.replaceState(null, "", url.pathname);
    if (result.kind === "ok") {
      store?.setItem(REQUEST_KEY, JSON.stringify(result.request));
    } else {
      store?.removeItem(REQUEST_KEY);
    }
  } else {
    try {
      const kept = JSON.parse(store?.getItem(REQUEST_KEY) ?? "null") as DesktopRequest | null;
      if (kept && B64_32.test(kept.pub) && B64_32.test(kept.state) && Number.isFinite(kept.issuedAt)) {
        result = checkAge(kept, now);
      }
    } catch {
      result = { kind: "none" };
    }
  }
  if (result.kind === "ok" && usedStates().includes(result.request.state)) {
    store?.removeItem(REQUEST_KEY);
    return { kind: "used" };
  }
  return result;
}

/** This request was answered (sent or cancelled): never again from this tab. */
export function markDesktopRequestUsed(state: string): void {
  const store = storage();
  if (!store) return;
  const used = [...usedStates().filter((s) => s !== state), state].slice(-20);
  store.setItem(USED_KEY, JSON.stringify(used));
  store.removeItem(REQUEST_KEY);
}

/** The function's refusals, plus `failed` for anything else. */
export type DesktopHandoffError =
  | "not_signed_in"
  | "invalid_request"
  | "email_unconfirmed"
  | "account_not_supported"
  | "rate_limited"
  | "unavailable"
  | "failed";

const KNOWN: ReadonlySet<string> = new Set([
  "not_signed_in",
  "invalid_request",
  "email_unconfirmed",
  "account_not_supported",
  "rate_limited",
  "unavailable",
]);

/** Ask the function for the sealed payload, as the signed-in user. */
export async function requestDesktopHandoff(
  request: DesktopRequest,
): Promise<{ ok: true; payload: string } | { ok: false; error: DesktopHandoffError }> {
  const client = getBrowserSupabase();
  if (!client) {
    return { ok: false, error: "unavailable" };
  }
  const { data, error } = await client.functions.invoke<{ v: number; payload: string }>("desktop-handoff", {
    body: { v: 1, pub: request.pub, state: request.state },
  });
  if (!error && data && typeof data.payload === "string" && data.payload.length > 0) {
    return { ok: true, payload: data.payload };
  }
  // A FunctionsHttpError carries the Response; its body names the refusal.
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    if (context.status === 404) {
      return { ok: false, error: "unavailable" };
    }
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body.error === "string" && KNOWN.has(body.error)) {
        return { ok: false, error: body.error as DesktopHandoffError };
      }
    } catch {
      // Not JSON: fall through.
    }
  }
  return { ok: false, error: "failed" };
}

/** Where the app is waiting. */
export function desktopCallbackUrl(state: string, payload: string): string {
  return `rail://auth/callback?state=${encodeURIComponent(state)}&payload=${encodeURIComponent(payload)}`;
}

/** Tell the app the user cancelled, so it stops waiting. */
export function desktopCancelUrl(state: string): string {
  return `rail://auth/callback?state=${encodeURIComponent(state)}&error=cancelled`;
}
