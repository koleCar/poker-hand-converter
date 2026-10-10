/**
 * `npm run floplib:realisation` (from `tests/`): measures the flop
 * realisation table on a local flop library and checks it held out
 * (`realisation.ts`). Not part of `npm test`: it reads the full library.
 *
 *     cd tests && FLOPLIB_DIR=/path/to/out npm run floplib:realisation
 *
 * `FLOPLIB_SETS` picks the chart sets (default: the 6-max and 9-max 100bb
 * sets). Prints the table fitted on every chunk next to the committed
 * `FLOP_REALISATION`, then the held-out agreement (fitted on half the flops,
 * judged on the other half) of raw equity, a factor per position, and the
 * committed categories at several margins.
 */

import { existsSync } from "node:fs";
import { it } from "vitest";

import { FLOP_MARGIN_POT, FLOP_REALISATION, flopRealisation } from "../../../frontend/src/lib/analysis/multiway.js";
import { agreement, fitRealisation, librarySamples, type Agreement, type Sample } from "./realisation.js";

const DIR = process.env.FLOPLIB_DIR ?? "";
const SETS = (process.env.FLOPLIB_SETS ?? "nlhe-cash-6max-100bb,nlhe-cash-9max-100bb").split(",");

const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
const show = (name: string, a: Agreement) =>
  console.log(
    `${name.padEnd(28)} verdict ${pct(a.sameVerdict)}  |ΔEV| ${a.evPot.toFixed(2)}% pot  same side ${pct(a.sameSide)}  ` +
      `Mistake right ${pct(a.mistakePrecision)}  Perfect right ${pct(a.perfectPrecision)}  false alarm ${pct(a.falseAlarm)}  miss ${pct(a.miss)}`,
  );

it("measures the flop realisation table", { timeout: 12 * 60 * 60_000 }, () => {
  if (!DIR || !existsSync(DIR)) {
    console.log("FLOPLIB_DIR (the flop library) must be set; nothing to do");
    return;
  }
  const started = performance.now();
  const { samples, chunks } = librarySamples(DIR, SETS);
  console.log(`=== ${chunks} chunks, ${samples.length} samples (${((performance.now() - started) / 1000).toFixed(0)} s)`);

  const all = fitRealisation(samples);
  let worst = 0;
  for (const [key, { r, weight }] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const committed = FLOP_REALISATION[key];
    if (committed !== undefined) worst = Math.max(worst, Math.abs(committed - r));
    console.log(`  ${key.padEnd(22)} R ${r.toFixed(3)}  committed ${committed?.toFixed(3) ?? "-"}  weight ${weight.toFixed(1)} nodes`);
  }
  console.log(`  largest difference from the committed table: ${worst.toFixed(4)}`);

  const train = samples.filter((s) => s.train);
  const test = samples.filter((s) => !s.train);
  const held = fitRealisation(train);
  const position = fitRealisation(train.map((s) => ({ ...s, key: s.key.split("|")[0] })));
  const fitted = (key: string) => held.get(key)?.r ?? flopRealisation(key.split("|").slice(1).join("|"), key.startsWith("ip"));
  console.log(`=== held out: fitted on ${train.length} samples, judged on ${test.length}`);
  show("raw equity (R = 1)", agreement(test, () => 1, 0));
  show("R by position", agreement(test, (key) => position.get(key.split("|")[0])?.r ?? 1, 0));
  for (const margin of [0, 0.03, FLOP_MARGIN_POT, 0.08, 0.1, 0.15]) {
    show(`R by category, margin ${(100 * margin).toFixed(0)}%`, agreement(test, fitted, margin));
  }
  const byPot = (s: Sample) => (s.line.endsWith("-3bet") ? "3-bet pots" : s.line === "sb-limp" ? "limped pots" : "single-raised pots");
  for (const pot of ["single-raised pots", "3-bet pots", "limped pots"]) {
    const subset = test.filter((s) => byPot(s) === pot);
    if (subset.length > 0) show(`  ${pot}`, agreement(subset, fitted, FLOP_MARGIN_POT));
  }
});
