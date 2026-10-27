/**
 * The river check trim, held out on shown hands (§10, 2026-10-14). The flop
 * and turn check trims were fitted on the range as the next card came
 * (`checkTrim.test.ts`, `headsUpCheckTrim.test.ts`, whose score, folds and
 * standard errors this reuses); a river check has no next card, but the
 * player's range after their last river action can be scored directly on the
 * hand they show down.
 *
 * Three families of candidates, each the shipped heuristic with only the river
 * check likelihood recomputed (`CHECK_VALUE`, `CHECK_AIR`; `CHECK_DRAW` does
 * nothing on the river, where no combo has outs):
 * - heads-up: a river check with two live players (`NarrowInput.players`
 *   unset or 2) re-trimmed, multiway river checks as shipped;
 * - multiway: a river check with three or more re-trimmed, heads-up as shipped;
 * - shared: both re-trimmed alike.
 * A fourth family varies `CHECK_REPEAT` (a check after the actor's earlier
 * postflop checks) on every street, everything else as shipped.
 *
 * Scored, every opponent shown down (the hero left out; no bomb pot):
 * - a flop two players saw, with or without the hero (`walkRanges`; the
 *   hero's own heads-up flops read the flop library where a chunk covers them,
 *   as the analysis does);
 * - a flop three or more saw (`walkMultiway`, from the hero's seat, or the
 *   first seat in a pot without the hero).
 * Rows: a river row for every shown player who acted on the river, on their
 * range after their last river action; for `CHECK_REPEAT`, also the flop and
 * turn rows of the earlier studies (the range as the next card came). A river
 * row is heads-up or multiway by the players live as the river began.
 *
 * Score as `analysis/17`-`/23`: mean log-likelihood per combo of the shown
 * combo, a combo outside the range at a twentieth of a uniform combo. Held out:
 * five folds by player (the hash of `multiwayNarrowing.test.ts`), every player
 * scored by the candidate that did best on the other four folds; standard
 * errors clustered by player. A fidelity check confirms the study's restated
 * baseline is the shipped `heuristicModel` to the bit.
 *
 *     cd tests && FLOPLIB_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out npm run floplib:river-check-trim
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { it } from "vitest";

import {
  BLUFF_ZONE,
  CHECK_AIR,
  CHECK_DRAW,
  CHECK_REPEAT,
  CHECK_VALUE,
  effectiveStrength,
  FlopLibraryLoader,
  flopSeats,
  handStrength,
  HEADS_UP_CHECK_AIR,
  HEADS_UP_CHECK_DRAW,
  HEADS_UP_CHECK_VALUE,
  heroSeatOf,
  heuristicModel,
  libraryEntry,
  libraryModel,
  MULTIWAY_CHECK_DRAW,
  MULTIWAY_CHECK_VALUE,
  percentiles,
  streetStrength,
  VALUE_SHARE,
  walkMultiway,
  walkRanges,
  type NarrowingModel,
  type NarrowInput,
} from "../../../web/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../web/src/lib/charts/index.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../web/src/lib/solver/index.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";

const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const FOLDS = 5;

/** `analysis/23`'s river check constants and repeat factor, restated: the baseline. */
const SHIPPED = { value: 0.5, air: 0.7, scale: 1 };
const SHIPPED_REPEAT = 0.5;
/** What the shipped heuristic should equal (the baseline, or the winner once shipped). */
const SHIPPED_NOW = { hu: { value: CHECK_VALUE, air: CHECK_AIR, scale: 1 }, mw: { value: CHECK_VALUE, air: CHECK_AIR, scale: 1 }, repeat: CHECK_REPEAT };
const FLOOR = 0.03;
const RAMP = 0.12;
const STRONG_DRAW_OUTS = 8;
const WEAK_DRAW_OUTS = 4;

const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

function ll(range: Float64Array | undefined | null, combo: number): number {
  if (!range) return FLOOR_LL;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

function ramp(q: number, from: number, to: number): number {
  if (q <= from) return 0;
  if (q >= to) return 1;
  return (q - from) / (to - from);
}

interface Trim {
  value: number;
  air: number;
  /** The whole trim × this (1: the constants as they are). */
  scale: number;
}

interface Candidate {
  /** River checks with two live players. */
  hu: Trim;
  /** River checks with three or more. */
  mw: Trim;
  /** `CHECK_REPEAT`, every street. */
  repeat: number;
}

/** `narrowing.ts`'s `check()` with the river constants and the repeat factor as parameters. */
function checkLikelihood(input: NarrowInput, k: Candidate): Float64Array {
  const strength = input.strength ?? streetStrength(input.board);
  let hs = handStrength(strength, input.opponent);
  if (input.opponents && input.opponents.length >= 2) {
    hs = handStrength(strength, input.opponents[0]);
    for (let i = 1; i < input.opponents.length; i += 1) {
      const other = handStrength(strength, input.opponents[i]);
      for (let c = 0; c < NUM_COMBOS; c += 1) hs[c] *= other[c];
    }
  }
  const q = percentiles(effectiveStrength(strength, hs), input.actor);
  const outs = strength.outs;
  const multiway = (input.players ?? 2) > 2;
  const river = input.street === "river";
  let value: number;
  let air: number;
  let draw: number;
  let scale = 1;
  if (river) {
    const t = multiway ? k.mw : k.hu;
    value = t.value;
    air = t.air;
    draw = CHECK_DRAW;
    scale = t.scale;
  } else if (multiway) {
    value = MULTIWAY_CHECK_VALUE;
    air = CHECK_AIR;
    draw = MULTIWAY_CHECK_DRAW;
  } else {
    value = HEADS_UP_CHECK_VALUE;
    air = HEADS_UP_CHECK_AIR;
    draw = HEADS_UP_CHECK_DRAW;
  }
  const repeat = scale * Math.pow(k.repeat, Math.max(0, input.action.checksBefore ?? 0));
  const cut = 1 - VALUE_SHARE[input.street];
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!(input.actor[c] > 0) || Number.isNaN(q[c])) continue;
    const o = outs[c];
    if (o >= STRONG_DRAW_OUTS) {
      out[c] = 1 - (1 - draw) * repeat;
      continue;
    }
    const v = ramp(q[c], cut - RAMP, cut);
    const a = q[c] < BLUFF_ZONE && o < WEAK_DRAW_OUTS ? 1 - ramp(q[c], BLUFF_ZONE - RAMP, BLUFF_ZONE) : 0;
    out[c] = Math.max(FLOOR, 1 - repeat * (v * (1 - value) + a * (1 - air)));
  }
  return out;
}

const candidateModel = (id: string, k: Candidate): NarrowingModel => ({
  id,
  likelihood(input: NarrowInput) {
    return input.action.kind === "check" ? checkLikelihood(input, k) : heuristicModel.likelihood(input);
  },
});

const trimLabel = (t: Trim) => (t.scale !== 1 ? `scale ${t.scale}` : `V${t.value} A${t.air}`);
const CUR_TRIM = trimLabel(SHIPPED);
const CURRENT = "current";

const TRIMS: Trim[] = [];
for (const value of [0.3, 0.5, 0.65, 0.8, 1]) for (const air of [0.5, 0.7, 0.8, 0.9, 1]) TRIMS.push({ value, air, scale: 1 });
for (const scale of [0, 0.25, 0.5, 0.75, 1.25, 1.5]) TRIMS.push({ ...SHIPPED, scale });
const REPEATS = [0, 0.25, 0.75, 1];

type Family = "hu" | "mw" | "shared";
const FAMILIES: Family[] = ["hu", "mw", "shared"];
/** Every candidate by name; `current` is the baseline. */
const CANDIDATES = new Map<string, Candidate>();
CANDIDATES.set(CURRENT, { hu: SHIPPED, mw: SHIPPED, repeat: SHIPPED_REPEAT });
const familyName = (f: Family, t: Trim) => (trimLabel(t) === CUR_TRIM ? CURRENT : `${f}: ${trimLabel(t)}`);
for (const f of FAMILIES)
  for (const t of TRIMS) {
    const name = familyName(f, t);
    if (name === CURRENT) continue;
    CANDIDATES.set(name, { hu: f === "mw" ? SHIPPED : t, mw: f === "hu" ? SHIPPED : t, repeat: SHIPPED_REPEAT });
  }
const repeatName = (r: number) => (r === SHIPPED_REPEAT ? CURRENT : `repeat ${r}`);
for (const r of REPEATS) CANDIDATES.set(repeatName(r), { hu: SHIPPED, mw: SHIPPED, repeat: r });
/** Candidates that change only the river (their flop and turn likelihoods are the baseline's). */
const riverOnly = (name: string) => name !== CURRENT && !name.startsWith("repeat ");

interface Row {
  player: string;
  fold: number;
  street: "flop" | "turn" | "river";
  /** Checked on the street and did nothing else on it. */
  checker: boolean;
  /** Checked, then called a bet. */
  checkCall: boolean;
  /** Checked, then raised. */
  checkRaise: boolean;
  /** Checked at least once on the street. */
  checked: boolean;
  /** Checked on an earlier postflop street (a check on this street is a repeated one). */
  earlierCheck: boolean;
  /** Live players as the street began. */
  players: number;
  /** Players who saw the flop. */
  flopPlayers: number;
  hero: boolean;
  score: Record<string, number>;
}

const foldOf = (name: string) => createHash("sha256").update(name).digest()[0] % FOLDS;

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

const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
const DECIDE = new Set(["check", "bet", "raise", "call"]);

it("scores the river check trim and the repeat factor on shown hands", { timeout: 12 * 60 * 60_000 }, async () => {
  if (!FILE || !existsSync(FILE) || !DIR || !existsSync(DIR)) {
    console.log("FLOPLIB_HANDS (JSONL of PHF hands) and FLOPLIB_DIR (the library) must both be set; nothing to do");
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
  const library = new FlopLibraryLoader("local:", localFetch);
  for (const spec of CHART_SETS) await library.ready(spec.id);

  const models = new Map<string, NarrowingModel>();
  for (const [name, k] of CANDIDATES) models.set(name, candidateModel(name, k));
  const restated = candidateModel("restated", SHIPPED_NOW);
  let fidelityRanges = 0;
  let mismatched = 0;
  const same = (a: Float64Array | undefined | null, b: Float64Array | undefined | null) => (!a && !b) || (!!a && !!b && a.every((w, c) => w === b[c]));

  const started = performance.now();
  const rows: Row[] = [];
  let groups = 0;
  for (const [h, hand] of hands.entries()) {
    if (h % 1000 === 0) console.log(`  hand ${h} of ${hands.length}, ${rows.length} rows, ${((performance.now() - started) / 1000).toFixed(0)} s`);
    if (hand.actions.some((a) => a.type === "bomb-ante")) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const actual = heroSeatOf(context);
    const comboOf = (seat: number): number | null => {
      try {
        const cards = toIndices(context.players.get(seat)?.holeCards ?? []);
        return cards.length === 2 ? comboIndex(cards[0], cards[1]) : null;
      } catch {
        return null;
      }
    };
    const shown = seats.filter((seat) => seat !== actual && comboOf(seat) !== null);
    if (shown.length === 0) continue;
    const heroIn = actual !== null && seats.includes(actual);
    const acts = (seat: number, street: string) => hand.actions.filter((a) => a.street === street && a.seat === seat && ["check", "bet", "raise", "call", "fold"].includes(a.type));
    const seatOfIndex = new Map(hand.actions.map((a) => [a.index, a.seat]));
    const nameOf = (seat: number) => `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
    /** The index of the seat's last river decision, if it ends the seat's river (no fold). */
    const lastRiver = (seat: number): number | null => {
      const own = acts(seat, "river");
      const last = own[own.length - 1];
      return last && DECIDE.has(last.type) ? last.index : null;
    };

    /**
     * Runs every candidate through `walk` and returns, per candidate, a reader of
     * a seat's range as the turn came, as the river came, and after its last
     * river action. River-only candidates reuse the baseline's flop and turn
     * likelihoods (they are the same inputs).
     */
    type Reader = (seat: number, at: "turn" | "river" | "end") => Float64Array | null | undefined;
    /** A model that keeps every river action's narrowed range (as `narrow` makes it), by action index. */
    const recorder = (inner: NarrowingModel) => {
      const ends = new Map<number, Float64Array>();
      const model: NarrowingModel = {
        id: inner.id,
        likelihood(input) {
          const out = inner.likelihood(input);
          if (input.street === "river" && input.actionIndex !== undefined) {
            const next = new Float64Array(NUM_COMBOS);
            for (let c = 0; c < NUM_COMBOS; c += 1) {
              const w = input.actor[c];
              if (w > 0) next[c] = w * Math.min(1, Math.max(0, out[c] || 0));
            }
            ends.set(input.actionIndex, next);
          }
          return out;
        },
      };
      const end = (seat: number) => {
        const i = lastRiver(seat);
        return i === null ? null : ends.get(i);
      };
      return { model, end };
    };
    /** Fidelity: the restated constants against the shipped heuristic, on the river-start and end-of-river ranges. */
    const fidelity = (walk: (model: NarrowingModel) => { river: (seat: number) => Float64Array | null | undefined } | null, check: readonly number[]) => {
      if (fidelityRanges >= 600) return;
      const a = recorder(heuristicModel);
      const b = recorder(restated);
      const wa = walk(a.model);
      const wb = walk(b.model);
      if (!wa) return;
      for (const seat of check) {
        for (const [x, y] of [
          [wa.river(seat), wb?.river(seat)],
          [a.end(seat), b.end(seat)],
        ] as const) {
          if (!x) continue;
          fidelityRanges += 1;
          if (!same(x, y)) mismatched += 1;
        }
      }
    };
    const runAll = (walk: (model: NarrowingModel) => { turn: (seat: number) => Float64Array | null | undefined; river: (seat: number) => Float64Array | null | undefined } | null) => {
      const memo = new Map<number, Float64Array>();
      const readers = new Map<string, Reader | null>();
      const order = [CURRENT, ...[...models.keys()].filter((n) => n !== CURRENT)];
      for (const name of order) {
        const inner = models.get(name) as NarrowingModel;
        const useMemo = name === CURRENT || riverOnly(name);
        const memoised: NarrowingModel = {
          id: inner.id,
          likelihood(input) {
            if (!useMemo || input.street === "river" || input.actionIndex === undefined) return inner.likelihood(input);
            const hit = name === CURRENT ? undefined : memo.get(input.actionIndex);
            if (hit) return hit;
            const out = inner.likelihood(input);
            if (name === CURRENT) memo.set(input.actionIndex, out);
            return out;
          },
        };
        const rec = recorder(memoised);
        const w = walk(rec.model);
        if (!w) {
          readers.set(name, null);
          continue;
        }
        readers.set(name, (seat, at) => {
          if (at === "turn") return w.turn(seat);
          if (at === "river") return w.river(seat);
          return rec.end(seat);
        });
      }
      return readers;
    };

    const addRows = (readers: Map<string, Reader | null>, seat: number, playersAt: (street: "flop" | "turn" | "river") => number) => {
      const base = readers.get(CURRENT);
      if (!base) return;
      const combo = comboOf(seat) as number;
      const name = nameOf(seat);
      let earlier = false;
      for (const street of ["flop", "turn", "river"] as const) {
        const own = acts(seat, street);
        if (own.length === 0) continue;
        const at = street === "flop" ? "turn" : street === "turn" ? "river" : "end";
        if (!base(seat, at)) continue;
        const score: Record<string, number> = {};
        for (const [m, read] of readers) {
          // River-only candidates leave the flop and turn rows as they are.
          if (street !== "river" && riverOnly(m)) continue;
          score[m] = ll(read?.(seat, at), combo);
        }
        const types = own.map((a) => a.type);
        const checks = types.filter((t) => t === "check").length;
        const firstCheck = types.indexOf("check");
        rows.push({
          player: name,
          fold: foldOf(name),
          street,
          checker: checks === types.length,
          checkCall: firstCheck >= 0 && types.slice(firstCheck + 1).includes("call"),
          checkRaise: firstCheck >= 0 && types.slice(firstCheck + 1).includes("raise"),
          checked: checks > 0,
          earlierCheck: earlier,
          players: playersAt(street),
          flopPlayers: seats.length,
          hero: heroIn,
          score,
        });
        if (checks > 0) earlier = true;
      }
    };

    if (seats.length === 2) {
      let found: Extract<ReturnType<typeof libraryEntry>, { ok: true }> | null = null;
      if (heroIn) {
        await library.prefetch(hand, charts);
        const entry = libraryEntry(hand, context, actual as number, charts, library);
        found = entry.ok ? entry : null;
      }
      for (const villain of shown) {
        const hero = heroIn ? (actual as number) : seats[0] === villain ? seats[1] : seats[0];
        const options = { populationHero: actual ?? -1 };
        const run = (model: NarrowingModel) => {
          try {
            const w = walkRanges(structuredClone(hand), buildContext(structuredClone(hand)), hero, villain, charts, found ? libraryModel(found, model) : model, options);
            return w.ok ? w : null;
          } catch {
            return null;
          }
        };
        groups += 1;
        const readers = runAll((model) => {
          const w = run(model);
          return w ? { turn: () => w.turnStart?.villain, river: () => w.riverStart?.villain } : null;
        });
        fidelity((model) => {
          const w = run(model);
          return w ? { river: () => w.riverStart?.villain } : null;
        }, [villain]);
        addRows(readers, villain, () => 2);
      }
      continue;
    }

    const hero = heroIn ? (actual as number) : seats[0];
    const options = { populationHero: actual ?? -1 };
    let base: ReturnType<typeof walkMultiway> | null = null;
    const run = (model: NarrowingModel) => {
      try {
        const w = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, model, options);
        return w.ok ? w : null;
      } catch {
        return null;
      }
    };
    groups += 1;
    const readers = runAll((model) => {
      const w = run(model);
      if (w && !base) base = w;
      return w ? { turn: (seat) => w.starts.turn?.get(seat), river: (seat) => w.starts.river?.get(seat) } : null;
    });
    const b = base as Extract<ReturnType<typeof walkMultiway>, { ok: true }> | null;
    if (!b) continue;
    fidelity((model) => {
      const w = run(model);
      return w ? { river: (seat) => w.starts.river?.get(seat) } : null;
    }, shown);
    const playersAt = (street: "flop" | "turn" | "river") => (street === "flop" ? seats.length : street === "turn" ? (b.starts.turn?.size ?? 0) : (b.starts.river?.size ?? 0));
    for (const seat of shown) addRows(readers, seat, playersAt);
  }

  const river = rows.filter((r) => r.street === "river");
  console.log(
    `=== ${FILE}: ${hands.length} hands; ${groups} walks; ${rows.length} rows (flop ${rows.filter((r) => r.street === "flop").length}, turn ${rows.filter((r) => r.street === "turn").length}, river ${river.length}: heads-up ${river.filter((r) => r.players === 2).length}, multiway ${river.filter((r) => r.players >= 3).length}) (${((performance.now() - started) / 1000).toFixed(0)} s)`,
  );
  console.log(`fidelity: the study's restated constants vs the shipped heuristic, ${fidelityRanges} turn- or river-start ranges, ${mismatched} differ`);
  // The end-of-river fidelity: the baseline candidate is `analysis/23` restated; it must match the shipped heuristic when nothing has shipped.
  console.log(`river checks among the river rows: ${river.filter((r) => r.checked).length} (repeated: ${river.filter((r) => r.checked && r.earlierCheck).length})`);

  const heldOut = (fit: readonly Row[], pool: readonly string[]) => {
    const chosen: string[] = [];
    const out = new Map<Row, number>();
    for (let k = 0; k < FOLDS; k += 1) {
      const train = fit.filter((r) => r.fold !== k);
      let best = CURRENT;
      let bestMean = -Infinity;
      for (const name of pool) {
        const mean = train.reduce((s, r) => s + r.score[name], 0) / Math.max(1, train.length);
        if (mean > bestMean + 1e-12) {
          bestMean = mean;
          best = name;
        }
      }
      chosen.push(best);
      for (const r of fit) if (r.fold === k) out.set(r, r.score[best]);
    }
    return { chosen, out };
  };
  const huRows = river.filter((r) => r.players === 2);
  const mwRows = river.filter((r) => r.players >= 3);
  const pool = (f: Family, scaleOnly: boolean) => [CURRENT, ...TRIMS.filter((t) => !scaleOnly || t.scale !== 1).map((t) => familyName(f, t)).filter((n) => n !== CURRENT)];
  const fits = {
    sharedGrid: heldOut(river, pool("shared", false)),
    sharedScale: heldOut(river, pool("shared", true)),
    huGrid: heldOut(huRows, pool("hu", false)),
    huScale: heldOut(huRows, pool("hu", true)),
    mwGrid: heldOut(mwRows, pool("mw", false)),
    mwScale: heldOut(mwRows, pool("mw", true)),
  };
  for (const [k, v] of Object.entries(fits)) console.log(`held-out choices, ${k}: ${v.chosen.join(" / ")}`);
  const separate = (grid: boolean) => (r: Row) => (r.players === 2 ? (grid ? fits.huGrid : fits.huScale) : grid ? fits.mwGrid : fits.mwScale).out.get(r) as number;
  const inSample = (subset: readonly Row[], f: Family) =>
    pool(f, false)
      .map((n) => ({ n, d: clustered(subset, (r) => r.score[n] - r.score[CURRENT]) }))
      .sort((a, b) => b.d.mean - a.d.mean)
      .slice(0, 6)
      .map(({ n, d }) => `${n} ${f3(d.mean)} ± ${d.se.toFixed(3)}`)
      .join(", ");
  console.log(`in-sample best, all river rows (shared): ${inSample(river, "shared")}`);
  console.log(`in-sample best, heads-up river rows: ${inSample(huRows, "hu")}`);
  console.log(`in-sample best, multiway river rows: ${inSample(mwRows, "mw")}`);
  const fixed = ["shared: scale 0.5", "shared: scale 0", "shared: scale 1.5", "shared: V1 A0.7", "shared: V0.5 A1"];

  const cell = (subset: readonly Row[], x: (r: Row) => number) => {
    const d = clustered(subset, x);
    return `${f3(d.mean)} ± ${d.se.toFixed(3)}`;
  };
  const report = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const b = clustered(subset, (r) => r.score[CURRENT]);
    const parts = [
      cell(subset, (r) => (fits.sharedGrid.out.get(r) as number) - r.score[CURRENT]),
      cell(subset, (r) => (fits.sharedScale.out.get(r) as number) - r.score[CURRENT]),
      cell(subset, (r) => separate(true)(r) - r.score[CURRENT]),
      cell(subset, (r) => separate(false)(r) - r.score[CURRENT]),
      ...fixed.map((n) => cell(subset, (r) => r.score[n] - r.score[CURRENT])),
    ];
    console.log(`| ${title} | ${subset.length} (${b.players}) | ${b.mean.toFixed(3)} | ${parts.join(" | ")} |`);
  };
  console.log(`| river rows | n (players) | analysis/23 | shared grid, held out | shared scale, held out | separate grids, held out | separate scales, held out | ${fixed.join(" | ")} |`);
  report("every river row", river);
  report("checked only", river.filter((r) => r.checker));
  report("check-call", river.filter((r) => r.checkCall));
  report("check-raise", river.filter((r) => r.checkRaise));
  report("never checked", river.filter((r) => !r.checked));
  report("checked, after an earlier check", river.filter((r) => r.checked && r.earlierCheck));
  report("checked, no earlier check", river.filter((r) => r.checked && !r.earlierCheck));
  report("heads-up", huRows);
  report("heads-up, checked only", huRows.filter((r) => r.checker));
  report("heads-up, check-call", huRows.filter((r) => r.checkCall));
  report("heads-up, never checked", huRows.filter((r) => !r.checked));
  report("heads-up, after a multiway flop", huRows.filter((r) => r.flopPlayers >= 3));
  report("multiway", mwRows);
  report("multiway, checked only", mwRows.filter((r) => r.checker));
  report("multiway, check-call", mwRows.filter((r) => r.checkCall));
  report("multiway, never checked", mwRows.filter((r) => !r.checked));
  report("the hero's pots", river.filter((r) => r.hero));
  report("pots without the hero", river.filter((r) => !r.hero));

  // CHECK_REPEAT on every street.
  const repeatPool = [CURRENT, ...REPEATS.map(repeatName).filter((n) => n !== CURRENT)];
  const rep = heldOut(rows, repeatPool);
  console.log(`held-out choices, CHECK_REPEAT: ${rep.chosen.join(" / ")}`);
  const repeatReport = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const b = clustered(subset, (r) => r.score[CURRENT]);
    const parts = [cell(subset, (r) => (rep.out.get(r) as number) - r.score[CURRENT]), ...repeatPool.slice(1).map((n) => cell(subset, (r) => r.score[n] - r.score[CURRENT]))];
    console.log(`| ${title} | ${subset.length} (${b.players}) | ${b.mean.toFixed(3)} | ${parts.join(" | ")} |`);
  };
  console.log(`| CHECK_REPEAT rows | n (players) | analysis/23 | held out | ${repeatPool.slice(1).join(" | ")} |`);
  repeatReport("every row", rows);
  for (const street of ["flop", "turn", "river"] as const) {
    const s = rows.filter((r) => r.street === street);
    repeatReport(`${street}, everyone`, s);
    repeatReport(`${street}, checked after an earlier check`, s.filter((r) => r.checked && r.earlierCheck));
  }
  repeatReport("a check after an earlier check (turn and river)", rows.filter((r) => r.street !== "flop" && r.checked && r.earlierCheck));
});
