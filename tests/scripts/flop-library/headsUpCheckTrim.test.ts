/**
 * A smaller heads-up check trim, held out on shown hands (§10, 2026-10-14).
 * The open point of the multiway check trim (`checkTrim.test.ts`, whose
 * score, folds and standard errors this reuses): applying half the trim to
 * heads-up checks too scored +0.039 ± 0.015 per combo on 91 heads-up
 * players who only checked the flop. Here the heuristic's check likelihood is
 * recomputed with other constants (`CHECK_VALUE`, `CHECK_AIR`, `CHECK_DRAW`),
 * or with its trim scaled by one factor, **only for flop and turn checks made
 * heads-up** (`NarrowInput.players` unset or 2); every other action, the
 * multiway checks (`analysis/22`'s constants) and the river are the shipped
 * heuristic.
 *
 * Scored, every opponent shown down (the hero left out; no bomb pot):
 * - a flop two players saw, with or without the hero: on the range as the
 *   turn came (flop rows) and as the river came (turn rows), from the
 *   heads-up walk (`walkRanges`; the hero's own pots read the hero's range as
 *   the analysis does, a pot without the hero reads both from the population);
 * - a multiway flop whose turn began heads-up with the hero: the turn row,
 *   from the multiway walk (`walkMultiway`, as the analysis hands it on).
 *
 * The flop library: on a heads-up flop with the hero, the analysis narrows
 * the flop with the library's strategy where a chunk covers the line
 * (`libraryModel`), and the heuristic only where the line leaves the tree.
 * Every row is scored twice: on the heuristic walk, and as analysed (the
 * library where it reads, the candidate as its fallback); a row is "through
 * the heuristic" when one of the player's flop checks fell back to it. The
 * candidate is fitted on the rows as analysed.
 *
 * Score as `analysis/17`-`/22`: mean log-likelihood per combo of the shown
 * combo, a combo outside the range at a twentieth of a uniform combo. The
 * candidate is chosen held out: five folds by player (the hash of
 * `multiwayNarrowing.test.ts`), every player scored by the candidate that did
 * best on the other four folds' flop and turn rows together; standard errors
 * clustered by player. A fidelity check confirms the shipped `heuristicModel`
 * is the study's winner (`WINNER`) to the bit.
 *
 *     cd tests && FLOPLIB_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out npm run floplib:hu-check-trim
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { it } from "vitest";

import {
  BLUFF_ZONE,
  CHECK_REPEAT,
  effectiveStrength,
  FlopLibraryLoader,
  flopSeats,
  handStrength,
  heroSeatOf,
  heuristicModel,
  libraryEntry,
  libraryModel,
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

/**
 * `analysis/22`'s heads-up flop and turn check constants (`CHECK_VALUE`,
 * `CHECK_AIR`, `CHECK_DRAW`, the river's to this day), restated so the study
 * still compares against them after `analysis/23`: the baseline.
 */
const SHIPPED = { value: 0.5, air: 0.7, draw: 0.6 };
/** What `analysis/23` ships (`HEADS_UP_CHECK_*`): the trim × 0.5 as constants. */
const WINNER = { value: 0.75, air: 0.85, draw: 0.8, scale: 1 };
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
  draw: number;
  /** The whole trim × this (1: the constants as they are). */
  scale: number;
}

/** `narrowing.ts`'s heads-up `check()`, with its constants as parameters (as `checkTrim.test.ts`). */
function checkLikelihood(input: NarrowInput, t: Trim): Float64Array {
  const strength = input.strength ?? streetStrength(input.board);
  const hs = handStrength(strength, input.opponent);
  const q = percentiles(effectiveStrength(strength, hs), input.actor);
  const outs = strength.outs;
  const repeat = t.scale * Math.pow(CHECK_REPEAT, Math.max(0, input.action.checksBefore ?? 0));
  const cut = 1 - VALUE_SHARE[input.street];
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!(input.actor[c] > 0) || Number.isNaN(q[c])) continue;
    const o = outs[c];
    if (o >= STRONG_DRAW_OUTS) {
      out[c] = 1 - (1 - t.draw) * repeat;
      continue;
    }
    const value = ramp(q[c], cut - RAMP, cut);
    const air = q[c] < BLUFF_ZONE && o < WEAK_DRAW_OUTS ? 1 - ramp(q[c], BLUFF_ZONE - RAMP, BLUFF_ZONE) : 0;
    out[c] = Math.max(FLOOR, 1 - repeat * (value * (1 - t.value) + air * (1 - t.air)));
  }
  return out;
}

const headsUpCheck = (input: NarrowInput) =>
  input.action.kind === "check" && input.street !== "river" && (input.players ?? 2) < 3 && !(input.opponents && input.opponents.length >= 2);

/** The shipped heuristic with heads-up flop and turn checks re-trimmed. */
const trimmed = (id: string, t: Trim): NarrowingModel => ({
  id,
  likelihood(input: NarrowInput) {
    return headsUpCheck(input) ? checkLikelihood(input, t) : heuristicModel.likelihood(input);
  },
});

const label = (t: Trim) => (t.scale !== 1 ? `scale ${t.scale}` : `V${t.value} A${t.air} D${t.draw}`);
const CURRENT = label({ ...SHIPPED, scale: 1 });

const GRID: Trim[] = [];
for (const value of [0.5, 0.65, 0.8, 1]) for (const air of [0.7, 0.8, 0.9, 1]) for (const draw of [0.6, 0.8, 1]) GRID.push({ value, air, draw, scale: 1 });
for (const scale of [0, 0.25, 0.5, 0.75]) GRID.push({ ...SHIPPED, scale });
const SCALES = GRID.filter((t) => t.scale !== 1 || label(t) === CURRENT);

interface Row {
  player: string;
  fold: number;
  street: "flop" | "turn";
  /** Checked on the street and did nothing else on it. */
  checker: boolean;
  /** Checked at least once on the street (a check-call or check-raise too). */
  checked: boolean;
  /** Where the row came from. */
  kind: "hero" | "no-hero" | "after-multiway";
  /** The analysis found a library chunk for the hand. */
  covered: boolean;
  /** One of the player's flop checks went through the heuristic as analysed (no chunk, or the line left the tree). */
  heuristicFlopCheck: boolean;
  /** Checked the flop at all. */
  flopChecked: boolean;
  /** The hero acted on the turn (heads-up): the analysis solves that turn, and the river starts from the solve where it can. */
  heroTurn: boolean;
  /** The score as analysed (the library where it reads). */
  score: Record<string, number>;
  /** The score on the heuristic walk. */
  plain: Record<string, number>;
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

it("scores a smaller heads-up check trim on shown hands", { timeout: 12 * 60 * 60_000 }, async () => {
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

  const models: Record<string, NarrowingModel> = {};
  for (const t of GRID) models[label(t)] = trimmed(label(t), t);
  // The shipped heuristic must be the study's winner, to the bit.
  const fidelity = trimmed("fidelity", WINNER);
  let fidelityRanges = 0;
  let mismatched = 0;
  const same = (a: Float64Array | undefined | null, b: Float64Array | undefined | null) => (!a && !b) || (!!a && !!b && a.every((w, c) => w === b[c]));

  const started = performance.now();
  const rows: Row[] = [];
  let headsUpHands = 0;
  let covered = 0;
  for (const hand of hands) {
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
    const acts = (seat: number, street: string) => hand.actions.filter((a) => a.street === street && a.seat === seat && ["check", "bet", "raise", "call", "fold"].includes(a.type));
    const shown = seats.filter((seat) => seat !== actual && comboOf(seat) !== null);
    if (shown.length === 0) continue;
    const heroIn = actual !== null && seats.includes(actual);
    const heroTurn = heroIn && acts(actual as number, "turn").length > 0;
    const nameOf = (seat: number) => `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
    const push = (seat: number, street: "flop" | "turn", kind: Row["kind"], extra: Pick<Row, "covered" | "heuristicFlopCheck" | "score" | "plain">) => {
      const own = acts(seat, street);
      const checks = own.filter((a) => a.type === "check").length;
      const name = nameOf(seat);
      rows.push({
        player: name,
        fold: foldOf(name),
        street,
        checker: checks === own.length,
        checked: checks > 0,
        kind,
        flopChecked: acts(seat, "flop").some((a) => a.type === "check"),
        heroTurn,
        ...extra,
      });
    };

    if (seats.length === 2) {
      headsUpHands += 1;
      // The analysis's library entry (only for the hero's own pots).
      let entry: ReturnType<typeof libraryEntry> | null = null;
      if (heroIn) {
        await library.prefetch(hand, charts);
        entry = libraryEntry(hand, context, actual as number, charts, library);
      }
      const found = entry && entry.ok ? entry : null;
      if (found) covered += 1;
      for (const villain of shown) {
        const hero = heroIn ? (actual as number) : seats[0] === villain ? seats[1] : seats[0];
        const options = { populationHero: actual ?? -1 };
        const combo = comboOf(villain) as number;
        const villainChecks = new Set(acts(villain, "flop").filter((a) => a.type === "check").map((a) => a.index));
        const walk = (model: NarrowingModel) => {
          try {
            const w = walkRanges(structuredClone(hand), buildContext(structuredClone(hand)), hero, villain, charts, model, options);
            return w.ok ? w : null;
          } catch {
            return null;
          }
        };
        const plainWalks: Record<string, ReturnType<typeof walk>> = {};
        const libWalks: Record<string, ReturnType<typeof walk>> = {};
        let fellBack = false;
        for (const [name, model] of Object.entries(models)) {
          plainWalks[name] = walk(model);
          if (!found) {
            libWalks[name] = plainWalks[name];
            continue;
          }
          const fallback: NarrowingModel = {
            id: model.id,
            likelihood(input) {
              if (name === CURRENT && input.street === "flop" && input.actionIndex !== undefined && villainChecks.has(input.actionIndex)) fellBack = true;
              return model.likelihood(input);
            },
          };
          libWalks[name] = walk(libraryModel(found, fallback));
        }
        const base = plainWalks[CURRENT];
        if (!base) continue;
        if (fidelityRanges < 400) {
          const shipped = walk(heuristicModel);
          const again = walk(fidelity);
          for (const k of ["turnStart", "riverStart"] as const) {
            if (!shipped?.[k]) continue;
            fidelityRanges += 1;
            if (!same(shipped[k]?.villain, again?.[k]?.villain) || !same(shipped[k]?.hero, again?.[k]?.hero)) mismatched += 1;
          }
        }
        for (const street of ["flop", "turn"] as const) {
          if (acts(villain, street).length === 0) continue;
          const key = street === "flop" ? "turnStart" : "riverStart";
          if (!base[key] || !libWalks[CURRENT]?.[key]) continue;
          const score: Record<string, number> = {};
          const plain: Record<string, number> = {};
          for (const name of Object.keys(models)) {
            score[name] = ll(libWalks[name]?.[key]?.villain, combo);
            plain[name] = ll(plainWalks[name]?.[key]?.villain, combo);
          }
          const flopChecked = villainChecks.size > 0;
          push(villain, street, heroIn ? "hero" : "no-hero", { covered: !!found, heuristicFlopCheck: flopChecked && (!found || fellBack), score, plain });
        }
      }
      continue;
    }

    // A multiway flop with the hero whose turn began heads-up: the turn row.
    if (!heroIn) continue;
    const hero = actual as number;
    const options = { populationHero: hero };
    const walks: Record<string, ReturnType<typeof walkMultiway>> = {};
    for (const [name, model] of Object.entries(models)) {
      try {
        walks[name] = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, model, options);
      } catch {
        walks[name] = { ok: false, reason: "range-empty" };
      }
    }
    const base = walks[CURRENT];
    if (!base.ok || (base.starts.turn?.size ?? 0) !== 2) continue;
    for (const seat of shown) {
      if (acts(seat, "turn").length === 0 || !base.starts.river?.has(seat)) continue;
      const combo = comboOf(seat) as number;
      const score: Record<string, number> = {};
      for (const [name, w] of Object.entries(walks)) score[name] = ll(w.ok ? w.starts.river?.get(seat) : null, combo);
      push(seat, "turn", "after-multiway", { covered: false, heuristicFlopCheck: false, score, plain: score });
    }
  }
  console.log(
    `=== ${FILE}: ${hands.length} hands; ${headsUpHands} heads-up flops with a shown opponent (${covered} with a library chunk); ${rows.length} rows (flop ${rows.filter((r) => r.street === "flop").length}, turn ${rows.filter((r) => r.street === "turn").length}) (${((performance.now() - started) / 1000).toFixed(0)} s)`,
  );
  console.log(`fidelity: the study's winner vs the shipped heuristic, ${fidelityRanges} turn- or river-start ranges, ${mismatched} differ`);
  const flopRows = rows.filter((r) => r.street === "flop");
  const flopCheckers = flopRows.filter((r) => r.flopChecked);
  console.log(
    `flop rows that checked the flop: ${flopCheckers.length}; with a chunk ${flopCheckers.filter((r) => r.covered).length}, of which a check fell back to the heuristic ${flopCheckers.filter((r) => r.covered && r.heuristicFlopCheck).length}; through the heuristic in all ${flopCheckers.filter((r) => r.heuristicFlopCheck).length}`,
  );
  const changed = (r: Row) => Object.values(r.score).some((v) => v !== r.score[CURRENT]);
  console.log(`rows any candidate moves, as analysed: ${rows.filter(changed).length} of ${rows.length}; turn rows where the hero acted on the turn (the river can start from a turn solve): ${rows.filter((r) => r.street === "turn" && r.heroTurn).length}`);

  // Held out: each fold scored with the candidate that did best on the other four (flop and turn rows together).
  const names = GRID.map(label);
  const heldOut = (fit: readonly Row[], pool: readonly string[], get: (r: Row) => Record<string, number>) => {
    const chosen: string[] = [];
    const out = new Map<Row, number>();
    for (let k = 0; k < FOLDS; k += 1) {
      const train = fit.filter((r) => r.fold !== k);
      let best = CURRENT;
      let bestMean = -Infinity;
      for (const name of pool) {
        const mean = train.reduce((s, r) => s + get(r)[name], 0) / Math.max(1, train.length);
        if (mean > bestMean) {
          bestMean = mean;
          best = name;
        }
      }
      chosen.push(best);
      for (const r of fit) if (r.fold === k) out.set(r, get(r)[best]);
    }
    return { chosen, out };
  };
  const grid = heldOut(rows, names, (r) => r.score);
  const scale = heldOut(rows, SCALES.map(label), (r) => r.score);
  const plainGrid = heldOut(rows, names, (r) => r.plain);
  const whole = [...names].sort((a, b) => rows.reduce((s, r) => s + r.score[b], 0) - rows.reduce((s, r) => s + r.score[a], 0));
  console.log(`held-out choices: grid ${grid.chosen.join(" / ")}; scale ${scale.chosen.join(" / ")}; grid on the heuristic walk ${plainGrid.chosen.join(" / ")}`);
  console.log(`in-sample best on all rows: ${whole.slice(0, 6).map((n) => `${n} ${f3(clustered(rows, (r) => r.score[n] - r.score[CURRENT]).mean)}`).join(", ")}`);
  const fixed = [whole[0], "V0.65 A0.7 D1", "scale 0.5", "scale 0"].filter((n, i, a) => a.indexOf(n) === i);

  const report = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const b = clustered(subset, (r) => r.score[CURRENT]);
    const g = clustered(subset, (r) => (grid.out.get(r) as number) - r.score[CURRENT]);
    const s = clustered(subset, (r) => (scale.out.get(r) as number) - r.score[CURRENT]);
    const p = clustered(subset, (r) => (plainGrid.out.get(r) as number) - r.plain[CURRENT]);
    const extra = fixed.map((n) => {
      const d = clustered(subset, (r) => r.score[n] - r.score[CURRENT]);
      return `${f3(d.mean)} ± ${d.se.toFixed(3)}`;
    });
    console.log(`| ${title} | ${subset.length} (${b.players}) | ${b.mean.toFixed(3)} | ${f3(g.mean)} ± ${g.se.toFixed(3)} | ${f3(s.mean)} ± ${s.se.toFixed(3)} | ${f3(p.mean)} ± ${p.se.toFixed(3)} | ${extra.join(" | ")} |`);
  };
  console.log(`| subset | n (players) | shipped | grid, held out | scale, held out | grid, held out, heuristic walk | ${fixed.join(" | ")} |`);
  const turn = rows.filter((r) => r.street === "turn");
  const own = flopRows.filter((r) => r.kind === "hero");
  report("all heads-up rows", rows);
  report("flop, everyone", flopRows);
  report("flop, checked only", flopRows.filter((r) => r.checker));
  report("flop, checked then called or raised", flopRows.filter((r) => r.checked && !r.checker));
  report("flop, never checked", flopRows.filter((r) => !r.checked));
  report("flop, the hero's pots", own);
  report("flop, the hero's pots, a chunk read", own.filter((r) => r.covered));
  report("flop, a check through the heuristic", flopRows.filter((r) => r.heuristicFlopCheck));
  report("flop, a check read from the library", flopRows.filter((r) => r.flopChecked && !r.heuristicFlopCheck));
  report("flop, pots without the hero", flopRows.filter((r) => r.kind === "no-hero"));
  report("turn, everyone", turn);
  report("turn, checked only", turn.filter((r) => r.checker));
  report("turn, checked then called or raised", turn.filter((r) => r.checked && !r.checker));
  report("turn, never checked", turn.filter((r) => !r.checked));
  report("turn, heads-up flop", turn.filter((r) => r.kind !== "after-multiway"));
  report("turn, after a multiway flop", turn.filter((r) => r.kind === "after-multiway"));
  report("turn, the hero acted on it", turn.filter((r) => r.heroTurn));
});
