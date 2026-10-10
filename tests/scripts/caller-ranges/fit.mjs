// Caller-range study (analysis/19): the shipped fit (`population/1` in
// frontend/src/lib/analysis/population.ts), on every shown hand, and the
// fitted ranges as 13x13 grids:
//   CALLERS_OUT=/local/shown.jsonl WEIGHT=1 node fit.mjs
import { rows, NAMES, combos } from "./lib.mjs";
import { CANDIDATES, biasFrom, fit } from "./study.mjs";
const SRC = ["cold-call", "bb-defence", "first-limp", "over-limp", "limp-call"];
const bias = biasFrom(rows);
const rs = rows.filter((r) => SRC.includes(r.source) && !r.allIn);
const p = fit(CANDIDATES["shape-pooled"], rs, bias);
console.log(JSON.stringify(p.map((x) => Math.round(x * 1000) / 1000)));
const RANK = "AKQJT98765432";
for (const s of SRC) {
  const w = CANDIDATES["shape-pooled"].range({ source: s }, p);
  console.log(`\n${s} width ${combos(w).toFixed(0)} (${(combos(w) / 13.26).toFixed(0)}%)`);
  for (let i = 0; i < 13; i++) {
    let line = "";
    for (let j = 0; j < 13; j++) {
      const name = i === j ? RANK[i] + RANK[j] : i < j ? RANK[i] + RANK[j] + "s" : RANK[j] + RANK[i] + "o";
      line += String(Math.round(100 * w[NAMES.indexOf(name)])).padStart(4);
    }
    console.log(line);
  }
}
