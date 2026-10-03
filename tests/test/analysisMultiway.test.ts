/**
 * Multiway postflop analysis (phase A9, `docs/ANALYSIS-PLAN.md` §10).
 *
 * - **The field's equity** (`equityVsRanges`) against brute force over every
 *   compatible tuple of combos on small ranges: river, turn and flop, two and
 *   three ranges, ties split, determinism of the sampler.
 * - **The MDF split and fold equity**: the formulas, and the narrowing's call
 *   cut multiway.
 * - **The walk**: every player narrowed by their own actions; a heads-up part
 *   is exactly the heads-up walk.
 * - **The approximate river call** against exact enumeration, with and
 *   without a player still to answer; refusals by name; the grade and its cap.
 * - **Heads-up reducible**: the grade equals the heads-up solver run on the
 *   same ranges, and says `multiway-history`.
 * - **Flags, explanations, links, determinism.**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyzeHand,
  callShare,
  followLine,
  gradeRank,
  gradeRiver,
  gradeRiverCall,
  headsUpWalk,
  heroSeatOf,
  heroSpots,
  mdfSplit,
  narrow,
  nextCardOuts,
  rangeWeight,
  riverActs,
  riverCallEv,
  riverStudy,
  solveRiverSpot,
  streetStrength,
  walkMultiway,
  walkRanges,
  flopSeats,
  heuristicModel,
  FLAG_CODES,
  MULTIWAY_SKIP_REASONS,
  type DecisionAnalysis,
  type HandAnalysis,
  type MultiWalk,
  type RiverCallEv,
} from "../../frontend/src/lib/analysis/index.js";
import { rakeOf } from "../../frontend/src/lib/analysis/river.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { cardCode, equity, equityVsRange, equityVsRanges, evaluate, type WeightedCombo } from "../../frontend/src/lib/equity/index.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { conceptsForDecision, FLAG_CONCEPTS } from "../../frontend/src/lib/learn/links.js";
import { allFold, alpha, mdf, mdfSplit as learnMdfSplit, multiwayBluffEv } from "../../frontend/src/lib/learn/math.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { comboHi, comboIndex, comboLo, NUM_COMBOS, parseCards } from "../../frontend/src/lib/solver/index.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";
const SEATS = ["Btn", "Sb", "Bb", "Utg", "Hj", "Co"];

let serial = 0;
/** A six-handed $0.5/$1 hand, 100bb deep, from its action lines. */
function hand(hero: string, cards: string, lines: string[], stacks: Record<string, number> = {}): PhfHand {
  serial += 1;
  const text = [
    `Poker Hand #MW${serial}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    "Table 'Mw' 6-max Seat #1 is the button",
    ...SEATS.map((name, i) => `Seat ${i + 1}: ${name} ($${stacks[name] ?? 100} in chips)`),
    "Sb: posts small blind $0.5",
    "Bb: posts big blind $1",
    "*** HOLE CARDS ***",
    `Dealt to ${hero} [${cards}]`,
    ...lines,
    "*** SHOWDOWN ***",
    "Co collected $20 from pot",
    "*** SUMMARY ***",
    `Total pot $20 ${FEES}`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

/** CO opens, the button and the big blind call: three see the flop. */
const THREE_WAY = ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: calls $2.5", "Sb: folds", "Bb: calls $1.5"];
const FLOP = "*** FLOP *** [Kd 7c 2s]";
const TURN = "*** TURN *** [Kd 7c 2s] [9h]";
const RIVER = "*** RIVER *** [Kd 7c 2s 9h] [3d]";
const CHECKED = (street: string) => [street, "Bb: checks", "Co: checks", "Btn: checks"];

const analysed = new Map<PhfHand, HandAnalysis>();
const analyse = (h: PhfHand): HandAnalysis => {
  let a = analysed.get(h);
  if (!a) {
    a = analyzeHand(structuredClone(h), { charts: CHARTS });
    analysed.set(h, a);
  }
  return a;
};
const decisionOn = (analysis: HandAnalysis, street: string, action: string): DecisionAnalysis => {
  const found = analysis.decisions.find((d) => d.street === street && d.action === action);
  if (!found) throw new Error(`no ${street} ${action}`);
  return found;
};

/* ------------------------------------------------------------ equities - */

const combo = (codes: string, weight = 1): WeightedCombo => {
  const [a, b] = parseCards(codes.split(" "));
  return { cards: [a, b], weight };
};

/** Brute force: every compatible tuple through `equity()`, weighted by the product of the weights. */
function bruteForce(hero: string[], ranges: WeightedCombo[][], board: string[]): number {
  const codes = (c: WeightedCombo) => c.cards.map((i) => cardCode(i));
  const used = new Set([...parseCards(hero), ...parseCards(board)]);
  let total = 0;
  let sum = 0;
  const walk = (depth: number, picked: WeightedCombo[], weight: number) => {
    if (depth === ranges.length) {
      const result = equity({ game: "holdem", hands: [hero, ...picked.map(codes)], board, method: "exhaustive" });
      sum += weight * result.equity[0];
      total += weight;
      return;
    }
    for (const c of ranges[depth]) {
      if (used.has(c.cards[0]) || used.has(c.cards[1])) continue;
      used.add(c.cards[0]);
      used.add(c.cards[1]);
      walk(depth + 1, [...picked, c], weight * c.weight);
      used.delete(c.cards[0]);
      used.delete(c.cards[1]);
    }
  };
  walk(0, [], 1);
  return sum / total;
}

describe("the field's equity (equityVsRanges)", () => {
  const A = [combo("As Ad", 1), combo("Ks Qs", 0.5), combo("7h 7d", 0.8), combo("Ah Kc", 0.3)];
  const B = [combo("Qh Qd", 1), combo("Jc Tc", 0.6), combo("9s 9c", 0.4), combo("As Qd", 0.7)];
  const C = [combo("8c 8d"), combo("Ac Jd", 0.5), combo("Kc Jc", 0.9)];

  it("equals brute force over every tuple on the river, two and three ranges", () => {
    const board = ["Kd", "7c", "2s", "9h", "3d"];
    const two = equityVsRanges({ hero: ["Kh", "7h"], ranges: [A, B], board });
    expect(two.method).toBe("exhaustive");
    expect(two.equity).toBeCloseTo(bruteForce(["Kh", "7h"], [A, B], board), 12);
    const three = equityVsRanges({ hero: ["Kh", "7h"], ranges: [A, B, C], board });
    expect(three.equity).toBeCloseTo(bruteForce(["Kh", "7h"], [A, B, C], board), 12);
    expect(three.equity).toBeLessThan(two.equity);
  });

  it("equals brute force over every runout on the turn and the flop", () => {
    const turn = ["Kd", "7c", "2s", "9h"];
    expect(equityVsRanges({ hero: ["Kh", "Js"], ranges: [A, B], board: turn }).equity).toBeCloseTo(
      bruteForce(["Kh", "Js"], [A, B], turn),
      12,
    );
    const flop = ["Kd", "7c", "2s"];
    const small = [A.slice(0, 2), B.slice(0, 2)];
    const exact = equityVsRanges({ hero: ["Kh", "Js"], ranges: small, board: flop, method: "exhaustive" });
    expect(exact.equity).toBeCloseTo(bruteForce(["Kh", "Js"], small, flop), 12);
  });

  it("is equityVsRange with one range, and splits a tie among everyone in it", () => {
    const board = ["Kd", "7c", "2s", "9h", "3d"];
    const one = equityVsRanges({ hero: ["Kh", "Js"], ranges: [A], board });
    expect(one.equity).toBeCloseTo(equityVsRange({ hero: ["Kh", "Js"], range: A, board }).equity, 12);
    // A royal flush on the board: everyone plays it, three ways.
    const royal = ["Ah", "Kh", "Qh", "Jh", "Th"];
    const split = equityVsRanges({ hero: ["2c", "3d"], ranges: [[combo("4c 5d")], [combo("6c 7d")]], board: royal });
    expect(split.equity).toBeCloseTo(1 / 3, 12);
    expect(split.tie).toBe(1);
  });

  it("drops a range that card removal empties, and samples deterministically close to exact", () => {
    const board = ["Kd", "7c", "2s", "9h"];
    const blocked = equityVsRanges({ hero: ["As", "Ad"], ranges: [[combo("As Ah")], B], board });
    expect(blocked.combos[0]).toBe(0);
    expect(blocked.equity).toBeCloseTo(equityVsRange({ hero: ["As", "Ad"], range: B, board }).equity, 12);
    const exact = equityVsRanges({ hero: ["Kh", "Js"], ranges: [A, B], board }).equity;
    const sampled = equityVsRanges({ hero: ["Kh", "Js"], ranges: [A, B], board, method: "monte-carlo", trials: 20_000, seed: 7 });
    expect(sampled.method).toBe("monte-carlo");
    expect(Math.abs(sampled.equity - exact)).toBeLessThan(0.02);
    expect(equityVsRanges({ hero: ["Kh", "Js"], ranges: [A, B], board, method: "monte-carlo", trials: 20_000, seed: 7 })).toEqual(sampled);
  });
});

/* ------------------------------------------------- MDF split, fold equity - */

describe("the MDF split and fold equity", () => {
  it("shares the table's defence: together the defenders fold exactly alpha", () => {
    for (const x of [0.33, 0.5, 0.75, 1, 1.5]) {
      expect(mdfSplit(x, 1)).toBeCloseTo(1 / (1 + x), 12);
      for (const k of [2, 3, 4]) {
        const each = mdfSplit(x, k);
        expect(Math.pow(1 - each, k)).toBeCloseTo(x / (1 + x), 12);
        expect(each).toBeLessThan(mdfSplit(x, k - 1));
        // The concept page's calculator says the same, in chips.
        expect(learnMdfSplit(10, 10 * x, k)).toBeCloseTo(each, 12);
      }
    }
  });

  it("multiplies fold equity down: the concept page's example", () => {
    expect(alpha(12, 8)).toBeCloseTo(0.4, 12);
    expect(mdf(12, 8)).toBeCloseTo(0.6, 12);
    expect(allFold(0.4, 2)).toBeCloseTo(0.16, 12);
    expect(multiwayBluffEv(12, 8, 0.4, 2)).toBeCloseTo(-4.8, 12);
    expect(multiwayBluffEv(12, 8, 0.4, 1)).toBeCloseTo(0, 12);
    expect(learnMdfSplit(12, 8, 2)).toBeCloseTo(1 - Math.sqrt(0.4), 12);
    expect(Math.round(learnMdfSplit(12, 8, 2) * 100)).toBe(37);
  });

  it("calls with a smaller share of the range multiway (the narrowing's MDF split)", () => {
    const board = parseCards(["Kd", "7c", "2s", "9h", "3d"]);
    const strength = streetStrength(board);
    const range = new Float64Array(NUM_COMBOS);
    for (let c = 0; c < NUM_COMBOS; c += 1) if (!board.includes(comboHi(c)) && !board.includes(comboLo(c))) range[c] = 1;
    const base = { street: "river" as const, board, actor: range, opponent: range, strength };
    const headsUp = callShare(heuristicModel, base, 0.75).share;
    const threeWay = callShare(heuristicModel, { ...base, players: 3, opponents: [range, range] }, 0.75).share;
    expect(threeWay).toBeLessThan(headsUp);
    // Heads-up inputs are untouched by A9: `players: 2` is the heads-up model.
    const same = narrow({ ...base, players: 2, action: { kind: "call", sizePot: 0.75, allIn: false } });
    expect(same).toEqual(narrow({ ...base, action: { kind: "call", sizePot: 0.75, allIn: false } }));
  });

  it("counts the next card's nut and non-nut outs by brute force", () => {
    // 7h6h on Ah8h2c: every heart makes a flush that is not the nuts.
    const outs = nextCardOuts(parseCards(["7h", "6h"]), parseCards(["Ah", "8h", "2c"]));
    expect(outs.cards).toBe(47);
    expect(outs.nut).toBe(0);
    expect(outs.nonNut).toBe(9);
    // The nut flush draw: the hearts make the nuts (no paired board, no straight flush possible).
    const nut = nextCardOuts(parseCards(["Kh", "Qh"]), parseCards(["Ah", "8h", "2c"]));
    expect(nut.nut).toBeGreaterThanOrEqual(7);
    expect(evaluate(["Kh", "Qh", "Ah", "8h", "2c", "3h"])).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- walk - */

describe("the multiway walk", () => {
  it("narrows every player by their own actions, and drops a player who folds", () => {
    const h = hand("Bb", "Kh Qh", [...THREE_WAY, FLOP, "Bb: checks", "Co: bets $3", "Btn: calls $3", "Bb: folds", ...CHECKED(TURN).filter((l) => !l.startsWith("Bb"))]);
    const context = buildContext(h);
    const hero = heroSeatOf(context)!;
    const walk = walkMultiway(h, context, hero, CHARTS) as MultiWalk;
    expect(walk.ok).toBe(true);
    expect(walk.seats.length).toBe(3);
    expect(walk.model).toBe("heuristic/2+mw");
    const flop = h.actions.filter((a) => a.street === "flop" && a.seat !== null && ["check", "bet", "call", "fold"].includes(a.type));
    const before = walk.before(flop[0].index)!;
    const after = walk.before(flop[1].index)!;
    // The big blind's check narrowed only the big blind.
    expect(after.get(hero)).not.toEqual(before.get(hero));
    for (const seat of walk.seats.filter((s) => s !== hero)) expect(after.get(seat)).toBe(before.get(seat));
    // The turn began with two players: the hero folded on the flop.
    expect(walk.starts.turn?.size).toBe(2);
    expect(walk.starts.turn?.has(hero)).toBe(false);
  });

  it("is exactly the heads-up walk once only two are left (a free fold, then checks)", () => {
    // Without charts both ranges are the placeholders of the same lines
    // (BTN open, BB call), so the multiway hand and the heads-up one start
    // equal; checks narrow without reading the pot.
    const streets = [FLOP, "Bb: checks", "Btn: checks", TURN, "Bb: checks", "Btn: checks", RIVER, "Bb: checks", "Btn: checks"];
    const open = ["Utg: folds", "Hj: folds", "Co: folds", "Btn: raises $1.5 to $2.5"];
    const hu = hand("Bb", "Kh Qh", [...open, "Sb: folds", "Bb: calls $1.5", ...streets]);
    const mw = hand("Bb", "Kh Qh", [...open, "Sb: calls $2", "Bb: calls $1.5", FLOP, "Sb: folds", ...streets.slice(1)]);
    const huContext = buildContext(hu);
    const mwContext = buildContext(mw);
    const heroHu = heroSeatOf(huContext)!;
    const [villainHu] = flopSeats(huContext).filter((s) => s !== heroHu);
    const huWalk = walkRanges(hu, huContext, heroHu, villainHu, null);
    const multi = walkMultiway(mw, mwContext, heroSeatOf(mwContext)!, null) as MultiWalk;
    const reduced = headsUpWalk(multi)!;
    if (!huWalk.ok) throw new Error(huWalk.reason);
    expect(reduced.multiway).toEqual({ players: 3, headsUpFrom: "turn" });
    expect(reduced.turnStart!.hero).toEqual(huWalk.turnStart!.hero);
    expect(reduced.turnStart!.villain).toEqual(huWalk.turnStart!.villain);
    expect(reduced.riverStart!.hero).toEqual(huWalk.riverStart!.hero);
    expect(reduced.riverStart!.villain).toEqual(huWalk.riverStart!.villain);
  });
});

/* ------------------------------------------------- the approximate call - */

/** A walk whose ranges at every action are the given combos (for exact sums). */
function stubWalk(hero: number, ranges: Map<number, string[]>): MultiWalk {
  const map = new Map<number, Float64Array>();
  for (const [seat, combos] of ranges) {
    const range = new Float64Array(NUM_COMBOS);
    for (const codes of combos) {
      const [a, b] = parseCards(codes.split(" "));
      range[comboIndex(a, b)] = 1;
    }
    map.set(seat, range);
  }
  return {
    ok: true,
    hero,
    seats: [...ranges.keys()],
    sources: new Map([...ranges.keys()].map((s) => [s, "chart" as const])),
    labels: new Map([...ranges.keys()].map((s) => [s, "open:CO"])),
    model: "stub+mw",
    before: () => map,
    starts: { turn: null, river: map },
    preflop: map,
  };
}

function riverSpot(h: PhfHand, action: string) {
  const context = buildContext(h);
  const hero = heroSeatOf(context)!;
  const spot = heroSpots(context, hero).find((s) => s.street === "river" && s.decision.type === action)!;
  const facts = decisionOn(analyzeHand(structuredClone(h), { charts: CHARTS, turn: false }), "river", action).facts;
  const seat = (name: string) => h.players.find((p) => p.name === name)!.seat;
  return { context, hero, spot, facts, seat };
}

describe("the approximate river call", () => {
  // River: the big blind bets, the cutoff calls, the button (the hero) closes the action.
  const closing = hand("Btn", "Ks Jd", [
    ...THREE_WAY,
    ...CHECKED(FLOP),
    ...CHECKED(TURN),
    RIVER,
    "Bb: bets $8",
    "Co: calls $8",
    "Btn: calls $8",
  ]);

  it("is exact showdown EV against fixed ranges when nobody is left to answer", () => {
    const { context, hero, spot, facts, seat } = riverSpot(closing, "call");
    const bbRange = ["Kc Qc", "7h 7d", "As 3s", "9c 8c"];
    const coRange = ["Ac Kh", "Qh Qd", "Th Ts", "9s 7s"];
    const walk = stubWalk(hero, new Map([[hero, ["Ks Jd"]], [seat("Bb"), bbRange], [seat("Co"), coRange]]));
    const result = riverCallEv({ spot, facts, hand: closing, context, hero, walk, model: heuristicModel, charts: CHARTS, seed: 1 }) as RiverCallEv;
    expect(result.ok).toBe(true);
    expect(result.respond).toEqual([]);
    expect(result.scenarios).toBe(1);
    const board = ["Kd", "7c", "2s", "9h", "3d"];
    const share = bruteForce(["Ks", "Jd"], [bbRange.map((c) => combo(c)), coRange.map((c) => combo(c))], board);
    const pot = facts.potBb + facts.toCallBb;
    const rake = rakeOf(CHARTS);
    const ev = share * (pot - Math.min(pot * rake.percent, rake.cap)) - facts.toCallBb;
    expect(result.equity).toBeCloseTo(share, 3);
    expect(result.call).toBeCloseTo(ev, 3);
  });

  it("mixes the ways a player still to answer can respond, each exactly", () => {
    // River: the big blind checks, the cutoff bets, the hero calls with the big blind still to answer.
    const h = hand("Btn", "Ks Jd", [...THREE_WAY, ...CHECKED(FLOP), ...CHECKED(TURN), RIVER, "Bb: checks", "Co: bets $8", "Btn: calls $8", "Bb: folds"]);
    const { context, hero, spot, facts, seat } = riverSpot(h, "call");
    const bbRange = ["Kc Qc", "7h 7d", "As 3s", "9c 8c", "5h 4h"];
    const coRange = ["Ac Kh", "Qh Qd", "Th Ts", "9s 7s"];
    const walk = stubWalk(hero, new Map([[hero, ["Ks Jd", "Ah Kc"]], [seat("Bb"), bbRange], [seat("Co"), coRange]]));
    const result = riverCallEv({ spot, facts, hand: h, context, hero, walk, model: heuristicModel, charts: CHARTS, seed: 1 }) as RiverCallEv;
    expect(result.ok).toBe(true);
    expect(result.respond.length).toBe(1);
    expect(result.scenarios).toBe(2);
    // The same answer by hand: the big blind's calling range by the model, then both showdowns.
    const ranges = walk.before(0)!;
    const board = parseCards(["Kd", "7c", "2s", "9h", "3d"]);
    const bb = Float64Array.from(ranges.get(seat("Bb"))!);
    for (const c of parseCards(["Ks", "Jd"])) for (let k = 0; k < NUM_COMBOS; k += 1) if (comboHi(k) === c || comboLo(k) === c) bb[k] = 0;
    const answer = callShare(
      heuristicModel,
      { street: "river", board, actor: bb, opponent: ranges.get(hero)!, opponents: [ranges.get(hero)!, ranges.get(seat("Co"))!], players: 3, strength: streetStrength(board) },
      facts.facingPot!,
    );
    expect(result.respond[0].call).toBeCloseTo(answer.share, 3);
    const asCombos = (r: Float64Array) => {
      const out: WeightedCombo[] = [];
      for (let k = 0; k < NUM_COMBOS; k += 1) if (r[k] > 0) out.push({ cards: [comboHi(k), comboLo(k)], weight: r[k] });
      return out;
    };
    const boardCodes = ["Kd", "7c", "2s", "9h", "3d"];
    const co = coRange.map((c) => combo(c));
    const alone = bruteForce(["Ks", "Jd"], [co], boardCodes);
    const both = bruteForce(["Ks", "Jd"], [co, asCombos(answer.range)], boardCodes);
    const rake = rakeOf(CHARTS);
    const net = (pot: number, share: number) => share * (pot - Math.min(pot * rake.percent, rake.cap)) - facts.toCallBb;
    const pot = facts.potBb + facts.toCallBb;
    const expected = (1 - answer.share) * net(pot, alone) + answer.share * net(pot + facts.toCallBb, both);
    expect(result.call).toBeCloseTo(expected, 3);
  });

  it("refuses a side pot and a crowd by name", () => {
    const short = hand(
      "Btn",
      "Ks Jd",
      [...THREE_WAY, FLOP, "Bb: bets $7.5 and is all-in", "Co: calls $7.5", "Btn: calls $7.5", TURN, "Co: checks", "Btn: checks", RIVER, "Co: bets $10", "Btn: calls $10"],
      { Bb: 10 },
    );
    const call = decisionOn(analyse(short), "river", "call");
    expect(call.status).toBe("not-analysed");
    expect(call.reason).toBe("multiway-side-pot");
    expect(call.facts.multiway?.opponents.some((o) => o.allIn)).toBe(true);
  });

  it("grades the better of call and fold at 100%, capped at Mistake, with the cap admitted", () => {
    const evs: RiverCallEv = { ok: true, call: -4, equity: 0.1, pot: 30, respond: [], scenarios: 1, rake: "r" };
    const call = gradeRiverCall(evs, "call", 20, false);
    expect(call.options.map((o) => o.freq)).toEqual([1, 0]);
    expect(call.grade).toBe("mistake");
    expect(call.ev.capped).toBe("blunder");
    expect(call.approximations).toEqual(["multiway-approx", "narrowing-heuristic", "rake-profile", "range-cap"]);
    // A call that beats nothing the opponents can hold keeps its Blunder.
    expect(gradeRiverCall(evs, "call", 20, true).grade).toBe("blunder");
    expect(gradeRiverCall(evs, "fold", 20, false).grade).toBe("perfect");
    expect(gradeRiverCall({ ...evs, call: 0.3 }, "fold", 20, false).grade).toBe("inaccurate");
  });

  it("grades a three-way river call in the analysis, labelled approximate, in both languages", () => {
    const call = decisionOn(analyse(closing), "river", "call");
    expect(call.status).toBe("analysed");
    expect(call.source).toBe("approx");
    expect(call.options.map((o) => o.action)).toEqual(["fold", "call"]);
    expect(call.approximations).toEqual(expect.arrayContaining(["multiway-approx", "narrowing-heuristic", "rake-profile"]));
    expect(gradeRank(call.grade!)).toBeLessThanOrEqual(gradeRank("mistake"));
    expect(call.facts.multiway?.ev?.call).toBeCloseTo(call.options[1].ev, 9);
    expect(call.facts.scenario).toMatch(/^caller-mw-(ip|oop)-vs-bet$/);
    expect(en.analysis.explain(call).join(" ")).toContain("(approximate, multiway)");
    expect(hr.analysis.explain(call).join(" ")).toContain("(približno, multiway)");
    expect(conceptsForDecision(call)).toContain("multiway-pots");
  });
});

/* ------------------------------------------------------- heads-up part - */

describe("heads-up reducible spots", { timeout: 120_000 }, () => {
  it("grades a river that began heads-up with the heads-up solver on the multiway walk's ranges", () => {
    const h = hand("Bb", "Kh Qh", [...THREE_WAY, FLOP, "Bb: checks", "Co: bets $3", "Btn: folds", "Bb: calls $3", TURN, "Bb: checks", "Co: checks", RIVER, "Bb: checks", "Co: bets $6", "Bb: calls $6"]);
    const analysis = analyzeHand(structuredClone(h), { charts: CHARTS, turn: false });
    const call = decisionOn(analysis, "river", "call");
    expect(call.source).toBe("solver");
    expect(call.approximations).toContain("multiway-history");
    // The same solve by hand, from `headsUpWalk`.
    const context = buildContext(h);
    const hero = heroSeatOf(context)!;
    const walk = headsUpWalk(walkMultiway(h, context, hero, CHARTS) as MultiWalk)!;
    expect(walk.multiway?.headsUpFrom).toBe("turn");
    const spots = heroSpots(context, hero);
    const spot = spots.find((s) => s.street === "river" && s.decision.type === "call")!;
    const solve = solveRiverSpot({
      hand: h,
      heroSeat: hero,
      villainSeat: walk.villain,
      heroFirst: true,
      heroCards: parseCards(["Kh", "Qh"]) as [number, number],
      board: parseCards(["Kd", "7c", "2s", "9h", "3d"]),
      potBb: spot.streetPot / 100,
      stackBb: spot.streetEffBehind / 100,
      ranges: walk.riverStart!,
      charts: CHARTS,
      model: walk.model,
      key: { players: 6, stackBucket: "100bb", preflopLine: analysis.potType, positions: ["BB", "CO"] },
    });
    if (!solve.ok) throw new Error(solve.reason);
    const acts = riverActs(h);
    const at = acts.findIndex((a) => a.index === spot.action.index);
    const line = followLine(solve, acts.slice(0, at));
    if (!line.ok) throw new Error(line.reason);
    const graded = gradeRiver(solve, line, acts[at]);
    if (!graded.ok) throw new Error(graded.reason);
    expect(call.approximations).not.toContain("range-sensitive");
    expect(call.options).toEqual(graded.options);
    expect(call.grade).toBe(graded.grade);
    expect(rangeWeight(walk.riverStart!.villain)).toBeGreaterThan(0);
    // The study view re-solves the same spot to the stored numbers.
    const study = riverStudy(structuredClone(h), call.actionIndex, { charts: CHARTS, turn: false });
    if (!study || !("hero" in study)) throw new Error("no study");
    expect(study.hero.freq).toEqual(call.options.map((o) => o.freq));
    expect(study.hero.ev).toEqual(call.options.map((o) => o.ev));
  });
});

/* -------------------------------------------------------------- flags - */

describe("multiway flags", () => {
  const bluff = hand("Btn", "5h 4h", [...THREE_WAY, ...CHECKED(FLOP), ...CHECKED(TURN), RIVER, "Bb: checks", "Co: checks", "Btn: bets $6", "Bb: folds", "Co: folds"]);
  const draw = hand("Bb", "7h 6h", [...THREE_WAY, "*** FLOP *** [Ah 8h 2c]", "Bb: checks", "Co: bets $5", "Btn: raises $25 to $30", "Bb: calls $29", "Co: folds"]);

  it("notes a bluff into two players, loudly only on the river with nothing", () => {
    const bet = decisionOn(analyse(bluff), "river", "bet");
    expect(bet.status).toBe("not-analysed");
    expect(bet.reason).toBe("multiway");
    const flag = bet.flags.find((f) => f.code === "multiway-bluff")!;
    expect(flag).toBeTruthy();
    expect(flag.severity).toBe("inaccurate");
    const fe = bet.facts.multiway!.foldEquity!;
    expect(fe.all).toBeCloseTo(fe.each.reduce((p, x) => p * x, 1), 2);
    expect(fe.all).toBeLessThan(fe.needed);
  });

  it("notes calling off with a draw that is not to the nuts, and the reverse implied odds", () => {
    const call = decisionOn(analyse(draw), "flop", "call");
    expect(call.flags.map((f) => f.code)).toContain("multiway-dominated-draw");
    expect(call.facts.multiway!.outs).toEqual({ nut: 0, nonNut: 9, cards: 47 });
    expect(call.facts.multiway!.reverseImplied).toBe(true);
    expect(call.facts.multiway!.mdfSplit!.defenders).toBe(2);
  });

  it("explains every multiway flag in both languages, quoting its numbers, and links it", () => {
    const decisions = [bluff, draw].flatMap((h) => analyse(h).decisions);
    const flagged = decisions.filter((d) => d.flags.some((f) => f.code.startsWith("multiway-")));
    expect(flagged.length).toBeGreaterThan(0);
    for (const d of flagged) {
      for (const flag of d.flags) {
        expect(FLAG_CODES).toContain(flag.code);
        expect(["note", "inaccurate"]).toContain(flag.severity);
        for (const value of Object.values(flag.params)) {
          if (typeof value === "number") {
            expect(en.analysis.explain(d).join(" ")).toContain(String(value));
            expect(hr.analysis.explain(d).join(" ")).toContain(String(value));
          }
        }
        expect(FLAG_CONCEPTS[flag.code][0]).toBeTruthy();
        expect(en.analysis.flags[flag.code]).toBeTruthy();
        expect(hr.analysis.flags[flag.code]).toBeTruthy();
      }
    }
  });

  it("explains every skip reason in both languages", () => {
    for (const reason of MULTIWAY_SKIP_REASONS) {
      expect(en.analysis.reasons[reason]).toBeTruthy();
      expect(hr.analysis.reasons[reason]).toBeTruthy();
    }
  });

  it("is deterministic, sampled equities included", () => {
    for (const h of [bluff, draw]) expect(analyzeHand(structuredClone(h), { charts: CHARTS })).toEqual(analyse(h));
  });
});
