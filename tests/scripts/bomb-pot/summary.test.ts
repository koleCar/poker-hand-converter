/**
 * Bomb pot study, step 3: `bombSummary` over a local export, for comparing
 * with the study's own numbers (ANALYSIS-PLAN §10, 2026-11-19).
 *
 *     cd tests && BOMB_HANDS=/path/hands.jsonl npx vitest run --config scripts/bomb-pot/vitest.config.ts summary
 */
import { readFileSync } from "node:fs";
import { it } from "vitest";

import { bombSummary } from "../../../web/src/lib/analysis/potKinds.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";

it("sums the bomb pots", () => {
  const file = process.env.BOMB_HANDS;
  if (!file) throw new Error("set BOMB_HANDS");
  const hands = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PhfHand);
  const s = bombSummary(hands);
  const pct = (r: { n: number; hits: number }) => `${((100 * r.hits) / Math.max(1, r.n)).toFixed(0)}% of ${r.n}`;
  console.log(`hands ${s.hands} net ${s.netBb.toFixed(0)} sd ${s.showdownBb.toFixed(0)} nsd ${s.nonShowdownBb.toFixed(0)}`);
  for (const r of s.byAnte) console.log(`ante ${r.anteBb}: ${r.hands} ${r.netBb.toFixed(0)}`);
  for (const r of s.byFirstMove) console.log(`first ${r.move}: ${r.hands} ${(r.netBb / r.hands).toFixed(2)}`);
  for (const [k, v] of Object.entries(s.habits)) console.log(`${k}: hero ${pct(v.hero)} pool ${pct(v.pool)}`);
  for (const [k, v] of Object.entries(s.foldThrough)) console.log(`fold-through ${k}: ${pct(v)}`);
});
