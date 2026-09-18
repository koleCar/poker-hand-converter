/**
 * Corpus loader for the Unibet suite.
 *
 * Kept apart from `p2Corpus.ts` for one reason: Unibet is the only room in the
 * project whose real exports are not reliably UTF-8. The same hand exists
 * upstream in two byte encodings, so this loader hands a test the *bytes* as
 * well as a UTF-8 reading of them, and supplies the Windows-1252 decoder that
 * the app's upload path does not currently try.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

export interface CorpusFile {
  /** File name only, as the UI would see it. */
  name: string;
  /** Path relative to the repository root, for readable test names. */
  relativePath: string;
  /** The file decoded as UTF-8, which is what the app's upload path produces. */
  text: string;
  bytes: Uint8Array;
}

function walk(dir: string): string[] {
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
      return walk(path);
    }
    return /\.(?:txt|xml)$/i.test(name) ? [path] : [];
  });
}

/** Every sample under `fixtures/samples/<site>`, recursively. */
export function sampleFiles(site: string): CorpusFile[] {
  return walk(join(ROOT, "fixtures/samples", site))
    .map((path) => {
      const bytes = new Uint8Array(readFileSync(path));
      return {
        name: path.split("/").pop()!,
        relativePath: relative(ROOT, path),
        text: new TextDecoder("utf-8").decode(bytes),
        bytes,
      };
    })
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
 * The 32 code points Windows-1252 puts where ISO-8859-1 has C1 controls.
 *
 * Node's own `TextDecoder("windows-1252")` does not return a string on every
 * build this project is run on, so the mapping is spelled out. `0x81`, `0x8D`,
 * `0x8F`, `0x90` and `0x9D` are unassigned and stay where they are.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Decodes bytes as Windows-1252, which is what the 2021-era exports are in. */
export function decodeCp1252(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte);
  }
  return out;
}
