/**
 * A stored hand as its standard text instead of its PHF document
 * (`20271114090000_text_storage.sql`, docs/DATABASE.md "The phf /
 * standard_text contract").
 *
 * `hands.phf` is ~2.75 KB a hand even compressed; the standard text is ~1.2
 * KB and reads back as the same hand. So a row may now hold **either**:
 *
 *  * `phf` (and maybe a display copy of the text) - every row written before
 *    the change, and every hand whose text does not read back identically; or
 *  * `standard_text` alone, `phf` null - the hand is the text, parsed again on
 *    read, with the provenance the text cannot carry put back from the row's
 *    columns ({@link restoreMeta}).
 *
 * The rule that keeps the second kind honest is that a writer only ever sends
 * a text it has **verified** ({@link verifiedStandardText}): rendered, parsed
 * back, provenance restored from the columns the server will store, and equal
 * to the document field for field but for {@link COSMETIC_PATHS}. A hand that
 * fails keeps its PHF. The same functions are the readers' ({@link
 * handOfStoredRow}), so what was verified is exactly what is read.
 *
 * The Rust twin is `core/rail-sync/src/stored_text.rs` (the desktop's ingest
 * and pull); `tests/test/storedText.test.ts` holds the two to the same
 * answers. This module imports nothing at run time - the parser is passed
 * in - so the backfill script (`tests/scripts/text-storage/backfill.mjs`)
 * runs it under plain Node.
 */

import type { PhfHand } from "./types";

/**
 * Fields that may differ between a hand and its text's re-read without the
 * hand being any different (measured over 1 200 production hands and the
 * corpus): the per-action line number and verbatim line (the text is laid out
 * differently from the room's), WePlay's "dealt lines for every player" flag
 * (the text prints the hero's only), and the conversion time.
 */
export const COSMETIC_PATHS: readonly string[] = [
  "$.meta.parsedAt",
  "$.meta.textStyle.dealtLinesForAllPlayers",
  "$.actions[].sourceLine",
  "$.actions[].rawLine",
];

/**
 * Each site's `meta.siteName`, as its parser writes it: put back when the
 * text re-reads as another room (WePlay's text is GG-format). Held equal to
 * both registries by `tests/test/storedText.test.ts` and
 * `stored_text::tests::site_names_match_the_registry`.
 */
export const SITE_NAMES: Readonly<Record<string, string>> = {
  "888poker": "888poker",
  acrwpn: "ACR / Winning Poker Network",
  chico: "Chico Network (BetOnline / PayNoRake / ActionPoker / Gear Poker)",
  coinpoker: "CoinPoker",
  entraction: "Entraction",
  fulltilt: "Full Tilt Poker",
  ggpoker: "GGPoker",
  ignition: "Ignition / Bodog / Bovada",
  ipoker: "iPoker Network",
  microgaming: "MicroGaming Network",
  ongame: "Ongame Network",
  partypoker: "partypoker",
  pokerbros: "PokerBros",
  pokerstars: "PokerStars",
  runitonce: "Run It Once Poker",
  standard: "Rail standard",
  unibet: "Unibet Poker",
  weplay: "WePlay",
  winamax: "Winamax",
};

/** The columns of a `hands` row that a text-only hand is restored from. */
export interface StoredHandRow {
  hand_key: string;
  site: string;
  /** Null on a text-only row. */
  phf?: PhfHand | null;
  standard_text?: string | null;
  parser_version?: string | null;
  source_filename?: string | null;
  /** The room's original text, kept on some web rows; `meta.rawText` when present. */
  source_text?: string | null;
  /** The row's `created_at`: stands in for `meta.parsedAt`. */
  created_at?: string | null;
}

/** Parses one standard text; the first hand it yields, or none. */
export type ParseText = (text: string) => Promise<PhfHand | null> | PhfHand | null;

/** The JSON value of a hand: what the database stores and returns. */
function jsonOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The row the server stores for `hand` (the columns {@link restoreMeta}
 * reads), as `handInsertFromPhf` / `hand_row_from_phf` and the insert trigger
 * write them.
 */
export function storedColumnsOf(hand: PhfHand): StoredHandRow {
  const site = hand.meta.siteId.trim().toLowerCase();
  const filename = hand.meta.originalFilename?.trim() ?? "";
  return {
    hand_key: `${site}:${hand.meta.handKey || hand.meta.handId}`,
    site,
    parser_version: hand.meta.parserVersion || null,
    source_filename: filename === "" ? null : filename,
    source_text: hand.meta.rawText || null,
    created_at: null,
  };
}

function isoOf(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/**
 * A re-read hand with the provenance its text cannot carry put back from the
 * row: the room (`site`; its name and parser when the text read as another
 * room), the hand key, the parser version, the file name, the original text
 * and the time. Returns a new object.
 */
export function restoreMeta(parsed: PhfHand, row: StoredHandRow): PhfHand {
  const hand = jsonOf(parsed);
  const meta = hand.meta;
  const site = row.site;
  if (meta.siteId !== site) {
    meta.siteName = SITE_NAMES[site] ?? meta.siteName;
    meta.parserId = site;
  }
  meta.siteId = site;
  const prefix = `${site}:`;
  if (row.hand_key.startsWith(prefix)) {
    const key = row.hand_key.slice(prefix.length);
    if ((meta.handKey || meta.handId) !== key) {
      meta.handKey = key;
    }
  }
  meta.parserVersion = row.parser_version ?? "";
  meta.originalFilename = row.source_filename ?? null;
  meta.rawText = row.source_text ?? "";
  meta.parsedAt = isoOf(row.created_at, meta.parsedAt);
  return hand;
}

function cosmetic(path: string): boolean {
  return COSMETIC_PATHS.includes(path.replace(/\[\d+\]/g, "[]"));
}

/** JSON paths where `a` and `b` differ, `$`-rooted, cosmetic paths left out. */
export function phfDiffs(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (cosmetic(path)) {
    return out;
  }
  if (a === b) {
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}.length`);
      return out;
    }
    a.forEach((item, i) => phfDiffs(item, b[i], `${path}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      phfDiffs(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  out.push(path);
  return out;
}

/** The outcome of checking one hand's text. */
export interface TextCheck {
  /** The text, when it reads back as the hand; null otherwise. */
  text: string | null;
  /** What differed (empty when `text` is set), or why it could not be read. */
  diffs: string[];
}

/**
 * Whether `text` reads back as `hand`: parsed, restored from the columns the
 * server will store for `hand` (or, for a row already stored, from its
 * `columns`), and compared. The hand is taken as JSON (as sent), so
 * `undefined` fields count as absent.
 */
export async function checkStandardText(
  hand: PhfHand,
  text: string,
  parse: ParseText,
  columns?: StoredHandRow,
): Promise<TextCheck> {
  if (!text.trim()) {
    return { text: null, diffs: ["empty text"] };
  }
  let parsed: PhfHand | null;
  try {
    parsed = await parse(text);
  } catch (error) {
    return { text: null, diffs: [`parse threw: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!parsed) {
    return { text: null, diffs: ["the text did not parse to a hand"] };
  }
  const original = jsonOf(hand);
  const restored = restoreMeta(parsed, columns ?? storedColumnsOf(original));
  const diffs = phfDiffs(original, restored);
  return diffs.length === 0 ? { text, diffs } : { text: null, diffs };
}

/** {@link checkStandardText}'s text, or null: what a writer sends as `standard_text`. */
export async function verifiedStandardText(hand: PhfHand, text: string, parse: ParseText): Promise<string | null> {
  return (await checkStandardText(hand, text, parse)).text;
}

/**
 * The hand a stored row holds: its PHF, or - on a text-only row - its text
 * parsed and restored. Null when the row has neither, or the text no longer
 * parses (a parser regression; the row is still there).
 */
export async function handOfStoredRow(row: StoredHandRow, parse: ParseText): Promise<PhfHand | null> {
  if (row.phf) {
    return row.phf;
  }
  const text = row.standard_text ?? "";
  if (!text.trim()) {
    return null;
  }
  let parsed: PhfHand | null;
  try {
    parsed = await parse(text);
  } catch {
    return null;
  }
  return parsed ? restoreMeta(parsed, row) : null;
}
