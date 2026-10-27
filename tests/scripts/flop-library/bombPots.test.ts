/**
 * Bomb pots (§10, 2026-10-19): how well the multiway heuristic, started from
 * any two cards, explains the hands bomb-pot opponents show down, against
 * how well it explains them in ordinary multiway pots (started from the
 * charts, the population ranges and the placeholders, as the analysis does).
 *
 * Every opponent (the hero left out) who saw a flop three or more saw, acted
 * on it and showed their cards is scored at the start of the turn and of the
 * river (as far as they got): the log-likelihood of the shown combo in the
 * narrowed range, a combo outside the range at a twentieth of a uniform
 * combo (as `analysis/17`-`/23`). Since the two kinds of pot start from very
 * different ranges, the comparison is the **lift**: that score minus the
 * same combo's score in the starting range with the board removed (no
 * postflop narrowing) - how much the narrowing explains, in nats per shown
 * combo. Standard errors are clustered by player. Nothing is fitted, so
 * nothing needs holding out: no parameter of the heuristic was ever set on a
 * bomb pot (they were refused until `analysis/28`).
 *
 * `BOMB_GRADES=1` also prints every graded hero decision of the bomb pots
 * (board, cards, action, price, grade) for a spot check - console only.
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl npm run floplib:bomb-pots
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { analyzeHand, flopSeats, heroSeatOf, heuristicModel, walkMultiway } from "../../../web/src/lib/analysis/index.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../web/src/lib/charts/index.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../web/src/lib/solver/index.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const GRADES = process.env.BOMB_GRADES === "1";
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));

/** ln(w(c) / Σw), floored at a twentieth of a uniform combo. */
function ll(range: Float64Array | undefined, combo: number): number {
  if (!range) return FLOOR_LL;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

/** The range with these cards' combos removed (the board, for the unnarrowed baseline). */
function without(range: Float64Array, cards: readonly number[]): Float64Array {
  const out = Float64Array.from(range);
  const dead = new Set(cards);
  for (let a = 0; a < 52; a += 1) {
    for (let b = a + 1; b < 52; b += 1) {
      if (dead.has(a) || dead.has(b)) out[comboIndex(a, b)] = 0;
    }
  }
  return out;
}

interface Row {
  player: string;
  bomb: boolean;
  street: "turn" | "river";
  active: boolean;
  players: number;
  score: number;
  start: number;
}

function clustered(rows: readonly Row[], x: (r: Row) => number): { mean: number; se: number; n: number; players: number } {
  const n = rows.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0, players: 0 };
  const mean = rows.reduce((s, r) => s + x(r), 0) / n;
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.player, (by.get(r.player) ?? 0) + (x(r) - mean));
  const g = by.size;
  let v = 0;
  for (const s of by.values()) v += s * s;
  const se = g > 1 ? Math.sqrt((g / (g - 1)) * v) / n : NaN;
  return { mean, se, n, players: g };
}

it("scores the multiway heuristic on shown bomb-pot hands", { timeout: 6 * 60 * 60_000 }, () => {
  if (!FILE || !existsSync(FILE)) {
    console.log("FLOPLIB_HANDS (JSONL of PHF hands) must be set; nothing to do");
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

  const rows: Row[] = [];
  const census = new Map<string, number>();
  const bump = (k: string) => census.set(k, (census.get(k) ?? 0) + 1);
  const grades: string[] = [];
  const gradeCount = new Map<string, number>();
  for (const [h, hand] of hands.entries()) {
    const context = buildContext(structuredClone(hand));
    const bomb = context.isBombPot;
    const seats = flopSeats(context);
    if (seats.length < 3) continue;
    if (bomb && (hand.game.bombPot?.doubleBoard || hand.board.runouts.length > 1)) {
      bump("bomb pot on two boards (left out)");
      continue;
    }
    bump(bomb ? "bomb-pot flops" : "other multiway flops");
    const actual = heroSeatOf(context);
    if (bomb && GRADES && actual !== null) {
      const result = analyzeHand(structuredClone(hand), { charts });
      for (const d of result.decisions) {
        const key = `${d.street} ${d.source} ${d.status === "analysed" ? (d.grade ?? "no grade") : d.reason}`;
        gradeCount.set(key, (gradeCount.get(key) ?? 0) + 1);
        if (d.grade === null) continue;
        const f = d.facts;
        grades.push(
          `hand ${h} ${d.street} ${f.board.join("")} | ${f.holeCards.join("")} ${d.action} ${f.toCallBb.toFixed(1)}bb into ${f.potBb.toFixed(1)}bb, ${f.players} players | ${d.source} ${d.grade} (EV loss ${d.evLoss?.toFixed(2)}bb) | equity ${f.equity ? (100 * f.equity.value).toFixed(0) : "?"}% | ${d.approximations.join(",")}`,
        );
      }
    }
    const shown = seats.filter((seat) => seat !== actual && (context.players.get(seat)?.holeCards?.length ?? 0) === 2);
    if (shown.length === 0) continue;
    const hero = actual !== null && seats.includes(actual) ? actual : seats[0];
    let walk: ReturnType<typeof walkMultiway>;
    try {
      walk = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, heuristicModel, { populationHero: actual ?? -1 });
    } catch {
      walk = { ok: false, reason: "range-empty" };
    }
    if (!walk.ok) {
      bump(`${bomb ? "bomb" : "other"}: walk failed ${walk.reason}`);
      continue;
    }
    const runout = hand.board.runouts[0];
    for (const seat of shown) {
      let combo: number;
      try {
        const cards = toIndices(context.players.get(seat)?.holeCards ?? []);
        combo = comboIndex(cards[0], cards[1]);
      } catch {
        continue;
      }
      const flopActs = hand.actions.filter((a) => a.street === "flop" && a.seat === seat && ["check", "bet", "raise", "call"].includes(a.type));
      if (flopActs.length === 0) continue;
      const name = `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
      const pre = walk.preflop.get(seat);
      if (!pre) continue;
      for (const street of ["turn", "river"] as const) {
        const at = walk.starts[street]?.get(seat);
        if (!at) continue;
        const codes = street === "turn" ? [...(runout?.flop ?? []), runout?.turn] : [...(runout?.flop ?? []), runout?.turn, runout?.river];
        const board = toIndices(codes.filter((c): c is string => !!c));
        rows.push({
          player: name,
          bomb,
          street,
          active: flopActs.some((a) => a.type !== "check"),
          players: seats.length,
          score: ll(at, combo),
          start: ll(without(pre, board), combo),
        });
      }
    }
  }
  console.log(`=== ${FILE}: ${hands.length} hands, ${rows.length} rows`);
  console.log(`census: ${[...census].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
  const report = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const lift = clustered(subset, (r) => r.score - r.start);
    const score = clustered(subset, (r) => r.score);
    const start = clustered(subset, (r) => r.start);
    const floor = subset.filter((r) => r.score <= FLOOR_LL + 1e-9).length;
    console.log(
      `--- ${title}: ${subset.length} rows (${lift.players} players); narrowed ${score.mean.toFixed(3)}, unnarrowed ${start.mean.toFixed(3)}, lift ${f3(lift.mean)} ± ${lift.se.toFixed(3)}; outside the range ${floor} (${((100 * floor) / subset.length).toFixed(1)}%)`,
    );
  };
  for (const street of ["turn", "river"] as const) {
    for (const bomb of [true, false]) {
      const kind = bomb ? "bomb pots" : "other multiway pots";
      const s = rows.filter((r) => r.bomb === bomb && r.street === street);
      report(`${street} start, ${kind}, everyone shown who acted on the flop`, s);
      report(`${street} start, ${kind}, bettors, raisers and callers on the flop`, s.filter((r) => r.active));
      report(`${street} start, ${kind}, checkers only`, s.filter((r) => !r.active));
      report(`${street} start, ${kind}, 3-4 saw the flop`, s.filter((r) => r.players <= 4));
      report(`${street} start, ${kind}, 5+ saw the flop`, s.filter((r) => r.players >= 5));
    }
  }
  if (GRADES) {
    console.log(`--- the hero's bomb-pot decisions: ${[...gradeCount].sort().map(([k, v]) => `${k} ${v}`).join("; ")}`);
    for (const g of grades) console.log(`  ${g}`);
  }
});
