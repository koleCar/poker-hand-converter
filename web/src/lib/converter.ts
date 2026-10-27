/**
 * Legacy converter facade.
 *
 * `convertCashWeplayFile` is what the Converter tab and the replayer upload box
 * still call, and it has to stay synchronous, so it drives the WePlay parser
 * and the standard-text serializer directly instead of going through the async
 * `convertAny` (which hashes failures with Web Crypto).
 *
 * New code should call `convertAny` from `lib/parsers` - it detects the site,
 * handles every registered format, validates, and returns structured failures
 * ready for the database. This file exists so the UI keeps working while it
 * migrates, and can be deleted afterwards.
 */

import { ParseSkip } from "./phf/detect";
import { toStandardText } from "./phf/serialize";
import type { PhfHand } from "./phf/types";
import { validateHand } from "./phf/validate";
import { weplayParser } from "./parsers/weplay";

export type FileStatus = "converted" | "failed";

export interface ConvertedFile {
  inputFileName: string;
  outputFileName: string;
  handCount: number;
  warningCount: number;
  warnings: string[];
  status: FileStatus;
  message?: string;
  outputText: string;
  /** The converted hands as PHF; new consumers should read this. */
  hands: PhfHand[];
}

function outputNameFor(fileName: string): string {
  return `${fileName.replace(/\.txt$/i, "")}.gg.txt`;
}

/**
 * Converts a WePlay file to standard text, cash hands only.
 *
 * Tournaments, bomb pots, Omaha and structurally broken hands are skipped and
 * reported in `warnings`, which is the behaviour the Converter tab expects.
 */
export function convertCashWeplayFile(fileName: string, input: string): ConvertedFile {
  const chunks = weplayParser.splitHands(input);

  if (chunks.length === 0) {
    return {
      inputFileName: fileName,
      outputFileName: outputNameFor(fileName),
      handCount: 0,
      warningCount: 0,
      warnings: [],
      status: "failed",
      message: "The file does not look like a WePlay hand history.",
      outputText: "",
      hands: [],
    };
  }

  const hands: PhfHand[] = [];
  const warnings: string[] = [];
  const skipCounts = new Map<string, number>();

  for (const chunk of chunks) {
    const header = chunk.split(/\r?\n/)[0] ?? "";
    try {
      const hand = weplayParser.parseHand(chunk, {
        sourceFilename: fileName,
        options: { cashOnly: true, skipBombPots: true, sourceFilename: fileName },
      });
      const report = validateHand(hand);
      if (!report.ok) {
        const reason = report.errors[0]?.code ?? "invalid-hand";
        skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
        warnings.push(`Skipped hand (${report.errors[0]?.message ?? reason}): ${header}`);
        continue;
      }
      hands.push(hand);
    } catch (error) {
      const reason = error instanceof ParseSkip ? error.reason : "parser-error";
      const message = error instanceof Error ? error.message : String(error);
      skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
      warnings.push(`Skipped hand (${message}): ${header}`);
    }
  }

  for (const [reason, count] of skipCounts) {
    warnings.push(`Skipped ${count} hand(s): ${reason}`);
  }

  if (hands.length === 0) {
    return {
      inputFileName: fileName,
      outputFileName: outputNameFor(fileName),
      handCount: 0,
      warningCount: warnings.length,
      warnings,
      status: "failed",
      message: "No convertible cash hands were found in this file.",
      outputText: "",
      hands: [],
    };
  }

  return {
    inputFileName: fileName,
    outputFileName: outputNameFor(fileName),
    handCount: hands.length,
    warningCount: warnings.length,
    warnings,
    status: "converted",
    outputText: hands.map((hand) => toStandardText(hand)).join("\n\n"),
    hands,
  };
}
