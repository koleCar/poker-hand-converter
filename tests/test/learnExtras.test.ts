/**
 * Learn L5 (`docs/LEARN-PLAN.md` §14): the placement test with test-out, the
 * module capstones, the daily dose (`lib/learn/mixed.ts`), the learner's own
 * example hands (`lib/learn/examples.ts`), re-check nudges
 * (`lib/learn/recheck.ts`) and the `tested-out` status in the progress model
 * (`lib/learn/progress.ts`), pinned.
 *
 * 1. **Tested out** is its own status, carried by the existing progress
 *    model with no migration: an entry under `TESTED_OUT`, never `passed`;
 *    passing the exercises later still masters the lesson; it survives the
 *    database's rows, the browser's storage and "add it to this account".
 * 2. **Mixed sets** deal only what the lessons deal (their counted
 *    exercises, as card specs that round-trip through storage),
 *    deterministically, interleaved by lesson and module; the placement rule
 *    and the results it records; the capstone's lesson and size; the dose's
 *    lesson and order.
 * 3. **Examples** pick the costliest mistake and the cleanest Perfect, and
 *    say why from the grade's own numbers.
 * 4. **Re-checks** fire only on a change past the noise with enough hands on
 *    both sides, and read a bounded number of reports.
 */

import { describe, expect, it } from "vitest";

import type { SpotRow } from "../../frontend/src/lib/analysis/leaks.js";
import type { OptionAnalysis } from "../../frontend/src/lib/analysis/types.js";
import { LESSONS, TRACKS, TRACK_IDS, lessonsIn, readsFlopLibrary, requiredExercises, type LessonId } from "../../frontend/src/lib/learn/course.js";
import { CLEAN_FREQ, cleanPerfect, costliest, exampleWhy, perfectMargin, referenceOption, type ExampleCandidate } from "../../frontend/src/lib/learn/examples.js";
import { MASTERY_MIN_DECISIONS, masteryFrom } from "../../frontend/src/lib/learn/mastery.js";
import {
  CAPSTONE_COUNT,
  DOSE_REVIEWS,
  PLACEMENT_MIN_GRADED,
  PLACEMENT_PER_MODULE,
  capstoneItems,
  capstoneLesson,
  doseDay,
  doseItems,
  doseLesson,
  drawable,
  interleave,
  moduleItems,
  newItem,
  placementItems,
  placementOutcome,
  testOutResults,
  type MixedItem,
} from "../../frontend/src/lib/learn/mixed.js";
import { generateCalc, generateClassify } from "../../frontend/src/lib/learn/practice.js";
import {
  TESTED_OUT,
  applyResult,
  exerciseResult,
  lessonDone,
  lessonStatus,
  localCard,
  parseCardItem,
  parseLocalProgress,
  progressAsResults,
  progressFromRows,
  settledAt,
  testedOutAt,
  type ProgressMap,
} from "../../frontend/src/lib/learn/progress.js";
import { RECHECK_MAX_GROUPS, recheckGroups, recheckNudge } from "../../frontend/src/lib/learn/recheck.js";

const NOW = new Date("2026-10-08T10:00:00Z");

/* ---------------------------------------------------------- tested out - */

describe("the tested-out status", () => {
  const testOut = (map: ProgressMap, lesson: LessonId, at = NOW) =>
    applyResult(map, { lesson, exercise: TESTED_OUT, correct: 4, total: 4, passed: true, lessonPassed: false }, at);

  it("is a status of its own, not passed, and passing the exercises still masters the lesson", () => {
    const meta = LESSONS["facing-3bets-and-4bets"];
    let map = testOut({}, meta.id);
    expect(lessonStatus(map[meta.id])).toBe("tested-out");
    expect(map[meta.id]?.status).toBe("started");
    expect(map[meta.id]?.passedAt).toBeNull();
    expect(lessonDone(map[meta.id])).toBe(true);
    expect(testedOutAt(map[meta.id])).toBe(NOW.toISOString());
    expect(settledAt(map[meta.id])).toBe(NOW.toISOString());
    // The exercises still have to be passed for "mastered".
    for (const def of requiredExercises(meta)) {
      map = applyResult(map, exerciseResult(map, meta, def.id, def.count, def.count, true), new Date("2026-10-09T10:00:00Z"));
    }
    expect(lessonStatus(map[meta.id])).toBe("mastered");
    expect(settledAt(map[meta.id])).toBe("2026-10-09T10:00:00.000Z");
    // An exercise result alone is "in progress", and a failed tested-out entry is nothing.
    expect(lessonStatus(applyResult({}, { lesson: meta.id, exercise: "vs-3bet", correct: 1, total: 10, passed: false }, NOW)[meta.id])).toBe("in-progress");
    const failed = applyResult({}, { lesson: meta.id, exercise: TESTED_OUT, correct: 1, total: 4, passed: false }, NOW);
    expect(lessonStatus(failed[meta.id])).toBe("in-progress");
    expect(lessonDone(undefined)).toBe(false);
  });

  it("survives the database's rows, the browser's storage and the merge into an account", () => {
    const map = testOut({}, "three-betting");
    const rows = [{ lesson_id: "three-betting", status: "started", exercises: map["three-betting"]!.exercises, started_at: NOW.toISOString(), passed_at: null }];
    expect(lessonStatus(progressFromRows(rows)["three-betting"])).toBe("tested-out");
    expect(lessonStatus(parseLocalProgress(JSON.stringify(map))["three-betting"])).toBe("tested-out");
    const rebuilt = progressAsResults(map).reduce((acc, result) => applyResult(acc, result, NOW), {} as ProgressMap);
    expect(lessonStatus(rebuilt["three-betting"])).toBe("tested-out");
  });
});

/* ---------------------------------------------------------- mixed sets - */

const sameDeal = (a: readonly MixedItem[], b: readonly MixedItem[]) => expect(a.map((i) => i.card)).toEqual(b.map((i) => i.card));

describe("mixed sets", () => {
  it("deal only the lessons' own counted exercises, deterministically, as cards that round-trip", () => {
    for (const module of ["p2", "f3", "r1", "x2"] as const) {
      const items = moduleItems(module, 8, 1234, true);
      sameDeal(items, moduleItems(module, 8, 1234, true));
      expect(items).toHaveLength(8);
      for (const item of items) {
        const meta = LESSONS[item.lesson];
        expect(meta.module).toBe(module);
        expect(meta.written).toBe(true);
        expect(requiredExercises(meta, true).map((def) => def.id)).toContain(item.card.exercise);
        expect(parseCardItem(JSON.parse(JSON.stringify(item.card.item)))).toEqual(item.card.item);
        expect(localCard(item.card, NOW).key).toBe(item.card.key);
      }
    }
    expect(moduleItems("p2", 8, 1, true).map((i) => i.card.key)).not.toEqual(moduleItems("p2", 8, 2, true).map((i) => i.card.key));
  });

  it("interleave lessons: neighbours come from different lessons wherever a module has several", () => {
    const items = moduleItems("f3", 10, 99, true);
    const lessons = new Set(items.map((i) => i.lesson));
    expect(lessons.size).toBeGreaterThan(1);
    for (let i = 1; i < items.length; i += 1) expect(items[i].lesson).not.toBe(items[i - 1].lesson);
    expect(interleave([[1, 2, 3], ["a"], [10, 20]])).toEqual([1, "a", 10, 2, 20, 3]);
  });

  it("leave flop spots out where the flop library cannot be played", () => {
    for (const item of moduleItems("f1", 12, 7, false)) {
      const def = LESSONS[item.lesson].exercises.find((d) => d.id === item.card.exercise)!;
      expect(readsFlopLibrary(def)).toBe(false);
    }
    for (const meta of lessonsIn("f1")) for (const def of drawable(meta, false)) expect(readsFlopLibrary(def)).toBe(false);
    // Unwritten lessons have nothing to draw.
    expect(drawable(LESSONS["multiway-preflop-choices"], true)).toEqual([]);
  });

  it("build every calc and classify item they deal", () => {
    for (const track of TRACK_IDS) {
      for (const item of placementItems(track, 4242, true)) {
        const spec = item.card.item;
        if (spec.k === "calc") expect(Number.isFinite(generateCalc(spec.calc, spec.seed).answer)).toBe(true);
        if (spec.k === "classify" && spec.classify !== "turn-card") expect(generateClassify(spec.classify, spec.seed).buckets).toContain(generateClassify(spec.classify, spec.seed).answer);
      }
    }
  });
});

describe("the placement test", () => {
  it("deals a few items from every module of the track, mixed across modules", () => {
    for (const track of TRACK_IDS) {
      const items = placementItems(track, 77, true);
      sameDeal(items, placementItems(track, 77, true));
      for (const module of TRACKS[track]) expect(items.filter((i) => i.module === module), module).toHaveLength(PLACEMENT_PER_MODULE);
      for (let i = 1; i < items.length; i += 1) expect(items[i].module).not.toBe(items[i - 1].module);
    }
  });

  it("tests a module out at three of four graded, never counting a skipped item against it", () => {
    const items = placementItems("preflop", 5, true);
    const answers = (pattern: Record<string, Array<boolean | null>>) => {
      const used: Record<string, number> = {};
      return items.map((item) => {
        const k = used[item.module] ?? 0;
        used[item.module] = k + 1;
        const list = pattern[item.module] ?? [];
        return k < list.length ? list[k] : false;
      });
    };
    const outcomes = placementOutcome(
      "preflop",
      items,
      answers({ p1: [true, true, true, false], p2: [true, true, false, false], p3: [true, true, true, null] }),
    );
    expect(outcomes.map((o) => [o.module, o.correct, o.graded, o.passed])).toEqual([
      ["p1", 3, 4, true],
      ["p2", 2, 4, false],
      ["p3", 3, 3, true],
    ]);
    // Too few graded: not judged, so not tested out.
    const thin = placementOutcome("preflop", items, answers({ p1: [true, true, null, null] }));
    expect(thin[0]).toMatchObject({ graded: 2, passed: false });
    expect(PLACEMENT_MIN_GRADED).toBe(3);
  });

  it("records tested-out for the written lessons of a passed module only, never as passed, and skips lessons already done", () => {
    const outcomes = [
      { module: "p2" as const, asked: 4, graded: 4, correct: 4, passed: true },
      { module: "p3" as const, asked: 4, graded: 4, correct: 1, passed: false },
    ];
    const progress: ProgressMap = {
      "three-betting": { status: "passed", exercises: {}, startedAt: "", passedAt: NOW.toISOString() },
    };
    const results = testOutResults(progress, outcomes);
    expect(results.map((r) => r.lesson)).toEqual(lessonsIn("p2").filter((m) => m.written && m.id !== "three-betting").map((m) => m.id));
    for (const r of results) expect(r).toMatchObject({ exercise: TESTED_OUT, passed: true, lessonPassed: false, correct: 4, total: 4 });
    const after = results.reduce((map, r) => applyResult(map, r, NOW), progress);
    expect(lessonStatus(after["facing-an-open"])).toBe("tested-out");
    expect(lessonStatus(after["three-betting"])).toBe("mastered");
    // A second run marks nothing new.
    expect(testOutResults(after, outcomes)).toEqual([]);
  });
});

describe("module capstones", () => {
  it("close each module on its last written lesson, with a mixed set of its lessons' exercises", () => {
    expect(capstoneLesson("p1")).toBe("limpers-and-isolation");
    expect(capstoneLesson("p3")).toBe("blind-play-and-bvb");
    expect(capstoneLesson("x4")).toBe("deep-stacks-200bb");
    for (const track of TRACK_IDS) {
      for (const module of TRACKS[track]) {
        const lesson = capstoneLesson(module);
        expect(lesson, module).not.toBeNull();
        const items = capstoneItems(module, 3, true);
        expect(items, module).toHaveLength(CAPSTONE_COUNT);
        const lessons = new Set(items.map((i) => i.lesson));
        expect(lessons.size, module).toBe(Math.min(CAPSTONE_COUNT, lessonsIn(module).filter((m) => drawable(m, true).length > 0).length));
      }
    }
  });
});

describe("the daily dose", () => {
  const card = (key: string, dueAt: string) => ({ ...localCard({ lesson: "facing-an-open" as LessonId, exercise: "call-3bet-fold", kind: "chart-quiz" as const, key, item: { k: "calc" as const, calc: "pot-odds" as const, seed: 1 } }, NOW), state: { reps: 0, lapses: 0, ease: 2.5, intervalDays: 0, dueAt } });

  it("takes the new item from the first recommended lesson not done, else the next lesson in course order", () => {
    const progress: ProgressMap = {
      "thin-value": { status: "passed", exercises: {}, startedAt: "", passedAt: NOW.toISOString() },
    };
    expect(doseLesson(progress, ["thin-value", "bluff-catching"], true)).toBe("bluff-catching");
    expect(doseLesson(progress, [], true)).toBe("positions-and-opening-ranges");
    const tested = applyResult({}, { lesson: "positions-and-opening-ranges", exercise: TESTED_OUT, correct: 4, total: 4, passed: true }, NOW);
    expect(doseLesson(tested, [], true)).toBe("open-sizing");
    const item = newItem("bluff-catching", 9, true)!;
    expect(item.lesson).toBe("bluff-catching");
    expect(requiredExercises(LESSONS["bluff-catching"], true).map((d) => d.id)).toContain(item.card.exercise);
    expect(newItem("multiway-preflop-choices", 9, true)).toBeNull();
  });

  it("plays the cards due longest, at most a few, with the new item in the middle", () => {
    const due = Array.from({ length: 7 }, (_, i) => card(`c${i}`, `2026-10-0${7 - (i % 7)}T00:00:00Z`));
    const fresh = newItem("bluff-catching", 1, true);
    const dose = doseItems(due, fresh);
    expect(dose).toHaveLength(DOSE_REVIEWS + 1);
    expect(dose[Math.floor(DOSE_REVIEWS / 2)].kind).toBe("new");
    const reviewed = dose.flatMap((d) => (d.kind === "review" ? [Date.parse(d.card.state.dueAt)] : []));
    expect(reviewed).toEqual([...reviewed].sort((a, b) => a - b));
    expect(doseItems([], fresh).map((d) => d.kind)).toEqual(["new"]);
    expect(doseItems(due.slice(0, 1), null)).toHaveLength(1);
    expect(doseDay(new Date(2026, 9, 8, 23, 30))).toBe("2026-10-08");
  });
});

/* ------------------------------------------------------------ examples - */

const option = (action: OptionAnalysis["action"], freq: number, ev: number): OptionAnalysis => ({ action, freq, ev });
const candidate = (over: Partial<ExampleCandidate>): ExampleCandidate => ({
  handId: "h",
  actionIndex: 3,
  street: "river",
  position: "BTN",
  heroCards: ["Ah", "Kd"],
  grade: "mistake",
  evLossBb: 1,
  evLossPot: 0.1,
  options: [option("fold", 0, 0), option("call", 1, 2)],
  chosen: 0,
  ...over,
});

describe("example hands from the learner's own decisions", () => {
  it("pick the costliest mistake, never a Perfect or a Good", () => {
    const rows = [
      candidate({ handId: "a", grade: "inaccurate", evLossBb: 0.8 }),
      candidate({ handId: "b", grade: "blunder", evLossBb: 4.5 }),
      candidate({ handId: "c", grade: "good", evLossBb: 9 }),
      candidate({ handId: "d", grade: "mistake", evLossBb: null }),
    ];
    expect(costliest(rows)?.handId).toBe("b");
    expect(costliest([candidate({ grade: "perfect", evLossBb: 0 })])).toBeNull();
  });

  it("pick the clean Perfect whose next best option gives up the most", () => {
    const perfect = (handId: string, freq: number, best: number, next: number) =>
      candidate({ handId, grade: "perfect", evLossBb: 0, chosen: 1, options: [option("fold", 1 - freq, next), option("call", freq, best)] });
    const rows = [perfect("small", 1, 3, 2.5), perfect("big", 0.95, 5, 1), perfect("mixed", 0.6, 9, 0), candidate({ handId: "worse", grade: "perfect", chosen: 0 })];
    expect(cleanPerfect(rows)?.handId).toBe("big");
    expect(perfectMargin(rows[1])).toBeCloseTo(4, 12);
    // A move that is not the best by EV has no margin; a mix below the clean line is not an example.
    expect(perfectMargin(rows[3])).toBeNull();
    expect(cleanPerfect([perfect("mixed", CLEAN_FREQ - 0.01, 9, 0)])).toBeNull();
  });

  it("say why from the grade's own numbers", () => {
    const mistake = exampleWhy(candidate({ grade: "mistake", evLossBb: 2, evLossPot: 0.2 }));
    expect(mistake).toMatchObject({ kind: "mistake", lossBb: 2, lossPot: 0.2, grade: "mistake" });
    if (mistake?.kind === "mistake") {
      expect(mistake.taken.action).toBe("fold");
      expect(mistake.reference.action).toBe("call");
    }
    const perfect = exampleWhy(candidate({ grade: "perfect", chosen: 1, evLossBb: 0, options: [option("fold", 0.02, 0.5), option("call", 0.98, 3)] }));
    expect(perfect).toMatchObject({ kind: "perfect", marginBb: 2.5 });
    expect(exampleWhy(candidate({ chosen: null }))).toBeNull();
    expect(referenceOption([option("check", 0.5, 1), option("bet", 0.5, 2), option("fold", 0.1, 3)])).toBe(1);
  });
});

/* ------------------------------------------------------------- rechecks - */

describe("re-check nudges", () => {
  const row = (scenario: string, decisions: number, mean: number): SpotRow => ({
    key: `river:${scenario}:${decisions}:${mean}`,
    street: "river",
    scenario,
    line: "",
    position: "BTN",
    taken: "call",
    best: "call",
    decisions,
    hands: decisions,
    nonPerfect: 0,
    mistakes: 0,
    evLossBb: 0,
    evLossPot: 0,
    scoreSum: mean * decisions,
    scoreSq: decisions * (mean * mean + 100),
  });
  const meta = LESSONS["bluff-catching"];

  it("fire only when the lesson's own hands got worse past the noise, with enough hands on both sides", () => {
    const good = [row("caller-ip-vs-bet", 40, 80)];
    const bad = [row("caller-ip-vs-bet", 40, 70)];
    expect(recheckNudge(meta.id, masteryFrom(meta, good, bad, "2026-10-01"))).toEqual({ lesson: meta.id, before: 40, after: 40, since: "2026-10-01" });
    expect(recheckNudge(meta.id, masteryFrom(meta, bad, good, "2026-10-01"))).toBeNull();
    expect(recheckNudge(meta.id, masteryFrom(meta, good, good, "2026-10-01"))).toBeNull();
    // A lean is not a nudge.
    expect(recheckNudge(meta.id, masteryFrom(meta, good, [row("caller-ip-vs-bet", 40, 76)], "2026-10-01"))).toBeNull();
    const thin = masteryFrom(meta, good, [row("caller-ip-vs-bet", MASTERY_MIN_DECISIONS - 1, 10)], "2026-10-01");
    expect(recheckNudge(meta.id, thin)).toBeNull();
  });

  it("group done lessons with spots by day and pot type, the latest first, at most a few groups", () => {
    const passed = (day: string) => ({ status: "passed" as const, exercises: {}, startedAt: "", passedAt: `${day}T12:00:00Z` });
    const progress: ProgressMap = {
      "bluff-catching": passed("2026-10-01"),
      "thin-value": passed("2026-10-01"),
      "3bp-river": passed("2026-10-01"),
      "reading-hud-stats": passed("2026-10-05"),
      "facing-an-open": { status: "started", exercises: {}, startedAt: "", passedAt: null },
    };
    const tested = applyResult(progress, { lesson: "three-betting", exercise: TESTED_OUT, correct: 4, total: 4, passed: true }, new Date("2026-10-07T09:00:00Z"));
    const groups = recheckGroups(tested);
    // reading-hud-stats names no spots; facing-an-open is not done.
    expect(groups).toEqual([
      { day: "2026-10-07", lessons: ["three-betting"] },
      expect.objectContaining({ day: "2026-10-01" }),
      expect.objectContaining({ day: "2026-10-01" }),
    ]);
    const oct1 = groups.filter((g) => g.day === "2026-10-01");
    expect(oct1.find((g) => g.potType === "3bet")?.lessons).toEqual(["3bp-river"]);
    expect(oct1.find((g) => !g.potType)?.lessons.sort()).toEqual(["bluff-catching", "thin-value"]);
    const many: ProgressMap = {};
    const ids: LessonId[] = ["bluff-catching", "thin-value", "river-sizing", "facing-an-open", "three-betting", "cbet-why-and-when", "defending-vs-cbets", "check-raising"];
    ids.forEach((id, i) => (many[id] = passed(`2026-09-${String(10 + i).padStart(2, "0")}`)));
    const capped = recheckGroups(many);
    expect(capped).toHaveLength(RECHECK_MAX_GROUPS);
    expect(capped[0].day).toBe("2026-09-17");
  });
});
