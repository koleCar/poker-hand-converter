/**
 * Downloads, clipboard, and the hand-off into the replayer.
 *
 * The replayer lives on its own route and is owned by another component, so
 * the converter cannot hand it a hand directly. It parks the hand in
 * `sessionStorage` under `PENDING_HAND_KEY`; the caller then navigates, and the
 * replayer picks the hand up on mount and clears the key. `sessionStorage`
 * rather than a query string because a hand is kilobytes, and rather than a
 * module singleton because the two routes are separate documents' worth of
 * JavaScript and a reload has to survive.
 *
 * ## Why parking and navigating are two calls now
 *
 * This module used to do both — `openHandInReplayer()` parked the hand and then
 * called `navigate()` from the old hand-rolled router, which was a plain
 * function over `history.pushState`. The App Router's equivalent is
 * `useRouter()`, a hook, and a hook cannot be called from a non-component
 * module. Rather than smuggle a router instance in here, the split is explicit:
 * this module parks, the component navigates. It is also the honest shape —
 * "put this somewhere the next screen can find it" and "go to that screen" are
 * two decisions, and only the first one belongs to the converter.
 */

import { toStandardText } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";

/** `sessionStorage` key the replayer should read on mount and then remove. */
export const PENDING_HAND_KEY = "pokerconverter.pendingHand";

/** Shape stored under {@link PENDING_HAND_KEY}. */
export interface PendingHand {
  /** Canonical PHF document. */
  phf: PhfHand;
  /** GG-style text, so a consumer that only reads text does not have to render it. */
  standardText: string;
  /** Where the hand came from, for the replayer's "unsaved upload" badge. */
  origin: "converter";
  /** ISO timestamp, so a stale entry from an old tab can be ignored. */
  at: string;
}

/**
 * Is a hand currently parked for the replayer?
 *
 * A peek, not a take: the replayer is still the one that consumes the key. The
 * shell needs this because the replay route is otherwise only open to someone
 * with a library, and a hand straight out of the converter is not in one yet.
 */
export function hasPendingHand(): boolean {
  try {
    return sessionStorage.getItem(PENDING_HAND_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Parks a hand for the library route to pick up. Navigate afterwards.
 *
 * Never throws: if storage is unavailable (private mode with quota 0) the
 * replayer simply opens empty, which is better than a click handler that blows
 * up on the one browser where this matters least.
 */
export function parkHandForReplayer(hand: PhfHand, standardText?: string): void {
  const payload: PendingHand = {
    phf: hand,
    standardText: standardText ?? toStandardText(hand),
    origin: "converter",
    at: new Date().toISOString(),
  };
  try {
    sessionStorage.setItem(PENDING_HAND_KEY, JSON.stringify(payload));
  } catch {
    // Storage full or blocked; the replayer will just open empty.
  }
}

/* ------------------------------------------------------------- downloads - */

export function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously races the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Output name for a converted source.
 *
 * Keeps the original stem so a user converting fifty files can still tell them
 * apart, and strips the archive prefix a zip entry carries.
 */
export function outputFileName(sourceName: string): string {
  const leaf = sourceName.split("→").pop()?.trim() ?? sourceName;
  const stem = leaf.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "-").trim() || "hands";
  return `${stem} - converted.txt`;
}

/** Copies to the clipboard, falling back to a hidden textarea on http:// origins. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
