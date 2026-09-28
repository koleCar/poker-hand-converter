/**
 * Where in a hand a link points.
 *
 * ## Why not the frame index
 *
 * Frames are *derived*. `buildReplay` decides how many of them a hand has, and
 * that decision has already changed once — the per-pot award rebuild turned one
 * award frame into one per pot, renumbering every frame after the first
 * showdown. A stored `frame.index` would have survived that change syntactically
 * and pointed at a different moment semantically, which is the worst kind of
 * breakage: silent. Multiply that by "every forum comment anchor ever written"
 * and it is not a tradeoff, it is a bug with a delay on it.
 *
 * So the anchor is `PhfAction.index`, which `lib/phf/types.ts` documents as
 * *stable across serialization* and which every action frame already carries as
 * `ReplayFrame.actionIndex`. It is a property of the hand, not of our rendering
 * of it.
 *
 * ## Why resolution is lossy-tolerant
 *
 * `actionIndex` is stable across serialization, not across a parser fix. If a
 * later change makes a room's "posts dead blind" its own action, every index
 * after it shifts by one, and a comment anchored at `a17` now names a
 * neighbouring moment. `frameIndexForPosition` therefore resolves to the **first
 * frame whose `actionIndex >= target`** rather than to an exact match: an
 * anchor that no longer exists lands one action late instead of silently
 * collapsing to frame 0, which is the failure mode that would make a whole
 * thread of comments look like they were written about the wrong hand.
 *
 * ## Why a query param and not a hash
 *
 * `?t=a17`, never `#a17`. The App Router move reads `searchParams` on the
 * server to render the page and its Open Graph tags; a fragment never leaves the
 * browser, so a hash anchor is invisible to exactly the layer that most needs
 * to know which moment a link is about.
 */

import { STREET_ORDER, type Street } from "../../lib/phf/types";
import type { ReplayFrame } from "../../lib/replay";

export type ReplayPosition =
  | { kind: "start" }
  | { kind: "action"; actionIndex: number }
  | { kind: "street"; street: Street }
  | { kind: "end" };

/** The query parameter a position travels in. */
export const POSITION_PARAM = "t";

export const START_POSITION: ReplayPosition = { kind: "start" };

/**
 * `"start"` | `"a17"` | `"flop"` | `"end"`.
 *
 * Deliberately short and typeable: these end up pasted into forum posts by
 * hand, and a base64 blob would be neither readable nor editable.
 */
export function encodePosition(position: ReplayPosition): string {
  switch (position.kind) {
    case "action":
      return `a${position.actionIndex}`;
    case "street":
      return position.street;
    case "end":
      return "end";
    default:
      return "start";
  }
}

/** Inverse of `encodePosition`. `null` for anything it does not recognise. */
export function decodePosition(raw: string | null | undefined): ReplayPosition | null {
  if (!raw) {
    return null;
  }
  const text = raw.trim().toLowerCase();
  if (text === "start") {
    return START_POSITION;
  }
  if (text === "end") {
    return { kind: "end" };
  }
  const action = /^a(\d+)$/.exec(text);
  if (action) {
    return { kind: "action", actionIndex: Number(action[1]) };
  }
  const street = STREET_ORDER.find((candidate) => candidate === text);
  return street ? { kind: "street", street } : null;
}

/**
 * The most specific position a frame can be named by.
 *
 * Action frames name themselves by their action, which is the whole point.
 * Dealer-side frames — the sweep into the middle, the deal, a street card —
 * have no action of their own, so they name their street: a link to "the flop"
 * is a thing a person means, and it survives any renumbering at all.
 *
 * Never returns `{ kind: "end" }`. The last frame of a hand is the award, which
 * carries the collect's `actionIndex` and is better named by it — `end` exists
 * for a *link author* who means "wherever this hand finishes", which is a
 * different statement from "the frame that happens to be last today".
 */
export function positionOfFrame(frame: ReplayFrame): ReplayPosition {
  if (frame.actionIndex !== null) {
    return { kind: "action", actionIndex: frame.actionIndex };
  }
  if (frame.index === 0) {
    return START_POSITION;
  }
  return { kind: "street", street: frame.street };
}

/**
 * Resolves a position against a hand's frames. Always returns a valid index —
 * a position that cannot be honoured lands adjacent, never at 0.
 */
export function frameIndexForPosition(
  frames: ReplayFrame[],
  position: ReplayPosition | null | undefined,
): number {
  const last = Math.max(0, frames.length - 1);
  if (!position || frames.length === 0) {
    return 0;
  }

  switch (position.kind) {
    case "start":
      return 0;
    case "end":
      return last;
    case "action": {
      // First frame at or after the anchor. `actionIndex` only ever increases
      // along the frame list, so a single forward scan is the whole search.
      const hit = frames.findIndex(
        (frame) => frame.actionIndex !== null && frame.actionIndex >= position.actionIndex,
      );
      return hit >= 0 ? hit : last;
    }
    case "street": {
      const exact = frames.findIndex((frame) => frame.street === position.street);
      if (exact >= 0) {
        return exact;
      }
      // The hand never reached that street — it ended on the turn and the link
      // says "river". Land on the first frame of the earliest street that is
      // still later than the one asked for, and failing that on the end.
      const wanted = STREET_ORDER.indexOf(position.street);
      const later = frames.findIndex((frame) => STREET_ORDER.indexOf(frame.street) >= wanted);
      return later >= 0 ? later : last;
    }
    default:
      return 0;
  }
}

/**
 * Reads `?t=` off the current URL.
 *
 * Guarded for the server render: the replayer is due to be rendered by the App
 * Router, where `window` does not exist and the position arrives as a prop from
 * `searchParams` instead.
 */
export function readPositionFromUrl(param: string = POSITION_PARAM): ReplayPosition | null {
  if (typeof window === "undefined") {
    return null;
  }
  return decodePosition(new URLSearchParams(window.location.search).get(param));
}

/**
 * Writes `?t=` without touching the rest of the URL or the history stack.
 *
 * `replaceState`, never `pushState`: stepping through a hand would otherwise
 * bury the page the reader arrived from under sixty history entries, and the
 * back button would walk the hand backwards one action at a time.
 *
 * Deliberately not routed through `routes/navigation.navigate()` — that fires
 * the app's navigation event and re-runs the route matcher, and the position is
 * not a navigation. Nothing in the route table reads `?t=`.
 */
export function writePositionToUrl(
  position: ReplayPosition,
  param: string = POSITION_PARAM,
): void {
  if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") {
    return;
  }
  const url = new URL(window.location.href);
  const value = encodePosition(position);
  if (url.searchParams.get(param) === value) {
    return;
  }
  url.searchParams.set(param, value);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
