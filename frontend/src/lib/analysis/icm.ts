/**
 * The Independent Chip Model (R5.5): what a tournament stack is worth in
 * prize money, and what that does to an all-in.
 *
 * **The model (Malmuth-Harville).** Chips are converted to prize equity by
 * the finishing order they imply: a player finishes first with probability
 * `stack / total` (Harville 1973, "Assigning probabilities to the outcomes of
 * multi-entry competitions", JASA 68: 312-316; brought to poker by Malmuth,
 * "Gambling Theory and Other Topics", 1987), and the places below are filled
 * the same way among the players left. A player's equity is the prize of
 * each place times the probability of finishing there.
 *
 * **Exact for small fields.** The places are filled one at a time over the
 * sets of players already placed: `P(S ∪ {i}) += P(S) · s_i / (S_total −
 * Σ_S)`. Only the paid places need filling (an unpaid place is worth 0), so
 * the work is `Σ_{m < paid} C(n, m) · (n − m)` steps (`exactCost`): 333 for a
 * nine-player sit-and-go paying three, 2 304 for a final table of nine paying
 * nine. Deterministic to the bit: the same stacks give the same doubles.
 *
 * **Monte-Carlo beyond that** (`EXACT_BUDGET` steps), seeded. Harville's
 * order is the order in which independent exponential clocks of rates
 * `s_i` ring (the first to ring is player `i` with probability `s_i / Σ s`,
 * and the race among the rest starts afresh by memorylessness), so a sample
 * is one draw `T_i = −ln(U_i) / s_i` per player, sorted. The draws come from
 * `mulberry32(seed)` in player order, so two calls with the same seed and the
 * same number of players use the **same** uniforms: the difference between
 * two stack vectors (what a decision compares) is estimated with common
 * random numbers and is far tighter than either value. **Error bound**: each
 * player's equity is the mean of `n` draws of a prize in `[0, z_1]`, so its
 * standard error is at most `z_1 / (2 √n)` whatever the stacks (Popoviciu's
 * inequality) - 0.35 % of first prize at the default 20 000 samples. The
 * result reports the bound and the empirical standard error.
 *
 * **Busted players.** A stack of 0 has finished: the busted share the
 * lowest places among the field equally (they busted in the same hand; who
 * started bigger is not the model's to say).
 *
 * Also here: the chip-EV model it reduces to (`chipEquity`: winner takes all,
 * or far from the money), the **bubble factor** and **risk premium** of an
 * all-in between two players, and the conversion of prize equity back to
 * chips (`chipsForEquity`).
 *
 * Pure: no I/O, no clocks.
 */

/**
 * `lib/equity`'s `mulberry32`, the same generator to the bit, kept here so
 * the analysis imports only the equity modules its rule names.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact Malmuth-Harville up to this many subset steps (`exactCost`); Monte-Carlo beyond. */
export const EXACT_BUDGET = 250_000;
/** Monte-Carlo samples when `IcmOptions.samples` is absent. */
export const DEFAULT_ICM_SAMPLES = 20_000;
/** The Monte-Carlo seed when `IcmOptions.seed` is absent. */
export const DEFAULT_ICM_SEED = 0x1c3;
/** The exact recursion keys subsets by a 31-bit mask. */
const MAX_EXACT_PLAYERS = 30;

export interface IcmOptions {
  /** `auto` (default): exact within `EXACT_BUDGET`, Monte-Carlo beyond. */
  method?: "auto" | "exact" | "monte-carlo";
  samples?: number;
  seed?: number;
}

export interface IcmResult {
  /** Each player's prize equity, in the prizes' unit, in the stacks' order. */
  equity: number[];
  method: "exact" | "monte-carlo";
  /** Monte-Carlo samples; 0 when exact. */
  samples: number;
  /** Monte-Carlo: the largest empirical standard error of a player's equity; 0 when exact. */
  standardError: number;
  /** Monte-Carlo: `z_1 / (2 √n)`, the distribution-free bound on any player's standard error; 0 when exact. */
  errorBound: number;
}

/** `C(n, k)` as a double (exact for the sizes the budget allows). */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
  return out;
}

/** The places that matter: up to the last nonzero prize, at most `players`. */
function paidPlaces(prizes: readonly number[], players: number): number {
  let last = 0;
  for (let p = 0; p < Math.min(prizes.length, players); p += 1) if (prizes[p] !== 0) last = p + 1;
  return last;
}

/** Steps the exact recursion takes for `players` alive and `places` paid places to fill. */
export function exactCost(players: number, places: number): number {
  let cost = 0;
  for (let m = 0; m < Math.min(places, players); m += 1) cost += choose(players, m) * (players - m);
  return cost;
}

function check(stacks: readonly number[], prizes: readonly number[]): void {
  if (stacks.length === 0) throw new RangeError("icm(): no players");
  for (const s of stacks) if (!(s >= 0) || !Number.isFinite(s)) throw new RangeError(`icm(): bad stack ${s}`);
  for (const z of prizes) if (!(z >= 0) || !Number.isFinite(z)) throw new RangeError(`icm(): bad prize ${z}`);
}

/**
 * Prize equity of every stack (Malmuth-Harville). `prizes[p]` is the prize
 * for place `p + 1`; places past the list pay 0, and prizes past the number
 * of players are never paid. Throws on a negative or non-finite input.
 */
export function icm(stacks: readonly number[], prizes: readonly number[], options: IcmOptions = {}): IcmResult {
  check(stacks, prizes);
  const n = stacks.length;
  const alive: number[] = [];
  for (let i = 0; i < n; i += 1) if (stacks[i] > 0) alive.push(i);
  const equity = new Array<number>(n).fill(0);
  const prizeAt = (place: number) => (place < prizes.length && place < n ? prizes[place] : 0);

  // The busted share the places below the living equally.
  const busted = n - alive.length;
  if (busted > 0) {
    let share = 0;
    for (let place = alive.length; place < n; place += 1) share += prizeAt(place);
    share /= busted;
    for (let i = 0; i < n; i += 1) if (!(stacks[i] > 0)) equity[i] = share;
  }
  const a = alive.length;
  if (a === 0) return { equity, method: "exact", samples: 0, standardError: 0, errorBound: 0 };
  const places = paidPlaces(prizes, a);
  if (places === 0) return { equity, method: "exact", samples: 0, standardError: 0, errorBound: 0 };

  const method = options.method ?? "auto";
  const exact =
    method === "exact" || (method === "auto" && a <= MAX_EXACT_PLAYERS && exactCost(a, places) <= EXACT_BUDGET);
  if (exact) {
    if (a > MAX_EXACT_PLAYERS) throw new RangeError(`icm(): exact needs at most ${MAX_EXACT_PLAYERS} players alive`);
    exactInto(equity, alive, stacks, prizeAt, places);
    return { equity, method: "exact", samples: 0, standardError: 0, errorBound: 0 };
  }
  return monteCarloInto(equity, alive, stacks, prizeAt, places, options);
}

/** The exact recursion over the sets of players already placed, one paid place at a time. */
function exactInto(
  equity: number[],
  alive: readonly number[],
  stacks: readonly number[],
  prizeAt: (place: number) => number,
  places: number,
): void {
  const a = alive.length;
  const s = alive.map((i) => stacks[i]);
  const total = s.reduce((sum, x) => sum + x, 0);
  const out = new Float64Array(a);
  // Level m: the sets of m players placed first, their probability and their chips.
  let level = new Map<number, number>([[0, 1]]);
  let chips = new Map<number, number>([[0, 0]]);
  for (let m = 0; m < places; m += 1) {
    const prize = prizeAt(m);
    const next = new Map<number, number>();
    const nextChips = new Map<number, number>();
    const last = m + 1 === places;
    for (const [mask, prob] of level) {
      const placed = chips.get(mask) ?? 0;
      const rest = total - placed;
      if (!(rest > 0)) continue;
      for (let i = 0; i < a; i += 1) {
        const bit = 1 << i;
        if (mask & bit) continue;
        const p = (prob * s[i]) / rest;
        out[i] += p * prize;
        if (!last) {
          const key = mask | bit;
          next.set(key, (next.get(key) ?? 0) + p);
          if (!nextChips.has(key)) nextChips.set(key, placed + s[i]);
        }
      }
    }
    level = next;
    chips = nextChips;
  }
  for (let i = 0; i < a; i += 1) equity[alive[i]] = out[i];
}

/** Seeded exponential races; one uniform per player (busted too, so the draws line up across calls). */
function monteCarloInto(
  equity: number[],
  alive: readonly number[],
  stacks: readonly number[],
  prizeAt: (place: number) => number,
  places: number,
  options: IcmOptions,
): IcmResult {
  const n = stacks.length;
  const a = alive.length;
  const samples = Math.max(1, Math.floor(options.samples ?? DEFAULT_ICM_SAMPLES));
  const random = mulberry32(options.seed ?? DEFAULT_ICM_SEED);
  const sum = new Float64Array(a);
  const sumSq = new Float64Array(a);
  const times = new Float64Array(a);
  const order = new Int32Array(a);
  const isAlive = new Uint8Array(n);
  for (const i of alive) isAlive[i] = 1;
  let first = 0;
  for (let p = 0; p < places; p += 1) first = Math.max(first, prizeAt(p));
  for (let t = 0; t < samples; t += 1) {
    let k = 0;
    for (let i = 0; i < n; i += 1) {
      // 1 − U is in (0, 1]: the logarithm is finite.
      const u = 1 - random();
      if (!isAlive[i]) continue;
      times[k] = -Math.log(u) / stacks[i];
      k += 1;
    }
    // Insertion sort of the living by their clock: the order is the finishing order.
    for (let i = 0; i < a; i += 1) {
      let j = i;
      while (j > 0 && times[order[j - 1]] > times[i]) {
        order[j] = order[j - 1];
        j -= 1;
      }
      order[j] = i;
    }
    for (let p = 0; p < places; p += 1) {
      const z = prizeAt(p);
      sum[order[p]] += z;
      sumSq[order[p]] += z * z;
    }
  }
  let standardError = 0;
  for (let i = 0; i < a; i += 1) {
    const mean = sum[i] / samples;
    equity[alive[i]] = mean;
    const variance = Math.max(0, sumSq[i] / samples - mean * mean);
    standardError = Math.max(standardError, Math.sqrt(variance / samples));
  }
  return { equity, method: "monte-carlo", samples, standardError, errorBound: first / (2 * Math.sqrt(samples)) };
}

/**
 * The chip-EV model: prize equity proportional to chips (`Σ prizes · s_i /
 * Σ s`). What ICM gives with one prize, and what a tournament far from the
 * money is graded in.
 */
export function chipEquity(stacks: readonly number[], prizes: readonly number[]): number[] {
  check(stacks, prizes);
  const total = stacks.reduce((sum, s) => sum + s, 0);
  const pool = prizes.slice(0, stacks.length).reduce((sum, z) => sum + z, 0);
  return stacks.map((s) => (total > 0 ? (pool * s) / total : 0));
}

/** The stacks after `winner` takes `amount` from `loser` (capped by the loser's stack). */
export function transfer(stacks: readonly number[], winner: number, loser: number, amount: number): number[] {
  const moved = Math.min(amount, stacks[loser]);
  return stacks.map((s, i) => (i === winner ? s + moved : i === loser ? s - moved : s));
}

export interface AllInPrice {
  /** Hero's equity now, if the hero wins the all-in, if the hero loses it. */
  now: number;
  win: number;
  lose: number;
  /**
   * Bubble factor: what losing the all-in costs over what winning it gains,
   * in prize equity, for the same chips. 1 in chip EV; above 1 under ICM.
   */
  bubbleFactor: number;
  /**
   * Hero's showdown equity needed to take an even all-in (no dead money) under
   * ICM: `(now − lose) / (win − lose)` = `BF / (1 + BF)`.
   */
  required: number;
  /** Risk premium: `required` over chip EV's 50 %. */
  riskPremium: number;
}

/**
 * The price of an all-in between `hero` and `villain` for the smaller of
 * their stacks, nothing else in the pot: the bubble factor and the risk
 * premium of that matchup (both depend on who covers whom and on everyone
 * else's stack). Null when either has no chips.
 */
export function allInPrice(
  stacks: readonly number[],
  prizes: readonly number[],
  hero: number,
  villain: number,
  options: IcmOptions = {},
): AllInPrice | null {
  const amount = Math.min(stacks[hero], stacks[villain]);
  if (!(amount > 0) || hero === villain) return null;
  const now = icm(stacks, prizes, options).equity[hero];
  const win = icm(transfer(stacks, hero, villain, amount), prizes, options).equity[hero];
  const lose = icm(transfer(stacks, villain, hero, amount), prizes, options).equity[hero];
  const gain = win - now;
  const cost = now - lose;
  const bubbleFactor = gain > 0 ? cost / gain : Infinity;
  const required = win - lose > 0 ? cost / (win - lose) : 1;
  return { now, win, lose, bubbleFactor, required, riskPremium: required - 0.5 };
}

/**
 * Chip-EV to $EV and back. `chipsForEquity` is the hero's stack that ICM
 * values at `equity`, the chips it takes or gives coming from the others in
 * proportion to their stacks (the total stays the same): "this decision cost
 * you the equivalent of X chips at your stack". Bisection to a chip's
 * precision; clamped to `[0, total]`.
 */
export function chipsForEquity(
  stacks: readonly number[],
  prizes: readonly number[],
  hero: number,
  equity: number,
  options: IcmOptions = {},
): number {
  const total = stacks.reduce((sum, s) => sum + s, 0);
  const othersTotal = total - stacks[hero];
  const at = (chips: number) => {
    const scale = othersTotal > 0 ? (total - chips) / othersTotal : 0;
    const next = stacks.map((s, i) => (i === hero ? chips : s * scale));
    return icm(next, prizes, options).equity[hero];
  };
  let lo = 0;
  let hi = total;
  if (equity <= at(lo)) return lo;
  if (equity >= at(hi)) return hi;
  for (let k = 0; k < 64 && hi - lo > 1e-9 * Math.max(1, total); k += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) < equity) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
