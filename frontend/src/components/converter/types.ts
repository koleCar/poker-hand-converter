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
import type { SourceProblem } from "./inputs";

export type SourceStatus = "queued" | "running" | "done" | "cancelled" | "skipped";

export interface SourceResult {
  id: string;
  name: string;
  bytes: number;
  encoding: string;
  /** Set when the file could not even be decoded; it never reaches the pipeline. */
  problem?: SourceProblem;
  status: SourceStatus;
  /** Registry id of the parser that claimed the text, once detection has run. */
  siteId: string | null;
  siteName: string | null;
  confidence: number | null;
  /** Hands found by the split; 0 until detection runs. */
  total: number;
  /** Hands processed so far. */
  done: number;
  /** Hands converted, all of them (`hands` may hold only the first). */
  handCount: number;
  /** Hands refused by the converter, all of them. */
  failureCount: number;
  /**
   * The converted hands the tab kept, for the list, previews and downloads.
   * All of them up to a few tens of thousands per drop; past that only the
   * counts grow (R4.2), and `truncated` says so.
   */
  hands: PhfHand[];
  failures: ConversionFailure[];
  truncated: boolean;
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
