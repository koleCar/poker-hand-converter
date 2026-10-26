/**
 * The push/fold game (R5.5): Nash equilibrium of the preflop jam-or-fold
 * game at one table, with the payoffs in prize equity (ICM) or in chips, and
 * the hero's EV of each option against it.
 *
 * **The game.** The players dealt in, in preflop order (first to act first,
 * the big blind last), each with a stack and what they posted (antes dead,
 * blinds live). The first player either folds or goes all in; while nobody
 * has, each next player does the same (the "first in"); once someone has,
 * each player behind either calls all in or folds, and **the first caller
 * plays it heads-up** - the players behind fold (the one-caller model every
 * push/fold chart uses; an overcall is rare at these depths and it is said
 * on the grade when more than one could have called). Everyone folding to
 * the big blind is a walk. Showdowns read the 169-class equity table
 * (`decodePushFoldEquity`, our own computation), opponents' classes weighted by
 * the combos the player's own class leaves them (`COMPAT`): card removal
 * between the two all in, not with the players who folded.
 *
 * **Payoffs.** Every end of the hand is a vector of stacks; `value` turns it
 * into each player's prize equity (`icm` over the players left, the table and
 * the rest of the field) or their chips. So the folds are valued too: a
 * player who folds still gains when two others' all-in busts one of them.
 *
 * **Solved by CFR+** (Tammelin 2014): regret matching+ on the counterfactual
 * values of each class at each of its decisions (first in; facing a push
 * from each seat in front), simultaneous updates, the average strategy
 * weighted by the iteration. A player acts at most once on any path, so the
 * distance from equilibrium is the sum over decisions of what the best
 * action gains over the strategy (`gap`), in the payoff's units, reported
 * with the solution. Deterministic: no sampling, a fixed iteration count.
 *
 * **What is solved is the sub-game the hero's decision is in**: the players
 * from the first-in pusher onwards (everyone in front folded; their stacks
 * are still in the payoffs). For the hero's own push that starts at the
 * hero; for a call it starts at the player who pushed.
 */

import {
  CLASS_COMBOS,
  COMPAT,
  COMBOS_AFTER_HAND,
  NUM_CLASSES,
  massVector,
} from "../solver";
import { PUSH_FOLD_EQUITY_DATA } from "./data/pushFoldEquity";

/** Boards the committed equity table was sampled on (`npm run icm:equity`). */
export const PUSH_FOLD_EQUITY_BOARDS = 1_000_000;
export const PUSH_FOLD_EQUITY_SEED = 0x9f0;
/** CFR+ iterations: the sub-game's distance from equilibrium is reported, and tested small at this count. */
export const PUSH_FOLD_ITERATIONS = 200;

const N = NUM_CLASSES;
const TOTAL_COMBOS = 1326;

/* ---------------------------------------------------------- the table - */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QUANTUM = 65_535;

/** The table's cells above the diagonal as 16-bit fractions, base64. */
export function encodePushFoldEquity(equity: Float64Array): string {
  const bytes: number[] = [];
  for (let i = 0; i < N; i += 1) {
    for (let j = i + 1; j < N; j += 1) {
      const q = Math.max(0, Math.min(QUANTUM, Math.round(equity[i * N + j] * QUANTUM)));
      bytes.push(q >> 8, q & 255);
    }
  }
  let out = "";
  let k = 0;
  for (; k + 2 < bytes.length; k += 3) {
    const v = (bytes[k] << 16) | (bytes[k + 1] << 8) | bytes[k + 2];
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }
  const rest = bytes.length - k;
  if (rest === 1) out += ALPHABET[bytes[k] >> 2] + ALPHABET[(bytes[k] & 3) << 4] + "==";
  else if (rest === 2) {
    const v = (bytes[k] << 16) | (bytes[k + 1] << 8);
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + "=";
  }
  return out;
}

/** `E[i * 169 + j]`, the all-in equity of class `i` against class `j`, from the encoded cells. */
export function decodePushFoldEquity(encoded: string = PUSH_FOLD_EQUITY_DATA): Float64Array {
  const clean = encoded.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let k = 0; k < clean.length; k += 1) {
    const d = ALPHABET.indexOf(clean[k]);
    if (d < 0) throw new Error(`decodePushFoldEquity: not base64 at ${k}`);
    value = ((value << 6) | d) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o] = (value >> bits) & 255;
      o += 1;
    }
  }
  const cells = (N * (N - 1)) / 2;
  if (o < cells * 2) throw new Error("decodePushFoldEquity: table too short");
  const out = new Float64Array(N * N);
  let c = 0;
  for (let i = 0; i < N; i += 1) {
    out[i * N + i] = 0.5;
    for (let j = i + 1; j < N; j += 1) {
      const e = ((bytes[2 * c] << 8) | bytes[2 * c + 1]) / QUANTUM;
      out[i * N + j] = e;
      out[j * N + i] = 1 - e;
      c += 1;
    }
  }
  return out;
}

interface Tables {
  equity: Float64Array;
  /** `COMPAT[i][j] · E[i][j]`. */
  weighted: Float64Array;
}

let shared: Tables | null = null;

/** The committed table, decoded once. */
function tables(): Tables {
  if (shared) return shared;
  const equity = decodePushFoldEquity();
  const weighted = new Float64Array(N * N);
  for (let k = 0; k < N * N; k += 1) weighted[k] = COMPAT[k] * equity[k];
  shared = { equity, weighted };
  return shared;
}

/* ------------------------------------------------------------ the game - */

export interface PushFoldPlayer {
  /** Chips at the start of the hand, before posting. */
  stack: number;
  /** Antes posted: dead, never matched. */
  dead: number;
  /** Blinds posted: live, part of a call. */
  live: number;
}

export interface PushFoldGame {
  /** The players dealt in, in preflop order (first to act first, the big blind last). At least two. */
  players: PushFoldPlayer[];
  /** Each player's payoff for the stacks every player ends the hand with, in one unit (prize equity or chips). */
  value: (stacks: Float64Array) => Float64Array;
}

/** The end of the hand when `winner` and `loser` were all in against each other, everyone else folded. */
function showdownStacks(players: readonly PushFoldPlayer[], winner: number, loser: number): Float64Array {
  const behind = (p: PushFoldPlayer) => p.stack - p.dead;
  const matched = Math.min(behind(players[winner]), behind(players[loser]));
  let pot = 2 * matched;
  const out = new Float64Array(players.length);
  players.forEach((p, x) => {
    pot += p.dead;
    if (x === winner || x === loser) out[x] = p.stack - p.dead - matched;
    else {
      pot += p.live;
      out[x] = p.stack - p.dead - p.live;
    }
  });
  out[winner] += pot;
  return out;
}

/** The end of the hand when everyone folded to `taker` (a push, or the big blind's walk). */
function uncontestedStacks(players: readonly PushFoldPlayer[], taker: number): Float64Array {
  let pot = 0;
  const out = new Float64Array(players.length);
  players.forEach((p, x) => {
    pot += p.dead + p.live;
    out[x] = p.stack - p.dead - p.live;
  });
  out[taker] += pot;
  return out;
}

/** Whether the game can be played as push/fold: everyone has chips behind their posts. */
export function pushFoldPlayable(game: PushFoldGame): boolean {
  return game.players.length >= 2 && game.players.every((p) => p.stack - p.dead - p.live > 0);
}

/* ------------------------------------------------------------ solving - */

export interface PushFoldSolution {
  /** The first pusher of the sub-game. */
  start: number;
  /** `push[j]`: how often each class goes all in first in from seat `j` (`start`..last but one). */
  push: Float64Array[];
  /** `call[j][i]`: how often seat `i` calls each class facing seat `j`'s push, nobody in between having called. */
  call: Float64Array[][];
  iterations: number;
  /**
   * Distance from equilibrium: summed over every player, what their best
   * response gains over the strategy, in the payoff's units. 0 is Nash.
   */
  gap: number;
  /** Every decision's values under the equilibrium (what `pushValues` / `callValues` read). */
  evaluation: Evaluation;
}

interface Outcomes {
  /** `fold[j]`: everyone folds to `j`'s push (`j` = last: the walk). */
  uncontested: Float64Array[];
  /** `win[j][i]` / `lose[j][i]`: pusher `j` wins / loses the all-in against caller `i`. */
  win: Float64Array[][];
  lose: Float64Array[][];
}

function outcomes(game: PushFoldGame, start: number): Outcomes {
  const k = game.players.length;
  const uncontested: Float64Array[] = [];
  const win: Float64Array[][] = [];
  const lose: Float64Array[][] = [];
  for (let j = start; j < k; j += 1) {
    uncontested[j] = game.value(uncontestedStacks(game.players, j));
    win[j] = [];
    lose[j] = [];
    for (let i = j + 1; i < k; i += 1) {
      win[j][i] = game.value(showdownStacks(game.players, j, i));
      lose[j][i] = game.value(showdownStacks(game.players, i, j));
    }
  }
  return { uncontested, win, lose };
}

/** Values of every decision under a profile (counterfactual: times the chance of reaching it). */
export interface Evaluation {
  /** Per pusher seat: each class's value of pushing / folding first in (counterfactual: times the chance of reaching it). */
  pushValue: Float64Array[];
  foldValue: Float64Array[];
  /** Per pusher seat and caller seat: each class's value of calling / folding (counterfactual). */
  callValue: Float64Array[][];
  passValue: Float64Array[][];
  /** The continuation vector at "first in at seat j": every player's expected payoff. */
  continuation: Float64Array[];
}

/** Scratch for one evaluation, allocated once per solve. */
interface Scratch {
  q: Float64Array[];
  a: Float64Array[];
  u: Float64Array;
  mass: Float64Array;
  massU: Float64Array;
  weightedU: Float64Array;
  carry: Float64Array;
  rankSum: Float64Array;
  chainBefore: Float64Array;
}

function evaluate(
  game: PushFoldGame,
  start: number,
  out: Outcomes,
  push: readonly Float64Array[],
  call: readonly Float64Array[][],
  s: Scratch,
  tab: Tables,
): Evaluation {
  const k = game.players.length;
  const pushValue: Float64Array[] = [];
  const foldValue: Float64Array[] = [];
  const callValue: Float64Array[][] = [];
  const passValue: Float64Array[][] = [];
  const continuation: Float64Array[] = [];
  continuation[k - 1] = out.uncontested[k - 1];

  // Chance of reaching "first in at j": everyone in front folded (card removal with them ignored).
  const reach = new Float64Array(k);
  // Filled after the backward pass (it needs the strategies only).
  {
    let r = 1;
    for (let j = start; j < k; j += 1) {
      reach[j] = r;
      if (j < k - 1) {
        let rate = 0;
        const p = push[j];
        for (let h = 0; h < N; h += 1) rate += CLASS_COMBOS[h] * p[h];
        r *= 1 - rate / TOTAL_COMBOS;
      }
    }
  }

  for (let j = k - 2; j >= start; j -= 1) {
    const callers = k - 1 - j;
    // Per caller: the chance they call a pusher holding h, and the pusher's win share of it.
    for (let c = 0; c < callers; c += 1) {
      const i = j + 1 + c;
      const range = call[j][i];
      massVector(range, s.q[c], s.rankSum);
      const a = s.a[c];
      a.fill(0);
      for (let x = 0; x < N; x += 1) {
        const w = range[x];
        if (w === 0) continue;
        // a[h] += M[h][x] w: M is not symmetric, so walk the column.
        for (let h = 0; h < N; h += 1) a[h] += tab.weighted[h * N + x] * w;
      }
      for (let h = 0; h < N; h += 1) a[h] /= COMBOS_AFTER_HAND;
    }

    const pv = new Float64Array(N);
    const cont = new Float64Array(k);
    const next = continuation[j + 1];
    const fold = next[j] * reach[j];
    const fv = new Float64Array(N).fill(fold);
    const pj = push[j];
    let foldWeight = 0;
    for (let h = 0; h < N; h += 1) {
      // The push's end for each pusher class: the first caller, or nobody.
      let alive = 1;
      let own = 0;
      const prior = CLASS_COMBOS[h] / TOTAL_COMBOS;
      const share = prior * pj[h];
      for (let c = 0; c < callers; c += 1) {
        const i = j + 1 + c;
        const q = s.q[c][h];
        const a = s.a[c][h];
        const winP = alive * a;
        const loseP = alive * (q - a);
        own += winP * out.win[j][i][j] + loseP * out.lose[j][i][j];
        if (share > 0) {
          const w = out.win[j][i];
          const l = out.lose[j][i];
          for (let x = 0; x < k; x += 1) cont[x] += share * (winP * w[x] + loseP * l[x]);
        }
        alive *= 1 - q;
      }
      own += alive * out.uncontested[j][j];
      if (share > 0) {
        const f = out.uncontested[j];
        for (let x = 0; x < k; x += 1) cont[x] += share * alive * f[x];
      }
      pv[h] = own * reach[j];
      foldWeight += prior * (1 - pj[h]);
    }
    for (let x = 0; x < k; x += 1) cont[x] += foldWeight * next[x];
    continuation[j] = cont;
    pushValue[j] = pv;
    foldValue[j] = fv;

    // The callers: a pusher's class distribution reaching caller i is push · Π(those between fold).
    callValue[j] = [];
    passValue[j] = [];
    s.chainBefore.fill(1);
    for (let c = 0; c < callers; c += 1) {
      const i = j + 1 + c;
      const u = s.u;
      for (let h = 0; h < N; h += 1) u[h] = pj[h] * s.chainBefore[h];
      // Σ_h COMPAT[x][h] u[h] / 1225 and Σ_h M[x][h] u[h] / 1225, for every caller class x.
      massVector(u, s.massU, s.rankSum);
      const wu = s.weightedU;
      wu.fill(0);
      for (let h = 0; h < N; h += 1) {
        const w = u[h];
        if (w === 0) continue;
        for (let x = 0; x < N; x += 1) wu[x] += tab.weighted[x * N + h] * w;
      }
      // After caller i folds: the callers behind, for player i's payoff, per pusher class.
      const carry = s.carry;
      for (let h = 0; h < N; h += 1) {
        let alive = 1;
        let value = 0;
        for (let d = c + 1; d < callers; d += 1) {
          const l = j + 1 + d;
          const q = s.q[d][h];
          const a = s.a[d][h];
          value += alive * (a * out.win[j][l][i] + (q - a) * out.lose[j][l][i]);
          alive *= 1 - q;
        }
        value += alive * out.uncontested[j][i];
        carry[h] = u[h] * value;
      }
      massVector(carry, s.mass, s.rankSum);
      const cv = new Float64Array(N);
      const fvi = new Float64Array(N);
      // Caller i wins the all-in: pusher j loses (`lose[j][i]`).
      const ifWin = out.lose[j][i][i];
      const ifLose = out.win[j][i][i];
      const prior = reach[j];
      for (let x = 0; x < N; x += 1) {
        const meets = s.massU[x];
        const wins = wu[x] / COMBOS_AFTER_HAND;
        cv[x] = prior * (wins * ifWin + (meets - wins) * ifLose);
        fvi[x] = prior * s.mass[x];
      }
      callValue[j][i] = cv;
      passValue[j][i] = fvi;
      for (let h = 0; h < N; h += 1) s.chainBefore[h] *= 1 - s.q[c][h];
    }
  }
  return { pushValue, foldValue, callValue, passValue, continuation };
}

function scratch(k: number): Scratch {
  return {
    q: Array.from({ length: k }, () => new Float64Array(N)),
    a: Array.from({ length: k }, () => new Float64Array(N)),
    u: new Float64Array(N),
    mass: new Float64Array(N),
    massU: new Float64Array(N),
    weightedU: new Float64Array(N),
    carry: new Float64Array(N),
    rankSum: new Float64Array(13),
    chainBefore: new Float64Array(N),
  };
}

/** Regret matching+ on a two-action decision: the share of the first action. */
function match(first: Float64Array, second: Float64Array, out: Float64Array): void {
  for (let h = 0; h < N; h += 1) {
    const a = first[h];
    const b = second[h];
    out[h] = a + b > 0 ? a / (a + b) : 0.5;
  }
}

function accumulate(regretA: Float64Array, regretB: Float64Array, valueA: Float64Array, valueB: Float64Array, strategy: Float64Array): void {
  for (let h = 0; h < N; h += 1) {
    const now = strategy[h] * valueA[h] + (1 - strategy[h]) * valueB[h];
    regretA[h] = Math.max(0, regretA[h] + valueA[h] - now);
    regretB[h] = Math.max(0, regretB[h] + valueB[h] - now);
  }
}

/** What the best action gains over the strategy, summed over classes weighted by their prior (or reach already in the values). */
function decisionGap(valueA: Float64Array, valueB: Float64Array, strategy: Float64Array, weights: Float64Array | null): number {
  let gap = 0;
  for (let h = 0; h < N; h += 1) {
    const now = strategy[h] * valueA[h] + (1 - strategy[h]) * valueB[h];
    gap += (weights ? weights[h] : 1) * (Math.max(valueA[h], valueB[h]) - now);
  }
  return gap;
}

const PRIOR = Float64Array.from({ length: N }, (_, h) => CLASS_COMBOS[h] / TOTAL_COMBOS);
/** A caller's class prior: their values already carry the chance of meeting each pusher class (`/1225`), so 1326 over the combos. */
const CALLER_PRIOR = Float64Array.from({ length: N }, (_, h) => (CLASS_COMBOS[h] * COMBOS_AFTER_HAND) / (TOTAL_COMBOS * COMBOS_AFTER_HAND));

/**
 * Solves the sub-game in which everyone in front of seat `start` folded.
 * Throws when the game cannot be played as push/fold (`pushFoldPlayable`).
 */
export function solvePushFold(game: PushFoldGame, start: number, iterations = PUSH_FOLD_ITERATIONS): PushFoldSolution {
  const k = game.players.length;
  if (!pushFoldPlayable(game)) throw new RangeError("solvePushFold: a player is all in from the posts");
  if (start < 0 || start > k - 2) throw new RangeError(`solvePushFold: no push from seat ${start}`);
  const tab = tables();
  const out = outcomes(game, start);
  const s = scratch(k);
  const strategyPush: Float64Array[] = [];
  const strategyCall: Float64Array[][] = [];
  const regret: { push: Float64Array; fold: Float64Array }[] = [];
  const regretCall: { call: Float64Array; pass: Float64Array }[][] = [];
  const sumPush: Float64Array[] = [];
  const sumCall: Float64Array[][] = [];
  for (let j = start; j < k - 1; j += 1) {
    strategyPush[j] = new Float64Array(N).fill(0.5);
    regret[j] = { push: new Float64Array(N), fold: new Float64Array(N) };
    sumPush[j] = new Float64Array(N);
    strategyCall[j] = [];
    regretCall[j] = [];
    sumCall[j] = [];
    for (let i = j + 1; i < k; i += 1) {
      strategyCall[j][i] = new Float64Array(N).fill(0.5);
      regretCall[j][i] = { call: new Float64Array(N), pass: new Float64Array(N) };
      sumCall[j][i] = new Float64Array(N);
    }
  }
  let weight = 0;
  for (let t = 1; t <= iterations; t += 1) {
    const ev = evaluate(game, start, out, strategyPush, strategyCall, s, tab);
    for (let j = start; j < k - 1; j += 1) {
      accumulate(regret[j].push, regret[j].fold, ev.pushValue[j], ev.foldValue[j], strategyPush[j]);
      for (let i = j + 1; i < k; i += 1) {
        accumulate(regretCall[j][i].call, regretCall[j][i].pass, ev.callValue[j][i], ev.passValue[j][i], strategyCall[j][i]);
      }
    }
    // The average, weighted by the iteration (CFR+), of the strategies just played.
    weight += t;
    for (let j = start; j < k - 1; j += 1) {
      for (let h = 0; h < N; h += 1) sumPush[j][h] += t * strategyPush[j][h];
      for (let i = j + 1; i < k; i += 1) for (let h = 0; h < N; h += 1) sumCall[j][i][h] += t * strategyCall[j][i][h];
    }
    for (let j = start; j < k - 1; j += 1) {
      match(regret[j].push, regret[j].fold, strategyPush[j]);
      for (let i = j + 1; i < k; i += 1) match(regretCall[j][i].call, regretCall[j][i].pass, strategyCall[j][i]);
    }
  }
  const push: Float64Array[] = [];
  const call: Float64Array[][] = [];
  for (let j = start; j < k - 1; j += 1) {
    push[j] = sumPush[j].map((v) => v / weight);
    call[j] = [];
    for (let i = j + 1; i < k; i += 1) call[j][i] = sumCall[j][i].map((v) => v / weight);
  }
  const final = evaluate(game, start, out, push, call, s, tab);
  let gap = 0;
  for (let j = start; j < k - 1; j += 1) {
    gap += decisionGap(final.pushValue[j], final.foldValue[j], push[j], PRIOR);
    for (let i = j + 1; i < k; i += 1) gap += decisionGap(final.callValue[j][i], final.passValue[j][i], call[j][i], CALLER_PRIOR);
  }
  return { start, push, call, iterations, gap, evaluation: final };
}

/* ------------------------------------------------------- the hero's EV - */

export interface PushFoldOptionValues {
  /** The hero's expected payoff (the game's unit) after each option, for the hero's class. */
  act: number;
  fold: number;
  /** How often the equilibrium takes the action (push, or call) with the hero's class. */
  freq: number;
}

/** The hero's push against the equilibrium: seat `seat` first in, holding class `hand`. */
export function pushValues(game: PushFoldGame, solution: PushFoldSolution, seat: number, hand: number): PushFoldOptionValues {
  const ev = solution.evaluation;
  const reach = reachOf(solution, seat, game.players.length);
  return {
    act: ev.pushValue[seat][hand] / reach,
    fold: ev.foldValue[seat][hand] / reach,
    freq: solution.push[seat][hand],
  };
}

/** The hero's call of seat `pusher`'s push from seat `seat`, holding class `hand`, everyone between having folded. */
export function callValues(game: PushFoldGame, solution: PushFoldSolution, pusher: number, seat: number, hand: number): PushFoldOptionValues {
  const k = game.players.length;
  const ev = solution.evaluation;
  // Normalise the counterfactual values by the chance of facing this push with this class.
  const u = new Float64Array(N);
  for (let h = 0; h < N; h += 1) {
    let chain = solution.push[pusher][h];
    for (let l = pusher + 1; l < seat; l += 1) chain *= 1 - callChance(solution.call[pusher][l], h);
    u[h] = chain;
  }
  const mass = new Float64Array(N);
  massVector(u, mass, new Float64Array(13));
  const meets = mass[hand] * reachOf(solution, pusher, k);
  return {
    act: meets > 0 ? ev.callValue[pusher][seat][hand] / meets : 0,
    fold: meets > 0 ? ev.passValue[pusher][seat][hand] / meets : 0,
    freq: solution.call[pusher][seat][hand],
  };
}

/** The chance a caller with `range` calls a pusher holding class `h`. */
function callChance(range: Float64Array, h: number): number {
  let sum = 0;
  for (let x = 0; x < N; x += 1) sum += COMPAT[h * N + x] * range[x];
  return sum / COMBOS_AFTER_HAND;
}

function reachOf(solution: PushFoldSolution, seat: number, k: number): number {
  let r = 1;
  for (let j = solution.start; j < seat && j < k - 1; j += 1) {
    let rate = 0;
    for (let h = 0; h < N; h += 1) rate += CLASS_COMBOS[h] * solution.push[j][h];
    r *= 1 - rate / TOTAL_COMBOS;
  }
  return r;
}

/** The share of all combos a per-class strategy takes the action with (0-1). */
export function rangeShare(strategy: ArrayLike<number>): number {
  let sum = 0;
  for (let h = 0; h < N; h += 1) sum += CLASS_COMBOS[h] * strategy[h];
  return sum / TOTAL_COMBOS;
}
