// Step 3 of the whole-corpus scrub check -- see scripts/scrub-corpus/README.md.
// Reads the originals and the scrub_phf() output and fails loudly on anything
// that survived: a screen name, the table, the room's hand or tournament id,
// the time of day, the filename -- and on any document the serializer or the
// replayer cannot handle.
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { toStandardText } from "../../../frontend/src/lib/phf/serialize.js";
import { buildReplay } from "../../../frontend/src/lib/replay.js";

const [corpusPath, scrubbedPath] = process.argv.slice(2);
const originals = new Map<number, any>();
for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
  if (!line) continue;
  const row = JSON.parse(line);
  originals.set(row.id, row.phf);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(name)}($|[^\\p{L}\\p{N}_])`, "u");
function strings(v: any, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}
const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const examples: Record<string, string> = {};
const note = (k: string, ex: string) => { bump(k); examples[k] ??= ex; };

const rl = createInterface({ input: createReadStream(scrubbedPath) });
for await (const line of rl) {
  if (!line) continue;
  const row = JSON.parse(line);
  const orig = originals.get(row.id);
  const doc = row.phf;
  const tag = `${row.mode}`;
  bump(`${tag}:total`);
  if (!row.ok) note(`${tag}:not-scrubbed`, `#${row.id}`);
  let text = "";
  try { text = toStandardText(doc); } catch (e) { note(`${tag}:serialize-throws`, `#${row.id} ${e}`); }
  try { const frames = buildReplay(doc); if (!frames.length) note(`${tag}:no-frames`, `#${row.id}`); } catch (e) { note(`${tag}:replay-throws`, `#${row.id} ${e}`); }

  const haystack = [...strings(doc), text];
  // Provenance that must never survive, in any mode.
  const tableName = orig.table?.name;
  if (tableName && tableName.length >= 3 && haystack.some((s) => s.includes(tableName))) note(`${tag}:table-name`, `#${row.id} ${tableName}`);
  const handId = orig.meta?.handId;
  if (handId && handId.length >= 5 && haystack.some((s) => s.includes(handId))) note(`${tag}:hand-id`, `#${row.id} ${handId}`);
  const tid = orig.tournament?.id;
  if (tid && tid.length >= 4 && haystack.some((s) => s.includes(tid))) note(`${tag}:tournament-id`, `#${row.id} ${tid}`);
  if (orig.playedAt) {
    const hhmmss = orig.playedAt.slice(11, 19);
    if (/\d\d:\d\d:\d\d/.test(hhmmss) && hhmmss !== "00:00:00" && haystack.some((s) => s.includes(hhmmss))) note(`${tag}:time-of-day`, `#${row.id} ${hhmmss}`);
  }
  const fn = orig.meta?.originalFilename;
  if (fn && haystack.some((s) => s.includes(fn))) note(`${tag}:filename`, `#${row.id}`);

  // Names, in the anonymising modes.
  if (row.mode !== "as-imported" && row.anonymization !== "positional") {
    const replacements = new Set(doc.players.map((p: any) => p.name));
    for (const p of orig.players) {
      if (!p.name || replacements.has(p.name)) continue;
      const re = token(p.name);
      const hit = haystack.find((s) => re.test(s));
      if (hit) note(`${tag}:name-survives`, `#${row.id} "${p.name}" in "${hit.slice(0, 120)}"`);
    }
  }
}
console.log(JSON.stringify(counts, null, 1));
console.log(JSON.stringify(examples, null, 1));
const failures = Object.keys(counts).filter((k) => !k.endsWith(":total"));
if (failures.length) {
  console.error(`FAIL: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("OK: nothing identifying survived, and every document serializes and replays.");
