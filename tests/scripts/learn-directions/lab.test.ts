/**
 * Learn L4: the directions the exploit lessons state, checked against Rail's
 * own exploit lab before they were written (as `directions.test.ts` did for
 * the turn and river).
 *
 * Not part of `npm test`: it solves and locks a few hundred rivers. Run
 * `npm run learn:lab` from `tests/` (`LAB_RIVERS` sets how many per preset).
 * Per preset of `LAB_PRESETS` it prints, over rivers of the trainer's own
 * generator with the hero in position:
 *
 *  - the hero's decision the lock is about — checked to (fold-to-bet,
 *    never-raise), or facing the opponent's first bet (air-bets) — as the
 *    share of the range that bets (or folds, calls, raises) at the baseline
 *    and in the best response, overall and by river category;
 *  - what the response gains over the baseline against the locked opponent,
 *    and what it gives back against the baseline opponent and against a
 *    counter, as a share of the river pot (mean, and how often it is zero).
 *
 * The lessons quote no number from it: they state directions ("bluff more",
 * "fold more of your bluff-catchers", "the counter costs more than the gain")
 * and this is where each was read. Numbers in a lesson come from the lab at
 * runtime, from the learner's own data, or from the toy game worked by hand.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

import { loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import { LAB_PRESET_IDS, LAB_PRESETS, labWorlds, viewAt } from "../../../frontend/src/lib/training/lab.js";
import { riverSetup } from "../../../frontend/src/lib/training/river.js";
import { seeded } from "../../../frontend/src/lib/training/rng.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

const RIVERS = Number(process.env.LAB_RIVERS ?? 40);

type Groups = Record<string, number>;

function groupName(kind: string, sizePot: number, facing: boolean): string {
  if (facing) return kind === "fold" ? "fold" : kind === "call" ? "call" : "raise";
  if (kind === "check") return "check";
  if (kind === "allin") return "allin";
  return sizePot <= 0.5 + 1e-9 ? "small" : sizePot <= 1 + 1e-9 ? "big" : "overbet";
}

class Tally {
  rows = new Map<string, { w: number; eq: Groups; best: Groups }>();
  add(key: string, w: number, eq: Groups, best: Groups) {
    let row = this.rows.get(key);
    if (!row) this.rows.set(key, (row = { w: 0, eq: {}, best: {} }));
    row.w += w;
    for (const [g, x] of Object.entries(eq)) row.eq[g] = (row.eq[g] ?? 0) + w * x;
    for (const [g, x] of Object.entries(best)) row.best[g] = (row.best[g] ?? 0) + w * x;
  }
  print(title: string) {
    console.log(`\n${title}`);
    const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);
    for (const [key, row] of [...this.rows.entries()].sort((a, b) => b[1].w - a[1].w)) {
      const groups = [...new Set([...Object.keys(row.eq), ...Object.keys(row.best)])].sort();
      const line = groups.map((g) => `${g} ${pct((row.eq[g] ?? 0) / row.w)}→${pct((row.best[g] ?? 0) / row.w)}`).join("  ");
      console.log(`  ${key.padEnd(22)} w ${row.w.toFixed(1).padStart(7)}  ${line}`);
    }
  }
}

describe("exploit lab directions (Learn L4)", () => {
  for (const preset of LAB_PRESET_IDS) {
    it(`${preset}: ${LAB_PRESETS[preset].lock} at ${LAB_PRESETS[preset].value}`, () => {
      const spec = LAB_PRESETS[preset];
      const tally = new Tally();
      const money = { n: 0, gain: 0, riskEq: 0, riskCounter: 0, baseline: 0, zeroRiskEq: 0, counterOverGain: 0, eqUnderGain: 0 };
      for (let k = 0; k < RIVERS; k += 1) {
        const seed = 70_000 + 97 * k;
        const setup = riverSetup(CHARTS, { pot: "any", seat: "ip" }, seeded(seed), seed);
        if (!setup) continue;
        const worlds = labWorlds(setup, spec.lock, spec.value);
        if (!worlds) continue;
        const { result, bestWorld, lab, hero, board } = worlds;
        const pot = result.pot;
        money.n += 1;
        money.gain += lab.gain / pot;
        money.riskEq += lab.riskVsEquilibrium / pot;
        money.riskCounter += lab.riskVsCounter / pot;
        money.baseline += lab.baselineRisk / pot;
        if (Math.abs(lab.riskVsEquilibrium) < 0.001 * pot) money.zeroRiskEq += 1;
        if (lab.riskVsCounter > lab.gain) money.counterOverGain += 1;
        if (lab.riskVsEquilibrium < lab.gain) money.eqUnderGain += 1;

        // The hero decisions the lock is about.
        const root = result.nodes[0];
        const nodes: number[] = [];
        if (spec.lock === "air-bets") {
          root.actions.forEach((a, k2) => {
            if (a.kind !== "check" && root.children[k2] >= 0) nodes.push(root.children[k2]);
          });
        } else {
          const check = root.actions.findIndex((a) => a.kind === "check");
          if (check >= 0 && root.children[check] >= 0) nodes.push(root.children[check]);
        }
        for (const index of nodes) {
          const node = result.nodes[index];
          if (node.player !== hero) continue;
          const view = viewAt(result, bestWorld, index, hero, board);
          const names = view.actions.map((a) => groupName(a.kind, a.sizePot, node.toCall > 0));
          const group = (mix: number[]) => {
            const out: Groups = {};
            mix.forEach((x, a) => (out[names[a]] = (out[names[a]] ?? 0) + x));
            return out;
          };
          for (const row of view.rows) tally.add(row.key, row.combos, group(row.eq), group(row.best));
          const all = view.rows.reduce((s, r) => s + r.combos, 0);
          tally.add("(whole range)", all, group(view.overall.eq), group(view.overall.best));
        }
      }
      const mean = (x: number) => (money.n > 0 ? `${((100 * x) / money.n).toFixed(2)}% of the pot` : "-");
      console.log(`\n=== ${preset} (${spec.lock} → ${spec.value}), ${money.n} rivers`);
      console.log(`  gain ${mean(money.gain)}; risk vs baseline ${mean(money.riskEq)} (zero in ${money.zeroRiskEq}); risk vs counter ${mean(money.riskCounter)}; baseline vs counter ${mean(money.baseline)}`);
      console.log(`  the counter costs more than the gain in ${money.counterOverGain} of ${money.n}; the baseline opponent costs less than the gain in ${money.eqUnderGain}`);
      tally.print(spec.lock === "air-bets" ? "  hero facing the first bet: baseline → response" : "  hero checked to: baseline → response");
    });
  }
});
