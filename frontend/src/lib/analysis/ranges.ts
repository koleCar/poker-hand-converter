/**
 * Default ranges — **an explicitly labelled fallback**.
 *
 * The heuristics need *something* to measure an equity against: "you needed
 * 25% and had 41%" is only a sentence if the 41% is against a range. Since
 * A2b the range comes from the preflop charts wherever the opponent's line has
 * a chart node (`chartRange` in `preflop.ts`: the frequencies the charts play
 * that line with, per class). Where it has none — 9-max, deep stacks, a limp,
 * a line too rare for the set — this file supplies a rough, conventional
 * range per preflop line and position, written by hand from general poker
 * knowledge, and every use of it is marked:
 *
 * - the decision carries the `placeholder-range` approximation;
 * - the equity fact says `source: "placeholder"`;
 * - the equity fact names the range it was taken against (`open:BTN`);
 * - flags built on it are `note` severity unless they also hold against any
 *   two cards.
 *
 * Postflop actions do **not** narrow these ranges in A1. That is A4's range
 * walk ("every postflop action narrows it by the solved strategy"), and doing it
 * by hand here would be inventing a strategy. A villain who bet three streets
 * is therefore measured against their whole preflop range, which flatters a
 * hero's bluff-catcher. That bias is why no flag here may be louder than a note
 * on the strength of these ranges alone.
 *
 * Nothing here is copied from any product or chart (§0, §3.1).
 */

import { parseRange, type ClassWeights } from "../equity/range";
import type { Position } from "../phf/types";
import type { Decision, StatsContext } from "../stats/context";

/** What a seat did preflop, in the vocabulary ranges are written in. */
export type PreflopLine =
  | "open"
  | "iso"
  | "limp"
  | "call"
  | "3bet"
  | "call-3bet"
  | "4bet"
  | "call-4bet"
  | "check"
  | "unknown";

type Band = "early" | "middle" | "late" | "sb" | "bb";

function band(position: Position | null): Band {
  switch (position) {
    case "UTG":
    case "UTG+1":
    case "UTG+2":
      return "early";
    case "MP":
    case "LJ":
    case "HJ":
      return "middle";
    case "CO":
    case "BTN":
      return "late";
    case "SB":
      return "sb";
    case "BB":
      return "bb";
    default:
      return "middle";
  }
}

const OPEN: Record<Exclude<Band, "bb">, string> = {
  early: "66+, A9s+, A5s-A4s, KTs+, QTs+, JTs, T9s, AJo+, KQo",
  middle: "55+, A7s+, A5s-A2s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+, QJo",
  late: "22+, A2s+, K5s+, Q7s+, J8s+, T8s+, 97s+, 86s+, 76s, 65s, A7o+, K9o+, QTo+, JTo",
  sb: "22+, A2s+, K5s+, Q7s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, A5o+, K9o+, QTo+, JTo",
};

/** The button opens wider than the cutoff; it is the one late seat split out. */
const OPEN_BTN =
  "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o, 98o";

/**
 * Spans are written either way round and by kicker (`A5s-A2s`, `22-JJ`):
 * `parseRange` reads both since A2b. Before that most of these threw and the
 * equity fact silently dropped (ANALYSIS-PLAN §10, A8a); a test now parses
 * every line from every position.
 */
const RANGES: Record<Exclude<PreflopLine, "open">, string> = {
  iso: "66+, A8s+, A5s-A2s:0.5, KTs+, QTs+, JTs, ATo+, KJo+",
  limp: "22-99, A2s-A9s, K2s+, Q5s+, J7s+, T7s+, 97s+, 86s+, 75s+, 64s+, 54s, A2o-ATo, K9o+, QTo+, JTo",
  call: "22-JJ, AQs-A9s, A5s-A4s, KQs-KTs, QJs-QTs, JTs, T9s, 98s, 87s, 76s, AQo, KQo",
  "3bet": "TT+, AQs+, AKo, AJs:0.5, KQs:0.5, A5s-A4s",
  "call-3bet": "99-QQ, AQs-AJs, AKo:0.5, KQs, JTs:0.5, T9s:0.5",
  "4bet": "KK+, AKs, AKo:0.6, A5s:0.4",
  "call-4bet": "QQ+, AKs, AKo",
  check: "*",
  unknown: "*",
};

/** The big blind defends far wider than anyone else calls: it is closing the action at a discount. */
const BB_DEFEND =
  "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o";

const cache = new Map<string, ClassWeights>();

export interface DefaultRange {
  /** `line:position`, e.g. `open:BTN`. What the screen names the range by. */
  key: string;
  line: PreflopLine;
  position: Position | null;
  range: ClassWeights;
}

/** The placeholder range for a line from a position. */
export function defaultRange(line: PreflopLine, position: Position | null): DefaultRange {
  const where = band(position);
  let text: string;
  if (line === "open") {
    text = position === "BTN" ? OPEN_BTN : where === "bb" ? OPEN.sb : OPEN[where];
  } else if (line === "call" && where === "bb") {
    text = BB_DEFEND;
  } else {
    text = RANGES[line];
  }
  let range = cache.get(text);
  if (!range) {
    range = parseRange(text);
    cache.set(text, range);
  }
  return { key: `${line}:${position ?? "?"}`, line, position, range };
}

/**
 * A seat's preflop line, read from the stats engine's decision stream.
 *
 * The last voluntary action decides it, at the raise level it happened: a
 * raise at level 0 is an open (or an isolation raise over limpers), at level 1
 * a 3-bet, beyond that a 4-bet; a call at level 0 is a limp, then a call of an
 * open, of a 3-bet, of a 4-bet. Only checks (the big blind's option) is
 * `check`. No preflop decision at all — a bomb pot — is `unknown`.
 */
export function preflopLine(context: StatsContext, seat: number): PreflopLine {
  const mine = (context.byStreet.get("preflop") ?? []).filter((decision) => decision.seat === seat);
  let last: Decision | null = null;
  for (const decision of mine) {
    if (decision.type === "raise" || decision.type === "call" || decision.type === "bet") {
      last = decision;
    }
  }
  if (!last) {
    return mine.some((decision) => decision.type === "check") ? "check" : "unknown";
  }
  const level = last.raisesBefore;
  if (last.type === "raise" || last.type === "bet") {
    if (level === 0) return last.enteredBefore.length > 0 ? "iso" : "open";
    if (level === 1) return "3bet";
    return "4bet";
  }
  if (level === 0) return "limp";
  if (level === 1) return "call";
  if (level === 2) return "call-3bet";
  return "call-4bet";
}
