/**
 * UI state shared between the converter tab and its panels.
 *
 * One `SourceResult` per file, archive entry or paste. It starts as the decoded
 * input, gains detection information when the pipeline reaches it, and
 * accumulates hands and failures as batches stream back — so the results view
 * can render a half-finished conversion without a second code path.
 */

import type { ConversionFailure } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";

export type SourceStatus = "queued" | "running" | "done" | "cancelled" | "skipped";

export interface SourceResult {
  id: string;
  name: string;
  bytes: number;
  encoding: string;
  /** Set when the file could not even be decoded; it never reaches the pipeline. */
  problem?: string;
  status: SourceStatus;
  /** Registry id of the parser that claimed the text, once detection has run. */
  siteId: string | null;
  siteName: string | null;
  confidence: number | null;
  /** Hands found by the split; 0 until detection runs. */
  total: number;
  /** Hands processed so far. */
  done: number;
  hands: PhfHand[];
  failures: ConversionFailure[];
}

/** Result of the automatic save, or the reason there is not one. */
export interface SaveState {
  status: "idle" | "saving" | "done" | "error";
  inserted: number;
  duplicates: number;
  /** Hands handed to `saveHands`, for the progress bar. */
  total: number;
  done: number;
  errors: string[];
}

export const IDLE_SAVE: SaveState = {
  status: "idle",
  inserted: 0,
  duplicates: 0,
  total: 0,
  done: 0,
  errors: [],
};
