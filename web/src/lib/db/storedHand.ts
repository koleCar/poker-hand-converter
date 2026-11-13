/**
 * The web's door to `lib/phf/storedText.ts` (`20271114090000_text_storage.sql`):
 * the parser it needs, wired to the conversion engine, for the writers (a
 * verified standard text, or none) and the readers (a stored row's hand,
 * parsed from its text when it has no PHF).
 *
 * The engine is imported on first use, so a page that only lists hands never
 * loads it; a reader pays for it only when a row is text-only.
 */

import { toStandardText } from "../phf/serialize";
import { handOfStoredRow, verifiedStandardText, type ParseText, type StoredHandRow } from "../phf/storedText";
import type { PhfHand } from "../phf/types";
import type { ConversionEngine } from "../wasm/engine";

export type { StoredHandRow };

/** One text through `engine`: exactly one hand, or none. */
export function parserOf(engine: ConversionEngine | Promise<ConversionEngine>): ParseText {
  return async (text) => {
    const result = await (await engine).convert(text);
    return result.hands.length === 1 ? result.hands[0] : null;
  };
}

/** The page's (or worker's) engine: the WebAssembly core, else the TypeScript parsers. */
export const engineParser: ParseText = async (text) => {
  const { conversionEngine } = await import("../wasm/engine");
  return parserOf(conversionEngine())(text);
};

/** The TypeScript parsers alone: for server code, where no `.wasm` is fetched. */
export const typescriptParser: ParseText = async (text) => {
  const { typescriptEngine } = await import("../wasm/engine");
  return parserOf(typescriptEngine())(text);
};

/** A hand as `ingest_hands` takes it: no original text (A2, Q4). */
export function ingestPhfOf(hand: PhfHand): PhfHand {
  return { ...hand, meta: { ...hand.meta, rawText: "" } };
}

/**
 * The standard text to store for `hand` (as sent), when it reads back as the
 * hand; null keeps the PHF. `text` defaults to `toStandardText(hand)`.
 */
export async function storableText(
  hand: PhfHand,
  parse: ParseText = engineParser,
  text: string = toStandardText(hand),
): Promise<string | null> {
  return verifiedStandardText(hand, text, parse);
}

/** A stored row's hand: its PHF, or its text parsed and restored. */
export async function handOfRow(row: StoredHandRow, parse: ParseText = engineParser): Promise<PhfHand | null> {
  return handOfStoredRow(row, parse);
}
