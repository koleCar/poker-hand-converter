/**
 * Public entry point for PHF.
 *
 * Importing this module also registers the built-in site parsers, so
 * `convertAny` and `detectSite` work without the caller knowing which parsers
 * exist.
 */

import "../parsers";
import { parseStandardHand, splitStandardHands } from "./serialize";
import type { PhfHand } from "./types";

export * from "./types";
export * from "./validate";
export {
  STANDARD_TEXT_PARSER_VERSION,
  formatPlayedAt,
  parseStandardHand,
  parseStandardText,
  splitStandardHands,
  toStandardText,
  toStandardTextFile,
  type SerializeOptions,
} from "./serialize";
export {
  convertAny,
  detectSite,
  fingerprint,
  fingerprintSync,
  getParser,
  getParsers,
  normalizeForFingerprint,
  registerParser,
  unregisterParser,
  ParseSkip,
  DETECTION_THRESHOLD,
  type ConversionFailure,
  type ConversionResult,
  type ConvertOptions,
  type DetectionCandidate,
  type SiteParser,
  type SiteParserContext,
} from "./detect";

/* ------------------------------------------------- standard-text shortcuts - */

/*
 * The four helpers below are what is left of `lib/handParser.ts`, the legacy
 * `ParsedHand` facade that the replayer was built on. Everything that made it
 * a second representation of a hand - a flattened seat list, a narrowed action
 * vocabulary, winners merged back together through `Math.round(x * 100) / 100`
 * and a cashout amount recovered by regexing a description string - is gone;
 * these are just convenience wrappers over the standard-text serializer, kept
 * at their old names because they read better at the call site than
 * `splitStandardHands` / `parseStandardHand` with a context object.
 */

/** Splits a multi-hand file of standard-format text into individual chunks. */
export function splitHands(text: string): string[] {
  return splitStandardHands(text);
}

export function looksLikeHandHistory(text: string): boolean {
  return splitHands(text).length > 0;
}

export function isGgFormat(text: string): boolean {
  return /^Poker\s+Hand\s+#/im.test(text);
}

export function isWeplayFormat(text: string): boolean {
  return /^﻿?Weplay\s+Hand\s+#/im.test(text);
}

/** Parses one standard-format hand chunk. Returns null for anything else. */
export function parseHand(text: string): PhfHand | null {
  return parseStandardHand(text, {
    siteId: "standard",
    siteName: "Rail standard",
    originalFilename: null,
  });
}
