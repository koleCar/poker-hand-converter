/**
 * The players behind a multiway call (§10, 2026-10-19/20, `analysis/29`): how
 * often the players still to answer a bet after someone has called it go on
 * to call (or raise) on the stored hands, against what the approximate call
 * grades assume (the narrowing model's MDF split, `modelResponders`), and
 * whether a population table in its place grades better.
 *
 * Part 1, the answers. In every pot three or more saw the flop of (one board;
 * every player, the hero too), at every call facing a bet or a raise with one
 * to three players still to answer behind it (the approximate call's
 * `responders`, `callEv` in `lib/analysis/multiway.ts`), each of those
 * players' next action: continue (call or raise) or fold - until someone
 * raises. The theory for each is exactly what the shipped call reads (the
 * caller as the hero: the same ranges, players, size, pruning). Candidate
 * tables are fitted on the other folds (five by hand; and five by the
 * answering player's name), scored by log-loss and Brier per answer,
 * standard errors clustered by hand (by player for the player folds).
 *
 * Part 2, the grades. Every hero decision of the multiway-flop hands analysed
 * twice (`AnalyzeOptions.responders`: the theory, and the candidate fitted
 * without the hand's fold), decision by decision; every changed grade
 * printed with `OVERCALL_GRADES=1` for a spot check (console only).
 *
 * Part 3, the checks. (a) The hero's approximate calls with players behind:
 * the model's call EV against what the hero won from the decision on (chips
 * collected minus chips put in from it), % of the pot, both fields. (b) At a
 * called multiway river bet, the bettor (who shows first, whatever they hold)
 * against the callers' calling ranges: the model's calling ranges (what
 * ships: only the frequency moves) and, for comparison, the same likelihood
 * raised to the power that puts it at the population's share (`powerAtShare`,
 * a tighter range in the model's order), predicted share against the share
 * won.
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl [OVERCALL_GRADES=1] [OVERCALL_CHART_ORDER=1] npm run floplib:multiway-overcall
 *
 * `OVERCALL_CHART_ORDER=1` re-runs it on `analysis/30`'s opponent ranges (no
 * `range-population-order`, analysis/31) - the before of that version's check
 * (multiway walks only: every pot here saw a multiway flop).
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it, vi } from "vitest";

vi.mock("../../../web/src/lib/analysis/rangeWalk.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../web/src/lib/analysis/rangeWalk.js")>();
  if (process.env.OVERCALL_CHART_ORDER !== "1") return original;
  type Options = NonNullable<Parameters<typeof original.preflopRangeOf>[5]>;
  const chartOrder = (options: Options | undefined) => (options ? { ...options, populationOrder: false } : options);
  return {
    ...original,
    preflopRangeOf: (...[hand, context, seat, before, charts, options]: Parameters<typeof original.preflopRangeOf>) =>
      original.preflopRangeOf(hand, context, seat, before, charts, chartOrder(options)),
    preflopClassRange: (...[hand, context, seat, before, charts, options]: Parameters<typeof original.preflopClassRange>) =>
      original.preflopClassRange(hand, context, seat, before, charts, chartOrder(options)),
  };
});

import {
  analyzeHand,
  callShare,
  EV_PRUNE_SHARE,
  flopSeats,
  heroSeatOf,
  heroSpots,
  heuristicModel,
  modelResponders,
  rangeWeight,
  removeCards,
  streetStrength,
  tableAt,
  walkMultiway,
  weightedCombos,
  type NarrowInput,
  type ResponderContext,
  type ResponderFrequency,
} from "../../../web/src/lib/analysis/index.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";
import { equityVsRanges } from "../../../web/src/lib/equity/multiway.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../web/src/lib/charts/index.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const GRADES = process.env.OVERCALL_GRADES === "1";
const PART2 = process.env.OVERCALL_PART2 !== "0";
const POSTFLOP = ["flop", "turn", "river"] as const;
type Street = (typeof POSTFLOP)[number];
const NOT_MONEY = new Set(["collect", "cashout-pay", "cashout-choose", "show", "muck"]);
const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const FOLDS = 5;
const foldOf = (hand: number) => (hand * 2654435761) % FOLDS;
const hashName = (name: string) => {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (h >>> 0) % FOLDS;
};

/* ------------------------------------------------------------ statistics - */

function clustered<T>(rows: readonly T[], key: (r: T) => string | number, x: (r: T) => number) {
  const n = rows.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0, clusters: 0 };
  const mean = rows.reduce((s, r) => s + x(r), 0) / n;
  const by = new Map<string | number, number>();
  for (const r of rows) by.set(key(r), (by.get(key(r)) ?? 0) + (x(r) - mean));
  const g = by.size;
  let v = 0;
  for (const s of by.values()) v += s * s;
  return { mean, se: g > 1 ? Math.sqrt((g / (g - 1)) * v) / n : NaN, n, clusters: g };
}

const clampP = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logloss = (p: number, y: number) => -(y * Math.log(clampP(p)) + (1 - y) * Math.log(1 - clampP(p)));
const brier = (p: number, y: number) => (p - y) ** 2;
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));

function fitLogistic(rows: ReadonlyArray<{ x: number[]; y: number }>, ridge = 1): number[] {
  const k = rows[0]?.x.length ?? 0;
  let w = new Array(k).fill(0);
  for (let iter = 0; iter < 50; iter += 1) {
    const g = new Array(k).fill(0);
    const h = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const { x, y } of rows) {
      const p = sigmoid(x.reduce((s, v, i) => s + v * w[i], 0));
      for (let i = 0; i < k; i += 1) {
        g[i] += (p - y) * x[i];
        for (let j = 0; j < k; j += 1) h[i][j] += p * (1 - p) * x[i] * x[j];
      }
    }
    for (let i = 0; i < k; i += 1) {
      g[i] += ridge * w[i];
      h[i][i] += ridge;
    }
    const step = solve(h, g);
    w = w.map((v, i) => v - step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  return w;
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c] || 1e-12;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = m[r][c] / d;
      for (let j = c; j <= n; j += 1) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-12));
}

/**
 * A tighter calling range at a known share (comparison only): the model's
 * call likelihood `L` raised to the power that makes the share exactly
 * `share` (combos at `L = 1` stay, so it cannot go below their mass).
 */
function powerAtShare(likelihood: Float64Array, actor: Float64Array, share: number): Float64Array {
  let total = 0;
  for (let c = 0; c < actor.length; c += 1) if (actor[c] > 0) total += actor[c];
  const l = Array.from(likelihood, (v) => Math.min(1, Math.max(0, v || 0)));
  const mass = (g: number) => {
    let s = 0;
    for (let c = 0; c < actor.length; c += 1) if (actor[c] > 0 && l[c] > 0) s += actor[c] * Math.pow(l[c], g);
    return s / total;
  };
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    if (mass(Math.exp(mid)) > share) lo = mid;
    else hi = mid;
  }
  const g = Math.exp((lo + hi) / 2);
  const out = new Float64Array(actor.length);
  for (let c = 0; c < actor.length; c += 1) if (actor[c] > 0 && l[c] > 0) out[c] = actor[c] * Math.pow(l[c], g);
  return out;
}

/* ------------------------------------------------------------ the rows - */

interface Row extends ResponderContext {
  hand: number;
  player: string;
  /** This player's place among those to answer (0 first). */
  order: number;
  /** Someone after the caller and before this player continued. */
  againCalled: boolean;
  y: number;
}

const sizeBucket = (s: number) => (s < 0.4 ? "<40%" : s < 0.6 ? "40-60%" : s < 0.85 ? "60-85%" : "85%+");
const SIZE_BUCKETS = ["<40%", "40-60%", "60-85%", "85%+"] as const;

/** A candidate: fitted on rows, a frequency for any context. */
interface Candidate {
  id: string;
  params: number;
  fit(rows: readonly Row[]): (ctx: ResponderContext) => number;
}

/** Shrunk cell rates: each level towards its parent by `m` pseudo-answers. */
function tableCandidate(id: string, keys: Array<(c: ResponderContext) => string>, m = 20): Candidate {
  return {
    id,
    params: 0,
    fit(rows) {
      const all = rows.reduce((s, r) => s + r.y, 0) / Math.max(1, rows.length);
      const levels = keys.map((_, depth) => {
        const cells = new Map<string, { n: number; y: number }>();
        for (const r of rows) {
          const k = keys
            .slice(0, depth + 1)
            .map((f) => f(r))
            .join("|");
          const c = cells.get(k) ?? { n: 0, y: 0 };
          c.n += 1;
          c.y += r.y;
          cells.set(k, c);
        }
        return cells;
      });
      return (ctx) => {
        let p = all;
        for (let depth = 0; depth < keys.length; depth += 1) {
          const k = keys
            .slice(0, depth + 1)
            .map((f) => f(ctx))
            .join("|");
          const c = levels[depth].get(k);
          if (c) p = (c.y + m * p) / (c.n + m);
        }
        return p;
      };
    },
  };
}

function logisticCandidate(id: string, features: (c: ResponderContext) => number[]): Candidate {
  return {
    id,
    params: 0,
    fit(rows) {
      const w = fitLogistic(rows.map((r) => ({ x: features(r), y: r.y })));
      return (ctx) => sigmoid(features(ctx).reduce((s, v, i) => s + v * w[i], 0));
    },
  };
}

const streetIndex = (s: string) => POSTFLOP.indexOf(s as Street);
const oneHot = (c: ResponderContext) => {
  const x = [0, 0, 0];
  x[streetIndex(c.street)] = 1;
  return x;
};

/** Fitted on the answers to a bet only; behind a call of a raise the model's own share. */
function betsOnly(c: Candidate): Candidate {
  return {
    id: `${c.id}, bets only`,
    params: c.params,
    fit(rows) {
      const f = c.fit(rows.filter((r) => !r.raised));
      return (ctx) => (ctx.raised ? ctx.model : f(ctx));
    },
  };
}

const recal = logisticCandidate("recalibrated theory (per street)", (c) => [...oneHot(c), logit(c.model)]);
const recalCommon = logisticCandidate("recalibrated theory (one intercept)", (c) => [1, logit(c.model)]);
const recalSlopes = logisticCandidate("recalibrated theory (per street, slope per street)", (c) => {
  const x = [...oneHot(c), 0, 0, 0];
  x[3 + streetIndex(c.street)] = logit(c.model);
  return x;
});

const CANDIDATES: Candidate[] = [
  betsOnly(recal),
  betsOnly(recalCommon),
  betsOnly(recalSlopes),
  betsOnly(tableCandidate("street × size", [(c) => c.street, (c) => sizeBucket(c.sizePot)])),
  tableCandidate("street", [(c) => c.street]),
  tableCandidate("street × size", [(c) => c.street, (c) => sizeBucket(c.sizePot)]),
  tableCandidate("street × size × behind", [(c) => c.street, (c) => sizeBucket(c.sizePot), (c) => (c.responders >= 2 ? "2+" : "1")]),
  logisticCandidate("logistic street, log size, behind", (c) => {
    const x = [...oneHot(c), 0, 0, 0, c.responders - 1];
    x[3 + streetIndex(c.street)] = Math.log(Math.max(0.05, c.sizePot));
    return x;
  }),
  recal,
  logisticCandidate("recalibrated theory + log size", (c) => {
    const x = [...oneHot(c), logit(c.model), 0, 0, 0];
    x[4 + streetIndex(c.street)] = Math.log(Math.max(0.05, c.sizePot));
    return x;
  }),
];

/* ---------------------------------------------------------------- study - */

it("measures the players behind a multiway call, held out, and the grades on the population's frequency", { timeout: 6 * 60 * 60_000 }, () => {
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
  const census = new Map<string, number>();
  const bump = (k: string) => census.set(k, (census.get(k) ?? 0) + 1);
  const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

  /* ------------------------------------------------ part 1: the rows - */
  const rows: Row[] = [];
  const multiwayHands: number[] = [];
  for (const [h, hand] of hands.entries()) {
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 3) continue;
    if (hand.game.bombPot?.doubleBoard || hand.board.runouts.length > 1) continue;
    const actual = heroSeatOf(context);
    const walker = actual !== null && seats.includes(actual) ? actual : seats[0];
    if (actual !== null && seats.includes(actual)) multiwayHands.push(h);
    let walk: ReturnType<typeof walkMultiway>;
    try {
      walk = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), walker, charts, heuristicModel, {
        populationHero: actual ?? -1,
      });
    } catch {
      walk = { ok: false, reason: "range-empty" };
    }
    if (!walk.ok) {
      bump(`walk failed ${walk.reason}`);
      continue;
    }
    const nameOf = new Map(hand.players.map((p) => [p.seat, p.name]));
    // Every seat's spots, by action index (heroSpots reads any seat).
    const spotAt = new Map<number, ReturnType<typeof heroSpots>[number]>();
    for (const seat of seats) for (const spot of heroSpots(context, seat)) spotAt.set(spot.action.index, spot);
    const postflop = hand.actions.filter(
      (a) => (POSTFLOP as readonly string[]).includes(a.street) && a.seat !== null && DECISIONS.has(a.type),
    );
    for (const call of postflop) {
      if (call.type !== "call") continue;
      const spot = spotAt.get(call.index);
      if (!spot || spot.toCall <= 0) continue;
      const table = tableAt(hand, call.index);
      const ranges = walk.before(call.index);
      if (!table || !ranges) continue;
      if (spot.toCall < table.high - spot.heroStreet - 1e-9) continue; // all-in for less
      if (table.opponents.some((o) => o.allIn && o.streetTotal < table.high)) continue;
      const street = call.street as Street;
      const aggressions = hand.actions.filter(
        (a) => a.street === street && a.index < call.index && (a.type === "bet" || a.type === "raise"),
      ).length;
      const callerRange = ranges.get(call.seat as number);
      if (!callerRange) continue;
      const known = toIndices(context.players.get(call.seat as number)?.holeCards ?? []);
      const prep = (range: Float64Array) => {
        const out = removeCards(Float64Array.from(range), known.length === 2 ? known : []);
        let max = 0;
        for (let c = 0; c < out.length; c += 1) max = Math.max(max, out[c]);
        for (let c = 0; c < out.length; c += 1) if (out[c] < max * EV_PRUNE_SHARE) out[c] = 0;
        return out;
      };
      const fixed: Float64Array[] = [];
      const responders: Array<{ seat: number; range: Float64Array }> = [];
      let bad = false;
      for (const o of table.opponents) {
        const r = ranges.get(o.seat);
        if (!r) {
          bad = true;
          break;
        }
        const own = prep(r);
        if (rangeWeight(own) <= 0) {
          bad = true;
          break;
        }
        if (o.allIn || o.streetTotal >= table.high) fixed.push(own);
        else responders.push({ seat: o.seat, range: own });
      }
      if (bad || responders.length === 0 || responders.length > 3) continue;
      const board = toIndices(spot.board);
      const strength = streetStrength(board);
      const players = table.opponents.length + 1;
      const sizePot = spot.potBefore - spot.toCall > 0 ? Math.round((1000 * spot.toCall) / (spot.potBefore - spot.toCall)) / 1000 : 0.5;
      // Each responder's next action, until a raise.
      let raisedSince = false;
      let againCalled = false;
      const after = hand.actions.filter((a) => a.street === street && a.index > call.index && a.seat !== null && DECISIONS.has(a.type));
      const answered = new Map<number, number>();
      for (const a of after) {
        if (raisedSince) break;
        const i = responders.findIndex((r) => r.seat === a.seat);
        if (i < 0 || answered.has(i)) continue;
        const y = a.type === "fold" ? 0 : a.type === "call" || a.type === "raise" ? 1 : -1;
        if (y < 0) break;
        answered.set(i, y);
        const responder = responders[i];
        const others = [callerRange, ...fixed, ...responders.filter((r) => r !== responder).map((r) => r.range)];
        const input: Omit<NarrowInput, "action"> = { street, board, actor: responder.range, opponent: others[0], strength };
        if (others.length >= 2) {
          input.players = players;
          input.opponents = others;
        }
        const theory = callShare(heuristicModel, input, sizePot).share;
        rows.push({
          hand: h,
          player: nameOf.get(responder.seat) ?? `seat${responder.seat}`,
          street,
          sizePot,
          responders: responders.length,
          players,
          model: theory,
          raised: aggressions >= 2,
          order: i,
          againCalled,
          y,
        });
        if (y === 1) againCalled = true;
        if (a.type === "raise") raisedSince = true;
      }
    }
  }
  console.log(
    `=== ${FILE}: ${hands.length} hands; multiway hands with the hero ${multiwayHands.length}; ${[...census].map(([k, v]) => `${k} ${v}`).join(", ")}`,
  );
  console.log(`answers behind a call: ${rows.length} (${new Set(rows.map((r) => r.hand)).size} hands, ${new Set(rows.map((r) => r.player)).size} players)`);

  /* --------------------------------------------- held out: per candidate - */
  const heldOut = (cand: Candidate, key: (r: Row) => number) => {
    const per = new Map<number, (c: ResponderContext) => number>();
    for (let k = 0; k < FOLDS; k += 1) per.set(k, cand.fit(rows.filter((r) => key(r) !== k)));
    return (r: Row) => (per.get(key(r)) as (c: ResponderContext) => number)(r);
  };
  const byHand = (r: Row) => foldOf(r.hand);
  const byPlayer = (r: Row) => hashName(r.player);
  const predictions = new Map<string, { hand: (r: Row) => number; player: (r: Row) => number }>();
  for (const cand of CANDIDATES) predictions.set(cand.id, { hand: heldOut(cand, byHand), player: heldOut(cand, byPlayer) });

  const report = (title: string, subset: Row[]) => {
    if (subset.length === 0) return;
    const obs = clustered(subset, (r) => r.hand, (r) => r.y);
    const th = clustered(subset, (r) => r.hand, (r) => r.model);
    console.log(
      `${title}: n ${subset.length} (${obs.clusters} hands) | continued ${obs.mean.toFixed(3)} ± ${obs.se.toFixed(3)} | theory ${th.mean.toFixed(3)} | theory log-loss ${clustered(subset, (r) => r.hand, (r) => logloss(r.model, r.y)).mean.toFixed(3)}`,
    );
    for (const cand of CANDIDATES) {
      const p = predictions.get(cand.id)!;
      const pm = clustered(subset, (r) => r.hand, p.hand);
      const dl = clustered(subset, (r) => r.hand, (r) => logloss(r.model, r.y) - logloss(p.hand(r), r.y));
      const db = clustered(subset, (r) => r.hand, (r) => brier(r.model, r.y) - brier(p.hand(r), r.y));
      const dlp = clustered(subset, (r) => r.player, (r) => logloss(r.model, r.y) - logloss(p.player(r), r.y));
      console.log(
        `    ${cand.id}: predicted ${pm.mean.toFixed(3)} | log-loss theory − it ${f3(dl.mean)} ± ${dl.se.toFixed(3)} (by player ${f3(dlp.mean)} ± ${dlp.se.toFixed(3)}) | Brier ${f3(db.mean)} ± ${db.se.toFixed(3)}`,
      );
    }
  };
  console.log("--- answers behind a call, held out (5 folds by hand; by player in brackets)");
  report("all", rows);
  report("facing a bet (not a raise)", rows.filter((r) => !r.raised));
  report("facing a raise", rows.filter((r) => r.raised));
  for (const s of POSTFLOP) {
    const sub = rows.filter((r) => r.street === s);
    report(s, sub);
    for (const b of SIZE_BUCKETS) report(`  ${s} ${b}`, sub.filter((r) => sizeBucket(r.sizePot) === b));
    report(`  ${s} 1 behind`, sub.filter((r) => r.responders === 1));
    report(`  ${s} 2+ behind`, sub.filter((r) => r.responders >= 2));
    report(`  ${s} after another continued`, sub.filter((r) => r.againCalled));
  }

  // The recalibrations' weights on every answer to a bet (what would be committed).
  {
    const bets = rows.filter((r) => !r.raised);
    const w1 = fitLogistic(bets.map((r) => ({ x: [...oneHot(r), logit(r.model)], y: r.y })));
    const w0 = fitLogistic(bets.map((r) => ({ x: [1, logit(r.model)], y: r.y })));
    const w2 = fitLogistic(
      bets.map((r) => {
        const x = [...oneHot(r), 0, 0, 0];
        x[3 + streetIndex(r.street)] = logit(r.model);
        return { x, y: r.y };
      }),
    );
    console.log(
      `recalibration weights on every answer to a bet (${bets.length}): per street [${w1.map((v) => v.toFixed(3)).join(", ")}]; one intercept [${w0.map((v) => v.toFixed(3)).join(", ")}]; slope per street [${w2.map((v) => v.toFixed(3)).join(", ")}]`,
    );
    for (const k of [0, 1, 2, 3, 4]) {
      const wk = fitLogistic(bets.filter((r) => foldOf(r.hand) !== k).map((r) => ({ x: [...oneHot(r), logit(r.model)], y: r.y })));
      console.log(`  per street without fold ${k}: [${wk.map((v) => v.toFixed(3)).join(", ")}]`);
    }
    const t = bets.map((r) => r.model).sort((a, b) => a - b);
    const q = (p: number) => t[Math.floor(p * (t.length - 1))].toFixed(3);
    console.log(`  theory share quantiles 10/50/90%: ${q(0.1)} / ${q(0.5)} / ${q(0.9)}`);
    const sorted = [...bets].sort((a, b) => a.model - b.model);
    const dec: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const part = sorted.slice(Math.floor((i * sorted.length) / 5), Math.floor(((i + 1) * sorted.length) / 5));
      const obs = part.reduce((s, r) => s + r.y, 0) / part.length;
      const th = part.reduce((s, r) => s + r.model, 0) / part.length;
      dec.push(`theory ${th.toFixed(3)} → continued ${obs.toFixed(3)} (n ${part.length})`);
    }
    console.log(`  by fifth of the theory: ${dec.join("; ")}`);
  }
  // The tables on everything.
  for (const cand of CANDIDATES.slice(4, 7)) {
    const f = cand.fit(rows);
    const lines: string[] = [];
    for (const s of POSTFLOP)
      for (const b of SIZE_BUCKETS) {
        const mid = { "<40%": 0.3, "40-60%": 0.5, "60-85%": 0.72, "85%+": 1 }[b];
        const n1 = rows.filter((r) => r.street === s && sizeBucket(r.sizePot) === b && r.responders === 1).length;
        const n2 = rows.filter((r) => r.street === s && sizeBucket(r.sizePot) === b && r.responders >= 2).length;
        lines.push(
          `${s} ${b}: 1 behind ${f({ street: s, sizePot: mid, responders: 1, players: 3, model: 0.5, raised: false }).toFixed(3)} (n ${n1}), 2+ behind ${f({ street: s, sizePot: mid, responders: 2, players: 4, model: 0.5, raised: false }).toFixed(3)} (n ${n2})`,
        );
      }
    console.log(`table "${cand.id}" on every answer:\n  ${lines.join("\n  ")}`);
  }

  if (!PART2) return;
  const CHOSEN = process.env.OVERCALL_CANDIDATE ?? "recalibrated theory (per street), bets only";
  const chosen = CANDIDATES.find((c) => c.id === CHOSEN) as Candidate;
  const perFold = new Map<number, ResponderFrequency>();
  for (let k = 0; k < FOLDS; k += 1) {
    const f = chosen.fit(rows.filter((r) => foldOf(r.hand) !== k));
    perFold.set(k, (ctx) => f(ctx));
  }
  console.log(`--- part 2: grades, the theory against "${CHOSEN}" fitted without the hand's fold`);

  /* ------------------------------------------- part 2: the hero's grades - */
  const moves = new Map<string, number>();
  const bumpMove = (k: string) => moves.set(k, (moves.get(k) ?? 0) + 1);
  const lines: string[] = [];
  interface Check {
    hand: number;
    street: string;
    pot: number;
    theory: number;
    population: number;
    realised: number;
  }
  const checks: Check[] = [];
  for (const h of multiwayHands) {
    const hand = hands[h];
    const before = analyzeHand(structuredClone(hand), { charts, responders: modelResponders });
    const after = analyzeHand(structuredClone(hand), { charts, responders: perFold.get(foldOf(h)) });
    const context = buildContext(structuredClone(hand));
    const hero = heroSeatOf(context) as number;
    const bb = Math.max(1, hand.game.bigBlind);
    for (const d of before.decisions) {
      const a = after.decisions.find((x) => x.actionIndex === d.actionIndex);
      if (!a) {
        bumpMove("missing after");
        continue;
      }
      const evB = d.facts.multiway?.ev ?? null;
      const evA = a.facts.multiway?.ev ?? null;
      const same = d.grade === a.grade && d.reason === a.reason && d.source === a.source;
      const approxCall = d.source === "approx" && (d.action === "call" || d.action === "fold");
      if (!same) bumpMove(`${approxCall ? "approx call/fold" : "OTHER"} ${d.street} ${d.action}: ${d.grade ?? d.reason} → ${a.grade ?? a.reason}`);
      else if (approxCall) bumpMove(`approx call/fold ${d.street} unchanged${evB && evB.respond.length > 0 ? " (players behind)" : ""}`);
      if (approxCall && evB && evA && evB.respond.length > 0) {
        const hole = (context.players.get(hero)?.holeCards ?? []).join("");
        const line = `hand ${h} | ${d.street} ${d.action} ${hole} on ${d.facts.board.join("")} | facing ${Math.round(100 * (d.facts.facingPot ?? 0))}% into ${d.facts.potBb.toFixed(1)}bb, ${d.facts.multiway?.players} players, behind ${evB.respond.map((r) => `${r.position ?? "?"} ${r.call.toFixed(2)}→${(evA.respond.find((x) => x.position === r.position)?.call ?? NaN).toFixed(2)}`).join(", ")} | call EV ${evB.call.toFixed(2)} → ${evA.call.toFixed(2)}bb, equity ${evB.equity.toFixed(3)} → ${evA.equity.toFixed(3)} | ${d.grade} → ${a.grade}${d.grade !== a.grade ? "  <<< CHANGED" : ""}`;
        if (GRADES || d.grade !== a.grade) lines.push(line);
        if (d.action === "call") {
          const result = hand.results.players.find((p) => p.seat === hero);
          const putIn = hand.actions
            .filter((x) => x.seat === hero && x.index >= d.actionIndex && !NOT_MONEY.has(x.type))
            .reduce((s, x) => s + x.amount, 0);
          // The call EV is net of the call, fold 0: realised = won − put in from the call on.
          checks.push({
            hand: h,
            street: d.street,
            pot: d.facts.potBb,
            theory: evB.call,
            population: evA.call,
            realised: ((result?.won ?? 0) - putIn) / bb,
          });
        }
      }
    }
  }
  console.log([...moves].sort().map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  console.log(lines.join("\n"));

  /* -------------------------------------------------- part 3: the checks - */
  const reportChecks = (title: string, subset: Check[]) => {
    if (subset.length === 0) return;
    const r = clustered(subset, (c) => c.hand, (c) => c.realised / c.pot);
    const dt = clustered(subset, (c) => c.hand, (c) => (c.realised - c.theory) / c.pot);
    const dp = clustered(subset, (c) => c.hand, (c) => (c.realised - c.population) / c.pot);
    const sq = clustered(subset, (c) => c.hand, (c) => ((c.realised - c.theory) / c.pot) ** 2 - ((c.realised - c.population) / c.pot) ** 2);
    console.log(
      `${title}: n ${subset.length} | realised ${r.mean.toFixed(3)} ± ${r.se.toFixed(3)} of the pot | realised − theory ${f3(dt.mean)} ± ${dt.se.toFixed(3)} | realised − population ${f3(dp.mean)} ± ${dp.se.toFixed(3)} | squared error theory − population ${f3(sq.mean)} ± ${sq.se.toFixed(3)}`,
    );
  };
  console.log("--- part 3a: the hero's approximate calls with players behind, call EV against what was won");
  reportChecks("all", checks);
  for (const s of POSTFLOP) reportChecks(s, checks.filter((c) => c.street === s));

  // 3b: a called multiway river bet, the bettor against the callers' calling ranges.
  interface Share {
    hand: number;
    won: number;
    mdf: number;
    population: number;
  }
  const shares: Share[] = [];
  for (const [h, hand] of hands.entries()) {
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 3 || hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    if (hand.actions.some((a) => a.allIn) || hand.results.pots.length > 1) continue;
    const river = hand.actions.filter((a) => a.street === "river" && a.seat !== null && DECISIONS.has(a.type));
    const firstBet = river.find((a) => a.type === "bet");
    if (!firstBet || river.some((a) => a.type === "raise")) continue;
    const bettor = firstBet.seat as number;
    const callers = river.filter((a) => a.index > firstBet.index && a.type === "call");
    if (callers.length === 0) continue;
    if ((context.players.get(bettor)?.holeCards?.length ?? 0) !== 2) continue;
    const atRiver = new Set(river.map((a) => a.seat as number));
    if (atRiver.size < 3) continue;
    const showdown = [bettor, ...callers.map((a) => a.seat as number)];
    const won = new Map(hand.results.players.map((p) => [p.seat, p.won]));
    const totalWon = showdown.reduce((s, seat) => s + (won.get(seat) ?? 0), 0);
    if (!(totalWon > 0)) continue;
    const actual = heroSeatOf(context);
    const walker = actual !== null && seats.includes(actual) ? actual : seats[0];
    let walk: ReturnType<typeof walkMultiway>;
    try {
      walk = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), walker, charts, heuristicModel, {
        populationHero: actual ?? -1,
      });
    } catch {
      continue;
    }
    if (!walk.ok) continue;
    const boardCodes = [...(hand.board.runouts[0].flop ?? []), hand.board.runouts[0].turn, hand.board.runouts[0].river].filter(
      (c): c is string => !!c,
    );
    const board = toIndices(boardCodes);
    const strength = streetStrength(board);
    let potBefore = 0;
    for (const a of hand.actions) {
      if (a.index >= firstBet.index) break;
      if (a.seat !== null && !NOT_MONEY.has(a.type)) potBefore += a.amount;
    }
    const sizePot = potBefore > 0 ? firstBet.amount / potBefore : 0.5;
    const f = perFold.get(foldOf(h)) as ResponderFrequency;
    const answering = river.filter((a) => a.index > firstBet.index && (a.type === "call" || a.type === "fold"));
    const mdf: Float64Array[] = [];
    const pop: Float64Array[] = [];
    let ok = true;
    for (const a of callers) {
      const ranges = walk.before(a.index);
      const actor = ranges?.get(a.seat as number);
      if (!ranges || !actor) {
        ok = false;
        break;
      }
      const others = [...ranges.keys()].filter((s) => s !== a.seat).map((s) => ranges.get(s) as Float64Array);
      const input: Omit<NarrowInput, "action"> = { street: "river", board, actor, opponent: others[0], strength };
      if (others.length >= 2) {
        input.players = others.length + 1;
        input.opponents = others;
      }
      const own = callShare(heuristicModel, input, sizePot);
      mdf.push(own.range);
      const target = f({ street: "river", sizePot, responders: answering.length, players: others.length + 1, model: own.share, raised: false }) ?? own.share;
      pop.push(powerAtShare(heuristicModel.likelihood({ ...input, action: { kind: "call", sizePot, allIn: false } }), actor, target));
    }
    if (!ok) continue;
    const cards = context.players.get(bettor)?.holeCards ?? [];
    const shareOf = (ranges: Float64Array[]) => {
      const lists = ranges.map((r) => weightedCombos(removeCards(Float64Array.from(r), toIndices(cards)))).filter((l) => l.length > 0);
      if (lists.length === 0) return NaN;
      return equityVsRanges({ hero: [...cards], ranges: lists, board: boardCodes, seed: 77 + h, trials: 8000 }).equity;
    };
    const m = shareOf(mdf);
    const p = shareOf(pop);
    if (Number.isFinite(m) && Number.isFinite(p)) shares.push({ hand: h, won: (won.get(bettor) ?? 0) / totalWon, mdf: m, population: p });
  }
  {
    const wn = clustered(shares, (s) => s.hand, (s) => s.won);
    const dm = clustered(shares, (s) => s.hand, (s) => s.won - s.mdf);
    const dp = clustered(shares, (s) => s.hand, (s) => s.won - s.population);
    const sq = clustered(shares, (s) => s.hand, (s) => (s.won - s.mdf) ** 2 - (s.won - s.population) ** 2);
    console.log(
      `--- part 3b: called multiway river bets, the bettor's share: n ${shares.length} | won ${wn.mean.toFixed(3)} ± ${wn.se.toFixed(3)} | won − the model's calling ranges (shipped) ${f3(dm.mean)} ± ${dm.se.toFixed(3)} | won − tightened to the population's share ${f3(dp.mean)} ± ${dp.se.toFixed(3)} | squared error model − tightened ${f3(sq.mean)} ± ${sq.se.toFixed(3)}`,
    );
  }
});
