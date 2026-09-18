/**
 * Downloads, clipboard, and the hand-off into the replayer.
 *
 * The replayer lives on its own route and is owned by another component, so
 * the converter cannot hand it a hand directly. It parks the hand in
 * `sessionStorage` under `PENDING_HAND_KEY` and navigates; the replayer picks
 * it up on mount and clears the key. `sessionStorage` rather than a query
 * string because a hand is kilobytes, and rather than a module singleton
 * because both routes are code-split and a reload has to survive.
 *
 * A prop (`onOpenHand`) overrides all of this when the shell is ready to pass
 * one — see `openHandInReplayer` for the default.
 */

import { navigate } from "../../routes/navigation";
import { paths } from "../../routes/routes";
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
 * Default hand-off: park the hand and go to the replayer.
 *
 * Falls back to doing nothing but navigating if storage is unavailable
 * (private mode with quota 0), which is still better than throwing inside a
 * click handler.
 */
export function openHandInReplayer(hand: PhfHand, standardText?: string): void {
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
  navigate(paths.replayer());
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
