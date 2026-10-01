/**
 * Corpus loader for the Winamax and Chico suites.
 *
 * Kept separate from the other `support/*Corpus.ts` files for the same reason
 * they are separate from each other: these two sites need per-skin grouping,
 * which nothing else does.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

export interface P6File {
  /** File name only, as the UI would see it. */
  name: string;
  /** Path relative to the repository root, for readable test names. */
  relativePath: string;
  text: string;
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.sort().flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return walk(full);
    }
    return name.endsWith(".txt") ? [full] : [];
  });
}

export function sampleFiles(site: string): P6File[] {
  return walk(join(ROOT, "fixtures/samples", site))
    .map((path) => ({
      name: path.split("/").pop()!,
      relativePath: relative(ROOT, path),
      text: readFileSync(path, "utf8"),
    }))
    .filter((file) => file.text.trim().length > 0);
}

/** Every sample directory except the ones named, for cross-detection tests. */
export function otherSampleSites(exclude: string[]): string[] {
  const base = join(ROOT, "fixtures/samples");
  return readdirSync(base)
    .filter((name) => statSync(join(base, name)).isDirectory())
    .filter((name) => !exclude.includes(name))
    .sort();
}

/**
 * Chico skin brand strings, in the order the parser trusts them.
 *
 * The first four are each backed by real fixture bytes. The last two are named
 * by the network and by fpdb-3's own regex but no hand bearing either string
 * could be obtained, so no test can assert anything about them beyond the fact
 * that the parser does not pretend otherwise.
 */
export const CHICO_CONFIRMED_SKINS = [
  "BetOnline Poker",
  "PayNoRake",
  "ActionPoker.com",
  "Gear Poker",
] as const;

export const CHICO_INFERRED_SKINS = ["SportsBetting.ag Poker", "Tiger Gaming"] as const;

/**
 * Which skin a file is written in, decided from the header line rather than
 * from the directory it sits in.
 *
 * The p2 suite does the same thing and it caught genuinely mislabelled upstream
 * fixtures; the Winamax corpus already contains one file whose name claims a
 * game type the bytes do not have, so the folder is not evidence here either.
 */
export function chicoSkinOf(text: string): string | null {
  const header = text.split(/\r?\n/).find((line) => / Game #\d+:/.test(line));
  if (!header) {
    return null;
  }
  return (
    [...CHICO_CONFIRMED_SKINS, ...CHICO_INFERRED_SKINS].find((skin) =>
      header.startsWith(`${skin} Game #`),
    ) ?? null
  );
}

/** True when a file's own bytes say it is a Winamax export. */
export function isWinamaxText(text: string): boolean {
  return /^﻿?Winamax Poker - /m.test(text);
}
