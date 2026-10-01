import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

export interface SampleFile {
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
  return entries
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        return walk(full);
      }
      // iPoker and the other XML networks are filed as `.xml`; the text rooms
      // as `.txt`. Everything else in a sample directory (SOURCES.md, notes)
      // is documentation and not a hand history.
      return /\.(?:txt|xml)$/i.test(name) ? [full] : [];
    });
}

/**
 * Every sample under `fixtures/samples/<site>`, recursively.
 *
 * Empty files are dropped: the harvested corpora contain a few placeholders
 * that hold nothing but a byte order mark, and they are not hands.
 */
export function sampleFiles(site: string): SampleFile[] {
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
