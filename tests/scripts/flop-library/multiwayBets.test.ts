/**
 * Multiway checks and bets (§10, 2026-10-19, not shipped): how a multiway
 * field answers a bet and bets when not facing one, on the stored hands, and
 * whether a river check-or-bet model built on it (`multiwayRiver.ts`, study
 * code beside this file) holds held out.
 *
 * Part 1, the field. In every pot three or more saw the flop of (bomb pots on
 * one board included; every player, the hero too):
 *   - **answers**: every street's first bet with two or more players to
 *     answer it, each player's first answer (fold; call or raise) up to the
 *     first raise;
 *   - **opens**: every decision not facing a bet with three or more live
 *     players (bet or check).
 * Each is scored against the theory (the narrowing model's MDF call share
 * and betting share: what the multiway call grades assume) and the
 * population model (`answerFeatures`, `openFeatures`: logistic per street)
 * fitted on the other folds - five folds by hand. Log-loss per answer, and
 * P(everyone folds) per bet; standard errors clustered by hand.
 *
 * Part 2, the whole river model held out. Every hero river decision not
 * facing a bet in such a pot that `riverCheckBetInput` takes (at most three
 * opponents, nobody all-in): the EV of the action taken by the population
 * model fitted without the hand's fold, and by the theory, against what the
 * hero actually won from the decision on (chips collected minus chips put
 * in from the decision), in % of the pot. Then the showdown share alone,
 * every player: at a river checked through three or more ways the first to
 * act (who shows first, so the sample is not selected on the result)
 * against the others' ranges after their checks, and at a called river bet
 * the bettor (who shows first) against the callers' calling ranges; with a
 * heads-up control, the shares against the preflop ranges and against any
 * two cards for scale, and the same with harder check trims (a probe).
 *
 * Part 3: the would-be grades of those hero decisions (both fields, the
 * smaller loss; and each field alone); with `MWBETS_GRADES=1` each one
 * printed for a spot check, and the hero's `multiway` decisions counted by
 * street, action and whether the hero was last to act.
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl [MWBETS_GRADES=1] npm run floplib:multiway-bets
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import {
  analyzeHand,
  callShare,
  flopSeats,
  heroSeatOf,
  heroSpots,
  heuristicModel,
  narrow,
  rangeWeight,
  removeCards,
  streetStrength,
  walkMultiway,
  weightedCombos,
  type NarrowingModel,
  type NarrowInput,
} from "../../../frontend/src/lib/analysis/index.js";
import {
  answerFeatures,
  callAtShare,
  gradeRiverCheckBet,
  logistic,
  openFeatures,
  populationField,
  RIVER_BET_MENU,
  riverCheckBetEv,
  riverCheckBetInput,
  theoryField,
  type AnswerContext,
  type OpenContext,
} from "./multiwayRiver.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";
import { equityVsRanges } from "../../../frontend/src/lib/equity/multiway.js";
import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  loadCharts,
  type ChartSet,
} from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const GRADES = process.env.MWBETS_GRADES === "1";
const POSTFLOP = ["flop", "turn", "river"] as const;
type Street = (typeof POSTFLOP)[number];
const NOT_MONEY = new Set([
  "collect",
  "cashout-pay",
  "cashout-choose",
  "show",
  "muck",
]);
const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const FOLDS = 5;
const foldOf = (hand: number) => (hand * 2654435761) % FOLDS;

interface Answer extends AnswerContext {
  hand: number;
  y: number;
  theory: number;
}

interface Open extends OpenContext {
  hand: number;
  y: number;
  theory: number;
}

interface Bet {
  hand: number;
  street: Street;
  size: number;
  answers: Answer[];
  facing: number;
  allFold: boolean;
  hero: boolean;
}

function boardOf(hand: PhfHand, street: Street): number[] {
  const r = hand.board.runouts[0];
  if (!r?.flop || r.flop.length !== 3) return [];
  const codes = [...r.flop];
  if (street !== "flop") {
    if (!r.turn) return [];
    codes.push(r.turn);
  }
  if (street === "river") {
    if (!r.river) return [];
    codes.push(r.river);
  }
  return toIndices(codes);
}

/* ------------------------------------------------------------ statistics - */

function clustered<T>(
  rows: readonly T[],
  key: (r: T) => string | number,
  x: (r: T) => number,
) {
  const n = rows.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0, clusters: 0 };
  const mean = rows.reduce((s, r) => s + x(r), 0) / n;
  const by = new Map<string | number, number>();
  for (const r of rows) by.set(key(r), (by.get(key(r)) ?? 0) + (x(r) - mean));
  const g = by.size;
  let v = 0;
  for (const s of by.values()) v += s * s;
  return {
    mean,
    se: g > 1 ? Math.sqrt((g / (g - 1)) * v) / n : NaN,
    n,
    clusters: g,
  };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clampP = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const predict = (w: readonly number[], x: readonly number[]) =>
  sigmoid(x.reduce((s, v, i) => s + v * w[i], 0));
const logloss = (p: number, y: number) =>
  -(y * Math.log(clampP(p)) + (1 - y) * Math.log(1 - clampP(p)));

/** Logistic regression by Newton's method with a small ridge. */
function fitLogistic(
  rows: ReadonlyArray<{ x: number[]; y: number }>,
  ridge = 1,
): number[] {
  const k = rows[0]?.x.length ?? 0;
  let w = new Array(k).fill(0);
  for (let iter = 0; iter < 50; iter += 1) {
    const g = new Array(k).fill(0);
    const h = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const { x, y } of rows) {
      const p = predict(w, x);
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
    for (let r = c + 1; r < n; r += 1)
      if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
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

/** Weights per fold (fitted without it) and on everything. */
function folds<T extends { hand: number; y: number }>(
  rows: readonly T[],
  features: (r: T) => number[],
) {
  const per = new Map<number, number[]>();
  for (let k = 0; k < FOLDS; k += 1)
    per.set(
      k,
      fitLogistic(
        rows
          .filter((r) => foldOf(r.hand) !== k)
          .map((r) => ({ x: features(r), y: r.y })),
      ),
    );
  return {
    per,
    all: fitLogistic(rows.map((r) => ({ x: features(r), y: r.y }))),
  };
}

/* ---------------------------------------------------------------- study - */

it(
  "measures how multiway fields answer and open, and the river check-or-bet model held out",
  { timeout: 6 * 60 * 60_000 },
  () => {
    if (!FILE || !existsSync(FILE)) {
      console.log(
        "FLOPLIB_HANDS (JSONL of PHF hands) must be set; nothing to do",
      );
      return;
    }
    const hands: PhfHand[] = readFileSync(FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PhfHand);
    const load = (id: string) =>
      loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
    const sets = CHART_SETS.map((spec) => load(spec.id));
    const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
    const charts = chartLibrary([single, ...sets.filter((s) => s !== single)]);

    const bets: Bet[] = [];
    const opens: Open[] = [];
    const riverSizes: number[] = [];
    const census = new Map<string, number>();
    const bump = (k: string) => census.set(k, (census.get(k) ?? 0) + 1);
    const multiwayHands: number[] = [];

    for (const [h, hand] of hands.entries()) {
      const context = buildContext(structuredClone(hand));
      const seats = flopSeats(context);
      if (seats.length < 3) continue;
      if (hand.game.bombPot?.doubleBoard || hand.board.runouts.length > 1)
        continue;
      const actual = heroSeatOf(context);
      const hero =
        actual !== null && seats.includes(actual) ? actual : seats[0];
      let walk: ReturnType<typeof walkMultiway>;
      try {
        walk = walkMultiway(
          structuredClone(hand),
          buildContext(structuredClone(hand)),
          hero,
          charts,
          heuristicModel,
          { populationHero: actual ?? -1 },
        );
      } catch {
        walk = { ok: false, reason: "range-empty" };
      }
      if (!walk.ok) {
        bump(`walk failed ${walk.reason}`);
        continue;
      }
      bump("multiway flops walked");
      if (actual !== null && seats.includes(actual)) multiwayHands.push(h);

      let pot = 0;
      let street: string | null = null;
      let totals = new Map<number, number>();
      let high = 0;
      let checks = 0;
      const live = new Set(seats);
      const allIn = new Set<number>();
      const checkedOn = new Set<number>();
      let open: { bet: Bet; pending: number[]; raised: boolean } | null = null;
      const strengths = new Map<Street, ReturnType<typeof streetStrength>>();
      const strengthOf = (st: Street) => {
        let s = strengths.get(st);
        if (!s) {
          s = streetStrength(boardOf(hand, st));
          strengths.set(st, s);
        }
        return s;
      };
      for (const action of hand.actions) {
        if (action.street !== street) {
          street = action.street;
          totals = new Map();
          high = 0;
          checks = 0;
          checkedOn.clear();
          open = null;
        }
        if (action.seat === null || NOT_MONEY.has(action.type)) continue;
        const postflop = (POSTFLOP as readonly string[]).includes(
          action.street,
        );
        const st = action.street as Street;
        if (postflop && DECISIONS.has(action.type) && live.has(action.seat)) {
          const seat = action.seat;
          const mine = totals.get(seat) ?? 0;
          const toCall = Math.max(0, high - mine);
          const ranges = walk.before(action.index);
          const board = boardOf(hand, st);
          const actor = ranges?.get(seat);
          const others = ranges
            ? [...ranges.keys()]
                .filter((s) => s !== seat)
                .map((s) => ranges.get(s) as Float64Array)
            : [];
          const input: Omit<NarrowInput, "action"> | null =
            actor && board.length >= 3 && others.length > 0
              ? {
                  street: st,
                  board,
                  actor,
                  opponent: others[0],
                  strength: strengthOf(st),
                }
              : null;
          if (input && others.length >= 2) {
            input.players = others.length + 1;
            input.opponents = others;
          }
          // Opens: not facing a bet, three or more live, able to bet.
          if (
            high === 0 &&
            (action.type === "check" || action.type === "bet") &&
            live.size >= 3 &&
            !allIn.has(seat) &&
            input
          ) {
            const order = hand.actions.filter(
              (a) =>
                a.street === action.street &&
                a.seat !== null &&
                DECISIONS.has(a.type),
            );
            const actedBefore = new Set(
              order
                .filter((a) => a.index < action.index)
                .map((a) => a.seat as number),
            );
            const behind = [...live].filter(
              (s) => s !== seat && !actedBefore.has(s) && !allIn.has(s),
            ).length;
            const size =
              action.type === "bet" && pot > 0 ? action.amount / pot : 0.6;
            const betL = narrow({
              ...input,
              action: { kind: "bet", sizePot: size, allIn: false },
            });
            const w = rangeWeight(input.actor);
            opens.push({
              hand: h,
              street: st,
              players: live.size,
              checksBefore: checks,
              behind,
              y: action.type === "bet" ? 1 : 0,
              theory: w > 0 ? rangeWeight(betL) / w : NaN,
            });
          }
          if (action.type === "bet" && high === 0) {
            if (st === "river" && pot > 0 && live.size >= 3)
              riverSizes.push(action.amount / pot);
            const pending = [...live].filter(
              (s) => s !== seat && !allIn.has(s),
            );
            const after = hand.actions.filter(
              (a) =>
                a.street === action.street &&
                a.index > action.index &&
                a.seat !== null &&
                pending.includes(a.seat),
            );
            const ordered: number[] = [];
            for (const a of after)
              if (!ordered.includes(a.seat as number))
                ordered.push(a.seat as number);
            if (
              pending.length >= 2 &&
              ordered.length === pending.length &&
              pot > 0
            ) {
              const bet: Bet = {
                hand: h,
                street: st,
                size: action.amount / pot,
                facing: pending.length,
                answers: [],
                allFold: true,
                hero: seat === actual,
              };
              bets.push(bet);
              open = { bet, pending: ordered, raised: false };
            } else open = null;
          } else if (
            open &&
            !open.raised &&
            open.pending.includes(seat) &&
            !open.bet.answers.some(
              (a) => a.order === open!.pending.indexOf(seat),
            )
          ) {
            const order = open.pending.indexOf(seat);
            const answer =
              action.type === "fold"
                ? 0
                : action.type === "call" || action.type === "raise"
                  ? 1
                  : -1;
            if (answer >= 0) {
              const before = pot - toCall;
              const theory = input
                ? callShare(
                    heuristicModel,
                    input,
                    before > 0 ? toCall / before : 0.5,
                  ).share
                : NaN;
              open.bet.answers.push({
                hand: h,
                street: st,
                size: open.bet.size,
                facing: open.bet.facing,
                order,
                priorCall: open.bet.answers.some((a) => a.y === 1),
                checkedBefore: checkedOn.has(seat),
                y: answer,
                theory,
              });
              if (answer === 1) open.bet.allFold = false;
              if (action.type === "raise") open.raised = true;
            }
          }
          if (action.type === "check") {
            checks += 1;
            checkedOn.add(seat);
          }
          if (action.type === "fold") live.delete(seat);
        }
        if (action.allIn) allIn.add(action.seat);
        pot += action.amount;
        if (
          action.type !== "ante" &&
          action.type !== "bomb-ante" &&
          action.type !== "uncalled"
        ) {
          const total = (totals.get(action.seat) ?? 0) + action.amount;
          totals.set(action.seat, total);
          high = Math.max(high, total);
        }
      }
    }

    console.log(
      `=== ${FILE}: ${hands.length} hands; ${[...census].map(([k, v]) => `${k} ${v}`).join(", ")}`,
    );
    const answers = bets
      .flatMap((b) => b.answers)
      .filter((a) => Number.isFinite(a.theory));
    const openRows = opens.filter((o) => Number.isFinite(o.theory));
    console.log(
      `bets with 2+ to answer ${bets.length}, answers ${answers.length}; opens ${openRows.length} (bets ${openRows.filter((o) => o.y === 1).length})`,
    );

    /* ------------------------------------------------ part 1: the field - */
    const A = folds(answers, (a) => answerFeatures(a));
    const O = folds(openRows, (o) => openFeatures(o));
    const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
    console.log(
      `answer weights (everything): [${A.all.map((v) => v.toFixed(3)).join(", ")}]`,
    );
    console.log(
      `open weights (everything): [${O.all.map((v) => v.toFixed(3)).join(", ")}]`,
    );
    const sorted = [...riverSizes].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    console.log(
      `river first bets three or more ways: ${sorted.length}, size quartiles ${q(0.25)?.toFixed(2)} / ${q(0.5)?.toFixed(2)} / ${q(0.75)?.toFixed(2)}`,
    );

    // A base feature set for comparison: no order-after-folds, no checked-before.
    const base = (a: Answer) => answerFeatures(a).slice(0, 8);
    const B = folds(answers, base);
    const heldA = (a: Answer) =>
      predict(A.per.get(foldOf(a.hand)) as number[], answerFeatures(a));
    const heldB = (a: Answer) =>
      predict(B.per.get(foldOf(a.hand)) as number[], base(a));
    const heldO = (o: Open) =>
      predict(O.per.get(foldOf(o.hand)) as number[], openFeatures(o));

    const sizeBucket = (s: number) =>
      s < 0.4 ? "<40%" : s < 0.6 ? "40-60%" : s < 0.85 ? "60-85%" : "85%+";
    const reportAnswers = (title: string, subset: Answer[]) => {
      if (subset.length === 0) return;
      const obs = clustered(
        subset,
        (a) => a.hand,
        (a) => a.y,
      );
      const th = clustered(
        subset,
        (a) => a.hand,
        (a) => a.theory,
      );
      const pop = clustered(subset, (a) => a.hand, heldA);
      const d = clustered(
        subset,
        (a) => a.hand,
        (a) => logloss(a.theory, a.y) - logloss(heldA(a), a.y),
      );
      const dB = clustered(
        subset,
        (a) => a.hand,
        (a) => logloss(heldB(a), a.y) - logloss(heldA(a), a.y),
      );
      console.log(
        `${title}: n ${subset.length} (${obs.clusters} hands) | called ${obs.mean.toFixed(3)} ± ${obs.se.toFixed(3)} | theory ${th.mean.toFixed(3)}, population ${pop.mean.toFixed(3)} | log-loss theory − population ${f3(d.mean)} ± ${d.se.toFixed(3)}; base − population ${f3(dB.mean)} ± ${dB.se.toFixed(3)}`,
      );
    };
    console.log("--- answers to a bet (held out by hand)");
    reportAnswers("all", answers);
    for (const s of POSTFLOP) {
      const sub = answers.filter((a) => a.street === s);
      reportAnswers(`${s}`, sub);
      for (const b of ["<40%", "40-60%", "60-85%", "85%+"])
        reportAnswers(
          `  ${s} ${b}`,
          sub.filter((a) => sizeBucket(a.size) === b),
        );
      reportAnswers(
        `  ${s} 2 to answer`,
        sub.filter((a) => a.facing === 2),
      );
      reportAnswers(
        `  ${s} 3+ to answer`,
        sub.filter((a) => a.facing >= 3),
      );
      reportAnswers(
        `  ${s} first to answer`,
        sub.filter((a) => a.order === 0),
      );
      reportAnswers(
        `  ${s} after a call`,
        sub.filter((a) => a.priorCall),
      );
      reportAnswers(
        `  ${s} after folds only`,
        sub.filter((a) => a.order > 0 && !a.priorCall),
      );
      reportAnswers(
        `  ${s} checked to the bettor`,
        sub.filter((a) => a.checkedBefore),
      );
      reportAnswers(
        `  ${s} acts after the bettor`,
        sub.filter((a) => !a.checkedBefore),
      );
    }

    const reportAllFold = (title: string, subset: Bet[]) => {
      const rows = subset.filter(
        (b) =>
          b.answers.length === b.facing &&
          b.answers.every((a) => Number.isFinite(a.theory)),
      );
      if (rows.length === 0) return;
      const obs = clustered(
        rows,
        (b) => b.hand,
        (b) => (b.allFold ? 1 : 0),
      );
      const th = clustered(
        rows,
        (b) => b.hand,
        (b) => b.answers.reduce((p, a) => p * (1 - a.theory), 1),
      );
      // Population: the chain in which each player folds, everyone before having folded.
      const pop = clustered(
        rows,
        (b) => b.hand,
        (b) =>
          b.answers.reduce(
            (p, a) => p * (1 - heldA({ ...a, priorCall: false })),
            1,
          ),
      );
      const dTh = clustered(
        rows,
        (b) => b.hand,
        (b) =>
          b.answers.reduce((p, a) => p * (1 - a.theory), 1) -
          (b.allFold ? 1 : 0),
      );
      const dPop = clustered(
        rows,
        (b) => b.hand,
        (b) =>
          b.answers.reduce(
            (p, a) => p * (1 - heldA({ ...a, priorCall: false })),
            1,
          ) - (b.allFold ? 1 : 0),
      );
      console.log(
        `${title}: bets ${rows.length} | everyone folded ${obs.mean.toFixed(3)} ± ${obs.se.toFixed(3)} | theory ${th.mean.toFixed(3)} (Δ ${f3(dTh.mean)} ± ${dTh.se.toFixed(3)}) | population ${pop.mean.toFixed(3)} (Δ ${f3(dPop.mean)} ± ${dPop.se.toFixed(3)})`,
      );
    };
    console.log(
      "--- P(everyone folds) per bet, held out (a raise counts as not folding)",
    );
    for (const s of POSTFLOP) {
      const sub = bets.filter((b) => b.street === s);
      reportAllFold(`${s}`, sub);
      for (const b of ["<40%", "40-60%", "60-85%", "85%+"])
        reportAllFold(
          `  ${s} ${b}`,
          sub.filter((x) => sizeBucket(x.size) === b),
        );
      reportAllFold(
        `  ${s} 2 to answer`,
        sub.filter((x) => x.facing === 2),
      );
      reportAllFold(
        `  ${s} 3+ to answer`,
        sub.filter((x) => x.facing >= 3),
      );
      reportAllFold(
        `  ${s} everyone checked to the bettor`,
        sub.filter((x) => x.answers.every((a) => a.checkedBefore)),
      );
      reportAllFold(
        `  ${s} the hero's bets`,
        sub.filter((x) => x.hero),
      );
    }

    const reportOpens = (title: string, subset: Open[]) => {
      if (subset.length === 0) return;
      const obs = clustered(
        subset,
        (o) => o.hand,
        (o) => o.y,
      );
      const th = clustered(
        subset,
        (o) => o.hand,
        (o) => o.theory,
      );
      const pop = clustered(subset, (o) => o.hand, heldO);
      const d = clustered(
        subset,
        (o) => o.hand,
        (o) => logloss(o.theory, o.y) - logloss(heldO(o), o.y),
      );
      console.log(
        `${title}: n ${subset.length} (${obs.clusters} hands) | bet ${obs.mean.toFixed(3)} ± ${obs.se.toFixed(3)} | theory ${th.mean.toFixed(3)}, population ${pop.mean.toFixed(3)} | log-loss theory − population ${f3(d.mean)} ± ${d.se.toFixed(3)}`,
      );
    };
    console.log("--- opens: betting when not facing a bet (held out by hand)");
    reportOpens("all", openRows);
    for (const s of POSTFLOP) {
      const sub = openRows.filter((o) => o.street === s);
      reportOpens(`${s}`, sub);
      reportOpens(
        `  ${s} first to act`,
        sub.filter((o) => o.checksBefore === 0),
      );
      reportOpens(
        `  ${s} checked to, players behind`,
        sub.filter((o) => o.checksBefore > 0 && o.behind > 0),
      );
      reportOpens(
        `  ${s} checked to, last to act`,
        sub.filter((o) => o.checksBefore > 0 && o.behind === 0),
      );
      reportOpens(
        `  ${s} 3 players`,
        sub.filter((o) => o.players === 3),
      );
      reportOpens(
        `  ${s} 4+ players`,
        sub.filter((o) => o.players >= 4),
      );
    }

    /* --------------------------------- part 2: the river model held out - */
    interface Pred {
      hand: number;
      action: string;
      last: boolean;
      pot: number;
      pop: number;
      theory: number;
      realised: number;
      share?: { predicted: number; won: number };
    }
    const preds: Pred[] = [];
    const gradeCounts = new Map<string, number>();
    const gradeLines: string[] = [];
    for (const h of multiwayHands) {
      const hand = hands[h];
      const context = buildContext(structuredClone(hand));
      const hero = heroSeatOf(context) as number;
      const walk = walkMultiway(
        structuredClone(hand),
        buildContext(structuredClone(hand)),
        hero,
        charts,
        heuristicModel,
        { populationHero: hero },
      );
      if (!walk.ok) continue;
      const bb = Math.max(1, hand.game.bigBlind);
      for (const spot of heroSpots(context, hero)) {
        if (
          spot.street !== "river" ||
          spot.toCall > 0 ||
          spot.opponents.length < 2
        )
          continue;
        const act = spot.decision.type;
        if (act !== "check" && act !== "bet") continue;
        const potBb = spot.potBefore / bb;
        const size = act === "bet" ? spot.amount / spot.potBefore : null;
        const input = riverCheckBetInput(
          spot,
          hand,
          context,
          hero,
          walk,
          charts,
          size !== null ? [size] : RIVER_BET_MENU,
          1000 + h,
        );
        if ("ok" in input) {
          bump(`river ${act}: ${input.reason}`);
          continue;
        }
        const k = foldOf(h);
        const popField = populationField(
          A.per.get(k) as number[],
          O.per.get(k) as number[],
        );
        const evPop = riverCheckBetEv(input, popField);
        const evTh = riverCheckBetEv(input, theoryField());
        const chosen = (e: typeof evPop) =>
          act === "check" ? e.check : e.bets[0].ev;
        const result = hand.results.players.find((p) => p.seat === hero);
        const putIn = hand.actions
          .filter(
            (a) =>
              a.seat === hero &&
              a.street === "river" &&
              a.index >= spot.action.index &&
              !NOT_MONEY.has(a.type),
          )
          .reduce((s, a) => s + a.amount, 0);
        const realised = ((result?.won ?? 0) - putIn) / bb;
        const last = input.opponents.every((o) => !o.behind);
        const pred: Pred = {
          hand: h,
          action: act,
          last,
          pot: potBb,
          pop: chosen(evPop),
          theory: chosen(evTh),
          realised,
        };
        // Checked through: the showdown share predicted against the share won.
        const after = hand.actions.filter(
          (a) =>
            a.street === "river" &&
            a.index > spot.action.index &&
            DECISIONS.has(a.type),
        );
        if (
          act === "check" &&
          after.every((a) => a.type === "check") &&
          (result?.wentToShowdown ?? false)
        ) {
          const raked =
            potBb - Math.min(potBb * input.rake.percent, input.rake.cap);
          const won = (result?.won ?? 0) / bb;
          pred.share = {
            predicted: last ? evPop.check / raked : NaN,
            won: Math.min(1, won / raked),
          };
        }
        preds.push(pred);
        // The would-be grade: both fields (the smaller loss), and each alone.
        const both = gradeRiverCheckBet(
          [
            { id: "population", ...evPop },
            { id: "theory", ...evTh },
          ],
          act,
          size,
          potBb,
        );
        const popOnly = gradeRiverCheckBet(
          [{ id: "population", ...evPop }],
          act,
          size,
          potBb,
        );
        const thOnly = gradeRiverCheckBet(
          [{ id: "theory", ...evTh }],
          act,
          size,
          potBb,
        );
        const bump3 = (k: string) =>
          gradeCounts.set(k, (gradeCounts.get(k) ?? 0) + 1);
        bump3(`would-be ${act}, both fields: ${both.grade}`);
        bump3(`would-be ${act}, population alone: ${popOnly.grade}`);
        bump3(`would-be ${act}, theory alone: ${thOnly.grade}`);
        const fmt = (e: typeof evPop) =>
          `check ${e.check.toFixed(2)}, ${e.bets.map((b) => `${Math.round(100 * b.size)}% ${b.ev.toFixed(2)} (all fold ${Math.round(100 * b.allFold)}%)`).join(", ")}`;
        gradeLines.push(
          `hand ${h} | ${spot.board.join("")} | ${(context.players.get(hero)?.holeCards ?? []).join("")} ${act}${size !== null ? ` ${Math.round(100 * size)}%` : ""} into ${potBb.toFixed(1)}bb, ${input.opponents.length + 1} players, ${last ? "last" : "players behind"} | both ${both.grade} (${(100 * both.evLossPot).toFixed(1)}% pot), population ${popOnly.grade} (${(100 * popOnly.evLossPot).toFixed(1)}%), theory ${thOnly.grade} (${(100 * thOnly.evLossPot).toFixed(1)}%) | population: ${fmt(evPop)} | theory: ${fmt(evTh)} | won ${(realised / potBb).toFixed(2)} pot`,
        );
      }
    }
    const reportPreds = (title: string, subset: Pred[]) => {
      if (subset.length === 0) return;
      const pot = (p: Pred) => p.pot;
      const realised = clustered(
        subset,
        (p) => p.hand,
        (p) => p.realised / pot(p),
      );
      const pop = clustered(
        subset,
        (p) => p.hand,
        (p) => p.pop / pot(p),
      );
      const th = clustered(
        subset,
        (p) => p.hand,
        (p) => p.theory / pot(p),
      );
      const dPop = clustered(
        subset,
        (p) => p.hand,
        (p) => (p.realised - p.pop) / pot(p),
      );
      const dTh = clustered(
        subset,
        (p) => p.hand,
        (p) => (p.realised - p.theory) / pot(p),
      );
      console.log(
        `${title}: n ${subset.length} | realised ${realised.mean.toFixed(3)} ± ${realised.se.toFixed(3)} of the pot | population ${pop.mean.toFixed(3)} (realised − predicted ${f3(dPop.mean)} ± ${dPop.se.toFixed(3)}) | theory ${th.mean.toFixed(3)} (${f3(dTh.mean)} ± ${dTh.se.toFixed(3)})`,
      );
    };
    console.log(
      "--- the hero's multiway river checks and bets: EV of the action taken, held out, against what was won (fractions of the pot)",
    );
    reportPreds("all", preds);
    reportPreds(
      "checks",
      preds.filter((p) => p.action === "check"),
    );
    reportPreds(
      "  last to act",
      preds.filter((p) => p.action === "check" && p.last),
    );
    reportPreds(
      "  players behind",
      preds.filter((p) => p.action === "check" && !p.last),
    );
    reportPreds(
      "bets",
      preds.filter((p) => p.action === "bet"),
    );
    const shares = preds.filter(
      (p) => p.share && Number.isFinite(p.share.predicted),
    );
    if (shares.length > 0) {
      const pr = clustered(
        shares,
        (p) => p.hand,
        (p) => p.share!.predicted,
      );
      const wn = clustered(
        shares,
        (p) => p.hand,
        (p) => p.share!.won,
      );
      const d = clustered(
        shares,
        (p) => p.hand,
        (p) => p.share!.won - p.share!.predicted,
      );
      console.log(
        `checked behind and checked through: n ${shares.length} | share predicted ${pr.mean.toFixed(3)}, won ${wn.mean.toFixed(3)} ± ${wn.se.toFixed(3)} (Δ ${f3(d.mean)} ± ${d.se.toFixed(3)})`,
      );
    }
    /* ------------- part 2b: showdown shares, the player who shows first - */
    // Every player, not only the hero, but only the one whose cards the
    // showdown reveals whatever they hold (a loser shown later may muck, which
    // would select the sample on the result): (i) a river checked through three
    // or more ways: the first to act's share against the others' ranges after
    // their checks; (ii) a called river bet: the bettor's share against the
    // callers' calling ranges, by the population (top of the range at the
    // held-out call share) and by the theory (the MDF call). One pot, nobody
    // all-in; the share won is the player's part of what was collected.
    interface Share {
      hand: number;
      kind: "checked" | "called" | "hu-checked";
      /** The same share against any two cards (scale). */
      anyTwo?: number;
      predicted: number;
      theory: number;
      won: number;
    }
    const sharesUnder = (model: NarrowingModel, counting: boolean): Share[] => {
      const sharesAll: Share[] = [];
      for (const [h, hand] of hands.entries()) {
        const context = buildContext(structuredClone(hand));
        const seats = flopSeats(context);
        if (
          seats.length < 2 ||
          hand.board.runouts.length > 1 ||
          hand.game.bombPot?.doubleBoard
        )
          continue;
        const headsUp = seats.length === 2;
        if (hand.actions.some((a) => a.allIn) || hand.results.pots.length > 1)
          continue;
        const river = hand.actions.filter(
          (a) =>
            a.street === "river" && a.seat !== null && DECISIONS.has(a.type),
        );
        if (river.length === 0) continue;
        const atRiver = new Set(river.map((a) => a.seat as number));
        if (atRiver.size < (headsUp ? 2 : 3)) continue;
        const folded = new Set(
          river.filter((a) => a.type === "fold").map((a) => a.seat as number),
        );
        const showdown = [...atRiver].filter((s) => !folded.has(s));
        if (showdown.length < 2) continue;
        const known = (seat: number) =>
          (context.players.get(seat)?.holeCards?.length ?? 0) === 2;
        const won = new Map(hand.results.players.map((p) => [p.seat, p.won]));
        const totalWon = showdown.reduce(
          (s, seat) => s + (won.get(seat) ?? 0),
          0,
        );
        if (!(totalWon > 0)) continue;
        const actual = heroSeatOf(context);
        const walker =
          actual !== null && seats.includes(actual) ? actual : seats[0];
        let walk: ReturnType<typeof walkMultiway>;
        try {
          walk = walkMultiway(
            structuredClone(hand),
            buildContext(structuredClone(hand)),
            walker,
            charts,
            model,
            { populationHero: actual ?? -1 },
          );
        } catch {
          continue;
        }
        if (!walk.ok) continue;
        const boardCodes = [
          ...(hand.board.runouts[0].flop ?? []),
          hand.board.runouts[0].turn,
          hand.board.runouts[0].river,
        ].filter((c): c is string => !!c);
        const board = toIndices(boardCodes);
        const strength = streetStrength(board);
        const shareFor = (seat: number, ranges: Float64Array[]) => {
          const cards = context.players.get(seat)?.holeCards ?? [];
          const own = toIndices(cards);
          const lists = ranges
            .map((r) => weightedCombos(removeCards(Float64Array.from(r), own)))
            .filter((l) => l.length > 0);
          if (lists.length === 0) return NaN;
          return equityVsRanges({
            hero: [...cards],
            ranges: lists,
            board: boardCodes,
            seed: 77 + h,
            trials: 8000,
          }).equity;
        };
        const k = foldOf(h);
        if (river.every((a) => a.type === "check")) {
          // The first to act shows first: their cards are known whatever they hold.
          const first = river[0].seat as number;
          const last = river[river.length - 1];
          if (counting)
            bump(
              `share: checked through ${known(first) ? "first shown" : "first not shown"}`,
            );
          if (!known(first)) continue;
          const ranges = walk.before(last.index);
          if (!ranges) continue;
          const lastSeat = last.seat as number;
          const lastOthers = [...ranges.keys()]
            .filter((x) => x !== lastSeat)
            .map((x) => ranges.get(x) as Float64Array);
          const lastChecked = narrow(
            {
              street: "river",
              board,
              actor: ranges.get(lastSeat) as Float64Array,
              opponent: lastOthers[0],
              players: lastOthers.length + 1,
              opponents: lastOthers,
              strength,
              action: {
                kind: "check",
                sizePot: null,
                allIn: false,
                checksBefore: hand.actions.filter(
                  (a) =>
                    a.seat === lastSeat &&
                    a.type === "check" &&
                    a.index < last.index &&
                    a.street !== "preflop",
                ).length,
              },
            },
            model,
          );
          const others = showdown
            .filter((x) => x !== first)
            .map((x) =>
              x === lastSeat ? lastChecked : (ranges.get(x) as Float64Array),
            );
          const p = shareFor(first, others);
          // For scale: the same share against the preflop ranges (no postflop narrowing).
          const pre = shareFor(
            first,
            showdown
              .filter((x) => x !== first)
              .map((x) =>
                removeCards(
                  Float64Array.from(walk.preflop.get(x) as Float64Array),
                  board,
                ),
              ),
          );
          const anyTwo = shareFor(
            first,
            showdown
              .filter((x) => x !== first)
              .map(() => removeCards(new Float64Array(1326).fill(1), board)),
          );
          if (Number.isFinite(p))
            sharesAll.push({
              hand: h,
              kind: headsUp ? "hu-checked" : "checked",
              predicted: p,
              theory: pre,
              anyTwo,
              won: (won.get(first) ?? 0) / totalWon,
            });
          continue;
        }
        if (headsUp) continue;
        const firstBet = river.find((a) => a.type === "bet");
        if (!firstBet || river.some((a) => a.type === "raise")) continue;
        const bettor = firstBet.seat as number;
        const callers = river
          .filter((a) => a.index > firstBet.index && a.type === "call")
          .map((a) => a.seat as number);
        if (callers.length === 0) continue;
        // The bettor shows first when called.
        if (counting)
          bump(
            `share: called bet ${known(bettor) ? "bettor shown" : "bettor not shown"}`,
          );
        if (!known(bettor)) continue;
        const pop: Float64Array[] = [];
        const th: Float64Array[] = [];
        let ok = true;
        let priorCall = false;
        const facing = river.filter(
          (a) =>
            a.index > firstBet.index &&
            (a.type === "call" || a.type === "fold"),
        ).length;
        let order = 0;
        let potBefore = 0;
        for (const a of hand.actions) {
          if (a.index >= firstBet.index) break;
          if (a.seat !== null && !NOT_MONEY.has(a.type)) potBefore += a.amount;
        }
        const sizePot = potBefore > 0 ? firstBet.amount / potBefore : 0.5;
        for (const a of river.filter((x) => x.index > firstBet.index)) {
          const ranges = walk.before(a.index);
          const actor = ranges?.get(a.seat as number);
          if (!ranges || !actor) {
            ok = false;
            break;
          }
          if (a.type === "call") {
            const others = [...ranges.keys()]
              .filter((s) => s !== a.seat)
              .map((s) => ranges.get(s) as Float64Array);
            const input: Omit<NarrowInput, "action"> = {
              street: "river",
              board,
              actor,
              opponent: others[0],
              strength,
            };
            if (others.length >= 2) {
              input.players = others.length + 1;
              input.opponents = others;
            }
            const ctx: AnswerContext = {
              street: "river",
              size: sizePot,
              facing,
              order,
              priorCall,
              checkedBefore: river.some(
                (x) => x.index < firstBet.index && x.seat === a.seat,
              ),
            };
            const p = logistic(A.per.get(k) as number[], answerFeatures(ctx));
            const l = callAtShare(input, p);
            const popRange = new Float64Array(actor.length);
            for (let c = 0; c < actor.length; c += 1)
              popRange[c] = actor[c] * l[c];
            pop.push(popRange);
            th.push(
              narrow({
                ...input,
                action: { kind: "call", sizePot, allIn: false },
              }),
            );
            priorCall = true;
          }
          order += 1;
        }
        if (!ok || pop.length !== callers.length) continue;
        const p = shareFor(bettor, pop);
        const t = shareFor(bettor, th);
        if (Number.isFinite(p) && Number.isFinite(t))
          sharesAll.push({
            hand: h,
            kind: "called",
            predicted: p,
            theory: t,
            won: (won.get(bettor) ?? 0) / totalWon,
          });
      }
      return sharesAll;
    };
    const sharesAll = sharesUnder(heuristicModel, true);
    const reportShares = (title: string, subset: Share[]) => {
      if (subset.length === 0) return;
      const pr = clustered(
        subset,
        (s) => s.hand,
        (s) => s.predicted,
      );
      const th = clustered(
        subset,
        (s) => s.hand,
        (s) => s.theory,
      );
      const wn = clustered(
        subset,
        (s) => s.hand,
        (s) => s.won,
      );
      const d = clustered(
        subset,
        (s) => s.hand,
        (s) => s.won - s.predicted,
      );
      const dt = clustered(
        subset,
        (s) => s.hand,
        (s) => s.won - s.theory,
      );
      const brier = clustered(
        subset,
        (s) => s.hand,
        (s) => (s.won - s.theory) ** 2 - (s.won - s.predicted) ** 2,
      );
      console.log(
        `${title}: n ${subset.length} | won ${wn.mean.toFixed(3)} ± ${wn.se.toFixed(3)} | population ${pr.mean.toFixed(3)} (won − predicted ${f3(d.mean)} ± ${d.se.toFixed(3)}) | theory ${th.mean.toFixed(3)} (${f3(dt.mean)} ± ${dt.se.toFixed(3)}) | squared error theory − population ${f3(brier.mean)} ± ${brier.se.toFixed(3)}`,
      );
    };
    console.log(
      `--- showdown shares at multiway river showdowns, the player who shows first; ${[
        ...census,
      ]
        .filter(([k]) => k.startsWith("share:"))
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
    reportShares(
      "checked through: the first to act",
      sharesAll.filter((s) => s.kind === "checked"),
    );
    reportShares(
      "  (theory column: against the preflop ranges; this row: against any two cards)",
      sharesAll
        .filter((s) => s.kind === "checked")
        .map((s) => ({ ...s, theory: s.anyTwo ?? NaN })),
    );
    reportShares(
      "heads-up control, checked through: the first to act",
      sharesAll.filter((s) => s.kind === "hu-checked"),
    );
    reportShares(
      "  (against any two cards)",
      sharesAll
        .filter((s) => s.kind === "hu-checked")
        .map((s) => ({ ...s, theory: s.anyTwo ?? NaN })),
    );
    for (const [lo, hi] of [
      [0, 0.3],
      [0.3, 0.7],
      [0.7, 1.01],
    ])
      reportShares(
        `  predicted ${lo}-${hi}`,
        sharesAll.filter(
          (s) => s.kind === "checked" && s.predicted >= lo && s.predicted < hi,
        ),
      );
    reportShares(
      "a called bet: the bettor",
      sharesAll.filter((s) => s.kind === "called"),
    );
    for (const [lo, hi] of [
      [0, 0.3],
      [0.3, 0.7],
      [0.7, 1.01],
    ])
      reportShares(
        `  predicted ${lo}-${hi}`,
        sharesAll.filter(
          (s) => s.kind === "called" && s.predicted >= lo && s.predicted < hi,
        ),
      );

    // For the record: the same shares with every check's likelihood raised to
    // a power (a harder check trim), on the river only or on every street - not
    // the analysis' narrowing, a probe of where the bias comes from.
    const harder = (power: number, riverOnly: boolean): NarrowingModel => ({
      id: `${heuristicModel.id}-check^${power}${riverOnly ? "-river" : ""}`,
      likelihood(input) {
        const l = heuristicModel.likelihood(input);
        if (
          input.action.kind === "check" &&
          (!riverOnly || input.street === "river")
        )
          for (let c = 0; c < l.length; c += 1)
            l[c] = Math.pow(Math.max(0, l[c]), power);
        return l;
      },
    });
    for (const [power, riverOnly] of [
      [2, true],
      [4, true],
      [2, false],
      [4, false],
    ] as const) {
      const rows = sharesUnder(harder(power, riverOnly), false);
      const label = `checks^${power}${riverOnly ? " on the river" : " on every street"}`;
      reportShares(
        `${label}: checked through, the first to act`,
        rows.filter((s) => s.kind === "checked"),
      );
      reportShares(
        `${label}: heads-up control`,
        rows.filter((s) => s.kind === "hu-checked"),
      );
      reportShares(
        `${label}: a called bet, the bettor`,
        rows.filter((s) => s.kind === "called"),
      );
    }

    console.log(
      `river refusals: ${[...census]
        .filter(([k]) => k.startsWith("river "))
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );

    /* ----------------------------------------------- part 3: the grades - */
    console.log(
      "--- the would-be grades of the hero's multiway river checks and bets (held-out population fit; no sensitivity check)",
    );
    for (const [k, v] of [...gradeCounts].sort()) console.log(`  ${k}: ${v}`);
    if (GRADES) {
      for (const line of gradeLines) console.log(line);
      // What stays `multiway` today, by street, action and place.
      const counts = new Map<string, number>();
      for (const h of multiwayHands) {
        const result = analyzeHand(structuredClone(hands[h]), { charts });
        for (const d of result.decisions) {
          if (d.reason !== "multiway") continue;
          const mw = d.facts.multiway;
          const key = `${d.street} ${d.action} ${d.facts.toCallBb > 0 ? "facing a bet" : mw?.lastToAct ? "last to act" : "players behind"}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      console.log(
        "--- the hero's `multiway` decisions (multiway flops with the hero in; bomb pots on one board included)",
      );
      for (const [k, v] of [...counts].sort()) console.log(`  ${k}: ${v}`);
    }
  },
);
