/**
 * The coverage census (§10, 2026-10-16): every hand of a JSONL file of PHF
 * hands (one `hands.phf` per line, as `psql -Atc "select phf from hands
 * where owner_id = ..."` prints them; never commit one) analysed with
 * `analyzeHand` the way the rebuild analyses it (`lib/db/analysisRows.ts`):
 * the chart library, the flop library read from a local directory through
 * the worker's own loader, turn solves on, and every opponent's statistics
 * summed over the whole file as the opponents panel sums them
 * (`villain_counters`). Every **hero** decision is then counted by street ×
 * outcome:
 *
 * - graded by an exact source: `chart`, `solver` (the turn and river
 *   solves, and the flop library - `flop-mapped` apart from an exact chunk);
 * - graded approximately (`source: "approx"`), by its approximation flag
 *   (`flop-realisation`, `turn-realisation`, the river's `multiway-approx`);
 * - analysed without a grade (`source: "heuristic"`, no reason: a heads-up
 *   flop no chunk covers, a turn with solves off);
 * - not analysed, by reason (`status: partial`), and the hero decisions of
 *   hands not analysed at all, by the hand's reason.
 *
 * Also by format (6-max / 9-max / heads-up table), by effective depth, and
 * heads-up against multiway (players at the decision).
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl FLOPLIB_DIR=/path/rail-floplib-out \
 *       CENSUS_OUT=/path/rows-0.jsonl [CENSUS_SHARD=0/3] [CENSUS_TURN=0] npm run floplib:census
 *     cd tests && CENSUS_REPORT=/path/rows-0.jsonl,/path/rows-1.jsonl,... npm run floplib:census
 *
 * The first form analyses (one shard of the hands: every n-th from the i-th,
 * so three shards run as three processes) and writes one row per hero
 * decision - hand index, street, action, outcome, grade, approximations,
 * table, depth; no cards, no names - to `CENSUS_OUT`, then prints its own
 * report. The second merges row files and prints the report over them;
 * with `CENSUS_BEFORE=<row files of an earlier census of the same hands>`
 * it also prints how each decision's outcome and grade moved (a version
 * change measured decision for decision).
 * `CENSUS_SETS` (default the three shipped sets, `nlhe-cash-6max-100bb`,
 * `nlhe-cash-9max-100bb` and `nlhe-cash-6max-150bb`) limits which flop-library sets the loader may read
 * from `FLOPLIB_DIR`, so a set still being solved there is never read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import * as analysis from "../../../frontend/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";
import { handFacts } from "../../../frontend/src/lib/stats/derive.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const OUT = process.env.CENSUS_OUT ?? "";
const REPORT = (process.env.CENSUS_REPORT ?? "").split(",").filter(Boolean);
const TURN = process.env.CENSUS_TURN !== "0";
const [SHARD, SHARDS] = (process.env.CENSUS_SHARD ?? "0/1").split("/").map(Number);
const SETS = new Set((process.env.CENSUS_SETS ?? "nlhe-cash-6max-100bb,nlhe-cash-9max-100bb,nlhe-cash-6max-150bb").split(",").filter(Boolean));

/** One hero decision, as the census counts it. No cards, no names. */
export interface CensusRow {
  hand: number;
  /** The decision's `PhfAction.index`; -1 for the decisions of a hand not analysed at all. */
  action: number;
  street: string;
  act: string;
  /** `chart` | `solver` | `approx` | `heuristic` (analysed, no grade) | `skipped` (a reason) | `hand-skipped`. */
  outcome: string;
  grade: string | null;
  reason: string | null;
  approximations: string[];
  /** The table: `6max` (3-6 seats), `9max` (7-10), `hu` (2). */
  table: string;
  /** Players dealt in. */
  dealt: number;
  depth: string;
  /** Players in the pot at the decision (postflop), or dealt in (preflop). */
  players: number;
  /** Three or more saw the flop. */
  multiwayFlop: boolean;
  facing: boolean;
  potType: string;
  /** The flop-library line/chunk read (`exact` | `mapped`) or null. */
  library: string | null;
  /** The grade's inputs (analysis/33, the big-blind floor): EV loss in bb, the pot before the decision, the chosen option's and the top frequency. */
  evLoss?: number | null;
  potBb?: number;
  chosenFreq?: number | null;
  maxFreq?: number | null;
}

const localFetch = async (url: string): Promise<Response> => {
  const rel = url.replace(/^local:\/*/, "");
  if (!SETS.has(rel.split("/")[0])) return new Response(null, { status: 404 });
  const path = join(DIR, rel);
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

const depthOf = (bb: number) => (bb < 50 ? "<50bb" : bb < 80 ? "50-80bb" : bb <= 120 ? "80-120bb" : bb <= 170 ? "120-170bb" : "170bb+");
const tableOf = (seats: number) => (seats <= 2 ? "hu" : seats <= 6 ? "6max" : "9max");

/** min(hero's starting stack, the deepest other dealt-in stack), in big blinds - as `analyze.ts` measures it. */
function effectiveBb(hand: PhfHand, hero: number): number {
  const context = buildContext(structuredClone(hand));
  const bb = Math.max(1, hand.game.bigBlind);
  const mine = context.players.get(hero)?.startingStack ?? 0;
  const other = Math.max(0, ...context.dealtInSeats.filter((s) => s !== hero).map((s) => context.players.get(s)?.startingStack ?? 0));
  return Math.min(mine, other) / bb;
}

function rowsOf(h: number, hand: PhfHand, result: analysis.HandAnalysis): CensusRow[] {
  const context = buildContext(structuredClone(hand));
  const hero = analysis.heroSeatOf(context);
  const base = {
    hand: h,
    table: tableOf(hand.table.maxSeats),
    dealt: context.dealtInSeats.length,
    depth: hero === null ? "?" : depthOf(effectiveBb(hand, hero)),
    multiwayFlop: analysis.flopSeats(context).length >= 3,
    potType: result.potType,
  };
  if (result.decisions.length === 0) {
    // A hand not analysed at all: its hero decisions, as the walk sees them, under the hand's reason.
    const spots = hero === null ? [] : analysis.heroSpots(context, hero);
    return spots.map((spot) => ({
      ...base,
      action: spot.action.index,
      street: spot.street,
      act: spot.decision.type,
      outcome: "hand-skipped",
      grade: null,
      reason: result.reason,
      approximations: [],
      players: spot.street === "preflop" ? base.dealt : spot.opponents.length + 1,
      facing: spot.toCall > 0,
      library: null,
    }));
  }
  return result.decisions.map((d) => ({
    ...base,
    action: d.actionIndex,
    street: d.street,
    act: d.action,
    outcome: d.status === "not-analysed" ? "skipped" : d.grade !== null ? d.source : "heuristic",
    grade: d.grade,
    reason: d.reason,
    approximations: [...d.approximations],
    players: d.street === "preflop" ? base.dealt : d.facts.players,
    facing: d.facts.toCallBb > 0,
    library: d.facts.flop?.source === "library" ? (d.facts.flop.mapped ? "mapped" : "exact") : null,
    evLoss: d.evLoss,
    potBb: d.facts.potBb,
    chosenFreq: d.chosen !== null ? (d.options[d.chosen]?.freq ?? null) : null,
    maxFreq: d.options.length > 0 ? Math.max(...d.options.map((o) => o.freq)) : null,
  }));
}

/* ---------------------------------------------------------------- report - */

const STREETS = ["preflop", "flop", "turn", "river"];

function table(title: string, rows: CensusRow[], key: (r: CensusRow) => string, columns: string[], col: (r: CensusRow) => string): string {
  const cells = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = key(r);
    const m = cells.get(k) ?? new Map<string, number>();
    m.set(col(r), (m.get(col(r)) ?? 0) + 1);
    m.set("all", (m.get("all") ?? 0) + 1);
    cells.set(k, m);
  }
  const keys = [...cells.keys()].sort((a, b) => (cells.get(b)?.get("all") ?? 0) - (cells.get(a)?.get("all") ?? 0));
  const lines = [`### ${title}`, "", `| | ${[...columns, "all"].join(" | ")} |`, `|---|${[...columns, "all"].map(() => "---").join("|")}|`];
  for (const k of keys) lines.push(`| ${k} | ${[...columns, "all"].map((c) => cells.get(k)?.get(c) ?? 0).join(" | ")} |`);
  const total = (c: string) => [...cells.values()].reduce((s, m) => s + (m.get(c) ?? 0), 0);
  lines.push(`| **all** | ${[...columns, "all"].map(total).join(" | ")} |`);
  return lines.join("\n");
}

/** graded / approx / heuristic / not analysed - the census' four outcomes. */
const coarse = (r: CensusRow) =>
  r.outcome === "chart" || r.outcome === "solver" ? "exact" : r.outcome === "approx" ? "approx" : r.outcome === "heuristic" ? "no grade" : "not analysed";
const COARSE = ["exact", "approx", "no grade", "not analysed"];

export function report(rows: CensusRow[]): string {
  const out: string[] = [];
  const hands = new Set(rows.map((r) => r.hand)).size;
  out.push(`## Coverage census: ${rows.length} hero decisions in ${hands} hands`, "");
  out.push(table("By street", rows, (r) => r.street, COARSE, coarse), "");

  // Exact sources, and the approximate grades by flag.
  const graded = rows.filter((r) => r.outcome === "chart" || r.outcome === "solver" || r.outcome === "approx");
  out.push(
    table(
      "Graded, by source",
      graded,
      (r) => r.street,
      ["chart", "solver: exact", "solver: library mapped", "solver: multiway-history", "approx: flop-realisation", "approx: turn-realisation", "approx: river"],
      (r) => {
        if (r.outcome === "chart") return "chart";
        if (r.outcome === "approx")
          return r.approximations.includes("flop-realisation") ? "approx: flop-realisation" : r.approximations.includes("turn-realisation") ? "approx: turn-realisation" : "approx: river";
        if (r.library === "mapped") return "solver: library mapped";
        if (r.approximations.includes("multiway-history")) return "solver: multiway-history";
        return "solver: exact";
      },
    ),
    "",
  );
  const flags = new Map<string, number>();
  for (const r of graded) for (const a of r.approximations) flags.set(`${r.street} ${a}`, (flags.get(`${r.street} ${a}`) ?? 0) + 1);
  out.push("### Approximation flags on graded decisions (street flag: count)", "");
  out.push([...flags].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("; "), "");

  // Every reason, ranked.
  const missed = rows.filter((r) => r.outcome === "skipped" || r.outcome === "hand-skipped" || r.outcome === "heuristic");
  const reasonOf = (r: CensusRow) => (r.outcome === "heuristic" ? "(analysed, no grade: heuristic)" : r.outcome === "hand-skipped" ? `hand: ${r.reason}` : String(r.reason));
  out.push(table("Not graded, by reason × street (ranked)", missed, reasonOf, STREETS, (r) => r.street), "");
  out.push(
    table(
      "Not graded, by reason × action (facing a bet marked *)",
      missed,
      reasonOf,
      ["fold*", "call*", "raise*", "check", "bet", "fold", "call", "raise"],
      (r) => `${r.act}${r.facing && r.act !== "check" && r.act !== "bet" ? "*" : ""}`,
    ),
    "",
  );
  out.push(table("By table", rows, (r) => `${r.table} ${r.street}`, COARSE, coarse), "");
  out.push(table("By depth", rows, (r) => `${r.depth} ${r.street === "preflop" ? "preflop" : "postflop"}`, COARSE, coarse), "");
  out.push(
    table(
      "Postflop, heads-up or multiway at the decision (and the flop)",
      rows.filter((r) => r.street !== "preflop"),
      (r) => `${r.street} ${r.players > 2 ? "multiway" : r.multiwayFlop ? "heads-up, multiway flop" : "heads-up"}`,
      COARSE,
      coarse,
    ),
    "",
  );
  out.push(table("Grades, by street (graded only)", graded, (r) => `${r.street} ${r.outcome}`, [...analysis.GRADES], (r) => String(r.grade)), "");
  return out.join("\n");
}

const readRows = (files: readonly string[]) =>
  files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CensusRow),
  );

/** How decisions move between two censuses of the same hands (`CENSUS_BEFORE` against `CENSUS_REPORT`). */
export function moves(before: CensusRow[], after: CensusRow[]): string {
  const old = new Map(before.map((r) => [`${r.hand}:${r.action}`, r]));
  const label = (r: CensusRow | undefined) => (!r ? "absent" : r.grade ? `${r.outcome} ${r.grade}` : r.outcome === "heuristic" ? "no grade" : `not analysed (${r.reason})`);
  const count = new Map<string, number>();
  const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  for (const r of after) {
    const b = old.get(`${r.hand}:${r.action}`);
    if (label(b) === label(r) && (b?.grade ?? null) === r.grade) {
      if (b && JSON.stringify(b.approximations) !== JSON.stringify(r.approximations)) bump(`${r.street}: same grade, approximations moved`);
      continue;
    }
    bump(`${r.street}: ${label(b)} -> ${label(r)}`);
  }
  return ["### Moves", "", ...[...count].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `- ${k}: ${v}`)].join("\n");
}

it("counts every hero decision by outcome on a stored library", { timeout: 24 * 60 * 60_000 }, async () => {
  if (REPORT.length > 0) {
    const rows = readRows(REPORT);
    console.log(report(rows));
    const before = (process.env.CENSUS_BEFORE ?? "").split(",").filter(Boolean);
    if (before.length > 0) console.log(moves(readRows(before), rows));
    return;
  }
  if (!FILE || !existsSync(FILE) || !DIR || !existsSync(DIR) || !OUT) {
    console.log("FLOPLIB_HANDS, FLOPLIB_DIR and CENSUS_OUT (or CENSUS_REPORT) must be set; nothing to do");
    return;
  }
  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PhfHand);
  const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const charts = chartLibrary([single, ...sets.filter((s) => s !== single)]);
  const library = new analysis.FlopLibraryLoader("local:", localFetch);

  // Every opponent's counters over the whole file, as `villain_counters` sums them (no bomb pots).
  const villains: Record<string, analysis.VillainStats> = {};
  for (const hand of hands) {
    if (hand.game.format !== "cash") continue;
    for (const seat of handFacts(structuredClone(hand)).seats) {
      if (seat.isHero || !seat.player) continue;
      const key = analysis.villainKey(hand.meta.siteId, seat.player);
      const v = (villains[key] ??= { vpipOpp: 0, vpip: 0, pfr: 0 });
      v.vpipOpp += seat.counters.vpip_opp;
      v.vpip += seat.counters.vpip;
      v.pfr += seat.counters.pfr;
    }
  }

  const started = performance.now();
  const rows: CensusRow[] = [];
  let failed = 0;
  for (const [h, hand] of hands.entries()) {
    if (h % SHARDS !== SHARD) continue;
    try {
      await library.prefetch(hand, charts);
      const result = analysis.analyzeHand(structuredClone(hand), { charts, turn: TURN, flopLibrary: library, villains });
      rows.push(...rowsOf(h, hand, result));
    } catch {
      failed += 1;
    }
  }
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`shard ${SHARD}/${SHARDS}: ${rows.length} hero decisions, ${failed} hands threw, ${((performance.now() - started) / 1000).toFixed(0)} s, turn solves ${TURN ? "on" : "off"}`);
  console.log(report(rows));
});
