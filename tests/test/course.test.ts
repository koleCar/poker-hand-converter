/**
 * The Learn tab (L1, `frontend/src/lib/learn/course.ts` and friends), pinned.
 *
 * 1. **The catalogue**: the five tracks in the order of a hand (L1.1); every
 *    lesson id, prerequisite, concept, chart set, seat and flag resolves;
 *    codes are unique; nothing names a lesson that does not exist; L1's
 *    orientation, maths and range lessons are reference pages, not lessons;
 *    no curated example hands yet.
 * 2. **The words**: every lesson and reference page has an outline in both
 *    languages; a lesson is written exactly when both languages have its
 *    body; the two bodies have the same structure (sections, blocks, widgets,
 *    checkpoints, right answers, checks, reference links); every exercise has
 *    its line; every widget preset is real; every number a lesson or
 *    reference page states is recomputed; the ideas L1.1 folded into lessons
 *    link their reference page.
 * 3. **The practice**: every generated item is deterministic in its seed and
 *    gradable — its own answer passes, a wrong one fails, and the answer is
 *    the engine's (`grade()`, `boardTexture()`, the hand classes).
 * 4. **Progress and cards**: the sticky rules the database also applies,
 *    automatic passing, review cards round-tripping through storage.
 * 5. **Recommendations**: leaks map to the lessons that teach them.
 * 6. **Exploits (L4)**: the exploit lessons' honesty banners, the lab's
 *    exercises and cards, the sampling arithmetic, and the learner's own pool
 *    (`lib/learn/pool.ts`) summed from opponents-panel rows. The lab itself is
 *    `learnLab.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { boardTexture, toIndices } from "../../frontend/src/lib/analysis/texture.js";
import { grade } from "../../frontend/src/lib/analysis/grading.js";
import { FLAG_CODES, GRADES, type OptionAnalysis } from "../../frontend/src/lib/analysis/types.js";
import { CHART_SETS } from "../../frontend/src/lib/charts/index.js";
import { cardIndex } from "../../frontend/src/lib/equity/evaluator.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { CONCEPT_IDS, WIDGET_IDS, type WidgetPreset } from "../../frontend/src/lib/learn/concepts.js";
import { FLOP_LIBRARY_ENABLED, FLOP_LINES } from "../../frontend/src/lib/analysis/flopLibrary.js";
import { FLOP_BET_SPOTS } from "../../frontend/src/lib/learn/flopBets.js";
import {
  CALC_KINDS,
  CLASSIFY_KINDS,
  LESSONS,
  LESSON_IDS,
  LESSON_NOTES,
  MODULE_IDS,
  MOVED_LESSONS,
  REFERENCE_BY_GROUP,
  REFERENCE_CONCEPTS,
  REFERENCE_GROUPS,
  REFERENCE_IDS,
  RESERVED_LEARN_SEGMENTS,
  TRACKS,
  TRACK_IDS,
  countsTowardsPass,
  courseOrder,
  isLessonId,
  isPlanned,
  isReferenceId,
  lessonsIn,
  moduleCode,
  readsFlopLibrary,
  requiredExercises,
  writtenLessons,
  type GeneratedExerciseDef,
  type LessonId,
} from "../../frontend/src/lib/learn/course.js";
import { checkHolds, MATH } from "../../frontend/src/lib/learn/lessons/checks.js";
import { LESSON_BODIES, LESSON_OUTLINES, REFERENCE_BODIES } from "../../frontend/src/lib/learn/lessons/index.js";
import { plainText, refLinks, type LessonBlock, type LessonBody, type MathCheck } from "../../frontend/src/lib/learn/lessons/types.js";
import {
  CLOSE_MAX,
  RAISER_FAVOURED,
  exactEquity,
  generateCalc,
  generateClassify,
  gradeCalc,
  gradeClassify,
  handBucket,
  needed,
  passes,
} from "../../frontend/src/lib/learn/practice.js";
import { COMBO_PRESETS, MATCHUP_PRESETS, RANGE_TEXT } from "../../frontend/src/lib/learn/presets.js";
import {
  addLocalCards,
  applyResult,
  cardFor,
  exerciseResult,
  lessonComplete,
  lessonStatus,
  localCard,
  parseCardItem,
  parseLocalCards,
  parseLocalProgress,
  progressAsResults,
  progressFromRows,
  reviewLocalCard,
  type ProgressMap,
} from "../../frontend/src/lib/learn/progress.js";
import { globMatch, lessonForArea, patternScore, recommend } from "../../frontend/src/lib/learn/recommend.js";
import { ALL_PREFLOP_SEATS, PREFLOP_FAMILIES } from "../../frontend/src/lib/training/preflop.js";
import { RIVER_POTS, RIVER_ROLES, RIVER_SEATS } from "../../frontend/src/lib/training/river.js";
import { LAB_PRESET_IDS } from "../../frontend/src/lib/training/labPresets.js";
import { marginOfError, sampleNeeded } from "../../frontend/src/lib/learn/math.js";
import { MIN_CHANCES, POOL_STATS, POOL_TOPIC_STATS, poolOf, poolReads, poolStat } from "../../frontend/src/lib/learn/pool.js";

const NOW = new Date("2026-10-06T10:00:00Z");

/* ------------------------------------------------------------ catalogue - */

describe("the course catalogue", () => {
  it("has five tracks in the order of a hand, 18 modules and 56 lessons, in order, with unique codes", () => {
    expect([...TRACK_IDS]).toEqual(["preflop", "flop", "turn", "river", "exploits"]);
    expect(MODULE_IDS).toHaveLength(18);
    expect(LESSON_IDS.length).toBe(56);
    expect(new Set(LESSON_IDS).size).toBe(56);
    expect(courseOrder().map((meta) => meta.id)).toEqual([...LESSON_IDS]);
    // The map's order: track by track, module by module.
    expect(TRACK_IDS.flatMap((track) => TRACKS[track]).flatMap((module) => lessonsIn(module).map((meta) => meta.id))).toEqual([...LESSON_IDS]);
    const codes = courseOrder().map((meta) => meta.code);
    expect(new Set(codes).size).toBe(56);
    for (const meta of courseOrder()) expect(meta.code).toMatch(new RegExp(`^${moduleCode(meta.module)}-L\\d+$`));
    expect(LESSONS["positions-and-opening-ranges"].code).toBe("P1-L1");
    expect(LESSONS["when-not-to-exploit"].code).toBe("X3-L2");
  });

  it("lays the modules out as the plan's §2 table", () => {
    const ids = (module: (typeof MODULE_IDS)[number]) => lessonsIn(module).map((meta) => meta.id);
    expect(ids("p1")).toEqual(["positions-and-opening-ranges", "open-sizing", "limpers-and-isolation"]);
    expect(ids("p2")).toEqual(["facing-an-open", "three-betting", "facing-3bets-and-4bets", "squeezes-and-multiway-preflop"]);
    expect(ids("p3")).toEqual(["blind-play-and-bvb", "multiway-preflop-choices", "preflop-by-stack-depth"]);
    expect(ids("f1")).toEqual(["cbet-why-and-when", "cbet-by-texture", "hand-classes-on-the-flop", "checking-back-and-delayed-cbets"]);
    expect(ids("f2")).toEqual(["oop-as-the-raiser", "facing-a-check-raise"]);
    expect(ids("f3")).toEqual(["defending-vs-cbets", "check-raising", "floating-and-stabbing-ip", "probes-and-donk-bets", "bb-vs-btn-blueprint"]);
    expect(ids("f4")).toEqual(["spr-and-commitment", "cbetting-as-the-3bettor", "playing-3bp-as-the-caller", "range-splitting-ip-vs-checks-3bp", "four-bet-pots"]);
    expect(ids("f5")).toEqual(["multiway-principles", "multiway-as-the-raiser", "multiway-defence"]);
    expect(ids("t1")).toEqual(["turn-card-classes", "double-barreling", "turn-sizing-and-overbets", "turn-after-flop-checks-through"]);
    expect(ids("t2")).toEqual(["facing-turn-barrels", "turn-check-raise-and-probe"]);
    expect(ids("t3")).toEqual(["3bp-turn"]);
    expect(ids("r1")).toEqual(["river-polarisation", "thin-value", "choosing-bluffs-blockers", "river-sizing"]);
    expect(ids("r2")).toEqual(["bluff-catching", "facing-river-raises"]);
    expect(ids("r3")).toEqual(["3bp-river"]);
    expect(ids("x1")).toEqual(["player-profiles", "reading-hud-stats"]);
    expect(ids("x2")).toEqual(["population-exploits", "exploiting-overfolders", "exploiting-calling-stations", "exploiting-aggressive-players", "underbluffed-rivers"]);
    expect(ids("x3")).toEqual(["node-locking-in-rail", "when-not-to-exploit"]);
    expect(ids("x4")).toEqual(["live-game-dynamics", "straddle-preflop", "straddle-postflop-low-spr", "deep-stacks-200bb"]);
  });

  it("keeps L1's orientation, maths and range lessons off the map as reference pages (L1.1)", () => {
    expect(REFERENCE_IDS).toHaveLength(16);
    for (const id of REFERENCE_IDS) {
      expect(isLessonId(id), id).toBe(false);
      expect(isReferenceId(id)).toBe(true);
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
      for (const concept of REFERENCE_CONCEPTS[id]) expect(CONCEPT_IDS as readonly string[], id).toContain(concept);
    }
    expect(REFERENCE_GROUPS.flatMap((group) => REFERENCE_BY_GROUP[group])).toEqual([...REFERENCE_IDS]);
    for (const id of ["gto-mixing-and-simplifying", "reading-rail-reports", "variance-bankroll-and-tilt", "how-rail-teaches", "pot-odds", "range-narrowing"]) {
      expect(isLessonId(id), id).toBe(false);
    }
    // A moved lesson redirects to one that exists; the old id is not a lesson.
    for (const [from, to] of Object.entries(MOVED_LESSONS)) {
      expect(isLessonId(from)).toBe(false);
      expect(isReferenceId(from)).toBe(false);
      expect(isLessonId(to)).toBe(true);
    }
  });

  it("puts every module in exactly one track", () => {
    const placed = TRACK_IDS.flatMap((track) => TRACKS[track]);
    expect([...placed].sort()).toEqual([...MODULE_IDS].sort());
    for (const module of MODULE_IDS) expect(lessonsIn(module).length).toBeGreaterThan(0);
  });

  it("uses ids a URL and the database accept, never a reserved /learn segment", () => {
    for (const id of LESSON_IDS) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
      expect(RESERVED_LEARN_SEGMENTS as readonly string[]).not.toContain(id);
    }
    expect(RESERVED_LEARN_SEGMENTS as readonly string[]).toContain("reference");
  });

  it("names only lessons that exist as prerequisites, each earlier in the course", () => {
    const order = new Map(LESSON_IDS.map((id, index) => [id, index]));
    for (const meta of courseOrder()) {
      for (const prereq of meta.prereqs) {
        expect(LESSONS[prereq], `${meta.id} → ${prereq}`).toBeDefined();
        expect(order.get(prereq)!, `${meta.id} → ${prereq}`).toBeLessThan(order.get(meta.id)!);
      }
    }
  });

  it("links only concepts that exist", () => {
    for (const meta of courseOrder()) {
      expect(meta.concepts.length).toBeGreaterThan(0);
      for (const concept of meta.concepts) expect(CONCEPT_IDS as readonly string[], meta.id).toContain(concept);
    }
  });

  it("defines exercises the engine can deal: real chart sets, seats, families and river filters", () => {
    const sets = new Set(CHART_SETS.map((spec) => spec.id));
    for (const meta of courseOrder()) {
      expect(meta.exercises.length, meta.id).toBeGreaterThan(0);
      const ids = meta.exercises.map((def) => def.id);
      expect(new Set(ids).size, meta.id).toBe(ids.length);
      for (const def of meta.exercises) {
        expect(def.id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
        if (def.kind === "chart-quiz") {
          expect([...PREFLOP_FAMILIES, "random"]).toContain(def.family);
          if (def.set) expect(sets.has(def.set), `${meta.id}/${def.id}`).toBe(true);
          if (def.seat) expect(ALL_PREFLOP_SEATS).toContain(def.seat);
          if (def.vs) expect(ALL_PREFLOP_SEATS).toContain(def.vs);
        }
        if (def.kind === "range-paint" && !isPlanned(def)) {
          // L3: a chart's first-in range (a real set and seat), or a river node (the river filters).
          if (def.source === "chart") {
            if (def.set) expect(sets.has(def.set), `${meta.id}/${def.id}`).toBe(true);
            if (def.seat) expect(ALL_PREFLOP_SEATS).toContain(def.seat);
          } else {
            expect([...RIVER_POTS, "any"]).toContain(def.pot);
            expect([...RIVER_SEATS, "any"]).toContain(def.seat);
            expect([...RIVER_ROLES, "any"]).toContain(def.role);
            if (def.facing === "check") expect(def.seat === "ip" || def.seat === "any").toBe(true);
          }
        }
        if (def.kind === "solver-spot" || def.kind === "range-split") {
          // The flop line before a turn (L3) filters turns only.
          if (def.flop) expect(def.street, `${meta.id}/${def.id}`).toBe("turn");
          expect([...RIVER_POTS, "any"]).toContain(def.pot);
          expect([...RIVER_SEATS, "any"]).toContain(def.seat);
          expect([...RIVER_ROLES, "any"]).toContain(def.role);
          if (def.street === "flop" || def.kind === "range-split") {
            // The flop (and a split): facing a check is in position; a bet or a raise from either seat; a line of the library.
            expect(["check", "bet", "raise", "any", undefined]).toContain(def.facing);
            if (def.facing === "check") expect(def.seat === "ip" || def.seat === "any").toBe(true);
            if (def.line) expect(FLOP_LINES.map((l) => l.id), `${meta.id}/${def.id}`).toContain(def.line);
            if (def.kind === "range-split") expect(["flop", "turn", "river"]).toContain(def.street);
          } else {
            expect(def.line, `${meta.id}/${def.id}`).toBeUndefined();
            expect(def.facing === "raise", `${meta.id}/${def.id}`).toBe(false);
            if (def.facing === "check" || def.facing === "bet") expect(def.seat === "ip" || def.seat === "any").toBe(true);
          }
        }
        if (def.kind === "calc") expect(CALC_KINDS).toContain(def.calc);
        // L4: the exploit lab deals one of its presets, or any.
        if (def.kind === "node-lock" && !isPlanned(def)) expect(["any", ...LAB_PRESET_IDS]).toContain(def.preset);
        if (def.kind === "classify") expect(CLASSIFY_KINDS).toContain(def.classify);
        if ("count" in def && def.kind !== "own-hands") {
          expect(def.count).toBeGreaterThan(0);
          expect(def.pass).toBeGreaterThan(0);
          expect(def.pass).toBeLessThanOrEqual(1);
        }
        if (def.kind === "own-hands") for (const flag of def.flags ?? []) expect(FLAG_CODES as readonly string[]).toContain(flag);
      }
    }
  });

  it("gives every written lesson at least one exercise that counts towards passing it, with the flop library on", () => {
    expect(FLOP_LIBRARY_ENABLED).toBe(true);
    for (const meta of writtenLessons()) expect(requiredExercises(meta, FLOP_LIBRARY_ENABLED).length, meta.id).toBeGreaterThan(0);
  });

  it("counts flop spots and flop splits only with the flop library on (L2)", () => {
    const meta = LESSONS["cbet-why-and-when"];
    expect(requiredExercises(meta, true).map((def) => def.id)).toEqual(["flop-cbets"]);
    expect(requiredExercises(meta, false)).toEqual([]);
    for (const lesson of courseOrder()) {
      for (const def of lesson.exercises) {
        if (readsFlopLibrary(def)) {
          expect(countsTowardsPass(def, false), `${lesson.id}/${def.id}`).toBe(false);
          expect(countsTowardsPass(def, true), `${lesson.id}/${def.id}`).toBe(true);
        }
      }
    }
  });

  it("has L1's preflop lessons, the flop track (L2), the turn and river tracks (L3) and the exploits track (L4) written", () => {
    const written = writtenLessons().map((meta) => meta.id);
    expect(written).toEqual([
      "positions-and-opening-ranges",
      "open-sizing",
      "limpers-and-isolation",
      "facing-an-open",
      "three-betting",
      "facing-3bets-and-4bets",
      "squeezes-and-multiway-preflop",
      "blind-play-and-bvb",
      ...TRACKS.flop.flatMap((module) => lessonsIn(module).map((meta) => meta.id)),
      ...TRACKS.turn.flatMap((module) => lessonsIn(module).map((meta) => meta.id)),
      ...TRACKS.river.flatMap((module) => lessonsIn(module).map((meta) => meta.id)),
      ...TRACKS.exploits.flatMap((module) => lessonsIn(module).map((meta) => meta.id)),
    ]);
    expect(written).toHaveLength(8 + 19 + 7 + 7 + 13);
  });

  it("matches leaks with real streets and flags", () => {
    for (const meta of courseOrder()) {
      for (const pattern of meta.match.spots) expect(["preflop", "flop", "turn", "river"]).toContain(pattern.street);
      for (const flag of meta.match.flags) expect(FLAG_CODES as readonly string[]).toContain(flag);
    }
  });

  it("has an empty slot for curated example hands, and no example yet", () => {
    for (const meta of courseOrder()) expect(meta.examples ?? []).toHaveLength(0);
  });

  it("names every lesson, reference page, module and track in both languages", () => {
    for (const id of [...LESSON_IDS, ...REFERENCE_IDS]) {
      expect(en.course.titles[id], id).toBeTruthy();
      expect(hr.course.titles[id], id).toBeTruthy();
    }
    for (const module of MODULE_IDS) {
      expect(en.course.modules[module]).toBeTruthy();
      expect(hr.course.modules[module]).toBeTruthy();
    }
    for (const track of TRACK_IDS) {
      expect(en.course.tracks[track]).toBeTruthy();
      expect(hr.course.tracks[track]).toBeTruthy();
    }
    for (const group of REFERENCE_GROUPS) {
      expect(en.course.map.reference.groups[group]).toBeTruthy();
      expect(hr.course.map.reference.groups[group]).toBeTruthy();
    }
    expect(hr.course.map.introPanel.points).toHaveLength(en.course.map.introPanel.points.length);
    for (const kind of ["chart-quiz", "solver-spot", "calc", "classify", "own-hands", "range-split", "depth-split", "range-paint", "range-walk", "pot-tracking", "profile-quiz", "node-lock", "placement"]) {
      expect(en.course.exerciseKinds[kind], kind).toBeTruthy();
      expect(hr.course.exerciseKinds[kind], kind).toBeTruthy();
    }
  });
});

/* ---------------------------------------------------------------- words - */

function validCards(codes: readonly string[] | undefined, lengths: number[]): boolean {
  if (!codes) return true;
  if (!lengths.includes(codes.length)) return false;
  const indices = codes.map(cardIndex);
  return indices.every((index) => index >= 0) && new Set(indices).size === indices.length;
}

function presetProblem(preset: WidgetPreset): string | null {
  if (!(WIDGET_IDS as readonly string[]).includes(preset.id)) return `unknown widget ${preset.id}`;
  if (preset.id === "equity") {
    if (preset.preset && !(preset.preset in RANGE_TEXT)) return `unknown range ${preset.preset}`;
    if (!validCards(preset.hand, [2])) return "bad hand";
  }
  if (preset.id === "range-vs-range") {
    if (preset.preset && !MATCHUP_PRESETS.some((m) => m.id === preset.preset)) return `unknown matchup ${preset.preset}`;
    if (!validCards(preset.board, [0, 3, 4, 5])) return "bad board";
  }
  if (preset.id === "combos") {
    if (preset.preset && !COMBO_PRESETS.some((c) => c.id === preset.preset)) return `unknown combo preset ${preset.preset}`;
    if (!validCards(preset.hand, [2])) return "bad hand";
  }
  if (preset.id === "board-texture" && !validCards(preset.board, [0, 3, 4, 5])) return "bad board";
  if (preset.id === "bet-math" && preset.focus && !["pot-odds", "mdf", "alpha", "polar", "steal"].includes(preset.focus)) {
    return `bad focus ${preset.focus}`;
  }
  for (const key of ["pot", "bet", "stack"] as const) {
    const value = preset[key];
    if (value !== undefined && !(value > 0)) return `bad ${key}`;
  }
  if (preset.share !== undefined && !(preset.share >= 0 && preset.share <= 1)) return "bad share";
  if (preset.id === "flop-bets" && !FLOP_BET_SPOTS.some((s) => s.line === preset.preset)) return `unknown flop-bets line ${preset.preset}`;
  // L4: the sample-size calculator opens on a stat and its chances; the lab on one of its presets.
  if (preset.id === "sample-size" && !(Number.isInteger(preset.count) && (preset.count as number) > 0)) return "bad count";
  if (preset.id === "exploit-lab" && !(LAB_PRESET_IDS as readonly string[]).includes(preset.preset ?? "")) return `unknown lab preset ${preset.preset}`;
  return null;
}

/** A block's structure, without its words. */
/** The reference links a text holds, in order: English and Croatian link the same pages. */
const linksOf = (text: string) => refLinks(text).flatMap((part) => (part.ref ? [part.ref] : []));

function shape(block: LessonBlock): string {
  if (typeof block === "string") return `p:${linksOf(block).join(",")}`;
  if ("list" in block) return `list:${block.list.length}:${block.list.map((item) => linksOf(item).join(",")).join("|")}`;
  if ("widget" in block) return `widget:${JSON.stringify(block.widget)}:${block.caption ? 1 : 0}`;
  if ("checkpoint" in block) {
    const c = block.checkpoint;
    return `checkpoint:${c.options.length}:${c.answer}:${JSON.stringify(c.math ?? null)}:${JSON.stringify(c.reveal ?? null)}`;
  }
  if ("formula" in block) return "formula";
  return `note:${block.note.tone}`;
}

function bodyShape(body: LessonBody): unknown {
  return {
    sections: body.sections.map((section) => section.blocks.map(shape)),
    rules: body.heuristics.rules.length,
    breaks: body.heuristics.breaks.length,
    exercises: Object.keys(body.exercises).sort(),
    checks: body.checks,
  };
}

function* blocks(body: LessonBody): Generator<LessonBlock> {
  for (const section of body.sections) yield* section.blocks;
}

/** Every text of a body that may hold a reference link (paragraphs, list items, rules), and every one that may not. */
function texts(body: LessonBody): { linked: string[]; plain: string[] } {
  const linked: string[] = [...body.heuristics.rules];
  const plain: string[] = [...body.heuristics.breaks, ...Object.values(body.exercises)];
  for (const section of body.sections) {
    plain.push(section.heading);
    for (const block of section.blocks) {
      if (typeof block === "string") linked.push(block);
      else if ("list" in block) linked.push(...block.list);
      else if ("widget" in block) plain.push(block.caption ?? "");
      else if ("checkpoint" in block) plain.push(block.checkpoint.question, block.checkpoint.explain, ...block.checkpoint.options);
      else if ("note" in block) plain.push(block.note.text);
    }
  }
  return { linked, plain };
}

/** Every written body: the lessons on the map and the reference pages, by locale. */
function allBodies(locale: "en" | "hr"): Array<[string, LessonBody]> {
  return [
    ...writtenLessons().map((meta) => [meta.id, LESSON_BODIES[locale][meta.id]!] as [string, LessonBody]),
    ...REFERENCE_IDS.map((id) => [id, REFERENCE_BODIES[locale][id]] as [string, LessonBody]),
  ];
}

describe("the lessons' words", () => {
  it("give every lesson and reference page an outline in both languages, with the same number of goals", () => {
    for (const id of [...LESSON_IDS, ...REFERENCE_IDS]) {
      for (const locale of ["en", "hr"] as const) {
        const outline = LESSON_OUTLINES[locale][id];
        expect(outline, `${locale}/${id}`).toBeDefined();
        expect(outline.summary.length, `${locale}/${id}`).toBeGreaterThan(20);
        expect(outline.summary.length, `${locale}/${id}`).toBeLessThanOrEqual(160);
        expect(outline.goals.length, `${locale}/${id}`).toBeGreaterThanOrEqual(3);
        expect(outline.goals.length, `${locale}/${id}`).toBeLessThanOrEqual(5);
      }
      expect(LESSON_OUTLINES.hr[id].goals.length, id).toBe(LESSON_OUTLINES.en[id].goals.length);
      // Goals may link a reference page, the same ones in both languages; a summary is plain text.
      expect(LESSON_OUTLINES.hr[id].goals.map(linksOf), id).toEqual(LESSON_OUTLINES.en[id].goals.map(linksOf));
      for (const locale of ["en", "hr"] as const) expect(linksOf(LESSON_OUTLINES[locale][id].summary), `${locale}/${id}`).toEqual([]);
    }
    // No outline for an id that is neither a lesson nor a reference page.
    for (const locale of ["en", "hr"] as const) {
      expect(Object.keys(LESSON_OUTLINES[locale]).sort()).toEqual([...LESSON_IDS, ...REFERENCE_IDS].sort());
    }
  });

  it("give every reference page a body in both languages, with the same structure", () => {
    for (const id of REFERENCE_IDS) {
      expect(REFERENCE_BODIES.en[id], id).toBeDefined();
      expect(REFERENCE_BODIES.hr[id], id).toBeDefined();
      expect(bodyShape(REFERENCE_BODIES.hr[id]), id).toEqual(bodyShape(REFERENCE_BODIES.en[id]));
    }
  });

  it("link only reference pages, and only from paragraphs, list items, rules and goals", () => {
    let links = 0;
    for (const locale of ["en", "hr"] as const) {
      for (const [id, body] of allBodies(locale)) {
        const { linked, plain } = texts(body);
        for (const text of linked) {
          for (const ref of linksOf(text)) {
            expect(isReferenceId(ref), `${locale}/${id}: ${ref}`).toBe(true);
            links += 1;
          }
          expect(plainText(text)).not.toMatch(/\[\[|\]\]/);
        }
        for (const text of plain) expect(text, `${locale}/${id}`).not.toMatch(/\[\[/);
      }
      for (const id of [...LESSON_IDS, ...REFERENCE_IDS]) {
        for (const goal of LESSON_OUTLINES[locale][id].goals) {
          for (const ref of linksOf(goal)) expect(isReferenceId(ref), `${locale}/${id}: ${ref}`).toBe(true);
        }
      }
    }
    expect(links).toBeGreaterThan(0);
  });

  it("fold L1's maths and range ideas into the first lesson that needs them, linking the reference page (L1.1)", () => {
    const outlineLinks = (locale: "en" | "hr", id: LessonId) => LESSON_OUTLINES[locale][id].goals.flatMap(linksOf);
    const bodyLinks = (locale: "en" | "hr", id: LessonId) => texts(LESSON_BODIES[locale][id]!).linked.flatMap(linksOf);
    for (const locale of ["en", "hr"] as const) {
      // Written: in the lesson's text, in place.
      expect(bodyLinks(locale, "facing-an-open")).toEqual(expect.arrayContaining(["pot-odds", "equity-realisation-and-implied-odds"]));
      // Written in L2: alpha / MDF where a flop bet is defended, range and nut advantage where the flop bet is sized.
      expect(bodyLinks(locale, "defending-vs-cbets")).toContain("bluffing-math-alpha-mdf");
      expect(bodyLinks(locale, "cbet-by-texture")).toEqual(expect.arrayContaining(["range-advantage", "nut-advantage"]));
      // Written in L3: combos and card removal where river bluffs are picked.
      expect(bodyLinks(locale, "choosing-bluffs-blockers")).toContain("combos-and-card-removal");
      // In the outline too.
      expect(outlineLinks(locale, "defending-vs-cbets")).toContain("bluffing-math-alpha-mdf");
      expect(outlineLinks(locale, "choosing-bluffs-blockers")).toContain("combos-and-card-removal");
      expect(outlineLinks(locale, "cbet-by-texture")).toEqual(expect.arrayContaining(["range-advantage", "nut-advantage"]));
    }
    // A written target carries the idea in its body: the two flop lessons since L2, R1's since L3.
    expect(LESSONS["defending-vs-cbets"].written).toBe(true);
    expect(LESSONS["cbet-by-texture"].written).toBe(true);
    expect(LESSONS["choosing-bluffs-blockers"].written).toBe(true);
  });

  it("teach the maths in place where a flop lesson decides with it (L2)", () => {
    const checksOf = (id: LessonId) => {
      const body = LESSON_BODIES.en[id]!;
      const all = [...body.checks];
      for (const block of blocks(body)) if (typeof block !== "string" && "checkpoint" in block && block.checkpoint.math) all.push(block.checkpoint.math);
      return all.map((check) => check.fn);
    };
    expect(checksOf("defending-vs-cbets")).toEqual(expect.arrayContaining(["alpha", "mdf", "requiredEquity"]));
    expect(checksOf("cbet-why-and-when")).toEqual(expect.arrayContaining(["alpha", "bluffEv"]));
    expect(checksOf("spr-and-commitment")).toContain("spr");
    expect(checksOf("multiway-principles")).toEqual(expect.arrayContaining(["allFold", "mdfSplit"]));
    // L3: the turn and river lessons price in place too.
    expect(checksOf("double-barreling")).toContain("alpha");
    expect(checksOf("facing-turn-barrels")).toEqual(expect.arrayContaining(["requiredEquity", "mdf"]));
    expect(checksOf("turn-sizing-and-overbets")).toContain("geometricBet");
    expect(checksOf("3bp-turn")).toContain("spr");
    expect(checksOf("river-polarisation")).toContain("bluffShare");
    expect(checksOf("bluff-catching")).toEqual(expect.arrayContaining(["requiredEquity", "bluffCatcherEv", "mdf"]));
    expect(checksOf("river-sizing")).toEqual(expect.arrayContaining(["alpha", "mdf"]));
    expect(checksOf("3bp-river")).toEqual(expect.arrayContaining(["alpha", "requiredEquity"]));
    // The board table is Rail's own library, on the lesson that sizes flop bets.
    const widgets = [...blocks(LESSON_BODIES.en["cbet-by-texture"]!)].flatMap((block) => (typeof block !== "string" && "widget" in block ? [block.widget.id] : []));
    expect(widgets).toContain("flop-bets");
  });

  it("say on every lesson with flop drills that a mapped flop is read by category (principle 5)", () => {
    for (const meta of writtenLessons()) {
      if (!meta.exercises.some(readsFlopLibrary)) continue;
      expect(meta.notes ?? [], meta.id).toContain("flop-mapped");
    }
  });

  it("have a body in both languages exactly for the written lessons", () => {
    for (const meta of courseOrder()) {
      expect(Boolean(LESSON_BODIES.en[meta.id]), `en/${meta.id}`).toBe(meta.written);
      expect(Boolean(LESSON_BODIES.hr[meta.id]), `hr/${meta.id}`).toBe(meta.written);
    }
  });

  it("have the same structure in English and Croatian", () => {
    for (const meta of writtenLessons()) {
      expect(bodyShape(LESSON_BODIES.hr[meta.id]!), meta.id).toEqual(bodyShape(LESSON_BODIES.en[meta.id]!));
    }
  });

  it("introduce every exercise of the lesson, and no other", () => {
    for (const meta of writtenLessons()) {
      for (const locale of ["en", "hr"] as const) {
        const body = LESSON_BODIES[locale][meta.id]!;
        expect(Object.keys(body.exercises).sort(), `${locale}/${meta.id}`).toEqual(meta.exercises.map((def) => def.id).sort());
        for (const line of Object.values(body.exercises)) expect(line.length).toBeGreaterThan(10);
      }
    }
  });

  it("teach in sections, with checkpoints whose answers exist, and rules of thumb", () => {
    for (const meta of writtenLessons()) {
      const body = LESSON_BODIES.en[meta.id]!;
      expect(body.sections.length, meta.id).toBeGreaterThanOrEqual(3);
      const checkpoints = [...blocks(body)].filter((block) => typeof block !== "string" && "checkpoint" in block);
      expect(checkpoints.length, meta.id).toBeGreaterThanOrEqual(1);
      for (const block of checkpoints) {
        const c = (block as { checkpoint: { options: readonly string[]; answer: number } }).checkpoint;
        expect(c.options.length).toBeGreaterThanOrEqual(2);
        expect(c.options.length).toBeLessThanOrEqual(5);
        expect(c.answer).toBeGreaterThanOrEqual(0);
        expect(c.answer).toBeLessThan(c.options.length);
        expect(new Set(c.options).size, meta.id).toBe(c.options.length);
      }
      expect(body.heuristics.rules.length).toBeGreaterThanOrEqual(2);
      expect(body.heuristics.breaks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("open every widget on a preset that exists", () => {
    for (const [id, body] of allBodies("en")) {
      for (const block of blocks(body)) {
        if (typeof block === "string") continue;
        const preset = "widget" in block ? block.widget : "checkpoint" in block ? block.checkpoint.reveal : undefined;
        if (preset) expect(presetProblem(preset), `${id}: ${JSON.stringify(preset)}`).toBeNull();
      }
    }
  });

  it("recompute every number a lesson or reference page states", () => {
    const all: Array<[string, MathCheck]> = [];
    for (const [id, body] of allBodies("en")) {
      for (const check of body.checks) all.push([id, check]);
      for (const block of blocks(body)) {
        if (typeof block !== "string" && "checkpoint" in block && block.checkpoint.math) all.push([id, block.checkpoint.math]);
      }
    }
    expect(all.length).toBeGreaterThan(20);
    for (const [id, check] of all) {
      expect(MATH[check.fn], `${id}: ${check.fn}`).toBeDefined();
      expect(checkHolds(check), `${id}: ${check.fn}(${check.args.join(", ")}) = ${MATH[check.fn](...check.args)} ≠ ${check.value}`).toBe(true);
    }
  });

  it("carry an honesty banner where the catalogue says the engine cannot solve the spot yet", () => {
    for (const meta of writtenLessons()) {
      if (!meta.notes?.length) continue;
      for (const locale of ["en", "hr"] as const) {
        const notes = [...blocks(LESSON_BODIES[locale][meta.id]!)].filter((block) => typeof block !== "string" && "note" in block);
        expect(notes.length, `${locale}/${meta.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("put the Learn banners' words in both dictionaries", () => {
    for (const note of LESSON_NOTES) {
      expect(en.course.notes[note]).toBeTruthy();
      expect(hr.course.notes[note]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------- practice - */

describe("generated calc items", () => {
  const SEEDS = Array.from({ length: 25 }, (_, i) => (i + 1) * 104729);

  it("are the same item for the same seed, and pass with their own answer", () => {
    for (const kind of CALC_KINDS) {
      for (const seed of SEEDS) {
        const item = generateCalc(kind, seed);
        expect(generateCalc(kind, seed)).toEqual(item);
        expect(Number.isFinite(item.answer), `${kind}/${seed}`).toBe(true);
        expect(gradeCalc(item, item.answer).correct, `${kind}/${seed}`).toBe(true);
        if (item.unit !== "grade") {
          expect(gradeCalc(item, item.answer + item.tolerance * 2 + 0.5).correct).toBe(false);
          expect(gradeCalc(item, item.answer - item.tolerance * 2 - 0.5).correct).toBe(false);
        } else {
          expect(gradeCalc(item, (item.answer + 1) % GRADES.length).correct).toBe(false);
        }
      }
    }
  });

  it("ask grades that grade() itself gives, over every grade", () => {
    const seen = new Set<number>();
    for (const seed of Array.from({ length: 80 }, (_, i) => i * 7919 + 3)) {
      const item = generateCalc("grade", seed);
      const p = item.params as { options: OptionAnalysis[]; chosen: number; pot: number };
      expect(GRADES.indexOf(grade({ options: p.options, chosen: p.chosen, pot: p.pot }).grade)).toBe(item.answer);
      seen.add(item.answer);
    }
    expect(seen.size).toBe(GRADES.length);
  });

  it("price calls, steals and the big blind's defence with the concept library's formulas", () => {
    const pot = generateCalc("pot-odds", 42);
    const { pot: p, bet } = pot.params as { pot: number; bet: number };
    expect(pot.answer).toBeCloseTo(bet / (p + 2 * bet), 9);
    const steal = generateCalc("steal", 42);
    const open = (steal.params as { open: number }).open;
    expect(steal.answer).toBeCloseTo(open / (1.5 + open), 9);
    const blind = generateCalc("blind-price", 42);
    const o = (blind.params as { open: number }).open;
    expect(blind.answer).toBeCloseTo((o - 1) / (2 * o + 0.5), 9);
  });

  it("enumerate draw equities exactly: two hands' shares add to one", () => {
    for (const seed of [1, 2, 3]) {
      const item = generateCalc("outs-equity", seed);
      const p = item.params as { flop: string[]; hero: string[]; villain: string[] };
      const a = exactEquity(toIndices(p.hero), toIndices(p.villain), toIndices(p.flop));
      const b = exactEquity(toIndices(p.villain), toIndices(p.hero), toIndices(p.flop));
      expect(a).toBeCloseTo(item.answer, 12);
      expect(a + b).toBeCloseTo(1, 12);
      expect(item.working.outs).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("generated classify items", () => {
  it("are deterministic, gradable, and answered by the engine's own words", () => {
    for (const kind of CLASSIFY_KINDS) {
      const seeds = kind === "turn-card" ? [11, 22] : kind === "range-advantage" || kind === "nut-advantage" ? [11, 22, 33, 44] : [11, 22, 33, 44, 55, 66, 77, 88];
      for (const seed of seeds) {
        const item = generateClassify(kind, seed);
        expect(item.buckets).toContain(item.answer);
        expect(gradeClassify(item, item.answer)).toBe(true);
        expect(gradeClassify(item, item.buckets.find((b) => b !== item.answer)!)).toBe(false);
        if (kind !== "turn-card") expect(generateClassify(kind, seed)).toEqual(item);
        const board = toIndices(item.board);
        const texture = boardTexture(board)!;
        if (kind === "texture") {
          const truth = { suits: texture.suits, pairing: texture.paired ? "paired" : "unpaired", connectedness: texture.connectedness, "high-card": texture.highCard }[item.ask];
          expect(item.answer).toBe(truth);
        }
        if (kind === "dynamism") expect(item.answer).toBe(texture.dynamism);
        if (kind === "hand-class") expect(item.answer).toBe(handBucket(toIndices(item.hand!), board)!.bucket);
        if (kind === "range-advantage") {
          const equity = Number(item.detail.equity);
          expect(item.answer === "raiser" ? equity >= RAISER_FAVOURED - 0.0005 : equity <= CLOSE_MAX + 0.0005).toBe(true);
        }
      }
    }
  });

  it("sort hands into the five plain buckets", () => {
    expect(handBucket(toIndices(["Ah", "As"]), toIndices(["Kd", "7c", "2h"]))!.bucket).toBe("top");
    expect(handBucket(toIndices(["7h", "7s"]), toIndices(["Kd", "7c", "2h"]))!.bucket).toBe("strong");
    expect(handBucket(toIndices(["8h", "8s"]), toIndices(["Kd", "7c", "2h"]))!.bucket).toBe("middle");
    expect(handBucket(toIndices(["Qh", "Jh"]), toIndices(["Th", "9h", "2c"]))!.bucket).toBe("draw");
    expect(handBucket(toIndices(["Qc", "Jd"]), toIndices(["5h", "4h", "2c"]))!.bucket).toBe("air");
  });
});

describe("pass rules", () => {
  it("need a share of the asked count, and a finished session", () => {
    expect(needed(10, 0.7)).toBe(7);
    expect(needed(6, 0.67)).toBe(5);
    expect(needed(3, 0.5)).toBe(2);
    expect(passes(7, 10, 10, 0.7)).toBe(true);
    expect(passes(6, 10, 10, 0.7)).toBe(false);
    expect(passes(7, 9, 10, 0.7)).toBe(false);
  });
});

/* ------------------------------------------------------------- progress - */

describe("lesson progress", () => {
  const ID = "facing-an-open";
  const EX = "call-3bet-fold";
  const meta = LESSONS[ID];

  it("keeps an exercise's latest score, and its pass and the lesson's pass sticky", () => {
    let map: ProgressMap = {};
    map = applyResult(map, { lesson: ID, exercise: EX, correct: 8, total: 10, passed: true }, NOW);
    expect(lessonStatus(map[ID])).toBe("in-progress");
    map = applyResult(map, { lesson: ID, exercise: EX, correct: 4, total: 10, passed: false }, NOW);
    expect(map[ID]!.exercises[EX]).toMatchObject({ correct: 4, total: 10, passed: true, attempts: 2 });
    map = applyResult(map, { lesson: ID, exercise: null, lessonPassed: true }, NOW);
    expect(lessonStatus(map[ID])).toBe("mastered");
    map = applyResult(map, { lesson: ID, exercise: EX, correct: 1, total: 10, passed: false, lessonPassed: false }, NOW);
    expect(map[ID]!.status).toBe("passed");
    expect(map[ID]!.passedAt).toBe(NOW.toISOString());
  });

  it("passes a lesson automatically when its last counted exercise passes, ignoring own hands", () => {
    expect(requiredExercises(meta).map((def) => def.id)).toEqual([EX]);
    const first = exerciseResult({}, meta, EX, 6, 12, false);
    expect(first.lessonPassed).toBe(false);
    const passed = exerciseResult({}, meta, EX, 10, 12, true);
    expect(passed.lessonPassed).toBe(true);
    const map = applyResult({}, passed, NOW);
    expect(lessonComplete(meta, map[ID]!.exercises)).toBe(true);
    // Already passed: a later result does not "pass" it again.
    expect(exerciseResult(map, meta, EX, 12, 12, true).lessonPassed).toBe(false);
  });

  it("needs every counted exercise of a lesson with several", () => {
    const m = LESSONS["facing-3bets-and-4bets"];
    expect(exerciseResult({}, m, "vs-3bet", 9, 10, true).lessonPassed).toBe(false);
    const map = applyResult({}, exerciseResult({}, m, "vs-3bet", 9, 10, true), NOW);
    expect(exerciseResult(map, m, "vs-4bet", 5, 6, true).lessonPassed).toBe(true);
  });

  it("reads stored rows and the browser's storage defensively", () => {
    const map = progressFromRows([
      { lesson_id: ID, status: "passed", exercises: { [EX]: { correct: 8, total: 10, passed: true, attempts: 1, at: "x" } }, started_at: "a", passed_at: "b" },
      { lesson_id: "not-a-lesson", status: "passed", exercises: {} },
      { lesson_id: "three-betting", status: "started", exercises: { "Bad Id": {}, "three-bet-or-not": "junk" } },
      // L1.1: rows of lessons that left the map stay in the database, and are not shown.
      { lesson_id: "pot-odds", status: "passed", exercises: { "price-drill": { correct: 8, total: 10, passed: true, attempts: 1, at: "x" } } },
      { lesson_id: "how-rail-teaches", status: "started", exercises: {} },
    ]);
    expect(Object.keys(map).sort()).toEqual([ID, "three-betting"]);
    expect(map["three-betting"]!.exercises).toEqual({});
    expect(parseLocalProgress("{broken")).toEqual({});
    expect(parseLocalProgress(JSON.stringify(map))).toEqual(map);
    expect(parseLocalCards("[1,2,{}]")).toEqual([]);
  });

  it("turns local progress back into results that rebuild it", () => {
    let map: ProgressMap = {};
    map = applyResult(map, exerciseResult(map, meta, EX, 10, 12, true), NOW);
    map = applyResult(map, { lesson: "three-betting", exercise: null }, NOW);
    let rebuilt: ProgressMap = {};
    for (const result of progressAsResults(map)) rebuilt = applyResult(rebuilt, result, NOW);
    expect(lessonStatus(rebuilt[ID])).toBe("mastered");
    expect(lessonStatus(rebuilt["three-betting"])).toBe("in-progress");
    // A browser that kept progress on a lesson that left the map: dropped when read back.
    expect(Object.keys(parseLocalProgress(JSON.stringify({ ...map, "pot-odds": map[ID] })))).not.toContain("pot-odds");
  });
});

describe("review cards", () => {
  it("round-trip every generated exercise's item through storage", () => {
    for (const meta of courseOrder()) {
      for (const def of meta.exercises) {
        // Flop spots and splits too (L2): a card stores only the spec, the library is read when it is replayed.
        if (isPlanned(def) || def.kind === "own-hands") continue;
        const card = cardFor(meta, def, 123456);
        expect(card.key).toMatch(/^[a-z0-9][a-z0-9:._-]{2,159}$/);
        expect(JSON.stringify(card.item).length).toBeLessThan(2048);
        expect(parseCardItem(JSON.parse(JSON.stringify(card.item)))).toEqual(card.item);
      }
    }
    // L2's kinds: a flop spot and a split, stored as solver-spot cards (no migration: the database checks only the card kind).
    const flop = cardFor(LESSONS["facing-a-check-raise"], LESSONS["facing-a-check-raise"].exercises[0] as GeneratedExerciseDef, 5);
    expect(flop.kind).toBe("solver-spot");
    expect(flop.item).toMatchObject({ k: "flop", facing: "raise", role: "pfr" });
    const split = cardFor(LESSONS["check-raising"], LESSONS["check-raising"].exercises[0] as GeneratedExerciseDef, 6);
    expect(split.kind).toBe("solver-spot");
    expect(split.item).toMatchObject({ k: "split", street: "flop", facing: "bet", seat: "oop" });
    // L3: a river split, a turn split after a checked flop, and the two kinds of paint.
    expect(parseCardItem({ k: "split", street: "river", seed: 1, pot: "srp", seat: "ip", role: "any" })).toEqual({ k: "split", street: "river", seed: 1, pot: "srp", seat: "ip", role: "any" });
    expect(parseCardItem({ k: "split", street: "turn", seed: 1, pot: "srp", seat: "oop", role: "caller", flop: "checked" })).toMatchObject({ flop: "checked" });
    expect(parseCardItem({ k: "split", street: "river", seed: 1, pot: "srp", seat: "ip", role: "any", flop: "checked" })).not.toHaveProperty("flop");
    expect(parseCardItem({ k: "split", street: "preflop", seed: 1, pot: "srp", seat: "ip", role: "any" })).toBeNull();
    const paintChart = cardFor(LESSONS["positions-and-opening-ranges"], LESSONS["positions-and-opening-ranges"].exercises[2] as GeneratedExerciseDef, 9);
    expect(paintChart.kind).toBe("chart-quiz");
    expect(paintChart.item).toMatchObject({ k: "paint", source: "chart", set: "nlhe-cash-6max-100bb" });
    const paintRiver = cardFor(LESSONS["river-polarisation"], LESSONS["river-polarisation"].exercises[1] as GeneratedExerciseDef, 9);
    expect(paintRiver.kind).toBe("solver-spot");
    expect(paintRiver.item).toMatchObject({ k: "paint", source: "river", facing: "check", seat: "ip" });
    expect(parseCardItem({ k: "paint", source: "chart", seed: 1, set: "../x" })).toEqual({ k: "paint", source: "chart", seed: 1, set: null, seat: null });
    expect(parseCardItem({ k: "paint", source: "river", seed: 1 })).toBeNull();
    const turn = cardFor(LESSONS["turn-after-flop-checks-through"], LESSONS["turn-after-flop-checks-through"].exercises[0] as GeneratedExerciseDef, 4);
    expect(turn.item).toMatchObject({ k: "turn", flop: "checked", facing: "check" });
    expect(parseCardItem({ k: "flop", seed: 1, pot: "srp", seat: "ip", role: "any", line: "../x" })).toEqual({ k: "flop", seed: 1, pot: "srp", seat: "ip", role: "any", bias: "range" });
    expect(parseCardItem({ k: "calc", calc: "nope", seed: 1 })).toBeNull();
    expect(parseCardItem({ k: "chart", seed: -1, family: "rfi" })).toBeNull();
  });

  it("schedule a browser-kept card by the drills' SM-2, and bring a missed-again card back now", () => {
    const meta = LESSONS["open-sizing"];
    const def = meta.exercises[0];
    if (def.kind !== "calc") throw new Error("open-sizing starts with a calc exercise");
    const card = localCard(cardFor(meta, def, 7), NOW);
    const right = reviewLocalCard(card, "perfect", NOW);
    expect(right.state.intervalDays).toBe(1);
    expect(right.state.reps).toBe(1);
    const wrong = reviewLocalCard(right, "mistake", NOW);
    expect(wrong.state.reps).toBe(0);
    expect(wrong.state.lapses).toBe(1);
    const later = new Date(NOW.getTime() + 5 * 86_400_000);
    const deck = addLocalCards([right], [cardFor(meta, def, 7)], later);
    expect(deck).toHaveLength(1);
    expect(Date.parse(deck[0].state.dueAt)).toBeLessThanOrEqual(later.getTime());
    expect(parseLocalCards(JSON.stringify(deck))).toEqual(deck);
  });
});

/* -------------------------------------------------------- recommendations - */

describe("recommendations from leaks", () => {
  const area = (street: string, scenario: string, family: string, hero: string, best = "raise") => ({
    id: [street, scenario, family, hero, "-"].join("~"),
    where: { street, scenario, family, hero, villain: "-" },
    leaks: [{ id: "x", taken: "fold", best, evLossBb: 3, mistakes: 3 }],
    evLossBb: 3,
    per100: 1.25,
  });

  it("matches scenario patterns with wildcards", () => {
    expect(globMatch("pfr-*-first", "pfr-ip-first")).toBe(true);
    expect(globMatch("pfr-*-first", "pfr-mw-ip-first")).toBe(true);
    expect(globMatch("pfr-ip-*", "caller-ip-first")).toBe(false);
    expect(globMatch("vs-open", "vs-open")).toBe(true);
    expect(patternScore({ street: "flop", scenarios: ["pfr-*-first"] }, { street: "turn", scenario: "pfr-ip-first", family: "first", hero: "BTN" })).toBe(0);
    // Merged to the family: still matches, less specifically.
    expect(patternScore({ street: "river", scenarios: ["caller-*-vs-bet"] }, { street: "river", scenario: "*", family: "vs-bet", hero: "*" })).toBe(2);
  });

  it("sends a leak to the written lesson that teaches its spot", () => {
    const written = { writtenOnly: true } as const;
    expect(lessonForArea(area("preflop", "unopened", "first-in", "UTG"), written)).toBe("positions-and-opening-ranges");
    expect(lessonForArea(area("preflop", "vs-open", "vs-raise", "BB", "call"), written)).toBe("blind-play-and-bvb");
    expect(lessonForArea(area("preflop", "vs-open", "vs-raise", "BTN", "raise"), written)).toBe("three-betting");
    expect(lessonForArea(area("preflop", "vs-open", "vs-raise", "CO", "call"), written)).toBe("facing-an-open");
    expect(lessonForArea(area("preflop", "vs-3bet", "vs-reraise", "CO"), written)).toBe("facing-3bets-and-4bets");
    expect(lessonForArea(area("preflop", "squeeze", "vs-raise", "BB"), written)).toBe("squeezes-and-multiway-preflop");
    expect(lessonForArea(area("preflop", "vs-limp", "first-in", "BTN"), written)).toBe("limpers-and-isolation");
    // L2: flop leaks go to the F lessons (L1.1's stand-in, the 3-bet-pot range split, is gone).
    expect(lessonForArea(area("flop", "pfr-ip-first", "first", "BTN", "bet"), written)).toBe("cbet-why-and-when");
    expect(lessonForArea(area("flop", "pfr-ip-first", "first", "BTN", "check"), written)).toBe("hand-classes-on-the-flop");
    expect(lessonForArea(area("flop", "pfr-oop-first", "first", "SB", "bet"), written)).toBe("oop-as-the-raiser");
    expect(lessonForArea(area("flop", "pfr-ip-vs-raise", "vs-raise", "BTN", "call"), written)).toBe("facing-a-check-raise");
    expect(lessonForArea(area("flop", "caller-oop-vs-bet", "vs-bet", "BB", "call"), written)).toBe("defending-vs-cbets");
    expect(lessonForArea(area("flop", "caller-oop-vs-bet", "vs-bet", "BB", "raise"), written)).toBe("check-raising");
    expect(lessonForArea(area("flop", "caller-ip-first", "first", "BB", "bet"), written)).toBe("floating-and-stabbing-ip");
    expect(lessonForArea(area("flop", "caller-oop-first", "first", "BB", "check"), written)).toBe("probes-and-donk-bets");
    // L3: turn and river leaks land on the T and R lessons.
    expect(lessonForArea(area("turn", "pfr-ip-first", "first", "BTN", "bet"), written)).toBe("double-barreling");
    expect(lessonForArea(area("turn", "pfr-ip-first", "first", "BTN", "check"), written)).toBe("double-barreling");
    expect(lessonForArea(area("turn", "caller-oop-vs-bet", "vs-bet", "BB", "call"), written)).toBe("facing-turn-barrels");
    expect(lessonForArea(area("turn", "caller-oop-vs-bet", "vs-bet", "BB", "raise"), written)).toBe("turn-check-raise-and-probe");
    expect(lessonForArea(area("turn", "caller-oop-first", "first", "BB", "bet"), written)).toBe("turn-check-raise-and-probe");
    expect(lessonForArea(area("river", "pfr-ip-first", "first", "BTN", "check"), written)).toBe("choosing-bluffs-blockers");
    expect(lessonForArea(area("river", "caller-ip-vs-raise", "vs-raise", "BTN", "fold"), written)).toBe("facing-river-raises");
    expect(lessonForArea(area("flop", "caller-mw-oop-vs-bet", "vs-bet", "BB", "call"), written)).toBe("multiway-principles");
    expect(lessonForArea(area("river", "pfr-oop-first", "first", "SB", "bet"), written)).toBe("thin-value");
    expect(lessonForArea(area("river", "caller-ip-vs-bet", "vs-bet", "BTN", "call"), written)).toBe("bluff-catching");
    // L4: a river call the reference folds is a call against too few bluffs.
    expect(lessonForArea(area("river", "caller-ip-vs-bet", "vs-bet", "BTN", "fold"), written)).toBe("underbluffed-rivers");
    expect(lessonForArea(area("river", "pfr-oop-vs-bet", "vs-bet", "SB", "fold"), written)).toBe("underbluffed-rivers");
    // The map also badges lessons that are coming soon, in the track of the hand's street.
    expect(lessonForArea(area("river", "pfr-oop-first", "first", "SB", "bet"))).toBe("thin-value");
    expect(lessonForArea(area("river", "caller-ip-vs-bet", "vs-bet", "BTN", "call"))).toBe("bluff-catching");
    expect(lessonForArea(area("flop", "caller-oop-vs-bet", "vs-bet", "BB", "call"))).toBe("defending-vs-cbets");
    expect(lessonForArea(area("turn", "caller-ip-vs-bet", "vs-bet", "BTN", "fold"))).toBe("facing-turn-barrels");
  });

  it("points every leak and flag at a lesson on the map, never at a reference page (L1.1)", () => {
    const flagged = new Set(courseOrder().flatMap((meta) => meta.match.flags));
    // Every heuristic flag still has a lesson that explains it.
    for (const flag of FLAG_CODES) expect(flagged.has(flag), flag).toBe(true);
    for (const flag of FLAG_CODES) {
      for (const rec of recommend([], [{ code: flag, decisions: 9 }])) expect(isLessonId(rec.lesson), `${flag} → ${rec.lesson}`).toBe(true);
    }
    for (const street of ["preflop", "flop", "turn", "river"]) {
      for (const scenario of ["unopened", "vs-open", "vs-3bet", "pfr-ip-first", "pfr-oop-first", "caller-ip-vs-bet", "caller-oop-vs-bet", "pfr-ip-vs-raise"]) {
        const id = lessonForArea(area(street, scenario, "*", "*", "call"));
        if (id !== null) {
          expect(isLessonId(id)).toBe(true);
          expect(isReferenceId(id)).toBe(false);
        }
      }
    }
  });

  it("never recommends a passed lesson, and adds lessons for flags seen often", () => {
    const passed = new Set<LessonId>(["positions-and-opening-ranges"]);
    expect(lessonForArea(area("preflop", "unopened", "first-in", "UTG"), { passed, writtenOnly: true })).toBe("open-sizing");
    const recs = recommend([area("preflop", "unopened", "first-in", "UTG")], [{ code: "check-back-nuts", decisions: 5 }, { code: "fold-nuts", decisions: 1 }]);
    expect(recs.map((rec) => [rec.lesson, rec.reason])).toEqual([
      ["positions-and-opening-ranges", "leak"],
      ["checking-back-and-delayed-cbets", "flag"],
    ]);
    expect(recs[0].per100).toBe(1.25);
    // L4: an exploit flag reaches the X2 lesson once the lesson that carries it first is passed.
    const done = new Set<LessonId>(["bluff-catching"]);
    expect(recommend([], [{ code: "call-beats-nothing", decisions: 5 }], { passed: done }).map((rec) => rec.lesson)).toEqual(["underbluffed-rivers"]);
  });
});

/* ------------------------------------------------------------- exploits - */

describe("the exploits track (L4)", () => {
  it("says on every lesson with a lab exercise that a lock is a read on a river solve (principle 5)", () => {
    for (const meta of writtenLessons()) {
      if (!meta.exercises.some((def) => def.kind === "node-lock")) continue;
      expect(meta.notes ?? [], meta.id).toContain("locked-read");
      expect(meta.notes ?? [], meta.id).toContain("approximate-ranges");
    }
    // The planned node-lock of L1.1 is built: no exercise waits for it any more.
    for (const meta of courseOrder()) for (const def of meta.exercises) expect(isPlanned(def) && def.kind === ("node-lock" as string), meta.id).toBe(false);
  });

  it("stores a lab item as a solver-spot card of its preset", () => {
    const meta = LESSONS["exploiting-overfolders"];
    const def = meta.exercises.find((d) => d.kind === "node-lock") as GeneratedExerciseDef;
    const card = cardFor(meta, def, 77);
    expect(card.kind).toBe("solver-spot");
    expect(card.item).toEqual({ k: "lock", seed: 77, preset: "overfold" });
    expect(parseCardItem({ k: "lock", seed: 1, preset: "any" })).toEqual({ k: "lock", seed: 1, preset: "any" });
    expect(parseCardItem({ k: "lock", seed: 1, preset: "nope" })).toBeNull();
  });

  it("shows the learner's own pool on the X lessons that read one, and the lab on the X2 lessons", () => {
    expect(LESSONS["exploiting-overfolders"].pool).toBe("overfold");
    expect(LESSONS["exploiting-calling-stations"].pool).toBe("station");
    expect(LESSONS["exploiting-aggressive-players"].pool).toBe("aggro");
    expect(LESSONS["underbluffed-rivers"].pool).toBe("underbluff");
    expect(LESSONS["reading-hud-stats"].pool).toBe("all");
    const presets = (id: LessonId) => LESSONS[id].exercises.flatMap((def) => (def.kind === "node-lock" ? [def.preset] : []));
    expect(presets("exploiting-overfolders")).toEqual(["overfold"]);
    expect(presets("exploiting-calling-stations")).toEqual(["station", "passive"]);
    expect(presets("exploiting-aggressive-players")).toEqual(["maniac"]);
    expect(presets("underbluffed-rivers")).toEqual(["underbluff"]);
    for (const topic of Object.keys(POOL_TOPIC_STATS) as Array<keyof typeof POOL_TOPIC_STATS>) {
      for (const stat of POOL_TOPIC_STATS[topic]) expect(POOL_STATS).toContain(stat);
    }
  });

  it("works the sampling arithmetic the HUD lesson teaches", () => {
    // 1.96 × √(p(1 − p) / n), and its inverse.
    expect(marginOfError(0.3, 50)).toBeCloseTo(1.96 * Math.sqrt(0.21 / 50), 12);
    expect(sampleNeeded(0.3, marginOfError(0.3, 50))).toBeCloseTo(50, 9);
    expect(sampleNeeded(0.3, 0.025) / sampleNeeded(0.3, 0.05)).toBeCloseTo(4, 12);
    expect(marginOfError(0.3, 0)).toBe(Infinity);
    // The calc items name a widget the lesson can open.
    const item = generateCalc("sample-size", 5);
    expect(item.widget?.id).toBe("sample-size");
  });

  it("sums the opponents panel's rows into the learner's own pool, with each stat's chances and interval", () => {
    const row = (counters: Record<string, number>) => ({ counters });
    const pool = poolOf([
      row({ hands: 400, fold_to_cbet_flop: 30, fold_to_cbet_flop_opp: 50, wtsd: 40, wtsd_opp: 120, bet_flop: 30, raise_flop: 10, call_flop: 50, fold_flop: 30 }),
      row({ hands: 600, fold_to_cbet_flop: 42, fold_to_cbet_flop_opp: 70, wtsd: 50, wtsd_opp: 130, bet_turn: 20, call_river: 10 }),
    ]);
    expect(pool.players).toBe(2);
    expect(pool.hands).toBe(1000);
    const fold = pool.stats.foldToCbet;
    expect(fold.made).toBe(72);
    expect(fold.chances).toBe(120);
    expect(fold.value).toBeCloseTo(0.6, 12);
    expect(fold.margin).toBeCloseTo(marginOfError(0.6, 120), 12);
    expect(fold.level).toBe("rough");
    // Aggression: bets and raises over every postflop decision.
    expect(pool.stats.aggression.made).toBe(60);
    expect(pool.stats.aggression.chances).toBe(150);
    // No chance, no number.
    expect(pool.stats.threeBet).toMatchObject({ value: null, margin: null, level: "thin" });
    // 60% ± 8.8 over 120 chances clears the 33.3% a half-pot bluff needs: a read, with its lesson and lab preset.
    expect(poolReads(pool)).toEqual([expect.objectContaining({ stat: "foldToCbet", direction: "above", lesson: "exploiting-overfolders", preset: "overfold" })]);
  });

  it("reads nothing into a thin stat, and only a whole interval past the line", () => {
    expect(poolStat("foldToCbet", 9, MIN_CHANCES - 1).level).toBe("thin");
    const thin = poolOf([{ counters: { fold_to_cbet_flop: 7, fold_to_cbet_flop_opp: 10 } }]);
    expect(poolReads(thin)).toEqual([]);
    // 20% over 400 chances: ± 3.9, wholly below the 25% a third-pot bluff needs.
    const callers = poolOf([{ counters: { fold_to_cbet_flop: 80, fold_to_cbet_flop_opp: 400 } }]);
    expect(callers.stats.foldToCbet.level).toBe("settled");
    expect(poolReads(callers)).toEqual([expect.objectContaining({ direction: "below", lesson: "exploiting-calling-stations", preset: "station" })]);
    // 30% over 400: between the lines, no read.
    expect(poolReads(poolOf([{ counters: { fold_to_cbet_flop: 120, fold_to_cbet_flop_opp: 400 } }]))).toEqual([]);
    expect(poolOf([]).players).toBe(0);
  });

  it("puts the pool and lab words in both dictionaries", () => {
    for (const id of LAB_PRESET_IDS) {
      expect(en.course.lab.presets[id], id).toBeTruthy();
      expect(hr.course.lab.presets[id], id).toBeTruthy();
    }
    for (const id of POOL_STATS) {
      expect(en.course.pool.stats[id], id).toBeTruthy();
      expect(hr.course.pool.stats[id], id).toBeTruthy();
    }
    for (const lock of ["fold-to-bet", "never-raise", "air-bets"]) {
      expect(en.course.lab.lockLine[lock]("x")).toBeTruthy();
      expect(hr.course.lab.lockLine[lock]("x")).toBeTruthy();
    }
  });
});
