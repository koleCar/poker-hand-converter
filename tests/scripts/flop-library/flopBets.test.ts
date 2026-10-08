/**
 * Writes `frontend/src/lib/learn/data/flop-bets.json` (Learn L2): how often
 * the preflop raiser bets the flop on every flop of the full library, for the
 * lines in `FLOP_BET_SPOTS`, read at the raiser's first decision. Rail's own
 * solves only; `tests/test/flopBets.test.ts` recomputes every row the
 * committed pilot holds.
 *
 *     cd tests && FLOPLIB_DIR=/path/to/out npm run floplib:bets
 *
 * `FLOPLIB_DIR` holds `<set>/<tree>/manifest.json` and the chunks, as the
 * batch runner writes them. Reading 300 chunks takes a few seconds.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { FLOP_PROFILE } from "../../../frontend/src/lib/analysis/index.js";
import { loadCharts } from "../../../frontend/src/lib/charts/index.js";
import { FLOP_BET_SPOTS, flopBetRow, type FlopBetData, type FlopBetRow } from "../../../frontend/src/lib/learn/flopBets.js";
import { decodeChunk, type FlopManifest } from "../../../frontend/src/lib/solver/index.js";

const DIR = process.env.FLOPLIB_DIR ?? "";
const OUT = join(import.meta.dirname, "../../../frontend/src/lib/learn/data/flop-bets.json");
const CHARTS = loadCharts(JSON.parse(readFileSync(join(import.meta.dirname, "../../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")));

it.runIf(DIR !== "")("writes the raiser's flop bet frequencies from the full library", () => {
  const root = join(DIR, CHARTS.id, FLOP_PROFILE.tree);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as FlopManifest;
  expect(manifest.charts.hash).toBe(CHARTS.model.hash);
  const lines = {} as FlopBetData["lines"];
  for (const { line, path } of FLOP_BET_SPOTS) {
    const rows: FlopBetRow[] = [];
    for (const entry of manifest.entries.filter((e) => e.line === line)) {
      const file = join(root, entry.path);
      if (!existsSync(file)) continue;
      const row = flopBetRow(decodeChunk(readFileSync(file)), path);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => a.flop.localeCompare(b.flop));
    expect(rows.length, line).toBeGreaterThanOrEqual(90);
    lines[line] = rows;
  }
  const data: FlopBetData = { set: CHARTS.id, hash: CHARTS.model.hash, tree: FLOP_PROFILE.tree, lines };
  writeFileSync(OUT, `${JSON.stringify(data)}\n`);
  console.log(`wrote ${OUT}: ${Object.values(lines).reduce((n, rows) => n + rows.length, 0)} rows`);
});
