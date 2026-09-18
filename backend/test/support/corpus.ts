import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

export interface CorpusFile {
  /** File name only, as the UI would see it. */
  name: string;
  /** Path relative to the repository root, for readable test names. */
  relativePath: string;
  text: string;
}

function readDirFiles(dir: string, prefix: string): CorpusFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((name) => ({
      name,
      relativePath: `${prefix}/${name}`,
      text: readFileSync(join(dir, name), "utf8"),
    }));
}

/** Every reference GG-format file in `gg-hh/`. */
export function ggFiles(): CorpusFile[] {
  return readDirFiles(join(ROOT, "gg-hh"), "gg-hh");
}

/** Every WePlay export in `weplay-hh/`, across both account folders. */
export function weplayFiles(): CorpusFile[] {
  const base = join(ROOT, "weplay-hh");
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => readDirFiles(join(base, entry.name), `weplay-hh/${entry.name}`));
}

/** WePlay fixtures, each of which exists because of a specific real bug. */
export function weplayFixtures(): CorpusFile[] {
  return readDirFiles(join(import.meta.dirname, "../fixtures/weplay"), "fixtures/weplay");
}
