/**
 * Corpus loaders for the PokerStars / GGPoker suites.
 *
 * Kept out of `support/corpus.ts` on purpose: that file is shared with the other
 * parser suites, and these two sites read whole directory trees rather than one
 * flat folder.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

export interface CorpusFile {
  /** File name only, as the UI would see it. */
  name: string;
  /** Path relative to the repository root, for readable test names. */
  relativePath: string;
  text: string;
}

/** Every `.txt` under `dir`, recursively, sorted for stable test names. */
export function readTree(dir: string, prefix: string): CorpusFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    // A sample directory the research agent has not filled in yet.
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return readTree(path, `${prefix}/${name}`);
    }
    if (!name.endsWith(".txt")) {
      return [];
    }
    return [{ name, relativePath: `${prefix}/${name}`, text: readFileSync(path, "utf8") }];
  });
}

/** A sample directory under `fixtures/samples/`. */
export function sampleFiles(site: string): CorpusFile[] {
  return readTree(join(ROOT, "fixtures/samples", site), `fixtures/samples/${site}`);
}

/** Fixtures added by these suites, each one recording a specific real bug. */
export function ownFixtures(site: string): CorpusFile[] {
  return readTree(join(import.meta.dirname, "../fixtures", site), `backend/test/fixtures/${site}`);
}

/** Every reference GG-format export in `gg-hh/`. */
export function ggCorpusFiles(): CorpusFile[] {
  return readTree(join(ROOT, "gg-hh"), "gg-hh");
}

/**
 * Sample directories that belong to somebody else.
 *
 * A parser claiming one of these is worse than a parser that fails to claim its
 * own, because the hand is then silently converted by the wrong grammar.
 */
export const FOREIGN_SITES = [
  "888poker",
  "bossmedia",
  "coinpoker",
  "entraction",
  "ipoker",
  "merge",
  "microgaming",
  "ongame",
  "partypoker",
  "unibet",
  "weplay",
  "wpt-global",
];
