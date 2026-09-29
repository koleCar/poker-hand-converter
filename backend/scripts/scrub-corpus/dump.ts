// Step 1 of the whole-corpus scrub check -- see scripts/scrub-corpus/README.md.
// Parses every real hand history in the repo and writes one PHF document per
// line: {id, file, anonymization, phf}.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import { detectAnonymization } from "../../../frontend/src/lib/db/anonymization.js";

const ROOT = join(import.meta.dirname, "../../..");
const OUT = process.argv[2];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = ["fixtures/samples", "gg-hh", "weplay-hh"].flatMap((d) => walk(join(ROOT, d)));
const lines: string[] = [];
let n = 0;
for (const f of files) {
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const result = await convertAny(text, { sourceFilename: relative(ROOT, f) });
  for (const hand of result.hands) {
    n++;
    lines.push(JSON.stringify({ id: n, file: relative(ROOT, f), anonymization: detectAnonymization(hand), phf: hand }));
  }
}
writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`files=${files.length} hands=${n}`);
