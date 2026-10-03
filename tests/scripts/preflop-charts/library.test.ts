/**
 * Chart coverage on a stored library (docs/CHARTS.md §6.6): every hero
 * preflop decision of a JSONL file of PHF hands (one `hands.phf` per line, as
 * `psql -Atc "select phf from hands where owner_id = ..."` prints them) is
 * graded the way the rebuild grades it (`analyzeHand`, turn solving off - the
 * preflop grades do not depend on it), and the refusals are broken down: by
 * reason, and the open-limp ones by the set the spot falls into and the shape
 * of the line (how many limpers, whether the hero limped).
 *
 *     cd tests && CHARTS_LIBRARY=/path/to/library.jsonl npm run charts:library
 *
 * Not part of `npm test`: it needs a local export of someone's hands.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { analyzeHand } from "../../../frontend/src/lib/analysis/index.js";
import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  loadCharts,
  pickChartSet,
  preflopSpotFromHand,
  type ChartSet,
} from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.CHARTS_LIBRARY ?? "";

const bump = (m: Map<string, number>, key: string, by = 1) => m.set(key, (m.get(key) ?? 0) + by);
const list = (m: Map<string, number>) =>
  [...m]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;

/** The shape of a limped line before the hero's decision: limpers, raises, whether the hero limped. */
function limpShape(hand: PhfHand, heroSeat: number, nth: number): string {
  const found = preflopSpotFromHand(hand, nth, heroSeat);
  if (!found.ok) return "?";
  let limpers = 0;
  let raises = 0;
  let heroLimped = false;
  for (const a of found.spot.actions) {
    if (a.type === "raise") raises += 1;
    else if (a.type === "call" && raises === 0 && a.position !== "SB" && a.position !== "BB") {
      limpers += 1;
      if (a.position === found.spot.hero) heroLimped = true;
    } else if (a.type === "call" && raises === 0 && a.position === "SB") {
      limpers += 1;
    }
  }
  const heroLimps = raises === 0 && found.heroAction.type === "call" && found.spot.hero !== "BB";
  const pick = pickChartSet(CHART_SETS, found.spot);
  const set = pick.ok ? pick.spec.id.replace("nlhe-cash-", "") : `no set (${pick.reason})`;
  const role = heroLimped ? "hero limped, faces a raise" : heroLimps ? "hero limps" : raises ? "limpers + raise" : "faces limpers";
  return `${set} | ${role} | ${limpers} limper${limpers === 1 ? "" : "s"}${raises ? `, ${raises} raise${raises > 1 ? "s" : ""}` : ""}`;
}

it("reports chart coverage on a stored library", { timeout: 4 * 60 * 60_000 }, async () => {
  if (!FILE || !existsSync(FILE)) {
    console.log("CHARTS_LIBRARY is not set to a JSONL file of PHF hands; nothing to do");
    return;
  }
  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PhfHand);
  const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const library = chartLibrary([single, ...sets.filter((s) => s !== single)]);

  let decisions = 0;
  let graded = 0;
  const reasons = new Map<string, number>();
  const bySet = new Map<string, number>();
  const limps = new Map<string, number>();
  const scenarios = new Map<string, number>();
  const grades = new Map<string, number>();
  let evLoss = 0;
  // River decisions the solver graded, and how many rest on a placeholder range (turns are not solved here).
  let rivers = 0;
  let riversPlaceholder = 0;
  const started = performance.now();
  // Decisions with a limp from a seat other than the blinds before them (charts/4's limp tree).
  const behindLimp = new Map<string, number>();
  const openLimpBefore = (hand: PhfHand, seat: number, nth: number) => {
    const found = preflopSpotFromHand(hand, nth, seat);
    if (!found.ok) return false;
    for (const a of found.spot.actions) {
      if (a.type === "raise") return false;
      if (a.type === "call" && a.position !== "SB" && a.position !== "BB") return true;
    }
    return false;
  };
  for (const hand of hands) {
    const analysis = analyzeHand(structuredClone(hand), { charts: library, turn: false });
    let nth = 0;
    for (const d of analysis.decisions) {
      if (d.street === "river" && d.source === "solver") {
        rivers += 1;
        if (d.approximations.includes("placeholder-range")) riversPlaceholder += 1;
      }
      if (d.street !== "preflop") continue;
      if (analysis.heroSeat !== null && openLimpBefore(hand, analysis.heroSeat, nth)) {
        bump(behindLimp, d.source === "chart" ? `graded (${d.grade})` : String(d.reason));
        // CHARTS_LIBRARY_DETAIL=chart-off-tree prints why each such refusal happened.
        if (process.env.CHARTS_LIBRARY_DETAIL && d.reason === process.env.CHARTS_LIBRARY_DETAIL) {
          const found = preflopSpotFromHand(hand, nth, analysis.heroSeat);
          if (found.ok) {
            const line = found.spot.actions.map((a) => `${a.position}:${a.type}${a.toBb ? a.toBb : ""}`).join(" ");
            console.log(`  ${found.spot.positions.length}p ${line} | hero ${found.spot.hero} ${found.heroAction.type}`);
          }
        }
      }
      decisions += 1;
      if (d.source === "chart") {
        graded += 1;
        bump(bySet, d.facts.chart?.set ?? "?");
        bump(scenarios, d.facts.chart?.scenario ?? "?");
        bump(grades, String(d.grade));
        evLoss += d.evLoss ?? 0;
      } else {
        bump(reasons, String(d.reason));
        if (d.reason === "chart-limp" && analysis.heroSeat !== null) {
          bump(limps, limpShape(hand, analysis.heroSeat, nth));
        }
      }
      nth += 1;
    }
  }
  console.log(
    [
      `=== ${FILE}: ${hands.length} hands, ${decisions} hero preflop decisions (${((performance.now() - started) / 1000).toFixed(0)} s)`,
      `graded ${graded} (${pct(graded, decisions)}); refused: ${list(reasons)}`,
      `graded by set: ${list(bySet)}`,
      `graded by scenario: ${list(scenarios)}`,
      `grades: ${list(grades)}; EV lost ${evLoss.toFixed(1)} bb`,
      `rivers graded by the solver: ${rivers}, on a placeholder range ${riversPlaceholder} (${pct(riversPlaceholder, rivers)})`,
      `behind an open limp (${[...behindLimp.values()].reduce((a, b) => a + b, 0)}): ${list(behindLimp)}`,
      `open-limp refusals by set and shape:`,
      ...[...limps].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`),
    ].join("\n"),
  );
});
