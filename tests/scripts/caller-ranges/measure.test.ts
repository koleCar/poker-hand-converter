/**
 * What the population ranges change (analysis/19), decision by decision, on
 * a stored library: every hand where an opponent who saw the flop with the
 * hero starts from a population range is analysed by a base checkout of the
 * analysis (`CALLERS_BASE`, the `frontend/src` of the commit before) and by
 * this one, both with the flop library and turn solving on, and the hero's
 * decisions are compared one by one. Prints totals only; `CALLERS_DUMP`
 * also writes each changed decision (hand number, street, action, grades,
 * EV losses) to a LOCAL file for inspection - never commit it.
 *
 *     cd tests && CALLERS_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out \
 *       CALLERS_BASE=/path/base/frontend/src [CALLERS_SHARD=0/3] \
 *       npx vitest run --config scripts/caller-ranges/vitest.config.ts measure
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import * as next from "../../../frontend/src/lib/analysis/index.js";
import * as nextCharts from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";

const FILE = process.env.CALLERS_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const BASE = process.env.CALLERS_BASE ?? "";
const DUMP = process.env.CALLERS_DUMP ?? "";
const [SHARD, SHARDS] = (process.env.CALLERS_SHARD ?? "0/1").split("/").map(Number);
const TURN = process.env.CALLERS_TURN !== "0";

const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

type Analysis = { decisions: { street: string; action: string; grade?: string | null; source: string; evLoss?: number | null; approximations: string[]; facts: { equity?: { value: number } | null } }[] };

it("measures the population ranges on a stored library", { timeout: 24 * 60 * 60_000 }, async () => {
  if (!FILE || !existsSync(FILE) || !DIR || !existsSync(DIR) || !BASE || !existsSync(BASE)) {
    console.log("CALLERS_HANDS, FLOPLIB_DIR and CALLERS_BASE must all be set; nothing to do");
    return;
  }
  const base = await import(join(BASE, "lib/analysis/index.ts"));
  const baseCharts = await import(join(BASE, "lib/charts/index.ts"));
  const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
  const libraryOf = (mod: typeof nextCharts) => {
    const sets = mod.CHART_SETS.map((spec) => mod.loadCharts(JSON.parse(readFileSync(join(DATA, `${spec.id}.json`), "utf8"))));
    const single = sets.find((s) => s.id === mod.DEFAULT_CHART_SET)!;
    return mod.chartLibrary([single, ...sets.filter((s) => s !== single)]);
  };
  const chartsNext = libraryOf(nextCharts);
  const chartsBase = libraryOf(baseCharts);
  const loaderNext = new next.FlopLibraryLoader("local:", localFetch);
  const loaderBase = new base.FlopLibraryLoader("local:", localFetch);

  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PhfHand);
  if (DUMP) writeFileSync(DUMP, "");

  const count = new Map<string, number>();
  const bump = (k: string, by = 1) => count.set(k, (count.get(k) ?? 0) + by);
  let selected = 0;
  const started = performance.now();
  for (const [h, hand] of hands.entries()) {
    if (h % SHARDS !== SHARD) continue;
    // Hands where an opponent who saw the flop with the hero reads a population range.
    const context = buildContext(structuredClone(hand));
    const hero = next.heroSeatOf(context);
    if (hero === null) continue;
    const seats = next.flopSeats(context);
    if (!seats.includes(hero)) continue;
    const cut = hand.actions.find((a) => a.street !== "preflop" && a.street !== "showdown")?.index ?? Number.MAX_SAFE_INTEGER;
    const lines = seats.filter((s) => s !== hero).map((s) => next.populationLine(hand, context, s, cut)).filter((l): l is next.PopulationLine => l !== null);
    if (lines.length === 0) continue;
    selected += 1;
    for (const l of lines) bump(`opponent ${l}`);
    bump(seats.length > 2 ? "hands multiway" : "hands heads-up");

    await loaderBase.prefetch(hand, chartsBase);
    await loaderNext.prefetch(hand, chartsNext);
    const before: Analysis = base.analyzeHand(structuredClone(hand), { charts: chartsBase, turn: TURN, flopLibrary: loaderBase });
    const after: Analysis = next.analyzeHand(structuredClone(hand), { charts: chartsNext, turn: TURN, flopLibrary: loaderNext });
    after.decisions.forEach((d, k) => {
      const old = before.decisions[k];
      if (!old || old.street !== d.street || old.action !== d.action) {
        bump("misaligned");
        return;
      }
      bump(`decisions ${d.street}`);
      if (old.grade) bump(`graded before ${d.street}`);
      if (d.grade) bump(`graded after ${d.street}`);
      if (old.grade) bump(`before ${d.street} ${old.grade}`);
      if (d.grade) bump(`after ${d.street} ${d.grade}`);
      bump(`ev before ${d.street}`, old.evLoss ?? 0);
      bump(`ev after ${d.street}`, d.evLoss ?? 0);
      if (d.approximations.includes("range-population")) bump(`flagged ${d.street}`);
      const eqOld = old.facts.equity?.value ?? null;
      const eqNew = d.facts.equity?.value ?? null;
      if (eqOld !== eqNew) {
        bump(`equity changed ${d.street}`);
        if (eqOld !== null && eqNew !== null) bump(`equity delta ${d.street}`, eqNew - eqOld);
      }
      const changed = old.grade !== d.grade || Math.abs((old.evLoss ?? 0) - (d.evLoss ?? 0)) > 1e-9;
      if (old.grade !== d.grade) bump(`moves ${d.street} ${d.source}: ${old.grade ?? "none"} -> ${d.grade ?? "none"}`);
      if (old.source !== d.source) bump(`source ${d.street}: ${old.source} -> ${d.source}`);
      if (changed && DUMP) {
        appendFileSync(
          DUMP,
          JSON.stringify({ h, street: d.street, action: d.action, source: [old.source, d.source], grade: [old.grade ?? null, d.grade ?? null], evLoss: [old.evLoss ?? null, d.evLoss ?? null], equity: [eqOld, eqNew] }) + "\n",
        );
      }
    });
    if (selected % 100 === 0) console.log(`${selected} hands, ${((performance.now() - started) / 60_000).toFixed(1)} min`);
  }
  console.log(`--- shard ${SHARD}/${SHARDS}: ${selected} hands`);
  for (const [k, v] of [...count].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${k}\t${Number.isInteger(v) ? v : v.toFixed(3)}`);
});
