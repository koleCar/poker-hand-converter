/**
 * Chart coverage on the corpora (docs/ANALYSIS-PLAN.md §10, A2c): how many
 * hero preflop decisions get a chart grade, and why the rest do not.
 *
 *     cd tests && npm run charts:coverage
 *
 * Every hand of the WePlay export (`weplay-hh/`, the owner's library) and of
 * the GG corpus goes through `analyzeHand`, as the in-browser rebuild runs
 * it, once with the 6-max 100bb set alone and once with the whole library;
 * the tables print graded decisions and refusals by reason, the library's
 * graded decisions by set, and how many solver-graded turns and rivers rest
 * on a placeholder range instead of the charts'. Not part of `npm test`
 * (several minutes: it solves turns and rivers).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { analyzeHand } from "../../../frontend/src/lib/analysis/index.js";
import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  loadCharts,
  type ChartSet,
} from "../../../frontend/src/lib/charts/index.js";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { weplayFiles } from "../../test/support/corpus.js";
import { ggCorpusFiles } from "../../test/support/psggCorpus.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));

async function parse(files: { name: string; text: string }[]): Promise<PhfHand[]> {
  const out = await Promise.all(
    files.map(async (f) => {
      try {
        return (await convertAny(f.text, { sourceFilename: f.name })).hands;
      } catch {
        return [];
      }
    }),
  );
  return out.flat();
}

interface Tally {
  decisions: number;
  graded: number;
  reasons: Map<string, number>;
  sets: Map<string, number>;
  /** Turn and river decisions the solver graded, and how many of them rest on a placeholder range. */
  solved: Record<"turn" | "river", { graded: number; placeholder: number }>;
}

function tally(hands: PhfHand[], charts: ChartSet): Tally {
  const out: Tally = {
    decisions: 0,
    graded: 0,
    reasons: new Map(),
    sets: new Map(),
    solved: { turn: { graded: 0, placeholder: 0 }, river: { graded: 0, placeholder: 0 } },
  };
  for (const hand of hands) {
    const analysis = analyzeHand(structuredClone(hand), { charts });
    for (const d of analysis.decisions) {
      if ((d.street === "turn" || d.street === "river") && d.source === "solver") {
        out.solved[d.street].graded += 1;
        if (d.approximations.includes("placeholder-range")) out.solved[d.street].placeholder += 1;
      }
      if (d.street !== "preflop") continue;
      out.decisions += 1;
      if (d.source === "chart") {
        out.graded += 1;
        const set = d.facts.chart?.set ?? "?";
        out.sets.set(set, (out.sets.get(set) ?? 0) + 1);
      } else {
        const reason = String(d.reason);
        out.reasons.set(reason, (out.reasons.get(reason) ?? 0) + 1);
      }
    }
  }
  return out;
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const list = (m: Map<string, number>) =>
  [...m]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

it("reports chart coverage", async () => {
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const library = chartLibrary([single, ...sets.filter((s) => s !== single)]);
  for (const [name, files] of [
    ["WePlay (weplay-hh/)", weplayFiles()],
    ["GG (gg-hh/ + GG samples)", ggCorpusFiles()],
  ] as const) {
    const hands = await parse(files);
    const before = tally(hands, single);
    const after = tally(hands, library);
    const lines = [
      `=== ${name}: ${hands.length} hands, ${after.decisions} hero preflop decisions`,
      `6-max 100bb set alone: graded ${before.graded} (${pct(before.graded, before.decisions)}); refused: ${list(before.reasons)}`,
      `library (${sets.length} sets):  graded ${after.graded} (${pct(after.graded, after.decisions)}); refused: ${list(after.reasons)}`,
      `graded by set: ${list(after.sets)}`,
      ...(["turn", "river"] as const).map(
        (street) =>
          `${street}s graded by the solver: ${before.solved[street].graded} -> ${after.solved[street].graded}; on a placeholder range ${before.solved[street].placeholder} (${pct(before.solved[street].placeholder, before.solved[street].graded)}) -> ${after.solved[street].placeholder} (${pct(after.solved[street].placeholder, after.solved[street].graded)})`,
      ),
    ];
    console.log(lines.join("\n"));
  }
});
