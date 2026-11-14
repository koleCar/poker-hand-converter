#!/usr/bin/env node
/**
 * The text-storage backfill (`20271114090000_text_storage.sql`): which stored
 * hands may drop their PHF for their standard text, and with which text.
 *
 *   node tests/scripts/text-storage/backfill.mjs [--in rows.jsonl] [--out results.jsonl]
 *
 * (Node 22.18+ / 24: it imports the web's `storedText.ts` with Node's own
 * type stripping.) Reads JSON lines from `--in` (default stdin), one `hands`
 * row each:
 *
 *   {"id": "<uuid>", "phf": {...}, "site": "weplay", "parser_version": "2.3.0",
 *    "source_filename": "x.txt" | null,
 *    // optional - when present they are what the row is restored from:
 *    "hand_key": "weplay:123", "source_text": "..." | null, "standard_text": "..." | null}
 *
 * and writes one JSON line per input line to `--out` (default stdout), in
 * input order:
 *
 *   {"id": "<uuid>", "ok": true,  "standard_text": "...", "source": "stored" | "serialized", "diffs": []}
 *   {"id": "<uuid>", "ok": false, "standard_text": null,  "source": null, "diffs": ["$.actions[3].amount", ...]}
 *
 * Every `ok` row was verified: its text was parsed back by the committed
 * WebAssembly core (`web/src/lib/wasm/rail-core`, the readers' parser), the
 * provenance restored from the row's own columns (`restoreMeta`), and the
 * result compared with the stored PHF field by field, ignoring only
 * `COSMETIC_PATHS` (per-action line numbers and verbatim lines, WePlay's
 * dealt-lines flag, `meta.parsedAt`). A row's existing `standard_text` (web
 * rows have one) is tried first, so a verified row keeps the exact text it
 * was downloaded as; otherwise the core's `serialize` renders a new one. A
 * row that fails both is `ok: false` and **must keep its PHF**; its `diffs`
 * say why. A line that is not JSON, or has no PHF, is `ok: false` too (with
 * `id` null when it has none).
 *
 * Apply the `ok` rows with `public.hands_store_text(p_rows)` (service role,
 * batches of up to 1000 `{id, standard_text}`): it fills `table_set`,
 * snapshots the hand's share links, then stores the text and nulls the PHF,
 * in that order, and skips a row whose PHF is already gone.
 *
 * A summary goes to stderr: rows read, verified (by site), kept as PHF (by
 * site and first differing path).
 */

import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { checkStandardText, storedColumnsOf } from "../../../web/src/lib/phf/storedText.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const WASM = join(ROOT, "web/src/lib/wasm/rail-core");

function argument(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

/** The committed core, instantiated from its bytes (no fetch under Node). */
export async function loadCore() {
  const glue = await import(join(WASM, "rail_core_wasm.js"));
  await glue.default({ module_or_path: readFileSync(join(WASM, "rail_core_wasm_bg.wasm")) });
  return glue;
}

const encoder = new TextEncoder();
const OPTIONS = JSON.stringify({ parsedAt: "1970-01-01T00:00:00.000Z", standardText: false });

/** The readers' parse: one text, exactly one hand, or none. */
export function parserOf(core) {
  return (text) => {
    const doc = JSON.parse(core.convert(encoder.encode(text), "", OPTIONS));
    return doc.hands?.length === 1 ? doc.hands[0].phf : null;
  };
}

/** The columns a row is restored from: the row's own where given, else the PHF's. */
function columnsOf(row) {
  const columns = storedColumnsOf(row.phf);
  for (const key of ["hand_key", "site", "parser_version", "source_filename", "source_text"]) {
    if (key in row) {
      columns[key] = row[key] ?? null;
    }
  }
  return columns;
}

/** One input row to its result line. */
export async function backfillRow(row, core, parse = parserOf(core)) {
  const id = typeof row?.id === "string" ? row.id : null;
  if (!row || typeof row.phf !== "object" || row.phf === null || typeof row.phf.meta !== "object") {
    return { id, ok: false, standard_text: null, source: null, diffs: ["no PHF"] };
  }
  const columns = columnsOf(row);
  const attempts = [];
  if (typeof row.standard_text === "string" && row.standard_text.trim()) {
    attempts.push(["stored", row.standard_text]);
  }
  try {
    attempts.push(["serialized", core.serialize(JSON.stringify(row.phf))]);
  } catch (error) {
    attempts.push(["serialized", null, `serialize threw: ${error instanceof Error ? error.message : String(error)}`]);
  }
  let diffs = [];
  for (const [source, text, failure] of attempts) {
    if (text === null) {
      diffs = [failure];
      continue;
    }
    const check = await checkStandardText(row.phf, text, parse, columns);
    if (check.text !== null) {
      return { id, ok: true, standard_text: check.text, source, diffs: [] };
    }
    diffs = check.diffs;
  }
  return { id, ok: false, standard_text: null, source: null, diffs };
}

async function main() {
  const input = argument("--in");
  const output = argument("--out");
  const core = await loadCore();
  const parse = parserOf(core);
  const lines = createInterface({ input: input ? createReadStream(input) : process.stdin, crlfDelay: Infinity });
  const out = output ? createWriteStream(output) : process.stdout;
  const summary = { read: 0, verified: 0, kept: 0, verifiedBySite: {}, keptBySite: {}, keptByPath: {} };
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    summary.read += 1;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      row = null;
    }
    const result = row === null
      ? { id: null, ok: false, standard_text: null, source: null, diffs: ["not JSON"] }
      : await backfillRow(row, core, parse);
    const site = String(row?.site ?? row?.phf?.meta?.siteId ?? "?");
    if (result.ok) {
      summary.verified += 1;
      summary.verifiedBySite[site] = (summary.verifiedBySite[site] ?? 0) + 1;
    } else {
      summary.kept += 1;
      summary.keptBySite[site] = (summary.keptBySite[site] ?? 0) + 1;
      const first = (result.diffs[0] ?? "?").replace(/\[\d+\]/g, "[]");
      summary.keptByPath[first] = (summary.keptByPath[first] ?? 0) + 1;
    }
    if (!out.write(`${JSON.stringify(result)}\n`)) {
      await new Promise((resolve) => out.once("drain", resolve));
    }
  }
  if (output) {
    await new Promise((resolve) => out.end(resolve));
  }
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
