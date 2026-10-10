/**
 * What the opponents' own statistics change (analysis/20), decision by
 * decision, on a stored library: every opponent's VPIP, PFR and hands are
 * summed over the whole library (as the opponents panel sums them), and
 * every hand where an opponent who saw the flop with the hero has their
 * range moved (`villain.ts`: a big blind's defence, at least
 * `VILLAIN_MIN_HANDS` hands) is analysed twice by this checkout - without
 * the statistics and with them - both with the flop library and turn
 * solving on; the hero's decisions are compared one by one. Prints totals
 * only; `CALLERS_DUMP` also writes each changed decision to a LOCAL file -
 * never commit it.
 *
 *     cd tests && CALLERS_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out [CALLERS_SHARD=0/3] \
 *       npx vitest run --config scripts/caller-ranges/vitest.config.ts villainMeasure
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import * as analysis from "../../../frontend/src/lib/analysis/index.js";
import * as charts from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";
import { handFacts } from "../../../frontend/src/lib/stats/derive.js";

const FILE = process.env.CALLERS_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const DUMP = process.env.CALLERS_DUMP ?? "";
const [SHARD, SHARDS] = (process.env.CALLERS_SHARD ?? "0/1").split("/").map(Number);
const TURN = process.env.CALLERS_TURN !== "0";

const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

it("measures the opponents' own statistics on a stored library", { timeout: 24 * 60 * 60_000 }, async () => {
  if (!FILE || !existsSync(FILE) || !DIR || !existsSync(DIR)) {
    console.log("CALLERS_HANDS and FLOPLIB_DIR must both be set; nothing to do");
    return;
  }
  const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
  const sets = charts.CHART_SETS.map((spec) => charts.loadCharts(JSON.parse(readFileSync(join(DATA, `${spec.id}.json`), "utf8"))));
  const single = sets.find((s) => s.id === charts.DEFAULT_CHART_SET)!;
  const library = charts.chartLibrary([single, ...sets.filter((s) => s !== single)]);
  const loader = new analysis.FlopLibraryLoader("local:", localFetch);

  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PhfHand);
  // Every opponent's counters over the whole library: what `stats_opponents` sums (no bomb pots).
  const villains: Record<string, analysis.VillainStats> = {};
  for (const hand of hands) {
    for (const seat of handFacts(structuredClone(hand)).seats) {
      if (seat.isHero || !seat.player) continue;
      const key = analysis.villainKey(hand.meta.siteId, seat.player);
      const v = (villains[key] ??= { vpipOpp: 0, vpip: 0, pfr: 0 });
      v.vpipOpp += seat.counters.vpip_opp;
      v.vpip += seat.counters.vpip;
      v.pfr += seat.counters.pfr;
    }
  }
  if (DUMP) writeFileSync(DUMP, "");

  const count = new Map<string, number>();
  const bump = (k: string, by = 1) => count.set(k, (count.get(k) ?? 0) + by);
  let selected = 0;
  const started = performance.now();
  for (const [h, hand] of hands.entries()) {
    if (h % SHARDS !== SHARD) continue;
    const context = buildContext(structuredClone(hand));
    const hero = analysis.heroSeatOf(context);
    if (hero === null) continue;
    const seats = analysis.flopSeats(context);
    if (!seats.includes(hero)) continue;
    const cut = hand.actions.find((a) => a.street !== "preflop" && a.street !== "showdown")?.index ?? Number.MAX_SAFE_INTEGER;
    const moved = seats
      .filter((s) => s !== hero)
      .map((s) => {
        const line = analysis.populationLine(hand, context, s, cut);
        const name = context.players.get(s)?.name ?? "";
        return line ? analysis.villainSample(line, villains[analysis.villainKey(hand.meta.siteId, name)]) : null;
      })
      .filter((x): x is analysis.VillainSample => x !== null);
    if (moved.length === 0) continue;
    selected += 1;
    bump(seats.length > 2 ? "hands multiway" : "hands heads-up");
    for (const m of moved) {
      bump("shift sum", m.shift);
      bump(m.shift > 0 ? "opponents widened" : "opponents narrowed");
      bump("sample hands sum", m.hands);
    }

    await loader.prefetch(hand, library);
    const before = analysis.analyzeHand(structuredClone(hand), { charts: library, turn: TURN, flopLibrary: loader });
    const after = analysis.analyzeHand(structuredClone(hand), { charts: library, turn: TURN, flopLibrary: loader, villains });
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
      if (d.approximations.includes("range-villain")) bump(`flagged ${d.street}`);
      if (d.approximations.includes("range-villain") && !d.facts.villain) bump("flagged without a sample");
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
