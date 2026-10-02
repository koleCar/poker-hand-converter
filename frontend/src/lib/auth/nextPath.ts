import { paths } from "../routes";

/**
 * Where `/auth/callback` is allowed to send the browser afterwards.
 *
 * ## Why this is an allow-list and not a validator
 *
 * `?next=` is an attacker-controlled string that ends up in a `Location`
 * header on a page that has just *minted a session*. With OAuth that is an
 * account-takeover vector, not a phishing nuisance: the classic chain is
 *
 *   1. victim clicks `…/auth/callback?next=https://evil.example/x`;
 *   2. the callback exchanges the code, sets the session cookie, and redirects;
 *   3. the attacker's page reads the `code`, the `Referer`, or simply owns the
 *      window that is now authenticated to a page it controls.
 *
 * Every "reject absolute URLs" rule ever written has been bypassed by a shape
 * somebody did not think of — `//evil.example`, `/\evil.example`,
 * `https:/evil.example`, `/%2f%2fevil.example`, a backslash Windows-normalises,
 * a `\t` Chrome strips before parsing. Enumerating bad input is a losing game
 * when the good input is a set of six literals.
 *
 * So: the answer is one of a fixed set of relative paths, or `/`. There is no
 * parsing, no normalisation, and therefore nothing to get subtly wrong. If the
 * product later needs a path with an argument in it — `/library?hand=<uuid>` —
 * the right move is to add the *pathname* here and carry the argument in its
 * own parameter, not to relax this.
 */
const ALLOWED: ReadonlySet<string> = new Set([
  paths.home(),
  paths.convert(),
  paths.library(),
  paths.stats(),
  paths.analysis(),
  // The one place a new account is sent to pick a name, and the page that
  // offers "resend the confirmation email" — so the link in that email has to
  // be able to come back here.
  paths.settings(),
  paths.submit(),
  paths.notifications(),
  paths.saved(),
  paths.mod(),
]);

/**
 * The path a sign-in should return to, given whatever arrived in `?next=`.
 *
 * Always returns a member of {@link ALLOWED}. Never throws, never echoes its
 * input: an unrecognised value lands on `/` rather than producing an error the
 * caller has to handle on the one code path where a mistake is expensive.
 *
 * `/h/:slug` and `/u/:username` are deliberately absent. A share link is a capability URL for a
 * stranger; nobody signs in *in order to* arrive at one, and admitting a
 * parameterised path here would mean parsing, which is the thing this avoids.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string") {
    return paths.home();
  }
  return ALLOWED.has(raw) ? raw : paths.home();
}

/** Exposed for the test of the thing, and for the callback route's logging. */
export const ALLOWED_NEXT_PATHS: readonly string[] = [...ALLOWED];
