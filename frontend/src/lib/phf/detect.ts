/**
 * Site detection, the parser plugin contract, and the one entry point the rest
 * of the app should use: `convertAny`.
 *
 * Adding support for a new poker room means writing one file in
 * `frontend/src/lib/parsers/<site>.ts` that exports a `SiteParser`, and adding
 * one `registerParser` call in `frontend/src/lib/parsers/index.ts`. Nothing
 * else in the codebase changes.
 */

import { assignPositions, type PhfHand } from "./types";
import { validateHand, type ValidationReport } from "./validate";

/** Options threaded from the caller down to the individual site parsers. */
export interface ConvertOptions {
  /** Name of the uploaded file, used for provenance and failure records. */
  sourceFilename?: string | null;
  /** Skip tournament hands. The legacy converter tab is cash-only. */
  cashOnly?: boolean;
  /** Skip bomb-pot hands. Kept because the legacy output shape excluded them. */
  skipBombPots?: boolean;
  /** Run the validator and turn hard errors into failures. Default true. */
  validate?: boolean;
  /** Force a specific parser instead of detecting one. */
  siteId?: string;
}

export interface SiteParserContext {
  sourceFilename: string | null;
  options: ConvertOptions;
}

/**
 * The contract every site parser implements.
 *
 * `detect` is deliberately cheap and total: it must never throw and must never
 * be expensive, because it runs against every candidate parser for every
 * upload. Do the real work in `parseHand`.
 */
export interface SiteParser {
  /** Stable machine id; stored in `PhfHand.meta.siteId` and in the database. */
  readonly id: string;
  /** Human readable name for the UI. */
  readonly name: string;
  /** Bumped when the parser's behaviour changes; recorded on every hand. */
  readonly version: string;
  /**
   * Confidence in 0..1 that this text came from this site.
   *
   * 0 means "definitely not mine". Anything above `DETECTION_THRESHOLD` is
   * treated as a real candidate. Return a *graded* score rather than 0/1 so the
   * registry can pick the best of several plausible matches.
   */
  detect(text: string): number;
  /**
   * Splits a file into individual hand chunks. Sites differ: some separate with
   * blank lines, some repeat a header, some use a separator line.
   */
  splitHands(text: string): string[];
  /**
   * Parses one chunk. Throw `ParseSkip` for a hand that is recognised but
   * cannot or should not be converted; throw anything else for a real bug.
   */
  parseHand(raw: string, ctx: SiteParserContext): PhfHand;
}

/** Scores at or above this are considered a match. */
export const DETECTION_THRESHOLD = 0.2;

/* ---------------------------------------------------------------- failures - */

export interface ConversionFailure {
  /** sha-256 hex of the whitespace-normalized raw text; dedupe key */
  fingerprint: string;
  rawText: string;
  detectedSite: string | null;
  detectionConfidence: number | null;
  stage: "split" | "detect" | "parse" | "validate" | "serialize";
  /** short machine code, e.g. "unknown-site", "unsupported-variant", "chip-mismatch" */
  reason: string;
  /** human readable, shown in the UI */
  message: string;
  parserVersion: string;
  sourceFilename: string | null;
}

/**
 * Thrown by a parser for a hand it recognises but refuses to convert.
 *
 * The distinction matters: a `ParseSkip` becomes a stored `ConversionFailure`
 * that we can write a converter for later, while an unexpected exception is a
 * bug in our code and is reported as such.
 */
export class ParseSkip extends Error {
  readonly reason: string;
  readonly stage: ConversionFailure["stage"];

  constructor(reason: string, message: string, stage: ConversionFailure["stage"] = "parse") {
    super(message);
    this.name = "ParseSkip";
    this.reason = reason;
    this.stage = stage;
  }
}

/* ---------------------------------------------------------------- registry - */

const registry = new Map<string, SiteParser>();

export function registerParser(parser: SiteParser): void {
  registry.set(parser.id, parser);
}

/** Mostly for tests; removes a parser from the registry. */
export function unregisterParser(id: string): void {
  registry.delete(id);
}

export function getParsers(): SiteParser[] {
  return [...registry.values()];
}

export function getParser(id: string): SiteParser | undefined {
  return registry.get(id);
}

export interface DetectionCandidate {
  parser: SiteParser;
  confidence: number;
}

/** Every parser that claims the text, best first. */
export function detectSite(text: string): DetectionCandidate[] {
  const out: DetectionCandidate[] = [];
  for (const parser of registry.values()) {
    let confidence = 0;
    try {
      confidence = parser.detect(text);
    } catch {
      confidence = 0;
    }
    if (confidence >= DETECTION_THRESHOLD) {
      out.push({ parser, confidence });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/* ------------------------------------------------------------- fingerprint - */

/**
 * Collapses runs of whitespace and trims, so that a file re-saved with CRLF
 * line endings or a trailing newline fingerprints the same as the original.
 */
export function normalizeForFingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Synchronous fallback used only when Web Crypto is unavailable (very old
 * browsers, or a non-secure context). It is a 128-bit FNV-1a mix, not sha-256,
 * so it is prefixed to make the difference obvious in stored rows.
 */
export function fingerprintSync(text: string): string {
  const input = normalizeForFingerprint(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (code + i), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 + (code << (i % 13)), 0x27d4eb2f) >>> 0;
  }
  const part = (value: number) => value.toString(16).padStart(8, "0");
  return `fnv1a128-${part(h1)}${part(h2)}${part(h3)}${part(h4)}`;
}

/** sha-256 hex of the whitespace-normalized text; the dedupe key for failures. */
export async function fingerprint(text: string): Promise<string> {
  const input = normalizeForFingerprint(text);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return fingerprintSync(text);
  }
  try {
    const bytes = new TextEncoder().encode(input);
    return hex(await subtle.digest("SHA-256", bytes));
  } catch {
    return fingerprintSync(text);
  }
}

/* --------------------------------------------------------------- pipeline - */

export interface ConversionResult {
  hands: PhfHand[];
  failures: ConversionFailure[];
  stats: { total: number; converted: number; failed: number; bySite: Record<string, number> };
}

/** A hand that converted, paired with whatever the validator had to say. */
export interface ConvertedHand {
  hand: PhfHand;
  report: ValidationReport;
}

/**
 * Raw text in, PHF out.
 *
 * Splits the upload into hands, detects the site for each chunk (files can be
 * mixed, and a chunk is more reliable evidence than a whole file), parses,
 * validates, and reports everything that did not make it in a shape the
 * database agent can insert directly.
 */
export async function convertAny(
  text: string,
  opts: ConvertOptions = {},
): Promise<ConversionResult> {
  const sourceFilename = opts.sourceFilename ?? null;
  const hands: PhfHand[] = [];
  const failures: ConversionFailure[] = [];
  const bySite: Record<string, number> = {};

  async function fail(
    rawText: string,
    stage: ConversionFailure["stage"],
    reason: string,
    message: string,
    parser: SiteParser | null,
    confidence: number | null,
  ): Promise<void> {
    failures.push({
      fingerprint: await fingerprint(rawText),
      rawText,
      detectedSite: parser?.id ?? null,
      detectionConfidence: confidence,
      stage,
      reason,
      message,
      parserVersion: parser?.version ?? "0",
      sourceFilename,
    });
  }

  const forced = opts.siteId ? getParser(opts.siteId) : undefined;
  if (opts.siteId && !forced) {
    await fail(text, "detect", "unknown-site", `No parser registered for "${opts.siteId}".`, null, null);
    return { hands, failures, stats: { total: 1, converted: 0, failed: 1, bySite } };
  }

  const candidates = forced
    ? [{ parser: forced, confidence: 1 }]
    : detectSite(text);

  if (candidates.length === 0) {
    await fail(
      text,
      "detect",
      "unknown-site",
      "The text does not match any hand history format we recognise.",
      null,
      null,
    );
    return { hands, failures, stats: { total: 1, converted: 0, failed: 1, bySite } };
  }

  const primary = candidates[0];
  let chunks: string[];
  try {
    chunks = primary.parser.splitHands(text);
  } catch (error) {
    await fail(
      text,
      "split",
      "split-failed",
      error instanceof Error ? error.message : String(error),
      primary.parser,
      primary.confidence,
    );
    return { hands, failures, stats: { total: 1, converted: 0, failed: 1, bySite } };
  }

  if (chunks.length === 0) {
    await fail(
      text,
      "split",
      "no-hands",
      `${primary.parser.name} recognised the file but found no hands in it.`,
      primary.parser,
      primary.confidence,
    );
    return { hands, failures, stats: { total: 1, converted: 0, failed: 1, bySite } };
  }

  for (const chunk of chunks) {
    // Per-chunk detection: an export can genuinely mix formats, and one hand is
    // a stronger signal than the surrounding file.
    const perChunk = forced ? candidates : detectSite(chunk);
    const chosen = perChunk[0] ?? primary;

    let hand: PhfHand;
    try {
      hand = chosen.parser.parseHand(chunk, {
        sourceFilename,
        options: opts,
      });
    } catch (error) {
      if (error instanceof ParseSkip) {
        await fail(chunk, error.stage, error.reason, error.message, chosen.parser, chosen.confidence);
      } else {
        await fail(
          chunk,
          "parse",
          "parser-error",
          error instanceof Error ? error.message : String(error),
          chosen.parser,
          chosen.confidence,
        );
      }
      continue;
    }

    // Positions are resolved centrally rather than per parser, so that every
    // site agrees and a new parser cannot get the ring wrong on its own.
    assignPositions(hand);

    if (opts.validate !== false) {
      const report = validateHand(hand);
      if (!report.ok) {
        const first = report.errors[0];
        await fail(
          chunk,
          "validate",
          first?.code ?? "invalid-hand",
          report.errors.map((problem) => problem.message).join("; "),
          chosen.parser,
          chosen.confidence,
        );
        continue;
      }
    }

    hands.push(hand);
    bySite[chosen.parser.id] = (bySite[chosen.parser.id] ?? 0) + 1;
  }

  return {
    hands,
    failures,
    stats: {
      total: chunks.length,
      converted: hands.length,
      failed: failures.length,
      bySite,
    },
  };
}
