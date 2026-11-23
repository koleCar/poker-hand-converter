/**
 * The Trainer opened from Analytics (docs/ANALYTICS.md Step 9):
 *
 * 1. **The links.** The drill-down's, a finding's and "Play it"'s queries
 *    (`packages/ui/analytics/view.ts`) read back on both routes (the web's
 *    address, the desktop's `#/trainer/<encoded query>`) as a trainer target
 *    with the size, the classes and where it came from; the target maps onto
 *    the session's settings and the dealer's request, and survives a round
 *    trip through the stored fields.
 * 2. **The deal.** A size bucket and hand classes narrow the deal exactly
 *    as the checker rows read a played decision: the first spot dealt from
 *    the drill-down's "Practise" is in the spot, the size and one of the
 *    classes, checked against the analysis' own facts of that spot.
 * 3. **The goal.** This drill's rate of the stat's action and the
 *    reference's on the same hands, counting with every answer, judged like
 *    the checker; the bar and the panel render it (EN + HR).
 * 4. **Play it.** A played decision dealt once, graded against its stored
 *    options (the move really made keeps its grade).
 */

import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import { analyticsUiEn } from "@rail/ui/strings/analytics.en";
import { analyticsUiHr } from "@rail/ui/strings/analytics.hr";
import { drillQuery, playQuery, practiseQuery } from "@rail/ui/analytics/view";

import { analyzeHand } from "../../web/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../web/src/lib/charts/index.js";
import { cardIndex } from "../../web/src/lib/equity/evaluator.js";
import { ANALYTICS } from "../../web/src/lib/stats/analytics.js";
import type { CheckerFinding } from "../../web/src/lib/stats/checker.js";
import { dealPreflop, generateRiverSpot, preflopAnswer, type RiverSpotOptions } from "../../web/src/lib/training/index.js";
import { facingWeights } from "../../web/src/lib/training/river.js";
import { heroNode, nodeBucket } from "../../web/src/lib/training/flop.js";
import { betBucket, facingBucket, handClassOf, keepClasses } from "../../web/src/lib/training/focusDeal.js";
import { gradeAnswer } from "../../web/src/lib/training/grade.js";
import { answerHand } from "../../web/src/lib/training/jobs.js";
import { seeded } from "../../web/src/lib/training/rng.js";
import type { SolveResult } from "../../web/src/lib/solver/index.js";
import { comboIndex } from "../../web/src/lib/solver/index.js";
import { trainerEn } from "../../web/src/lib/i18n/ns/trainer.en.js";
import { trainerHr } from "../../web/src/lib/i18n/ns/trainer.hr.js";
import { analyticsAction, analyticsLink, analyticsTarget, drillGoal, flopLineOf, sideOf, type GoalAnswer } from "../../web/src/components/trainer/analytics.js";
import { AnalyticsBar, GoalPanel } from "../../web/src/components/trainer/FromAnalytics.js";
import { TrainerHostProvider, type TrainerHost } from "../../web/src/components/trainer/host.js";
import { gradePlayed, playedSpot } from "../../web/src/components/trainer/played.js";
import { answerMix, defaultName, sameTraining, type SessionAnswer } from "../../web/src/components/trainer/sessions.js";
import { DEFAULT_SETTINGS, parseSettings, settingsFields, spotOptions, targetSettings, type TrainerSettings } from "../../web/src/components/trainer/settings.js";
import { analyticsSettings } from "../../web/src/components/trainer/Trainer.js";
import { lockedSummary } from "../../web/src/components/trainer/SessionTrainer.js";
import { initialSettings } from "../../web/src/components/analysis/train/trainerQuery.js";
import { fileOf as chartFile } from "./charts/support.js";

const CHARTS: ChartSet = loadCharts(JSON.parse(readFileSync(chartFile("nlhe-cash-6max-100bb"), "utf8")));

const FOLD = "flop_fold_vs_bet";
const BB_VS_SB = "single-raised|caller|BB|SB";
const FIGURES = { player: 52, target: 31, cost: 1.3, tone: "far" as const };

/** The desktop's route: the query as `#/trainer/<encoded>`, read back by `useRouteParam` (decoded) into `URLSearchParams`. */
function viaDesktop(query: string): URLSearchParams {
  const hash = `#/trainer/${encodeURIComponent(query)}`;
  const param = decodeURIComponent(hash.slice("#/trainer/".length));
  return new URLSearchParams(param);
}

/** The web's route: Next's `searchParams` record. */
function viaWeb(query: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(query).entries());
}

/* ------------------------------------------------------------ links -- */

describe("Analytics links read back (Step 9)", () => {
  const query = drillQuery(FOLD, BB_VS_SB, "20-40", ["middle_pair", "underpair"], FIGURES);

  it("carry the stat, spot, size, classes and the goal's figures", () => {
    const params = new URLSearchParams(query);
    expect(params.get("from")).toBe("analytics");
    expect(params.get("size")).toBe("20-40");
    expect(params.get("classes")).toBe("middle_pair,underpair");
    expect([params.get("you"), params.get("ref"), params.get("cost"), params.get("tone")]).toEqual(["52", "31", "1.3", "far"]);
    // Without figures the query is Step 8's, unchanged.
    expect(drillQuery(FOLD, BB_VS_SB, null, [])).toBe(`from=analytics&stat=${FOLD}&spot=${encodeURIComponent(BB_VS_SB)}`);
  });

  it("read the same on the web's address and the desktop's route parameter", () => {
    const web = analyticsLink(viaWeb(query));
    const desktop = analyticsLink(viaDesktop(query));
    expect(web).not.toBeNull();
    expect(desktop).toEqual(web);
  });

  it("make a flop target on the library line of the two seats, facing a bet of the bucket, from the classes", () => {
    const link = analyticsLink(viaWeb(query))!;
    expect(link.approximate).toBe(false);
    expect(link.play).toBeNull();
    expect(link.target).toMatchObject({
      mode: "flop",
      set: "nlhe-cash-6max-100bb",
      pot: "srp",
      side: "ip",
      role: "caller",
      seat: "BB",
      facing: "bet",
      line: "sb-bb",
      sizes: ["20-40"],
      classes: ["middle_pair", "underpair"],
      from: { stat: FOLD, spot: BB_VS_SB, you: 52, ref: 31, cost: 1.3, tone: "far" },
    });
  });

  it("map onto the session's settings and the dealer's request", () => {
    const settings = analyticsSettings(analyticsLink(viaWeb(query))!, DEFAULT_SETTINGS);
    expect(settings).toMatchObject({ mode: "flop", play: "spot", seat: "BB", line: "sb-bb", facing: "bet", size: "20-40", classes: ["middle_pair", "underpair"] });
    const request = spotOptions("flop", settings);
    expect(request).toEqual({
      kind: "flop",
      options: {
        set: "nlhe-cash-6max-100bb",
        pot: "srp",
        seat: "ip",
        role: "caller",
        facing: "bet",
        hero: "BB",
        line: "sb-bb",
        bias: DEFAULT_SETTINGS.deal,
        size: "20-40",
        classes: ["middle_pair", "underpair"],
      },
    });
  });

  it("survive the stored fields (strings only) and a session continued with newer figures", () => {
    const settings = analyticsSettings(analyticsLink(viaWeb(query))!, DEFAULT_SETTINGS);
    const fields = settingsFields(settings);
    expect(Object.values(fields).every((value) => typeof value === "string")).toBe(true);
    expect(fields.classes).toBe("middle_pair,underpair");
    expect(parseSettings(fields)).toEqual(settings);
    const later = analyticsSettings(analyticsLink(viaWeb(drillQuery(FOLD, BB_VS_SB, "20-40", ["middle_pair", "underpair"], { player: 47, target: 31 })))!, DEFAULT_SETTINGS);
    expect(sameTraining(later, settings)).toBe(true);
    expect(sameTraining({ ...later, size: "40-60" }, settings)).toBe(false);
  });

  it("drop what the catalogue does not know, and refuse what is not a link or not a rate", () => {
    const link = analyticsLink({ from: "analytics", stat: FOLD, spot: BB_VS_SB, size: "10-20", classes: "middle_pair,royal" })!;
    expect(link.target.sizes).toBeUndefined();
    expect(link.target.classes).toEqual(["middle_pair"]);
    expect(analyticsLink({ stat: FOLD })).toBeNull();
    expect(analyticsLink({ from: "analytics", stat: "wtsd" })).toBeNull();
    expect(analyticsLink({ from: "analytics", stat: "nope" })).toBeNull();
    expect(parseSettings({ size: "nope", classes: ["royal"], from: "{bad" })).toMatchObject({ size: null, classes: [], from: null });
  });

  it("a played decision: 'Play it' adds the hand and its decision", () => {
    const example = { handId: "6f1c", ord: 7, actionIndex: 12, spot: BB_VS_SB, size: "20-40", handClass: "underpair" };
    const link = analyticsLink(viaDesktop(playQuery(FOLD, example, FIGURES)))!;
    expect(link.play).toEqual({ hand: "6f1c", ord: 7, action: 12 });
    expect(link.target.classes).toEqual(["underpair"]);
  });

  it("preflop: the chart family, the seat and the raiser", () => {
    const link = analyticsLink({ from: "analytics", stat: "three_bet", spot: "|vs-open|BTN|CO" })!;
    expect(link.target).toMatchObject({ mode: "preflop", family: "vs-open", seat: "BTN", vs: "CO" });
    const settings = analyticsSettings(link, DEFAULT_SETTINGS);
    expect(spotOptions("preflop", settings)).toEqual({ kind: "preflop", options: { set: DEFAULT_SETTINGS.set, family: "vs-open", seat: "BTN", vs: "CO", bias: "borderline" } });
    expect(analyticsLink({ from: "analytics", stat: "rfi", spot: "|unopened|CO|" })!.target).toMatchObject({ family: "rfi", seat: "CO", vs: null });
  });

  it("turn and river: the seats and, out of position, the villain's bet after the hero's check", () => {
    const turn = analyticsLink({ from: "analytics", stat: "turn_fold_vs_bet", spot: "single-raised|caller|BB|BTN", size: "60-85" })!;
    const settings = analyticsSettings(turn, DEFAULT_SETTINGS);
    expect(settings).toMatchObject({ mode: "turn", side: "oop", seat: "BB", vs: "BTN", facing: "bet", size: "60-85" });
    expect(spotOptions("turn", settings).options).toMatchObject({ facing: "check-bet", hero: "BB", villain: "BTN", seat: "oop", size: "60-85" });
    const river = analyticsLink({ from: "analytics", stat: "river_bet", spot: "single-raised|pfr|BTN|BB" })!;
    expect(spotOptions("river", analyticsSettings(river, DEFAULT_SETTINGS)).options).toMatchObject({ facing: "check", hero: "BTN", villain: "BB", seat: "ip" });
  });

  it("a finding's 'Practise this' carries its spot's figures and cost", () => {
    const finding = {
      family: "gives_up",
      lean: "tight",
      tone: "far",
      cost: 2.25,
      stats: [{ id: FOLD, counted: true }],
      lead: FOLD,
      direction: "high",
      why: { stat: FOLD, source: "solver", spot: BB_VS_SB, spotPlayer: 52.04, spotTarget: 31, handClass: "middle_pair", classPlayer: null, classTarget: null, classShare: null, classWorth: null },
    } as CheckerFinding;
    const link = analyticsLink(viaWeb(practiseQuery(finding)))!;
    expect(link.target.from).toEqual({ stat: FOLD, spot: BB_VS_SB, you: 52, ref: 31, cost: 2.25, tone: "far" });
    expect(link.target.classes).toEqual(["middle_pair"]);
  });

  it("deal as near as they can, and say so, where the dealers hold no such spot", () => {
    expect(analyticsTarget(FOLD, "single-raised|caller|BB|multi", null, [], { stat: FOLD, spot: "", you: null, ref: null, cost: null })!.approximate).toBe(true);
    expect(analyticsTarget(FOLD, "bomb|bomb|BB|SB", null, [], { stat: FOLD, spot: "", you: null, ref: null, cost: null })!.approximate).toBe(true);
    expect(flopLineOf("nlhe-cash-6max-100bb", "srp", "BTN", "CO")).toBeNull();
    expect(sideOf("BTN", "BB")).toBe("ip");
    expect(sideOf("SB", "UTG")).toBe("oop");
  });

  it("leave a study plan's or a leak's target without Analytics' narrowing", () => {
    const base: TrainerSettings = { ...DEFAULT_SETTINGS, size: "20-40", classes: ["nothing"] };
    const shaped = targetSettings({ mode: "river", pot: "srp", side: "ip", role: "any" }, base);
    expect(shaped.settings).toMatchObject({ size: null, classes: [], from: null, facing: "any" });
  });

  it("a plain trainer address is unchanged: a link without a mode keeps the stored settings", () => {
    expect(initialSettings(viaWeb(query), null)).toEqual(DEFAULT_SETTINGS);
  });

  it("name and summarise the session with the size and the Hands chip", () => {
    const settings = analyticsSettings(analyticsLink(viaWeb(query))!, DEFAULT_SETTINGS);
    expect(defaultName(settings, trainerEn)).toContain("20–40%");
    expect(analyticsAction(settings)).toBe("fold");
    expect(lockedSummary(settings, trainerEn)).toContain("Hands you tend to fold");
    expect(lockedSummary(settings, trainerEn)).toContain("Facing 20–40% of the pot");
    expect(lockedSummary(settings, trainerHr)).toContain("Ruke koje često foldaš");
  });
});

/* ------------------------------------------------------------- deal -- */

const idx = (codes: string[]) => codes.map(cardIndex);

describe("the deal narrowed by size and hand class (Step 9)", () => {
  it("names hand classes as the checker rows do", () => {
    const board = idx(["Kc", "7s", "2d"]);
    expect(handClassOf(idx(["Ah", "Kd"]), board)).toBe("top_pair_plus");
    expect(handClassOf(idx(["7h", "6h"]), board)).toBe("middle_pair");
    expect(handClassOf(idx(["5h", "5d"]), board)).toBe("middle_pair");
    expect(handClassOf(idx(["Qh", "2h"]), board)).toBe("weak_pair");
    expect(handClassOf(idx(["3h", "3d"]), idx(["Kc", "9s", "5d"]))).toBe("underpair");
    expect(handClassOf(idx(["Ah", "5h"]), idx(["Kh", "9h", "2c"]))).toBe("strong_draw");
    expect(handClassOf(idx(["Ah", "Kd"]), [])).toBeNull();
  });

  it("buckets a bet as facts.facingPot does: the bet over the pot before it", () => {
    expect(facingBucket(13.3, 3.3)).toBe("20-40");
    expect(facingBucket(17.5, 7.5)).toBe("60-85");
    expect(facingBucket(10, 0)).toBeNull();
    expect(betBucket(0.33)).toBe("20-40");
    expect(betBucket(1.25)).toBe("125+");
  });

  it("keeps only the classes' combos", () => {
    const board = idx(["Kc", "7s", "2d"]);
    const hands = Uint16Array.from([comboIndex(cardIndex("Ah"), cardIndex("Kd")), comboIndex(cardIndex("7h"), cardIndex("6h")), comboIndex(cardIndex("Qh"), cardIndex("Jh"))]);
    const kept = keepClasses(Float64Array.from([1, 1, 1]), hands, board, { classes: ["middle_pair", "nothing"] });
    expect([...kept]).toEqual([0, 1, 1]);
    expect([...keepClasses(Float64Array.from([1, 1, 1]), hands, board, {})]).toEqual([1, 1, 1]);
  });

  it("draws only villain bets of the bucket", () => {
    const actions = [
      { kind: "check" as const, sizePot: 0 },
      { kind: "bet" as const, sizePot: 0.33 },
      { kind: "bet" as const, sizePot: 0.75 },
    ];
    expect(facingWeights(actions, [0.5, 0.3, 0.2], "bet", 0.01, "60-85")).toEqual([0, 0, 0.2]);
    expect(facingWeights(actions, [0.5, 0.3, 0.2], "check-bet", 0.01, "20-40")).toEqual([0, 0.3, 0]);
    expect(facingWeights(actions, [0.5, 0.3, 0.2], "bet", 0.01)).toEqual([0, 0.3, 0.2]);
  });

  it("walks the flop tree to a bet of the bucket only", () => {
    // A root (out of position) that checks, bets a third or bets three quarters; the hero (in position) answers.
    const n = 2;
    const node = (over: Record<string, unknown>) => ({ kind: "action", street: "flop", path: "", labels: [], strategy: new Float32Array(3 * n).fill(1 / 3), ...over });
    const result = {
      hands: [Uint16Array.from([0, 1]), Uint16Array.from([2, 3])],
      weights: [Float32Array.from([1, 1]), Float32Array.from([1, 1])],
      nodes: [
        node({ player: 0, parent: -1, parentEdge: -1, pot: 10, toCall: 0, actions: [{ kind: "check" }, { kind: "bet" }, { kind: "bet" }], frequency: [0.5, 0.3, 0.2], children: [1, 2, 3] }),
        node({ player: 1, parent: 0, parentEdge: 0, pot: 10, toCall: 0, actions: [{ kind: "check" }], frequency: [1], children: [-1] }),
        node({ player: 1, parent: 0, parentEdge: 1, pot: 13.3, toCall: 3.3, actions: [{ kind: "fold" }], frequency: [1], children: [-1] }),
        node({ player: 1, parent: 0, parentEdge: 2, pot: 17.5, toCall: 7.5, actions: [{ kind: "fold" }], frequency: [1], children: [-1] }),
      ],
    } as unknown as SolveResult;
    expect([nodeBucket(result, 2), nodeBucket(result, 3)]).toEqual(["20-40", "60-85"]);
    const reached = new Set<number>();
    for (let seed = 1; seed <= 40; seed += 1) {
      expect(heroNode(result, 1, "bet", seeded(seed), "flop", "60-85")?.node).toBe(3);
      expect(heroNode(result, 1, "bet", seeded(seed), "flop", "20-40")?.node).toBe(2);
      reached.add(heroNode(result, 1, "bet", seeded(seed))!.node);
    }
    expect([...reached].sort()).toEqual([2, 3]);
    expect(heroNode(result, 1, "bet", seeded(1), "flop", "125+")).toBeNull();
  });

  /** The analysis' own reading of the hero's decision in a dealt river spot. */
  function factsOf(spot: NonNullable<ReturnType<typeof generateRiverSpot>>) {
    const answer = answerHand(spot, 0);
    const decision = gradeAnswer(answer.hand, answer.actionIndex, CHARTS);
    expect(decision).not.toBeNull();
    const facts = decision!.facts;
    return {
      position: facts.position,
      role: facts.role,
      size: ANALYTICS.sizeBucket(facts.facingPot)?.id ?? null,
      handClass: ANALYTICS.handClass(facts.made?.class ?? null, facts.draws)?.id ?? null,
    };
  }

  /** The first spot the Trainer deals from a drill-down query (a few seeds, as the table tries). */
  function firstDealt(query: string) {
    const settings = analyticsSettings(analyticsLink(viaWeb(query))!, DEFAULT_SETTINGS);
    const request = spotOptions("river", settings);
    expect(request.kind).toBe("river");
    for (let seed = 101; seed < 109; seed += 1) {
      const spot = generateRiverSpot(CHARTS, request.options as RiverSpotOptions, seed);
      if (spot) return spot;
    }
    throw new Error("no spot dealt");
  }

  it("from the drill-down's Practise, the first river dealt out of position is in the spot, the size and a class", () => {
    const classes = ["middle_pair", "weak_pair", "nothing"];
    const spot = firstDealt(drillQuery("river_fold_vs_bet", "single-raised|caller|BB|BTN", "60-85", classes, FIGURES));
    expect([spot.hero, spot.villain, spot.seat, spot.pot]).toEqual(["BB", "BTN", "oop", "srp"]);
    expect(spot.script.river).toMatchObject([{ position: "BB", type: "check" }, { position: "BTN", type: "bet" }]);
    const facts = factsOf(spot);
    expect(facts).toMatchObject({ position: "BB", role: "caller", size: "60-85" });
    expect(classes).toContain(facts.handClass);
  });

  it("and in position, facing the villain's lead", () => {
    const classes = ["top_pair_plus", "middle_pair"];
    const spot = firstDealt(drillQuery("river_fold_vs_bet", "single-raised|pfr|BTN|BB", null, classes, FIGURES));
    expect([spot.hero, spot.villain, spot.seat]).toEqual(["BTN", "BB", "ip"]);
    const facts = factsOf(spot);
    expect(facts).toMatchObject({ position: "BTN", role: "pfr" });
    expect(facts.size).not.toBeNull();
    expect(classes).toContain(facts.handClass);
  });
});

/* ------------------------------------------------------------- goal -- */

const answer = (action: string, mix: Record<string, number>): GoalAnswer => ({ action, mix, grade: "good" });

describe("the goal panel's math (Step 9)", () => {
  it("counts this drill's rate of the stat's action and the reference's on the same hands", () => {
    const answers = [answer("fold", { fold: 0.2, call: 0.8 }), answer("call", { fold: 0, call: 1 }), answer("fold", { fold: 1 }), { grade: "good" } as GoalAnswer];
    const goal = drillGoal(answers, "fold");
    expect(goal).toMatchObject({ n: 3, taken: 2, tone: "few" });
    expect(goal.rate).toBeCloseTo(66.667, 2);
    expect(goal.ref).toBeCloseTo(40, 6);
    expect(drillGoal([], "fold")).toEqual({ n: 0, taken: 0, rate: null, ref: null, tone: "few" });
  });

  it("updates after each answer and judges it like the checker (band floor 5 points, twice the band far)", () => {
    const right = answer("call", { fold: 0.1, call: 0.9 });
    const fold = answer("fold", { fold: 0.1, call: 0.9 });
    const rates: (number | null)[] = [];
    const list: GoalAnswer[] = [];
    for (const next of [fold, right, right, right, right, right, right, right, right, right]) {
      list.push(next);
      rates.push(drillGoal(list, "fold").rate);
    }
    expect(rates.map((r) => Math.round(r!))).toEqual([100, 50, 33, 25, 20, 17, 14, 13, 11, 10]);
    // ref 10% over 10 answers: half-width max(5, 196·√(0.09/10)) = 18.6 points.
    expect(drillGoal(list, "fold").tone).toBe("ok");
    const folds = Array.from({ length: 10 }, () => fold);
    expect(drillGoal(folds, "fold").tone).toBe("far");
    const some = [...Array.from({ length: 4 }, () => fold), ...Array.from({ length: 6 }, () => right)];
    expect(drillGoal(some, "fold")).toMatchObject({ rate: 40, tone: "off" });
  });

  it("reads a class of several actions (VPIP: call, bet, raise)", () => {
    expect(drillGoal([answer("raise", { raise: 0.5, fold: 0.5 }), answer("fold", { call: 1 })], "vpip")).toMatchObject({ taken: 1, ref: 75 });
  });

  it("takes an answer's action and the mix from its graded decision", () => {
    const d = {
      action: "fold",
      chosen: 1,
      options: [
        { action: "fold", freq: 0.25 },
        { action: "call", freq: 0.5 },
        { action: "raise", freq: 0.125 },
        { action: "raise", freq: 0.125 },
      ],
    } as unknown as Parameters<typeof answerMix>[0];
    expect(answerMix(d)).toEqual({ action: "call", mix: { fold: 0.25, call: 0.5, raise: 0.25 } });
  });
});

/* ----------------------------------------------------- bar and panel -- */

function uiStrings(locale: "en" | "hr"): UiStrings {
  return { intlLocale: locale === "en" ? "en-GB" : "hr-HR", analytics: locale === "en" ? analyticsUiEn : analyticsUiHr } as unknown as UiStrings;
}

function host(locale: "en" | "hr"): TrainerHost {
  return {
    t: locale === "en" ? trainerEn : trainerHr,
    locale: locale === "en" ? "en-GB" : "hr-HR",
    analyticsHref: (stat: string) => `/stats/${stat}`,
  } as unknown as TrainerHost;
}

function render(locale: "en" | "hr", node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(UiStringsProvider, { strings: uiStrings(locale) }, createElement(TrainerHostProvider, { host: host(locale) }, node)),
  );
}

const sessionAnswer = (action: string, mix: Record<string, number>): SessionAnswer => ({
  at: "2026-11-22T20:00:00Z",
  street: "flop",
  cards: "7h6h",
  board: "Kc7s2d",
  spotKey: "k",
  position: "BB",
  handClass: null,
  move: action,
  best: "",
  grade: "good",
  evLoss: 0,
  score: 90,
  ref: null,
  action,
  mix,
});

describe("the From Analytics bar and the goal panel (Step 9)", () => {
  const settings = analyticsSettings(analyticsLink(viaWeb(drillQuery(FOLD, BB_VS_SB, "20-40", ["middle_pair", "underpair"], FIGURES)))!, DEFAULT_SETTINGS);

  it("name the leak, the spot and size, the cost and the way back (EN)", () => {
    const html = render("en", createElement(AnalyticsBar, { from: settings.from!, size: settings.size }));
    expect(html).toContain("From Analytics");
    expect(html).toContain("Folds too much · Flop · Fold vs bet");
    expect(html).toContain("BB vs SB");
    expect(html).toContain("Facing 20–40% of the pot");
    expect(html).toContain("costs you −1.30 bb/100");
    expect(html).toContain('href="/stats/flop_fold_vs_bet"');
  });

  it("show your rate here, the target and this drill's rate, counting as answers come (EN, HR)", () => {
    const before = render("en", createElement(GoalPanel, { settings, answers: [] }));
    expect(before).toContain("Goal from Analytics");
    expect(before).toContain("Your fold rate here");
    expect(before).toContain("52%");
    expect(before).toContain("31%");
    expect(before).toContain("Hands are dealt from the classes you got wrong: Middle pair, Pocket pair under the board.");
    const after = render("en", createElement(GoalPanel, { settings, answers: [sessionAnswer("fold", { fold: 0.2, call: 0.8 }), sessionAnswer("call", { fold: 0.2, call: 0.8 })] }));
    expect(after).toContain('data-goal-tone="few"');
    expect(after).toContain(">50%<");
    expect(after).toContain("reference 20% on these hands");
    const hr = render("hr", createElement(GoalPanel, { settings, answers: [] }));
    expect(hr).toContain("Cilj iz Analitike");
    expect(hr).toContain("Tvoj postotak folda ovdje");
  });
});

/* ---------------------------------------------------------- play it -- */

describe("Play it: a played decision dealt once (Step 9)", () => {
  // A preflop hand as it was played, analysed by the charts (the decision's stored options).
  const dealt = dealPreflop(CHARTS, { family: "vs-open", seat: "BB", vs: "BTN", bias: "range" }, 41)!;
  const played = preflopAnswer(dealt, 0);
  const decisions = analyzeHand(structuredClone(played.hand), { charts: CHARTS }).decisions;
  const decision = decisions.find((d) => d.actionIndex === played.actionIndex)!;

  it("shows the hand up to the decision with the hero's cards, and grades against the stored options", () => {
    expect(decision.grade).not.toBeNull();
    const spot = playedSpot({ phf: played.hand, decisions }, { ord: decision.order, action: decision.actionIndex })!;
    expect(spot.street).toBe("preflop");
    expect(spot.cards).toEqual(dealt.cards);
    expect(spot.hand.actions.every((a) => a.index < decision.actionIndex)).toBe(true);
    // The move really made keeps its stored grade; another is graded with the same options.
    const same = gradePlayed(spot, decision.chosen!);
    expect(same.result.grade).toBe(decision.grade);
    expect(same.shown).toBe(decision);
    const other = decision.options.findIndex((_, i) => i !== decision.chosen);
    const graded = gradePlayed(spot, other);
    expect(graded.shown.chosen).toBe(other);
    expect(graded.shown.grade).toBe(graded.result.grade);
  });

  it("finds nothing at a decision the analysis has none for", () => {
    expect(playedSpot({ phf: played.hand, decisions }, { ord: -1, action: 9999 })).toBeNull();
    expect(playedSpot({ phf: played.hand, decisions: [] }, { ord: -1, action: decision.actionIndex })).toBeNull();
  });
});
