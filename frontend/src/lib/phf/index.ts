/**
 * Public entry point for PHF.
 *
 * Importing this module also registers the built-in site parsers, so
 * `convertAny` and `detectSite` work without the caller knowing which parsers
 * exist.
 */

import "../parsers";

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
