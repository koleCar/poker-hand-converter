/**
 * analysis/24 (ANALYSIS-PLAN §10, 2026-10-16, the coverage census): two
 * preflop lines the charts refused although their game is one they chart.
 *
 * - **A dead button.** `assignPositions` names the live seats behind an empty
 *   button seat against a ring one longer with the button dropped (five
 *   players: SB, BB, UTG, HJ, CO), which no chart seat map took
 *   (`chart-players`). The game is the five-handed one with the cutoff in
 *   the button's place, so it is read as that, `dead-button`.
 * - **A poster's check.** A player who posted a live big blind from another
 *   seat and checked has a big blind in and nothing to match: a limp in
 *   chips, refused as "CO checks facing a bet" (`chart-off-tree`). Read as a
 *   limp, `posted-blind`, capped at Inaccurate (the charts' limper is not
 *   any two cards, as a poster is). The poster's own check stays ungraded.
 *
 * - **A flop pair across depths.** `analysis/9` places both flop players on
 *   the set nearest the pair's effective stack when their own lookups land
 *   on sets of different depths, but re-judged the deeper player's depth on
 *   that set against their own deepest opponent (often a third player who
 *   folded later) and so refused the pair. Judged at the pair's stack now.
 *
 * The first two are checked against the same game written the plain way:
 * the options and grade of the hero's decision must be the same.
 */

import { describe, expect, it } from "vitest";

import { analyzeHand, chartLineOf, gradeRank, type DecisionAnalysis, type HandAnalysis } from "../../web/src/lib/analysis/index.js";
import { liveNames, postedLimp, preflopSpotFromHand } from "../../web/src/lib/charts/index.js";
import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import { buildContext } from "../../web/src/lib/stats/context.js";
import type { PhfAction, PhfHand, Position } from "../../web/src/lib/phf/types.js";
import { fullLibrary } from "./charts/support.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";
const CHARTS = fullLibrary();

let n = 0;
/** A hand at $0.5/$1, the button on seat 1; `seats` are `[seat number, name, stack in dollars (100)]`. */
function hand(opts: { seats: [number, string, number?][]; hero: string; cards: string; posts: string[]; lines: string[]; winner: string; pot: number }): PhfHand {
  n += 1;
  const text = [
    `Poker Hand #DB${n}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    `Table 'Db' 6-max Seat #1 is the button`,
    ...opts.seats.map(([seat, name, stack]) => `Seat ${seat}: ${name} ($${stack ?? 100} in chips)`),
    ...opts.posts,
    "*** HOLE CARDS ***",
    `Dealt to ${opts.hero} [${opts.cards}]`,
    ...opts.lines,
    `${opts.winner} collected $${opts.pot} from pot`,
    "*** SUMMARY ***",
    `Total pot $${opts.pot} ${FEES}`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

const BLINDS = ["Sb: posts small blind $0.5", "Bb: posts big blind $1"];
const pre = (analysis: HandAnalysis): DecisionAnalysis => analysis.decisions.filter((d) => d.street === "preflop")[0];
const analyse = (h: PhfHand) => analyzeHand(h, { charts: CHARTS, equity: false });

/** The parts of a chart grade that must not depend on how the game was written. */
const graded = (d: DecisionAnalysis) => ({ status: d.status, reason: d.reason, options: d.options, chosen: d.chosen, grade: d.grade, evLoss: d.evLoss, line: d.facts.chart?.line, set: d.facts.chart?.set });

describe("liveNames", () => {
  it("maps a dead button's names onto the live ring of the same size", () => {
    expect(liveNames(["SB", "BB", "CO"])).toEqual(new Map<Position, Position>([["SB", "SB"], ["BB", "BB"], ["CO", "BTN"]]));
    expect(liveNames(["CO", "SB", "BB", "UTG", "HJ"])?.get("CO")).toBe("BTN");
    expect(liveNames(["CO", "SB", "BB", "UTG", "HJ"])?.get("HJ")).toBe("CO");
    expect(liveNames(["SB", "BB", "UTG", "LJ", "HJ", "CO"])?.get("LJ")).toBe("HJ");
    expect(liveNames(["SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"])?.get("UTG+1")).toBe("LJ");
  });
  it("leaves a live button, heads-up and any other set of names alone", () => {
    expect(liveNames(["SB", "BB", "BTN"])).toBeNull();
    expect(liveNames(["SB", "BB", "UTG", "HJ", "CO", "BTN"])).toBeNull();
    expect(liveNames(["SB", "BB"])).toBeNull();
    expect(liveNames(["SB", "BB", "HJ"])).toBeNull();
  });
});

describe("a dead button", () => {
  // Five players, the button seat (1) empty: SB, BB, UTG, HJ, CO by the parser's names.
  const dead = (cards: string, action: string) =>
    hand({
      seats: [[2, "Sb"], [3, "Bb"], [4, "Utg"], [5, "Hj"], [6, "Co"]],
      hero: "Co",
      cards,
      posts: BLINDS,
      lines: ["Utg: folds", "Hj: folds", action, "Sb: folds", "Bb: folds"],
      winner: "Co",
      pot: 1.5,
    });
  // The same game with a live button: five players, the cutoff seat empty, the hero on the button.
  const live = (cards: string, action: string) =>
    hand({
      seats: [[1, "Co"], [2, "Sb"], [3, "Bb"], [4, "Utg"], [5, "Hj"]],
      hero: "Co",
      cards,
      posts: BLINDS,
      lines: ["Utg: folds", "Hj: folds", action, "Sb: folds", "Bb: folds"],
      winner: "Co",
      pot: 1.5,
    });

  it("is named without a button by the parser, and was refused before analysis/24", () => {
    const h = dead("Ah Kd", "Co: raises $1.5 to $2.5");
    expect(h.players.map((p) => p.position).sort()).toEqual(["BB", "CO", "HJ", "SB", "UTG"]);
    const found = preflopSpotFromHand(h);
    expect(found.ok && found.spot.deadButton).toBe(true);
    expect(found.ok && found.spot.hero).toBe("BTN");
  });

  it("grades the cutoff exactly as the button of the same five-handed game", () => {
    for (const [cards, action] of [
      ["Ah Kd", "Co: raises $1.5 to $2.5"],
      ["7h 2d", "Co: folds"],
      ["9h 8h", "Co: raises $1.5 to $2.5"],
    ] as const) {
      const a = pre(analyse(dead(cards, action)));
      const b = pre(analyse(live(cards, action)));
      expect(a.status).toBe("analysed");
      expect(graded(a)).toEqual(graded(b));
      expect(a.approximations).toContain("dead-button");
      expect(b.approximations).not.toContain("dead-button");
      expect(a.approximations.filter((x) => x !== "dead-button")).toEqual(b.approximations);
    }
  });
});

describe("a poster's check", () => {
  const SIX: [number, string][] = [[1, "Btn"], [2, "Sb"], [3, "Bb"], [4, "Utg"], [5, "Hj"], [6, "Co"]];
  // The cutoff posts a big blind to sit in and checks; the hero in the small blind acts.
  const posted = (cards: string, action: string) =>
    hand({
      seats: SIX,
      hero: "Sb",
      cards,
      posts: [...BLINDS, "Co: posts big blind $1"],
      lines: ["Utg: folds", "Hj: folds", "Co: checks", "Btn: folds", action, "Bb: checks"],
      winner: "Bb",
      pot: 3,
    });
  // The same game, the cutoff limping.
  const limped = (cards: string, action: string) =>
    hand({
      seats: SIX,
      hero: "Sb",
      cards,
      posts: BLINDS,
      lines: ["Utg: folds", "Hj: folds", "Co: calls $1", "Btn: folds", action, "Bb: checks"],
      winner: "Bb",
      pot: 3,
    });

  it("reads only a live one-big-blind post, checked, from a seat other than the blinds", () => {
    const action = (type: string, streetTotal: number) => ({ type, streetTotal }) as PhfAction;
    expect(postedLimp(action("check", 100), "CO", 100, 100)).toBe(true);
    expect(postedLimp(action("check", 100), "CO", 150, 100)).toBe(false); // a dead small blind with it
    expect(postedLimp(action("check", 100), "BB", 100, 100)).toBe(false);
    expect(postedLimp(action("check", 100), "CO", 0, 100)).toBe(false);
    expect(postedLimp(action("fold", 0), "CO", 100, 100)).toBe(false);
  });

  it("grades the small blind as against a limp, with posted-blind, no worse than Inaccurate", () => {
    for (const [cards, action] of [
      ["Ah Kd", "Sb: raises $4 to $5"],
      ["7h 2d", "Sb: folds"],
      ["Ah Ad", "Sb: folds"],
    ] as const) {
      const poster = pre(analyse(posted(cards, action)));
      const limp = pre(analyse(limped(cards, action)));
      expect(poster.status).toBe("analysed");
      const { grade: posterGrade, ...posterRest } = graded(poster);
      const { grade: limpGrade, ...limpRest } = graded(limp);
      expect(posterRest).toEqual(limpRest);
      expect(posterGrade).toBe(gradeRank(limpGrade!) > gradeRank("inaccurate") ? "inaccurate" : limpGrade);
      expect(poster.approximations).toContain("posted-blind");
      expect(poster.approximations).toContain("limp-tremble");
      expect(poster.approximations.filter((x) => x !== "posted-blind")).toEqual(limp.approximations);
    }
    // Folding aces to a limp is a Blunder against a limper, capped against a poster.
    expect(gradeRank(pre(analyse(limped("Ah Ad", "Sb: folds"))).grade!)).toBeGreaterThan(gradeRank("inaccurate"));
    expect(pre(analyse(posted("Ah Ad", "Sb: folds"))).grade).toBe("inaccurate");
  });

  it("leaves the poster's own check ungraded", () => {
    const h = hand({
      seats: SIX,
      hero: "Co",
      cards: "Ah Kd",
      posts: [...BLINDS, "Co: posts big blind $1"],
      lines: ["Utg: folds", "Hj: folds", "Co: checks", "Btn: folds", "Sb: folds", "Bb: checks"],
      winner: "Bb",
      pot: 2.5,
    });
    const d = pre(analyse(h));
    expect(d.status).toBe("not-analysed");
    expect(d.approximations).not.toContain("posted-blind");
  });
});

describe("a flop pair across depths", () => {
  // The cutoff opens with 150bb, the button (200bb) folds, the big blind calls:
  // the cutoff's own lookup reads 150bb (against the button), the big blind's 100bb.
  const pair = (bb: number) =>
    hand({
      seats: [[1, "Btn", 200], [2, "Sb", 100], [3, "Bb", bb], [4, "Utg", 100], [5, "Hj", 100], [6, "Co", 150]],
      hero: "Bb",
      cards: "9h 8h",
      posts: BLINDS,
      lines: ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: folds", "Sb: folds", "Bb: calls $1.5", "*** FLOP *** [Ks 7d 2c]", "Bb: checks", "Co: checks"],
      winner: "Co",
      pot: 5.5,
    });
  const seatsOf = (h: PhfHand) => {
    const context = buildContext(structuredClone(h));
    return context.dealtInSeats.filter((s) => context.foldedOn.get(s) !== "preflop");
  };

  it("places both on the set nearest the pair's effective stack", () => {
    const h = pair(100);
    const placed = chartLineOf(h, seatsOf(h), CHARTS);
    expect(placed?.set.id).toBe("nlhe-cash-6max-100bb");
    expect(placed?.line).toBe("ffrffc");
  });

  it("places a shorter pair on the shorter player's own set", () => {
    // The shorter player's own lookup is at the pair's stack, so its set is always within 20% of it.
    const h = pair(70);
    expect(chartLineOf(h, seatsOf(h), CHARTS)?.set.id).toBe("nlhe-cash-6max-60bb");
  });
});
