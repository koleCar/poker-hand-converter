/**
 * The flops the library solves, and where every other flop goes (phase A5b).
 *
 * There are 22,100 flops and 1,755 up to suit isomorphism (`canonicalBoard`).
 * Solving all of them for a dozen preflop lines is ~4,000 core-hours, so the
 * library solves ~100 **representatives** and maps every canonical flop to
 * the nearest one by texture. A flop that is a representative (up to suits)
 * reads the library combo for combo; any other reads it by hand category
 * (`lib/analysis/flopLibrary.ts`, approximations `flop-mapped` and
 * `library-bucketed`).
 *
 * **Texture class** (hard: a flop maps only inside its class). Pairing
 * (unpaired, paired, trips) and suits: rainbow, monotone, or two-tone by
 * *which* two ranks share the suit (high and middle, high and low, middle
 * and low) - `As Ks 5h` and `As 5s Kh` draw to different flushes. Paired
 * two-tone boards form one class (the suited pair is fixed by the ranks).
 *
 * **Distance within a class** (in ranks, `2` = 0 … `A` = 12):
 *
 *     d = 1.5·|Δhigh| + 1.0·|Δmiddle| + 0.7·|Δlow| + 0.4·|Δstraights|
 *
 * where `straights` counts the unordered pairs of hole ranks that make a
 * straight with the flop (0 on `K72`, 8 on `987`; the wheel counts). The high
 * card weighs most because it decides which preflop range hits the board.
 *
 * **The representatives** are a weighted k-medoids (PAM: greedy build, then
 * best-improvement swaps) inside each class, with the 100 split over the
 * classes by their share of the 22,100 flops (largest remainder, at least
 * two each). They are committed as data (`FLOP_REPRESENTATIVES`) so the
 * library's flops never change silently; a test recomputes them.
 */

import { cardCode } from "../equity";
import { parseCards } from "./combos";
import { canonicalBoard } from "./isomorphism";

/** The texture class of a flop: pairing and suit pattern. */
export type FlopClass = "u-r" | "u-m" | "u-s12" | "u-s13" | "u-s23" | "p-r" | "p-s" | "t-r";

export const FLOP_CLASSES: readonly FlopClass[] = ["u-r", "u-m", "u-s12", "u-s13", "u-s23", "p-r", "p-s", "t-r"];

export interface FlopFeatures {
  cls: FlopClass;
  /** Ranks high to low, 0 (`2`) … 12 (`A`). */
  ranks: [number, number, number];
  /** Unordered hole-rank pairs that make a straight with the flop. */
  straights: number;
}

/** Feature weights of the distance (header). */
export const FLOP_DISTANCE_WEIGHTS = { high: 1.5, middle: 1.0, low: 0.7, straights: 0.4 } as const;

/** How many representatives the library solves. */
export const FLOP_REPRESENTATIVE_COUNT = 100;
/** Every texture class gets at least this many: one representative of trips would stand for both `222` and `AAA`. */
export const MIN_PER_CLASS = 2;

/** Pairs of hole ranks (x <= y, distinct from each other) that complete a straight with `ranks`. */
export function straightPairs(ranks: readonly number[]): number {
  const board = new Set(ranks);
  let count = 0;
  for (let x = 0; x < 13; x += 1) {
    for (let y = x + 1; y < 13; y += 1) {
      const have = new Set([...board, x, y]);
      // Rank 12 (the ace) also plays low: windows A-2-3-4-5 … T-J-Q-K-A.
      let made = false;
      for (let lo = -1; lo <= 8 && !made; lo += 1) {
        let all = true;
        for (let r = lo; r < lo + 5; r += 1) {
          const rank = r === -1 ? 12 : r;
          if (!have.has(rank)) {
            all = false;
            break;
          }
        }
        made = all;
      }
      if (made) count += 1;
    }
  }
  return count;
}

/** Texture features of a flop (any suits). */
export function flopFeatures(flop: readonly (string | number)[]): FlopFeatures {
  const cards = parseCards(flop);
  if (cards.length !== 3) throw new RangeError(`a flop has three cards, got ${cards.length}`);
  const sorted = [...cards].sort((a, b) => b - a);
  const ranks = sorted.map((c) => c >> 2) as [number, number, number];
  const suits = sorted.map((c) => c & 3);
  const distinctRanks = new Set(ranks).size;
  const distinctSuits = new Set(suits).size;
  let cls: FlopClass;
  if (distinctRanks === 1) cls = "t-r";
  else if (distinctRanks === 2) cls = distinctSuits === 3 ? "p-r" : "p-s";
  else if (distinctSuits === 3) cls = "u-r";
  else if (distinctSuits === 1) cls = "u-m";
  else if (suits[0] === suits[1]) cls = "u-s12";
  else if (suits[0] === suits[2]) cls = "u-s13";
  else cls = "u-s23";
  return { cls, ranks, straights: straightPairs(ranks) };
}

/** Distance between two flops' features; Infinity across texture classes. */
export function flopDistance(a: FlopFeatures, b: FlopFeatures): number {
  if (a.cls !== b.cls) return Infinity;
  const w = FLOP_DISTANCE_WEIGHTS;
  return (
    w.high * Math.abs(a.ranks[0] - b.ranks[0]) +
    w.middle * Math.abs(a.ranks[1] - b.ranks[1]) +
    w.low * Math.abs(a.ranks[2] - b.ranks[2]) +
    w.straights * Math.abs(a.straights - b.straights)
  );
}

export interface CanonicalFlop {
  /** Canonical spelling, flop high to low, e.g. `["Ks", "7h", "2d"]`. */
  board: string[];
  /** As one string, e.g. `"Ks7h2d"`: the library's key. */
  key: string;
  /** How many of the 22,100 flops it stands for. */
  weight: number;
  features: FlopFeatures;
}

let canonicalCache: CanonicalFlop[] | null = null;

/** All 1,755 canonical flops with their weights, in a fixed order (by key). */
export function canonicalFlops(): CanonicalFlop[] {
  if (canonicalCache) return canonicalCache;
  const byKey = new Map<string, CanonicalFlop>();
  for (let a = 0; a < 52; a += 1) {
    for (let b = a + 1; b < 52; b += 1) {
      for (let c = b + 1; c < 52; c += 1) {
        const board = canonicalBoard([a, b, c]).board;
        const key = board.join("");
        const found = byKey.get(key);
        if (found) found.weight += 1;
        else byKey.set(key, { board, key, weight: 1, features: flopFeatures(board) });
      }
    }
  }
  canonicalCache = [...byKey.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return canonicalCache;
}

/** The canonical key of any flop, e.g. `"Ks7h2d"`. */
export function flopKey(flop: readonly (string | number)[]): string {
  const cards = parseCards(flop);
  if (cards.length !== 3) throw new RangeError(`a flop has three cards, got ${cards.length}`);
  return canonicalBoard(cards).board.join("");
}

/** Splits a flop key back into its three card codes. */
export function flopCards(key: string): string[] {
  return [key.slice(0, 2), key.slice(2, 4), key.slice(4, 6)];
}

/* --------------------------------------------------------- selection - */

/** How many representatives each class gets: by share of the 22,100 flops, largest remainder, at least one. */
export function classQuota(total = FLOP_REPRESENTATIVE_COUNT): Map<FlopClass, number> {
  const flops = canonicalFlops();
  const mass = new Map<FlopClass, number>(FLOP_CLASSES.map((c) => [c, 0]));
  for (const flop of flops) mass.set(flop.features.cls, (mass.get(flop.features.cls) ?? 0) + flop.weight);
  const all = [...mass.values()].reduce((s, x) => s + x, 0);
  const quota = new Map<FlopClass, number>();
  const rest: { cls: FlopClass; frac: number }[] = [];
  let used = 0;
  for (const cls of FLOP_CLASSES) {
    const exact = ((mass.get(cls) ?? 0) / all) * total;
    const base = Math.max(MIN_PER_CLASS, Math.floor(exact));
    quota.set(cls, base);
    used += base;
    rest.push({ cls, frac: exact - Math.floor(exact) });
  }
  rest.sort((a, b) => b.frac - a.frac || FLOP_CLASSES.indexOf(a.cls) - FLOP_CLASSES.indexOf(b.cls));
  for (let k = 0; used < total && k < rest.length; k += 1, used += 1) {
    quota.set(rest[k].cls, (quota.get(rest[k].cls) ?? 0) + 1);
  }
  return quota;
}

/**
 * Weighted k-medoids (PAM) over one class: greedy build, then the best
 * improving swap until none improves. Deterministic: ties go to the lower
 * index. Returns indices into `points`.
 */
export function kMedoids(points: readonly CanonicalFlop[], k: number): number[] {
  const n = points.length;
  if (k >= n) return points.map((_, i) => i);
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) dist[i * n + j] = flopDistance(points[i].features, points[j].features);
  }
  const weight = points.map((p) => p.weight);
  const cost = (medoids: readonly number[]): number => {
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      let best = Infinity;
      for (const m of medoids) best = Math.min(best, dist[i * n + m]);
      total += weight[i] * best;
    }
    return total;
  };
  const medoids: number[] = [];
  while (medoids.length < k) {
    let pick = -1;
    let pickCost = Infinity;
    for (let c = 0; c < n; c += 1) {
      if (medoids.includes(c)) continue;
      const value = cost([...medoids, c]);
      if (value < pickCost - 1e-9) {
        pick = c;
        pickCost = value;
      }
    }
    medoids.push(pick);
  }
  let current = cost(medoids);
  for (let round = 0; round < 200; round += 1) {
    let bestCost = current;
    let swap: [number, number] | null = null;
    for (let mi = 0; mi < medoids.length; mi += 1) {
      for (let c = 0; c < n; c += 1) {
        if (medoids.includes(c)) continue;
        const trial = medoids.slice();
        trial[mi] = c;
        const value = cost(trial);
        if (value < bestCost - 1e-9) {
          bestCost = value;
          swap = [mi, c];
        }
      }
    }
    if (!swap) break;
    medoids[swap[0]] = swap[1];
    current = bestCost;
  }
  return medoids.sort((a, b) => a - b);
}

/** Computes the representatives from scratch (the test checks `FLOP_REPRESENTATIVES` against this). */
export function computeRepresentatives(total = FLOP_REPRESENTATIVE_COUNT): string[] {
  const flops = canonicalFlops();
  const quota = classQuota(total);
  const out: string[] = [];
  for (const cls of FLOP_CLASSES) {
    const members = flops.filter((f) => f.features.cls === cls);
    for (const index of kMedoids(members, quota.get(cls) ?? 1)) out.push(members[index].key);
  }
  return out;
}

/**
 * The library's flops, canonical keys, by texture class. Generated by
 * `computeRepresentatives()` and committed so they cannot drift; the
 * test `flopSet.test.ts` recomputes them.
 */
export const FLOP_REPRESENTATIVES: readonly string[] = [
  "5s4h2d", "7s5h3d", "8s3h2d", "8s6h2d", "8s6h5d", "9s5h3d", "9s7h4d", "As4h2d", "As6h3d",
  "As8h5d", "AsKh7d", "AsQh3d", "AsQhTd", "AsTh4d", "AsTh8d", "Js4h2d", "Js7h4d", "Js9h3d",
  "Js9h6d", "Ks6h3d", "Ks8h4d", "Ks9h7d", "KsJh2d", "KsJh6d", "KsQhTd", "Qs6h3d", "Qs8h5d",
  "QsTh4d", "QsTh8d", "Ts7h4d", "Ts8h7d", "7s5s3s", "AsJs6s", "Ks6s3s", "QsTs6s", "Ts7s4s",
  "5s4s2h", "7s5s3h", "8s5s3h", "9s7s4h", "As4s2h", "As8s5h", "AsQs4h", "AsQs9h", "Js4s2h",
  "Js9s6h", "Ks6s3h", "KsJs7h", "KsTs3h", "Qs8s4h", "QsTs8h", "Ts7s4h", "5s4h2s", "7s5h3s",
  "9s4h2s", "9s7h4s", "As8h5s", "AsQh4s", "AsQh9s", "Js5h2s", "Js9h6s", "Ks5h3s", "KsJh7s",
  "KsTh3s", "Qs8h4s", "QsTh8s", "Ts7h4s", "5s4h2h", "7s5h3h", "9s4h2h", "9s7h4h", "As8h5h",
  "AsQh4h", "AsQh9h", "Js5h2h", "Js9h6h", "Ks5h3h", "KsJh7h", "KsTh3h", "Qs8h4h", "QsTh8h",
  "Ts7h4h", "5s3d3h", "7h7s4d", "9h9s7d", "AhAs9d", "JhJs5d", "Js3d3h", "KhKs9d", "Ks6d6h",
  "5s3h3s", "7h7s4s", "9h9s7s", "AhAs9s", "JhJs5s", "Js3h3s", "KhKs9s", "Ks6h6s", "4d4h4s",
  "JdJhJs",
];

/* ------------------------------------------------------------ mapping - */

export interface FlopMapping {
  /** The flop's canonical key. */
  key: string;
  /** The representative it reads, canonical key. */
  representative: string;
  /** 0 when the flop is the representative. */
  distance: number;
  exact: boolean;
}

let repFeatures: { key: string; features: FlopFeatures }[] | null = null;

/** The representative a flop reads: the nearest in its texture class (ties: the earlier one). */
export function mapFlop(flop: readonly (string | number)[], representatives: readonly string[] = FLOP_REPRESENTATIVES): FlopMapping {
  const key = flopKey(flop);
  const features = flopFeatures(flopCards(key));
  const reps =
    representatives === FLOP_REPRESENTATIVES && repFeatures
      ? repFeatures
      : representatives.map((rep) => ({ key: rep, features: flopFeatures(flopCards(rep)) }));
  if (representatives === FLOP_REPRESENTATIVES) repFeatures = reps;
  let best = "";
  let bestDistance = Infinity;
  for (const rep of reps) {
    if (rep.key === key) return { key, representative: key, distance: 0, exact: true };
    const d = flopDistance(features, rep.features);
    if (d < bestDistance) {
      best = rep.key;
      bestDistance = d;
    }
  }
  if (!best) throw new RangeError(`no representative in class ${features.cls} for ${key}`);
  return { key, representative: best, distance: bestDistance, exact: false };
}

/** Per representative: how many of the 22,100 flops read it, and their mean distance. */
export function representativeCoverage(
  representatives: readonly string[] = FLOP_REPRESENTATIVES,
): Map<string, { flops: number; canonical: number; meanDistance: number; maxDistance: number }> {
  const out = new Map(representatives.map((key) => [key, { flops: 0, canonical: 0, meanDistance: 0, maxDistance: 0 }]));
  for (const flop of canonicalFlops()) {
    const mapped = mapFlop(flop.board, representatives);
    const entry = out.get(mapped.representative);
    if (!entry) continue;
    entry.flops += flop.weight;
    entry.canonical += 1;
    entry.meanDistance += flop.weight * mapped.distance;
    entry.maxDistance = Math.max(entry.maxDistance, mapped.distance);
  }
  for (const entry of out.values()) if (entry.flops > 0) entry.meanDistance /= entry.flops;
  return out;
}

/** A flop key's cards as indices. */
export function flopIndices(key: string): number[] {
  return parseCards(flopCards(key));
}

/** The canonical spelling of a flop's cards as codes (convenience for scripts). */
export function flopCodes(cards: readonly number[]): string[] {
  return cards.map(cardCode);
}
