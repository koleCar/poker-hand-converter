/**
 * The study plan (phase A8b, `docs/ANALYSIS-PLAN.md` §7,
 * `frontend/src/lib/training/plan.ts`).
 *
 * The database keeps plans and counts progress
 * (`20270215090000_analysis_study_plan.sql`, pinned by pgTAP); everything
 * that decides what a week's plan *is* — which areas, which tasks, what
 * carries over, what a retrospective may claim — is asserted here on
 * hand-built leak rows, so every number can be checked by hand. The trainer
 * filters the plan links to (`vs` preflop, `role` on the river) are dealt on
 * the real chart set.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { periodWindows, rateZ, type SpotRow } from "../../frontend/src/lib/analysis/leaks.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { CONCEPT_IDS } from "../../frontend/src/lib/learn/concepts.js";
import {
  FUNDAMENTAL_CONCEPTS,
  MAX_DRILL_TARGET,
  MIN_PLAN_MOVES,
  TRAIN_TARGET,
  addWeeks,
  areaSet,
  areaChange,
  daysLeft,
  dealPreflop,
  focusAreas,
  fundamentalsTasks,
  generateRiverSpot,
  lineAggressor,
  localDate,
  parseFocus,
  parseTrainerRef,
  pickFocus,
  planFocus,
  planProgress,
  planTasks,
  retroWindows,
  riverSeatings,
  rpcTask,
  trainerMatch,
  trainerNodes,
  trainerRef,
  trainerTarget,
  weekBounds,
  weekStart,
  withReviews,
  type PreviousPlan,
} from "../../frontend/src/lib/training/index.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

/** A finest row; the key is built the way `analysis_spot_key` builds it. */
function row(
  street: string,
  scenario: string,
  line: string,
  position: string,
  taken: string,
  best: string,
  decisions: number,
  evLossBb = 0,
  nonPerfect = taken === best ? 0 : decisions,
): SpotRow {
  return {
    key: [street, scenario, line, position, taken, best].join("|"),
    street,
    scenario,
    line,
    position,
    taken,
    best,
    decisions,
    hands: decisions,
    nonPerfect,
    mistakes: nonPerfect,
    evLossBb,
    evLossPot: 0,
    scoreSum: 100 * (decisions - nonPerfect),
    scoreSq: 10000 * (decisions - nonPerfect),
  };
}

/**
 * The sample every test below reads:
 *
 * - river, preflop raiser out of position first to act, BTN: checks where the
 *   reference bets (6, 10 bb), bets where it checks (3, 4 bb), 20 right bets —
 *   one area of two leaks, 29 decisions, 9 mistakes: medium;
 * - BB against the BTN open: one fold where the reference calls (12 bb, the
 *   AA fold), 45 right folds — 46 decisions, 1 mistake: low, and too thin to
 *   be a focus even as a tentative one;
 * - SB first in: 25 raises where the reference limps (5 bb), 30 right — high;
 * - BB against the CO open: 3 folds where it calls (2 bb) in 5 decisions —
 *   merged up as "the other spots", low, 3 mistakes: a tentative focus.
 */
const ROWS: SpotRow[] = [
  row("river", "pfr-oop-first", "", "BTN", "check", "bet", 6, 10),
  row("river", "pfr-oop-first", "", "BTN", "bet", "check", 3, 4),
  row("river", "pfr-oop-first", "", "BTN", "bet", "bet", 20),
  row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 1, 12),
  row("preflop", "vs-open", "fffrf", "BB", "fold", "fold", 45),
  row("preflop", "unopened", "ffff", "SB", "raise", "call", 25, 5),
  row("preflop", "unopened", "ffff", "SB", "call", "call", 30),
  row("preflop", "vs-open", "ffrff", "BB", "fold", "call", 3, 2),
  row("preflop", "vs-open", "ffrff", "BB", "call", "call", 2),
];
const HANDS = 200;
const RIVER_AREA = "river~pfr-oop-first~first~BTN~-";
const SB_AREA = "preflop~unopened~first-in~SB~-";

describe("weeks", () => {
  it("names a week by its local Monday", () => {
    expect(weekStart(new Date(2026, 9, 2, 15, 0))).toBe("2026-09-28"); // a Friday
    expect(weekStart(new Date(2026, 9, 4, 23, 59))).toBe("2026-09-28"); // the Sunday after
    expect(weekStart(new Date(2026, 8, 28, 0, 0))).toBe("2026-09-28"); // the Monday itself
    expect(weekStart(new Date(2027, 0, 1))).toBe("2026-12-28"); // across the new year
  });

  it("steps by weeks and bounds a week at local midnights", () => {
    expect(addWeeks("2026-09-28", 1)).toBe("2026-10-05");
    expect(addWeeks("2026-09-28", -1)).toBe("2026-09-21");
    expect(addWeeks("2026-12-28", 1)).toBe("2027-01-04");
    const bounds = weekBounds("2026-09-28");
    expect(bounds.from).toBe(localDate("2026-09-28").toISOString());
    expect(bounds.to).toBe(localDate("2026-10-05").toISOString());
    expect(daysLeft("2026-09-28", new Date(2026, 8, 28, 9))).toBe(7);
    expect(daysLeft("2026-09-28", new Date(2026, 9, 4, 22))).toBe(1);
  });
});

describe("focus areas", () => {
  const areas = focusAreas(ROWS, HANDS);

  it("gathers a situation's leaks into one area and sums them", () => {
    const river = areas.find((area) => area.id === RIVER_AREA)!;
    expect(river.leaks.map((leak) => `${leak.taken}>${leak.best}`)).toEqual(["check>bet", "bet>check"]);
    expect(river).toMatchObject({ evLossBb: 14, per100: 7, spotDecisions: 29, mistakes: 9, confidence: "medium" });
    expect(river.keys).toEqual(["river|pfr-oop-first||BTN|bet|check", "river|pfr-oop-first||BTN|check|bet"]);
    expect(river.concepts).toEqual(["thin-value", "bet-sizing"]);
  });

  it("ranks areas by EV lost, the same order as EV lost per 100 hands", () => {
    expect(areas.map((area) => area.evLossBb)).toEqual([14, 12, 5, 2]);
    const per100 = areas.map((area) => area.per100);
    expect(per100).toEqual([...per100].sort((a, b) => b - a));
  });

  it("takes confident areas first and fills with thin ones only when they have two mistakes, labelled", () => {
    const picked = pickFocus(areas);
    expect(picked.map((area) => [area.id, area.confidence, area.tentative])).toEqual([
      [RIVER_AREA, "medium", false],
      [SB_AREA, "high", false],
      ["preflop~*~*~*~*", "low", true],
    ]);
    // The one-hand AA fold (12 bb, low confidence, one mistake) is not a week's focus.
    expect(picked.some((area) => area.where.villain === "BTN")).toBe(false);
    expect(pickFocus(areas, 1).map((area) => area.id)).toEqual([RIVER_AREA]);
  });

  it("is deterministic in the order of its rows", () => {
    expect(focusAreas([...ROWS].reverse(), HANDS)).toEqual(areas);
  });

  it("links every area to concept pages that exist", () => {
    for (const area of areas) for (const concept of area.concepts) expect(CONCEPT_IDS).toContain(concept);
    for (const concept of FUNDAMENTAL_CONCEPTS) expect(CONCEPT_IDS).toContain(concept);
  });
});

describe("trainer targets", () => {
  it("maps a preflop spot to the chart family, seat and raiser", () => {
    const where = (scenario: string, family: string, hero: string, villain: string) => ({ street: "preflop", scenario, family, hero, villain });
    expect(trainerTarget(where("vs-open", "vs-raise", "BTN", "CO"))).toEqual({ mode: "preflop", family: "vs-open", seat: "BTN", vs: "CO" });
    expect(trainerTarget(where("vs-open", "vs-raise", "BB", "SB"))).toEqual({ mode: "preflop", family: "bvb", seat: "BB", vs: "SB" });
    expect(trainerTarget(where("unopened", "first-in", "SB", "-"))).toEqual({ mode: "preflop", family: "rfi", seat: "SB", vs: null });
    expect(trainerTarget(where("vs-3bet-cold", "vs-reraise", "*", "*"))).toEqual({ mode: "preflop", family: "vs-3bet", seat: null, vs: null });
    expect(trainerTarget(where("*", "vs-raise", "*", "*"))).toEqual({ mode: "preflop", family: "vs-open", seat: null, vs: null });
    expect(trainerTarget(where("*", "*", "*", "*"))).toEqual({ mode: "preflop", family: "random", seat: null, vs: null });
  });

  it("maps a river spot to the role and side, and has no trainer for the flop or turn yet", () => {
    const where = (street: string, scenario: string) => ({ street, scenario, family: "first", hero: "BTN", villain: "-" });
    expect(trainerTarget(where("river", "pfr-oop-first"))).toEqual({ mode: "river", pot: "any", side: "oop", role: "pfr" });
    expect(trainerTarget(where("river", "limped-ip-vs-bet"))).toEqual({ mode: "river", pot: "limped", side: "ip", role: "any" });
    expect(trainerTarget(where("river", "*"))).toEqual({ mode: "river", pot: "any", side: "any", role: "any" });
    // Only the trainer's in-position hero faces a bet: a spot facing one is practised there.
    expect(trainerTarget(where("river", "caller-oop-vs-bet"))).toEqual({ mode: "river", pot: "any", side: "ip", role: "caller" });
    expect(trainerTarget({ street: "river", scenario: "*", family: "vs-bet", hero: "*", villain: "*" })).toEqual({
      mode: "river",
      pot: "any",
      side: "ip",
      role: "any",
    });
    expect(trainerTarget(where("turn", "pfr-oop-first"))).toBeNull();
    expect(trainerTarget(where("flop", "caller-ip-vs-bet"))).toBeNull();
  });

  it("counts river answers by the (line, seat) pairs a role and side allow", () => {
    const match = trainerMatch({ mode: "river", pot: "any", side: "oop", role: "pfr" });
    expect(match.spots).toEqual(["btn-bb-3bet:BB", "btn-sb-3bet:SB", "co-bb-3bet:BB", "sb-bb:SB"]);
    for (const seating of riverSeatings({ seat: "oop", role: "pfr" })) {
      expect(seating.seat).toBe("oop");
      expect(lineAggressor(seating.line.line)).toBe(seating.hero);
    }
    expect(trainerMatch({ mode: "river", pot: "any", side: "any", role: "any" }).spots).toBeNull();
    expect(trainerMatch({ mode: "preflop", family: "vs-open", seat: "BTN", vs: "CO" })).toEqual({
      mode: "preflop",
      family: "vs-open",
      position: "BTN",
      spots: null,
    });
  });

  it("writes references the database accepts", () => {
    const shape = /^(preflop|river)(\/[A-Za-z0-9+-]{1,20}){0,5}$/;
    expect(trainerRef({ mode: "preflop", family: "vs-open", seat: "BTN", vs: "CO" })).toBe("preflop/vs-open/BTN/vs-CO");
    expect(trainerRef({ mode: "preflop", family: "rfi", seat: null, vs: null })).toBe("preflop/rfi/any");
    expect(trainerRef({ mode: "river", pot: "any", side: "oop", role: "pfr" })).toBe("river/any/oop/pfr");
    for (const area of focusAreas(ROWS, HANDS)) {
      if (area.trainer) expect(trainerRef(area.trainer)).toMatch(shape);
      expect(area.id).toMatch(/^[A-Za-z0-9*~+-]{1,120}$/);
    }
  });

  it("reads a reference back as its target, and nothing else", () => {
    const targets = [
      { mode: "preflop", family: "vs-open", seat: "BTN", vs: "CO" },
      { mode: "preflop", family: "random", seat: null, vs: null },
      { mode: "river", pot: "3bp", side: "oop", role: "pfr" },
      { mode: "river", pot: "any", side: "any", role: "any" },
    ] as const;
    for (const target of targets) expect(parseTrainerRef(trainerRef(target))).toEqual(target);
    for (const junk of ["", "preflop", "preflop/moon/BTN", "preflop/rfi/XX", "preflop/vs-open/BTN/CO", "river/srp/ip", "river/srp/up/pfr"]) {
      expect(parseTrainerRef(junk)).toBeNull();
    }
  });

  it("practises an area on the set it was met on most, and names 9-max seats (A2d)", () => {
    expect(areaSet([{ sets: { "nlhe-cash-9max-100bb": 3, "nlhe-cash-6max-100bb": 2 } }, { sets: { "nlhe-cash-6max-100bb": 2 } }])).toBe(
      "nlhe-cash-6max-100bb",
    );
    expect(areaSet([{ sets: { "nlhe-cash-9max-150bb": 2, "nlhe-cash-9max-100bb": 2 } }])).toBe("nlhe-cash-9max-100bb");
    expect(areaSet([{ sets: {} }])).toBeNull();
    const where = { street: "preflop", scenario: "unopened", family: "first-in", hero: "UTG+1", villain: "-", table: "9max" };
    const target = trainerTarget(where, "nlhe-cash-9max-150bb");
    expect(target).toEqual({ mode: "preflop", family: "rfi", seat: "UTG+1", vs: null, set: "nlhe-cash-9max-150bb" });
    expect(trainerRef(target!)).toBe("preflop/rfi/UTG+1/nlhe-cash-9max-150bb");
    expect(trainerRef(target!)).toMatch(/^(preflop|river)(\/[A-Za-z0-9+-]{1,20}){0,5}$/);
    expect(parseTrainerRef(trainerRef(target!))).toEqual(target);
    const vs = { mode: "preflop", family: "vs-open", seat: "LJ", vs: "UTG+2", set: "nlhe-cash-9max-100bb" } as const;
    expect(parseTrainerRef(trainerRef(vs))).toEqual(vs);
    expect(parseTrainerRef("preflop/rfi/UTG/nlhe-cash-9max-100bb/vs-CO")).toBeNull();
    // A set the trainer does not know is left out, not passed on.
    expect(trainerTarget(where, "something-else")).toEqual({ mode: "preflop", family: "rfi", seat: "UTG+1", vs: null });
  });

  it("practises facing limpers on the limped-pot trainer (A2d)", () => {
    const where = (scenario: string, hero: string, villain: string) => ({ street: "preflop", scenario, family: "first-in", hero, villain });
    expect(trainerTarget(where("vs-limp", "BTN", "UTG"))).toEqual({ mode: "preflop", family: "vs-limp", seat: "BTN", vs: "UTG" });
    expect(trainerTarget(where("bb-option", "BB", "CO"))).toEqual({ mode: "preflop", family: "vs-limp", seat: "BB", vs: "CO" });
    // Behind the small blind's completion alone it is still blind vs blind.
    expect(trainerTarget(where("bb-option", "BB", "-"))).toEqual({ mode: "preflop", family: "bvb", seat: "BB", vs: null });
  });

  it("deals preflop spots against the raiser asked for, and drops a filter the charts cannot deal", () => {
    const nodes = trainerNodes(CHARTS, "vs-open", "BTN", "CO");
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.actor).toBe("BTN");
      expect(lineAggressor(node.line)).toBe("CO");
    }
    for (let seed = 1; seed <= 5; seed += 1) {
      const spot = dealPreflop(CHARTS, { family: "vs-open", seat: "BTN", vs: "CO" }, seed)!;
      expect(spot.hero).toBe("BTN");
      expect(lineAggressor(spot.line)).toBe("CO");
    }
    // Nobody opens before UTG: the filter is dropped, the family and seat kept.
    expect(trainerNodes(CHARTS, "vs-open", "HJ", "BB")).toHaveLength(0);
    const fallback = dealPreflop(CHARTS, { family: "vs-open", seat: "HJ", vs: "BB" }, 7)!;
    expect(fallback.hero).toBe("HJ");
    expect(fallback.family).toBe("vs-open");
  });

  it("deals river spots in the role asked for, each one counted by the plan's filter", () => {
    const match = trainerMatch({ mode: "river", pot: "any", side: "oop", role: "pfr" });
    for (let seed = 11; seed <= 13; seed += 1) {
      const spot = generateRiverSpot(CHARTS, { role: "pfr", seat: "oop" }, seed);
      expect(spot).not.toBeNull();
      expect(spot!.seat).toBe("oop");
      expect(match.spots).toContain(`${spot!.lineId}:${spot!.hero}`);
    }
  });
});

describe("the week's plan", () => {
  const focus = planFocus({ rows: ROWS, hands: HANDS, graded: 132 });
  const drills = new Map([
    ["river|pfr-oop-first||BTN|check|bet", { items: 3, due: 2 }],
    ["river|pfr-oop-first||BTN|bet|check", { items: 1, due: 0 }],
    ["preflop|unopened|ffff|SB|raise|call", { items: 25, due: 20 }],
  ]);
  const tasks = planTasks({
    areas: focus.areas,
    hands: { [RIVER_AREA]: ["h1", "h2", "h3", "h4"], [SB_AREA]: ["h2", "h5"] },
    drills,
  });

  it("is a leaks plan with three areas, new this week", () => {
    expect(focus).toMatchObject({ kind: "leaks", reason: null });
    expect(focus.areas.map((area) => area.weeks)).toEqual([1, 1, 1]);
  });

  it("gives each area its concepts, a trainer session, its due drills and its hands", () => {
    expect(tasks.map((task) => `${task.focus}:${task.kind}:${task.ref}:${task.target}`)).toEqual([
      "0:read:thin-value:1",
      "0:read:bet-sizing:1",
      `0:train:river/any/oop/pfr:${TRAIN_TARGET.river}`,
      `0:drill:${RIVER_AREA}:2`,
      "0:review:h1:1",
      "0:review:h2:1",
      "0:review:h3:1",
      "1:read:steal:1",
      `1:train:preflop/rfi/SB:${TRAIN_TARGET.preflop}`,
      `1:drill:${SB_AREA}:${MAX_DRILL_TARGET}`,
      "1:review:h5:1",
      "2:read:rfi:1",
      "2:read:position:1",
      `2:train:preflop/random/any:${TRAIN_TARGET.preflop}`,
    ]);
  });

  it("snapshots each area's review hands in task order, a hand it cannot describe kept bare", () => {
    const known = new Map([["h2", { handId: "h2", cards: ["Ah", "Kd"], handClass: "AKo", position: "BTN", evLossBb: 4.2, playedAt: null }]]);
    const areas = withReviews(focus.areas, tasks, known);
    expect(areas[0].reviews.map((hand) => [hand.handId, hand.handClass])).toEqual([
      ["h1", null],
      ["h2", "AKo"],
      ["h3", null],
    ]);
    expect(areas[1].reviews.map((hand) => hand.handId)).toEqual(["h5"]);
    expect(areas[2].reviews).toEqual([]);
  });

  it("writes tasks in the shape save_study_plan takes", () => {
    expect(rpcTask(tasks[2])).toEqual({
      kind: "train",
      ref: "river/any/oop/pfr",
      target: TRAIN_TARGET.river,
      focus: 0,
      hand_id: null,
      match_mode: "river",
      match_family: null,
      match_position: null,
      match_spots: ["btn-bb-3bet:BB", "btn-sb-3bet:SB", "co-bb-3bet:BB", "sb-bb:SB"],
      spot_keys: null,
    });
    expect(rpcTask(tasks[3]).spot_keys).toEqual(focus.areas[0].keys);
    expect(rpcTask(tasks[4])).toMatchObject({ kind: "review", ref: "h1", hand_id: "h1", match_mode: null, spot_keys: null });
  });

  it("rolls over: weeks in focus count up, read concepts and reviewed hands are not asked again, open hands carry", () => {
    const previous: PreviousPlan = {
      focus: [{ id: RIVER_AREA, weeks: 2 }],
      tasks: [
        { kind: "read", ref: "thin-value", focus: 0, done: true },
        { kind: "read", ref: "bet-sizing", focus: 0, done: false },
        { kind: "review", ref: "h1", focus: 0, done: true },
        { kind: "review", ref: "h9", focus: 0, done: false },
      ],
    };
    const next = planFocus({ rows: ROWS, hands: HANDS, graded: 132, previous });
    expect(next.areas.map((area) => area.weeks)).toEqual([3, 1, 1]);
    const rolled = planTasks({ areas: next.areas, hands: { [RIVER_AREA]: ["h1", "h2", "h3", "h4"] }, drills, previous });
    expect(rolled.filter((task) => task.focus === 0 && (task.kind === "read" || task.kind === "review")).map((task) => task.ref)).toEqual([
      "bet-sizing",
      "h9",
      "h2",
      "h3",
    ]);
  });

  it("falls back to the fundamentals when the sample cannot carry a plan", () => {
    expect(planFocus({ rows: [], hands: 0, graded: 0 })).toEqual({ kind: "fundamentals", areas: [], reason: "none" });
    expect(planFocus({ rows: ROWS, hands: HANDS, graded: MIN_PLAN_MOVES - 1 })).toMatchObject({ reason: "few" });
    const clean = [row("preflop", "unopened", "ffff", "SB", "call", "call", 80)];
    expect(planFocus({ rows: clean, hands: 80, graded: 80 })).toMatchObject({ kind: "fundamentals", reason: "no-leaks" });

    const basics = fundamentalsTasks(0);
    expect(basics.map((task) => `${task.kind}:${task.ref}`)).toEqual([
      "read:position",
      "read:rfi",
      "read:pot-odds",
      "train:preflop/rfi/any",
      "train:preflop/vs-open/BB",
      "train:river/any/any/any",
    ]);
    expect(basics.every((task) => task.focus === null)).toBe(true);
    expect(fundamentalsTasks(40).at(-1)).toMatchObject({ kind: "drill", ref: "all", target: MAX_DRILL_TARGET, spotKeys: null });
    const after = fundamentalsTasks(0, { focus: [], tasks: [{ kind: "read", ref: "position", focus: null, done: true }] });
    expect(after.filter((task) => task.kind === "read").map((task) => task.ref)).toEqual(["rfi", "pot-odds"]);
  });

  it("puts the lesson for a leak first in its area (Learn L1), once, and in the fundamentals when given", () => {
    const withLessons = planTasks({
      areas: focus.areas,
      hands: { [RIVER_AREA]: ["h1", "h2", "h3", "h4"], [SB_AREA]: ["h2", "h5"] },
      drills,
      lessonFor: (area) => (area.where.street === "preflop" ? "positions-and-opening-ranges" : null),
    });
    const lessons = withLessons.filter((task) => task.kind === "lesson");
    expect(lessons.map((task) => `${task.focus}:${task.ref}:${task.target}`)).toEqual(["1:positions-and-opening-ranges:1"]);
    expect(withLessons.filter((task) => task.focus === 1)[0].kind).toBe("lesson");
    expect(rpcTask(lessons[0])).toMatchObject({ kind: "lesson", ref: "positions-and-opening-ranges", hand_id: null, match_mode: null, spot_keys: null });
    // Without a resolver the plan is exactly what it was.
    expect(withLessons.filter((task) => task.kind !== "lesson")).toEqual(tasks);
    const basics = fundamentalsTasks(0, null, "pot-odds");
    expect(basics[0]).toEqual({ kind: "lesson", ref: "pot-odds", target: 1, focus: null });
    expect(basics.slice(1)).toEqual(fundamentalsTasks(0));
  });

  it("measures progress by tasks done, and partly done ones by their share", () => {
    const progress = planProgress([
      { kind: "read", focus: 0, done: true, progress: 1, target: 1 },
      { kind: "train", focus: 0, done: false, progress: 5, target: 10 },
      { kind: "review", focus: 1, done: false, progress: 0, target: 1 },
      { kind: "drill", focus: null, done: true, progress: 3, target: 3 },
    ]);
    expect(progress).toMatchObject({ done: 2, total: 4, share: 2.5 / 4 });
    expect(progress.byFocus.get(0)).toEqual({ done: 1, total: 2 });
    expect(progress.byFocus.get(null)).toEqual({ done: 1, total: 1 });
    expect(planProgress([]).share).toBe(0);
  });

  it("reads a stored snapshot back as it was written, and drops what it does not know", () => {
    const stored = JSON.parse(JSON.stringify(focus.areas));
    expect(parseFocus(stored)).toEqual(focus.areas);
    expect(parseFocus("nope")).toEqual([]);
    const tampered = parseFocus([{ ...stored[0], keys: ["<script>", stored[0].keys[0]], where: { ...stored[0].where, street: "moon" } }, stored[1]]);
    expect(tampered.map((area) => area.id)).toEqual([SB_AREA]);
    expect(parseFocus([{ ...stored[0], keys: ["<script>", stored[0].keys[0]] }])[0].keys).toEqual([stored[0].keys[0]]);
  });
});

describe("the retrospective", () => {
  const area = focusAreas(ROWS, HANDS).find((a) => a.id === RIVER_AREA)!;

  it("compares an area's mistake rate in its spot with A6's test, and EV lost per 100 hands", () => {
    const prior = { rows: ROWS, hands: HANDS };
    const current = {
      rows: [
        row("river", "pfr-oop-first", "", "BTN", "check", "bet", 1, 1.5),
        row("river", "pfr-oop-first", "", "BTN", "bet", "bet", 30),
      ],
      hands: 150,
    };
    const change = areaChange(area, current, prior);
    expect(change.current).toMatchObject({ spot: 31, mistakes: 1, evLossBb: 1.5, per100: 1 });
    expect(change.prior).toMatchObject({ spot: 29, mistakes: 9, evLossBb: 14, per100: 7 });
    expect(change.z).toBeCloseTo(rateZ(1, 31, 9, 29)!, 10);
    expect(change.trend).toBe("better");
  });

  it("says too few rather than guessing on a thin period", () => {
    const thin = { rows: [row("river", "pfr-oop-first", "", "BTN", "bet", "bet", 4)], hands: 4 };
    expect(areaChange(area, thin, { rows: ROWS, hands: HANDS }).trend).toBe("too-few");
    const none = areaChange(area, { rows: [], hands: 0 }, { rows: ROWS, hands: HANDS });
    expect(none.current).toMatchObject({ spot: 0, per100: null, rate: null });
    expect(none.trend).toBe("too-few");
  });

  it("compares last week's plan week when hands were played in it, else A6's last 7 days of play", () => {
    const week = "2026-09-21";
    const inWeek = localDate("2026-09-23").toISOString();
    expect(retroWindows(week, inWeek)).toEqual({
      basis: "plan-week",
      current: weekBounds(week),
      prior: weekBounds("2026-09-14"),
    });
    const february = "2026-02-21T22:04:15.000Z";
    const lastPlay = periodWindows(february, 7);
    expect(retroWindows(week, february)).toEqual({ basis: "last-play", current: lastPlay.current, prior: lastPlay.prior });
    expect(retroWindows(null, february)?.basis).toBe("last-play");
    expect(retroWindows(week, null)).toBeNull();
  });
});
