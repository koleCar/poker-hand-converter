/**
 * The Learn tab's course catalogue (`docs/LEARN-PLAN.md`): tracks, modules,
 * lessons, and what each lesson practises.
 *
 * Language-free, like `concepts.ts`: ids, order, prerequisites, the concepts a
 * lesson links, its exercises (what Rail's engine generates and grades), and
 * the spots and heuristic flags that tie it to the learner's own leaks. The
 * words live elsewhere: lesson titles in the dictionary (`course.titles`,
 * because the course map and the study plan name lessons client-side), and
 * the outline (summary, goals) and bodies in `lessons/`, which only the
 * server reads.
 *
 * `LessonId` is a closed union, so a prerequisite, a plan task or a link can
 * never name a lesson that does not exist (`tests/test/course.test.ts`).
 *
 * **Nothing locks.** Prerequisites are advice: the map shows them and suggests
 * an order, but every lesson opens. A lesson that is not written yet is in the
 * map as "coming soon" and its page says so.
 *
 * Same import rule as `lib/analysis`: pure TypeScript, no React, no framework.
 */

import type { FlagCode } from "../analysis/types";
import type { ChartPosition } from "../charts";
import type { DealBias, PreflopFamily } from "../training/preflop";
import type { RiverPot, RiverRole, RiverSeat } from "../training/river";
import type { ConceptId } from "./concepts";

/* ------------------------------------------------------------- structure - */

export const TRACK_IDS = ["foundations", "preflop", "postflop", "live"] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export const MODULE_IDS = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const TRACKS: Readonly<Record<TrackId, readonly ModuleId[]>> = {
  foundations: ["m0", "m1", "m2"],
  preflop: ["m3"],
  postflop: ["m4", "m5", "m6", "m7", "m8", "m9"],
  live: ["m10"],
};

export const LESSON_IDS = [
  // M0 orientation
  "how-rail-teaches",
  "gto-mixing-and-simplifying",
  "reading-rail-reports",
  "variance-bankroll-and-tilt",
  // M1 poker maths
  "pot-odds",
  "equity-and-outs",
  "expected-value",
  "combos-and-card-removal",
  "bluffing-math-alpha-mdf",
  "equity-realisation-and-implied-odds",
  // M2 ranges
  "thinking-in-ranges",
  "range-advantage",
  "nut-advantage",
  "board-texture",
  "who-the-next-card-helps",
  "range-narrowing",
  // M3 preflop
  "positions-and-opening-ranges",
  "open-sizing",
  "facing-an-open",
  "three-betting",
  "facing-3bets-and-4bets",
  "blind-play-and-bvb",
  "squeezes-and-multiway-preflop",
  "limpers-and-isolation",
  // M4 single-raised pots as the preflop raiser
  "cbet-why-and-when",
  "cbet-by-texture",
  "hand-classes-on-the-flop",
  "oop-as-the-raiser",
  "checking-back-and-delayed-cbets",
  "facing-a-check-raise",
  // M5 single-raised pots as the caller
  "defending-vs-cbets",
  "check-raising",
  "floating-and-stabbing-ip",
  "probes-and-donk-bets",
  "facing-turn-barrels",
  "bb-vs-btn-blueprint",
  // M6 3-bet and 4-bet pots
  "spr-and-commitment",
  "cbetting-as-the-3bettor",
  "playing-3bp-as-the-caller",
  "range-splitting-ip-vs-checks-3bp",
  "3bp-turn-and-river",
  "four-bet-pots",
  // M7 the turn
  "turn-card-classes",
  "double-barreling",
  "turn-sizing-and-overbets",
  "turn-after-flop-checks-through",
  // M8 the river
  "river-polarisation",
  "thin-value",
  "choosing-bluffs-blockers",
  "bluff-catching",
  "river-sizing",
  "facing-river-raises",
  // M9 multiway
  "multiway-principles",
  "multiway-as-the-raiser",
  "multiway-defence",
  "multiway-preflop-choices",
  // M10 live cash, deep stacks, straddles, exploits
  "live-game-dynamics",
  "straddle-preflop",
  "straddle-postflop-low-spr",
  "deep-stacks-200bb",
  "population-exploits",
  "player-profiles",
] as const;
export type LessonId = (typeof LESSON_IDS)[number];

/** Path segments under `/learn` that are not lessons. A lesson id may never be one. */
export const RESERVED_LEARN_SEGMENTS = ["review"] as const;

/* ------------------------------------------------------------- exercises - */

/** Generated, then graded by `lib/learn/practice.ts` (arithmetic from `math.ts`, exact equity, `grade()`). */
export const CALC_KINDS = [
  "pot-odds",
  "outs-equity",
  "ev",
  "combos",
  "alpha-mdf",
  "spr",
  "grade",
  "steal",
  "blind-price",
  "per100",
  "allin-ev",
  "multiway",
] as const;
export type CalcKind = (typeof CALC_KINDS)[number];

/** Sorting boards and hands into buckets, graded by `lib/analysis/texture.ts`, hand classes and range equity. */
export const CLASSIFY_KINDS = ["texture", "dynamism", "hand-class", "range-advantage", "nut-advantage", "turn-card"] as const;
export type ClassifyKind = (typeof CLASSIFY_KINDS)[number];

/**
 * Exercises that need a widget Rail does not have yet. They are typed so the
 * catalogue can name them now; the lesson page shows them as planned and they
 * never count towards passing a lesson.
 */
export const PLANNED_KINDS = ["range-split", "range-paint", "range-walk", "pot-tracking", "profile-quiz", "placement"] as const;
export type PlannedKind = (typeof PLANNED_KINDS)[number];

/** A spot as the leak finder names it. Scenario entries may use `*` as a wildcard (`pfr-ip-*`, `*-vs-bet`). */
export interface SpotPattern {
  street: "preflop" | "flop" | "turn" | "river";
  scenarios?: readonly string[];
  /** The hero's seat (`SpotAttrs.hero`). */
  heroes?: readonly string[];
  /** The reference's best action in the spot (`SpotRow.best`). */
  best?: readonly string[];
}

interface ExerciseBase {
  /** Unique within the lesson; kebab-case. Also the progress key. */
  id: string;
}

/** A preflop trainer session (`lib/training/preflop.ts`): the chart family, seat and set. */
export interface ChartQuizDef extends ExerciseBase {
  kind: "chart-quiz";
  count: number;
  /** Share of answers the reference plays (Perfect or Good) needed to pass. */
  pass: number;
  family: PreflopFamily | "random";
  seat?: ChartPosition | null;
  vs?: ChartPosition | null;
  /** Chart set id; the default 6-max 100bb set when absent. */
  set?: string;
  bias: DealBias;
}

/** Postflop trainer spots: river spots (A7) and turn spots (`lib/training/turn.ts`). The flop needs the A5b library. */
export interface SolverSpotDef extends ExerciseBase {
  kind: "solver-spot";
  street: "flop" | "turn" | "river";
  count: number;
  pass: number;
  pot: RiverPot | "any";
  seat: RiverSeat | "any";
  role: RiverRole | "any";
  /** In position: only spots where the villain checked to the hero (`check`) or bet (`bet`). */
  facing?: "check" | "bet" | "any";
  bias: DealBias;
}

export interface CalcDef extends ExerciseBase {
  kind: "calc";
  calc: CalcKind;
  count: number;
  pass: number;
}

export interface ClassifyDef extends ExerciseBase {
  kind: "classify";
  classify: ClassifyKind;
  count: number;
  pass: number;
}

/**
 * The learner's own analysed decisions that match the lesson: by spot, by
 * heuristic flag, or both; worst EV loss first, replayed spoiler-safe. Never
 * required (a signed-out reader, or one without hands, still passes).
 */
export interface OwnHandsDef extends ExerciseBase {
  kind: "own-hands";
  count: number;
  spots?: readonly SpotPattern[];
  flags?: readonly FlagCode[];
  /** The analysis' pot type filter (`3bet`, `single-raised`, …). */
  potType?: string;
}

export interface PlannedDef extends ExerciseBase {
  kind: PlannedKind;
  /** Why it waits: a widget to build, or the flop library (`FLOP_LIBRARY_ENABLED`). */
  waitsFor: "widget" | "flop-library" | "villain-stats" | "straddle-charts";
  street?: "flop" | "turn" | "river";
}

export type ExerciseDef = ChartQuizDef | SolverSpotDef | CalcDef | ClassifyDef | OwnHandsDef | PlannedDef;
export type GeneratedExerciseDef = ChartQuizDef | SolverSpotDef | CalcDef | ClassifyDef;

export function isPlanned(def: ExerciseDef): def is PlannedDef {
  return (PLANNED_KINDS as readonly string[]).includes(def.kind);
}

/**
 * Whether an exercise counts towards passing its lesson: every generated
 * exercise Rail can grade today. Own hands, planned widgets and flop spots
 * while the flop library is off do not.
 */
export function countsTowardsPass(def: ExerciseDef, flopLibrary = false): def is GeneratedExerciseDef {
  if (def.kind === "own-hands" || isPlanned(def)) return false;
  if (def.kind === "solver-spot" && def.street === "flop") return flopLibrary;
  return true;
}

/* --------------------------------------------------------------- lessons - */

/** Where an honesty banner is due: the analysis' own words for what the engine cannot solve yet. */
export type LessonNote = "flop-library-off" | "approximate-ranges" | "conceptual" | "straddle-not-analysed";

/**
 * A curated example hand from outside Rail, with where it came from. The slot
 * is here for the example hands a separate research job is collecting; none
 * are in the catalogue yet (L4).
 */
export interface LessonExample {
  id: string;
  source: { kind: "video"; channel: string; url: string; title: string; timestamp?: string };
  /** The hand in standard hand-history text, as Rail parses an upload. */
  handText: string;
}

export interface LessonMeta {
  id: LessonId;
  module: ModuleId;
  /** `M1-L1`. */
  code: string;
  /** Read first. Advice only: nothing locks. */
  prereqs: readonly LessonId[];
  /** Concept pages the lesson links (and reuses the widgets of), most useful first. */
  concepts: readonly ConceptId[];
  exercises: readonly ExerciseDef[];
  /** Which leaks and flags make this lesson a recommendation. */
  match: { spots: readonly SpotPattern[]; flags: readonly FlagCode[] };
  /** The lesson's text is written, in both languages. False: "coming soon". */
  written: boolean;
  notes?: readonly LessonNote[];
  examples?: readonly LessonExample[];
}

/* ------------------------------------------------------------- shorthand - */

const TABLE_6_100 = "nlhe-cash-6max-100bb";
const TABLE_9_100 = "nlhe-cash-9max-100bb";
const TABLE_6_200 = "nlhe-cash-6max-200bb";

const spot = (street: SpotPattern["street"], scenarios?: string[], extra: Partial<SpotPattern> = {}): SpotPattern => ({
  street,
  ...(scenarios ? { scenarios } : {}),
  ...extra,
});
const POSTFLOP = ["flop", "turn", "river"] as const;
const everyStreet = (scenarios: string[]): SpotPattern[] => POSTFLOP.map((street) => spot(street, scenarios));

const calc = (id: string, kind: CalcKind, count: number, pass = 0.7): CalcDef => ({ id, kind: "calc", calc: kind, count, pass });
const classify = (id: string, kind: ClassifyKind, count: number, pass = 0.7): ClassifyDef => ({ id, kind: "classify", classify: kind, count, pass });
const chart = (id: string, family: ChartQuizDef["family"], count: number, extra: Partial<ChartQuizDef> = {}): ChartQuizDef => ({
  id,
  kind: "chart-quiz",
  family,
  count,
  pass: 0.7,
  bias: "borderline",
  ...extra,
});
const solver = (id: string, street: SolverSpotDef["street"], count: number, extra: Partial<SolverSpotDef> = {}): SolverSpotDef => ({
  id,
  kind: "solver-spot",
  street,
  count,
  pass: 0.5,
  pot: "any",
  seat: "any",
  role: "any",
  bias: "range",
  ...extra,
});
const hands = (extra: Omit<OwnHandsDef, "id" | "kind" | "count"> & { count?: number }): OwnHandsDef => ({
  id: "your-hands",
  kind: "own-hands",
  count: extra.count ?? 3,
  ...extra,
});
const planned = (id: string, kind: PlannedKind, waitsFor: PlannedDef["waitsFor"] = "widget", street?: PlannedDef["street"]): PlannedDef => ({
  id,
  kind,
  waitsFor,
  ...(street ? { street } : {}),
});

const lesson = (
  id: LessonId,
  module: ModuleId,
  prereqs: LessonId[],
  concepts: ConceptId[],
  exercises: ExerciseDef[],
  match: { spots?: SpotPattern[]; flags?: FlagCode[] } = {},
  extra: Partial<Pick<LessonMeta, "written" | "notes" | "examples">> = {},
): LessonMeta => {
  return {
    id,
    module,
    code: "",
    prereqs,
    concepts,
    exercises,
    match: { spots: match.spots ?? [], flags: match.flags ?? [] },
    written: extra.written ?? false,
    ...(extra.notes ? { notes: extra.notes } : {}),
    ...(extra.examples ? { examples: extra.examples } : {}),
  };
};
const WRITTEN = { written: true } as const;

/* ------------------------------------------------------------- catalogue - */

const LIST: LessonMeta[] = [
  // ---- M0 orientation
  lesson("how-rail-teaches", "m0", [], ["ev-and-grading", "gto-vs-exploitative"], [calc("grade-quiz", "grade", 6, 0.67), planned("placement", "placement")], {}, WRITTEN),
  lesson(
    "gto-mixing-and-simplifying",
    "m0",
    ["how-rail-teaches"],
    ["gto-vs-exploitative", "ev-and-grading"],
    [calc("close-calls", "grade", 5, 0.6), solver("mixed-rivers", "river", 4, { bias: "borderline" })],
    {},
    WRITTEN,
  ),
  lesson(
    "reading-rail-reports",
    "m0",
    ["how-rail-teaches"],
    ["ev-and-grading"],
    [calc("per-100", "per100", 5), hands({ spots: [] })],
    {},
    WRITTEN,
  ),
  lesson("variance-bankroll-and-tilt", "m0", [], ["ev-and-grading", "pot-odds"], [calc("allin-ev", "allin-ev", 6), hands({})], {}, WRITTEN),

  // ---- M1 poker maths
  lesson(
    "pot-odds",
    "m1",
    [],
    ["pot-odds", "mdf-alpha"],
    [calc("price-drill", "pot-odds", 10), hands({ flags: ["call-without-odds", "fold-with-odds"] })],
    { spots: ["flop", "turn"].map((street) => spot(street as "flop" | "turn", ["pfr-ip-vs-bet", "pfr-oop-vs-bet", "caller-ip-vs-bet", "caller-oop-vs-bet", "limped-*-vs-bet"])), flags: ["call-without-odds", "fold-with-odds"] },
    WRITTEN,
  ),
  lesson(
    "equity-and-outs",
    "m1",
    ["pot-odds"],
    ["pot-odds", "equity-realisation"],
    [calc("draw-equity", "outs-equity", 6, 0.67), hands({ flags: ["call-without-odds"] })],
    { spots: [spot("flop", ["*-vs-bet"]), spot("turn", ["*-vs-bet"])], flags: ["call-without-odds"] },
    WRITTEN,
  ),
  lesson(
    "expected-value",
    "m1",
    ["pot-odds"],
    ["ev-and-grading", "pot-odds"],
    [calc("ev-trees", "ev", 6, 0.67), solver("river-ev", "river", 3)],
    { flags: ["fold-nuts", "free-fold"] },
    WRITTEN,
  ),
  lesson("combos-and-card-removal", "m1", ["equity-and-outs"], ["blockers", "ranges"], [calc("count-combos", "combos", 8)], {}, WRITTEN),
  lesson(
    "bluffing-math-alpha-mdf",
    "m1",
    ["expected-value"],
    ["mdf-alpha", "bluff-catching"],
    [calc("sizing-quiz", "alpha-mdf", 8), hands({ flags: ["fold-with-odds"], spots: [spot("river", ["*-vs-bet"])] })],
    { spots: [spot("river", ["pfr-*-vs-bet", "caller-*-vs-bet", "limped-*-vs-bet"])], flags: ["fold-with-odds"] },
    WRITTEN,
  ),
  lesson(
    "equity-realisation-and-implied-odds",
    "m1",
    ["equity-and-outs"],
    ["equity-realisation", "position", "spr"],
    [chart("bb-vs-btn", "vs-open", 12, { seat: "BB", vs: "BTN", set: TABLE_6_100 })],
    { spots: [spot("preflop", ["vs-open"])] },
    WRITTEN,
  ),

  // ---- M2 ranges
  lesson(
    "thinking-in-ranges",
    "m2",
    ["combos-and-card-removal"],
    ["ranges", "rfi"],
    [planned("paint-an-open", "range-paint"), chart("full-ring-opens", "rfi", 12, { set: TABLE_9_100, bias: "range" })],
    { flags: ["call-beats-nothing"] },
    WRITTEN,
  ),
  lesson(
    "range-advantage",
    "m2",
    ["thinking-in-ranges"],
    ["range-advantage", "continuation-bet"],
    [classify("who-is-ahead", "range-advantage", 8)],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "nut-advantage",
    "m2",
    ["range-advantage"],
    ["nut-advantage", "bet-sizing"],
    [classify("who-has-the-nuts", "nut-advantage", 8)],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "board-texture",
    "m2",
    ["range-advantage"],
    ["board-texture", "dynamic-boards"],
    [classify("read-the-flop", "texture", 12), classify("static-or-dynamic", "dynamism", 8)],
    { spots: [spot("flop", ["pfr-*-first", "caller-*-first"])] },
    WRITTEN,
  ),
  lesson(
    "who-the-next-card-helps",
    "m2",
    ["board-texture", "nut-advantage"],
    ["dynamic-boards", "range-advantage"],
    [classify("whose-card", "turn-card", 8)],
    { spots: [spot("turn", ["pfr-ip-first", "pfr-oop-first"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "range-narrowing",
    "m2",
    ["who-the-next-card-helps"],
    ["ranges", "blockers", "bluff-catching"],
    [planned("range-walk", "range-walk"), solver("river-calls", "river", 4, { seat: "ip", facing: "bet" }), hands({ flags: ["call-beats-nothing"], spots: [spot("river", ["*-vs-bet"])] })],
    { spots: [spot("river", ["pfr-*-vs-bet", "caller-*-vs-bet"])], flags: ["call-beats-nothing"] },
    WRITTEN,
  ),

  // ---- M3 preflop
  lesson(
    "positions-and-opening-ranges",
    "m3",
    ["thinking-in-ranges"],
    ["rfi", "position", "steal"],
    [chart("opens-6max", "rfi", 12, { set: TABLE_6_100 }), chart("opens-9max", "rfi", 12, { set: TABLE_9_100 }), planned("paint-a-seat", "range-paint")],
    { spots: [spot("preflop", ["unopened"])] },
    WRITTEN,
  ),
  lesson(
    "open-sizing",
    "m3",
    ["positions-and-opening-ranges"],
    ["rfi", "steal", "spr"],
    [calc("steal-price", "steal", 6), calc("blind-price", "blind-price", 6), hands({ spots: [spot("preflop", ["unopened"])] })],
    { spots: [spot("preflop", ["unopened"])] },
    WRITTEN,
  ),
  lesson(
    "facing-an-open",
    "m3",
    ["positions-and-opening-ranges"],
    ["three-bet", "blind-defence", "equity-realisation"],
    [chart("call-3bet-fold", "vs-open", 12), hands({ spots: [spot("preflop", ["vs-open"])] })],
    { spots: [spot("preflop", ["vs-open"], { heroes: ["UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"] })] },
    WRITTEN,
  ),
  lesson(
    "three-betting",
    "m3",
    ["facing-an-open"],
    ["three-bet", "blockers"],
    [chart("three-bet-or-not", "vs-open", 12, { seat: "BTN" }), hands({ spots: [spot("preflop", ["vs-open"], { best: ["raise"] })] })],
    { spots: [spot("preflop", ["vs-open"], { best: ["raise"] })] },
    WRITTEN,
  ),
  lesson(
    "facing-3bets-and-4bets",
    "m3",
    ["three-betting"],
    ["three-bet", "spr", "blockers"],
    [chart("vs-3bet", "vs-3bet", 10), chart("vs-4bet", "vs-4bet", 6, { pass: 0.67 })],
    { spots: [spot("preflop", ["vs-3bet", "vs-3bet-cold", "vs-4bet"])] },
    WRITTEN,
  ),
  lesson(
    "blind-play-and-bvb",
    "m3",
    ["facing-an-open"],
    ["blind-defence", "steal", "pot-odds"],
    [chart("blind-vs-blind", "bvb", 10), chart("big-blind-defence", "vs-open", 10, { seat: "BB" })],
    { spots: [spot("preflop", ["vs-open"], { heroes: ["SB", "BB"] }), spot("preflop", ["bb-option"])] },
    WRITTEN,
  ),
  lesson(
    "squeezes-and-multiway-preflop",
    "m3",
    ["three-betting"],
    ["squeeze", "multiway-pots"],
    [chart("squeeze-spots", "squeeze", 10)],
    { spots: [spot("preflop", ["squeeze"])] },
    WRITTEN,
  ),
  lesson(
    "limpers-and-isolation",
    "m3",
    ["positions-and-opening-ranges"],
    ["steal", "multiway-pots"],
    [chart("facing-limpers", "vs-limp", 10), solver("limped-rivers", "river", 3, { pot: "limped" })],
    { spots: [spot("preflop", ["vs-limp", "bb-option"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),

  // ---- M4 single-raised pots as the preflop raiser
  lesson(
    "cbet-why-and-when",
    "m4",
    ["range-advantage", "nut-advantage", "board-texture"],
    ["continuation-bet", "range-advantage", "nut-advantage"],
    [solver("flop-cbets", "flop", 6, { pot: "srp", role: "pfr" })],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"])] },
    { notes: ["flop-library-off"] },
  ),
  lesson(
    "cbet-by-texture",
    "m4",
    ["cbet-why-and-when"],
    ["board-texture", "dynamic-boards", "bet-sizing"],
    [planned("split-three-flops", "range-split", "flop-library", "flop"), classify("texture-warmup", "texture", 8)],
    { spots: [spot("flop", ["pfr-ip-first"])] },
    { notes: ["flop-library-off"] },
  ),
  lesson(
    "hand-classes-on-the-flop",
    "m4",
    ["cbet-by-texture"],
    ["continuation-bet", "thin-value"],
    [classify("name-the-hand", "hand-class", 10), planned("split-one-flop", "range-split", "flop-library", "flop"), hands({ spots: [spot("flop", ["pfr-*-first"])] })],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"])] },
  ),
  lesson(
    "oop-as-the-raiser",
    "m4",
    ["hand-classes-on-the-flop"],
    ["position", "check-raise"],
    [solver("oop-rivers", "river", 4, { role: "pfr", seat: "oop", pot: "srp" }), solver("oop-flops", "flop", 4, { role: "pfr", seat: "oop", pot: "srp" })],
    { spots: everyStreet(["pfr-oop-first"]) },
  ),
  lesson(
    "checking-back-and-delayed-cbets",
    "m4",
    ["hand-classes-on-the-flop"],
    ["continuation-bet", "thin-value"],
    [solver("delayed-turns", "turn", 3, { role: "pfr", seat: "ip", pot: "srp", facing: "check" }), hands({ flags: ["check-back-nuts"] })],
    { spots: [spot("turn", ["pfr-ip-first"])], flags: ["check-back-nuts"] },
  ),
  lesson(
    "facing-a-check-raise",
    "m4",
    ["hand-classes-on-the-flop"],
    ["check-raise", "mdf-alpha"],
    [solver("flop-vs-raise", "flop", 4, { role: "pfr" }), hands({ spots: [spot("flop", ["pfr-*-vs-raise"])] })],
    { spots: [spot("flop", ["pfr-ip-vs-raise", "pfr-oop-vs-raise"])] },
    { notes: ["flop-library-off"] },
  ),

  // ---- M5 single-raised pots as the caller
  lesson(
    "defending-vs-cbets",
    "m5",
    ["hand-classes-on-the-flop"],
    ["mdf-alpha", "pot-odds", "equity-realisation"],
    [solver("flop-defence", "flop", 6, { role: "caller", pot: "srp" }), hands({ flags: ["call-without-odds", "fold-with-odds"], spots: [spot("flop", ["caller-*-vs-bet"])] })],
    { spots: [spot("flop", ["caller-ip-vs-bet", "caller-oop-vs-bet"])], flags: ["call-without-odds", "fold-with-odds"] },
    { notes: ["flop-library-off"] },
  ),
  lesson(
    "check-raising",
    "m5",
    ["defending-vs-cbets"],
    ["check-raise", "nut-advantage"],
    [planned("fold-call-raise", "range-split", "flop-library", "flop")],
    { spots: [spot("flop", ["caller-oop-vs-bet"], { best: ["raise"] })] },
    { notes: ["flop-library-off"] },
  ),
  lesson(
    "floating-and-stabbing-ip",
    "m5",
    ["defending-vs-cbets"],
    ["position", "continuation-bet"],
    [solver("stab-turns", "turn", 3, { role: "caller", seat: "ip", pot: "srp", facing: "check" })],
    { spots: [spot("turn", ["caller-ip-first"]), spot("flop", ["caller-ip-first"])] },
  ),
  lesson(
    "probes-and-donk-bets",
    "m5",
    ["floating-and-stabbing-ip"],
    ["donk-bet", "range-advantage"],
    [solver("probe-turns", "turn", 3, { role: "caller", seat: "oop", pot: "srp" })],
    { spots: [spot("turn", ["caller-oop-first"]), spot("flop", ["caller-oop-first"])] },
  ),
  lesson(
    "facing-turn-barrels",
    "m5",
    ["defending-vs-cbets"],
    ["bluff-catching", "mdf-alpha"],
    [solver("turn-barrels", "turn", 3, { role: "caller", seat: "ip", pot: "srp", facing: "bet" }), hands({ spots: [spot("turn", ["caller-*-vs-bet"])] })],
    { spots: [spot("turn", ["caller-ip-vs-bet", "caller-oop-vs-bet"])] },
  ),
  lesson(
    "bb-vs-btn-blueprint",
    "m5",
    ["defending-vs-cbets", "check-raising", "floating-and-stabbing-ip", "probes-and-donk-bets", "facing-turn-barrels"],
    ["blind-defence", "continuation-bet", "mdf-alpha"],
    [solver("mixed-rivers", "river", 5, { pot: "srp" }), solver("mixed-turns", "turn", 3, { pot: "srp" }), hands({ spots: everyStreet(["caller-*"]) })],
  ),

  // ---- M6 3-bet and 4-bet pots
  lesson(
    "spr-and-commitment",
    "m6",
    ["hand-classes-on-the-flop", "defending-vs-cbets"],
    ["spr", "bet-sizing"],
    [calc("spr-drill", "spr", 8), hands({ flags: ["committed-fold", "thin-stack-behind"] })],
    { flags: ["committed-fold", "thin-stack-behind"] },
  ),
  lesson(
    "cbetting-as-the-3bettor",
    "m6",
    ["spr-and-commitment"],
    ["continuation-bet", "range-advantage", "spr"],
    [solver("3bp-flops", "flop", 6, { pot: "3bp", role: "pfr" }), solver("3bp-rivers", "river", 4, { pot: "3bp", role: "pfr" })],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"])] },
    { notes: ["flop-library-off"] },
  ),
  lesson(
    "playing-3bp-as-the-caller",
    "m6",
    ["spr-and-commitment"],
    ["check-raise", "bluff-catching", "spr"],
    [solver("3bp-caller-rivers", "river", 4, { pot: "3bp", role: "caller" })],
    { spots: [spot("flop", ["caller-*-vs-bet"]), spot("river", ["caller-*-vs-bet"])] },
  ),
  lesson(
    "range-splitting-ip-vs-checks-3bp",
    "m6",
    ["spr-and-commitment", "cbetting-as-the-3bettor", "playing-3bp-as-the-caller", "cbet-by-texture"],
    ["continuation-bet", "bet-sizing", "range-advantage", "nut-advantage", "board-texture", "dynamic-boards", "spr", "check-raise"],
    [
      planned("flop-split", "range-split", "flop-library", "flop"),
      solver("turn-3bettor", "turn", 2, { pot: "3bp", seat: "ip", role: "pfr", facing: "check" }),
      solver("turn-caller", "turn", 2, { pot: "3bp", seat: "ip", role: "caller", facing: "check" }),
      solver("river-3bettor", "river", 3, { pot: "3bp", seat: "ip", role: "pfr", facing: "check" }),
      solver("river-caller", "river", 3, { pot: "3bp", seat: "ip", role: "caller", facing: "check" }),
      hands({ spots: everyStreet(["pfr-ip-first", "caller-ip-first"]), potType: "3bet" }),
    ],
    { spots: everyStreet(["pfr-ip-first", "caller-ip-first"]) },
    { ...WRITTEN, notes: ["flop-library-off", "approximate-ranges"] },
  ),
  lesson(
    "3bp-turn-and-river",
    "m6",
    ["range-splitting-ip-vs-checks-3bp"],
    ["spr", "bet-sizing", "bluff-catching"],
    [solver("3bp-turns", "turn", 3, { pot: "3bp" }), solver("3bp-rivers", "river", 5, { pot: "3bp" })],
    { spots: [spot("turn", ["pfr-*", "caller-*"]), spot("river", ["pfr-*", "caller-*"])] },
  ),
  lesson(
    "four-bet-pots",
    "m6",
    ["spr-and-commitment"],
    ["spr", "three-bet"],
    [chart("vs-4bet", "vs-4bet", 8), calc("4bp-spr", "spr", 5)],
    { spots: [spot("preflop", ["vs-4bet"])] },
  ),

  // ---- M7 the turn
  lesson("turn-card-classes", "m7", ["who-the-next-card-helps"], ["dynamic-boards", "range-advantage"], [classify("turn-cards", "turn-card", 10)], {
    spots: [spot("turn", ["pfr-*-first", "caller-*-first"])],
  }),
  lesson(
    "double-barreling",
    "m7",
    ["turn-card-classes"],
    ["bet-sizing", "blockers", "continuation-bet"],
    [solver("barrel-turns", "turn", 4, { role: "pfr" })],
    { spots: [spot("turn", ["pfr-ip-first", "pfr-oop-first"])] },
  ),
  lesson(
    "turn-sizing-and-overbets",
    "m7",
    ["double-barreling"],
    ["nut-advantage", "bet-sizing", "blockers"],
    [solver("sizing-turns", "turn", 4)],
    { spots: [spot("turn", ["pfr-*-first"], { best: ["bet"] })] },
  ),
  lesson(
    "turn-after-flop-checks-through",
    "m7",
    ["turn-card-classes", "probes-and-donk-bets"],
    ["donk-bet", "continuation-bet"],
    [solver("checked-flop-turns", "turn", 4)],
    { spots: [spot("turn", ["caller-oop-first", "pfr-ip-first"])] },
  ),

  // ---- M8 the river
  lesson("river-polarisation", "m8", ["double-barreling"], ["bet-sizing", "thin-value", "mdf-alpha"], [solver("river-basics", "river", 5)], {
    spots: [spot("river", ["pfr-*-first", "caller-*-first"])],
  }),
  lesson(
    "thin-value",
    "m8",
    ["river-polarisation"],
    ["thin-value"],
    [solver("thin-rivers", "river", 5, { seat: "ip", facing: "check" }), hands({ flags: ["check-back-nuts"], spots: [spot("river", ["*-first"])] })],
    { spots: [spot("river", ["pfr-*-first", "caller-*-first"], { best: ["bet"] })], flags: ["check-back-nuts"] },
  ),
  lesson(
    "choosing-bluffs-blockers",
    "m8",
    ["river-polarisation"],
    ["blockers", "bluff-catching"],
    [solver("bluff-rivers", "river", 5)],
    { spots: [spot("river", ["pfr-*-first", "caller-*-first"], { best: ["check"] })] },
  ),
  lesson(
    "bluff-catching",
    "m8",
    ["range-narrowing", "choosing-bluffs-blockers"],
    ["bluff-catching", "blockers", "mdf-alpha"],
    [solver("catch-rivers", "river", 5, { seat: "ip", facing: "bet" }), hands({ flags: ["call-beats-nothing", "fold-with-odds"], spots: [spot("river", ["*-vs-bet"])] })],
    { spots: [spot("river", ["pfr-*-vs-bet", "caller-*-vs-bet"])], flags: ["call-beats-nothing", "fold-with-odds"] },
  ),
  lesson("river-sizing", "m8", ["thin-value"], ["bet-sizing", "nut-advantage"], [solver("sizing-rivers", "river", 5)], {
    spots: [spot("river", ["pfr-*-first", "caller-*-first"], { best: ["bet"] })],
  }),
  lesson(
    "facing-river-raises",
    "m8",
    ["bluff-catching"],
    ["bluff-catching", "gto-vs-exploitative"],
    [hands({ spots: [spot("river", ["*-vs-raise"])] })],
    { spots: [spot("river", ["pfr-*-vs-raise", "caller-*-vs-raise"])] },
  ),

  // ---- M9 multiway
  lesson(
    "multiway-principles",
    "m9",
    ["hand-classes-on-the-flop", "defending-vs-cbets"],
    ["multiway-pots"],
    [calc("multiway-maths", "multiway", 6), hands({ flags: ["multiway-bluff", "multiway-slowplay", "multiway-dominated-draw"] })],
    { spots: everyStreet(["*-mw-*"]), flags: ["multiway-bluff", "multiway-slowplay", "multiway-dominated-draw"] },
  ),
  lesson(
    "multiway-as-the-raiser",
    "m9",
    ["multiway-principles"],
    ["multiway-pots", "continuation-bet"],
    [hands({ spots: [spot("flop", ["pfr-mw-*-first"])] })],
    { spots: [spot("flop", ["pfr-mw-ip-first", "pfr-mw-oop-first"])] },
  ),
  lesson(
    "multiway-defence",
    "m9",
    ["multiway-principles"],
    ["multiway-pots", "mdf-alpha"],
    [calc("mdf-split", "multiway", 6), hands({ spots: everyStreet(["*-mw-*-vs-bet"]) })],
    { spots: everyStreet(["caller-mw-*-vs-bet", "pfr-mw-*-vs-bet"]) },
  ),
  lesson(
    "multiway-preflop-choices",
    "m9",
    ["squeezes-and-multiway-preflop"],
    ["squeeze", "multiway-pots"],
    [chart("squeeze-or-call", "squeeze", 8), chart("limped-pots", "vs-limp", 8)],
    { spots: [spot("preflop", ["squeeze", "vs-limp"])] },
  ),

  // ---- M10 live cash, deep stacks, straddles, exploits
  lesson("live-game-dynamics", "m10", ["open-sizing"], ["rfi", "spr"], [planned("pot-tracking", "pot-tracking")]),
  lesson(
    "straddle-preflop",
    "m10",
    ["open-sizing"],
    ["rfi", "blind-defence"],
    [planned("straddle-charts", "range-paint", "straddle-charts")],
    {},
    { notes: ["straddle-not-analysed", "conceptual"] },
  ),
  lesson(
    "straddle-postflop-low-spr",
    "m10",
    ["straddle-preflop", "spr-and-commitment"],
    ["spr", "multiway-pots"],
    [calc("low-spr", "spr", 6), solver("low-spr-rivers", "river", 3, { pot: "3bp" })],
    {},
    { notes: ["straddle-not-analysed"] },
  ),
  lesson(
    "deep-stacks-200bb",
    "m10",
    ["spr-and-commitment"],
    ["spr", "equity-realisation", "bet-sizing"],
    [chart("deep-opens", "rfi", 12, { set: TABLE_6_200 }), chart("deep-defence", "vs-open", 12, { set: TABLE_6_200 }), planned("spr-toggle", "range-split", "flop-library", "flop")],
    { spots: [spot("preflop", ["unopened", "vs-open"])] },
  ),
  lesson(
    "population-exploits",
    "m10",
    ["bluff-catching"],
    ["gto-vs-exploitative", "bluff-catching"],
    [planned("exploit-hands", "profile-quiz", "villain-stats")],
  ),
  lesson("player-profiles", "m10", ["population-exploits"], ["gto-vs-exploitative"], [planned("profile-quiz", "profile-quiz", "villain-stats")]),
];

/** Lessons in course order, with their `M<n>-L<k>` codes filled in. */
function withCodes(list: LessonMeta[]): LessonMeta[] {
  const counts = new Map<ModuleId, number>();
  return list.map((meta) => {
    const k = (counts.get(meta.module) ?? 0) + 1;
    counts.set(meta.module, k);
    return { ...meta, code: `M${meta.module.slice(1)}-L${k}` };
  });
}

const ORDERED = withCodes(LIST);

export const LESSONS: Readonly<Record<LessonId, LessonMeta>> = Object.fromEntries(ORDERED.map((meta) => [meta.id, meta])) as Record<
  LessonId,
  LessonMeta
>;

/* --------------------------------------------------------------- helpers - */

export function isLessonId(value: unknown): value is LessonId {
  return typeof value === "string" && (LESSON_IDS as readonly string[]).includes(value);
}

/** The lessons of one module, in course order. */
export function lessonsIn(module: ModuleId): LessonMeta[] {
  return ORDERED.filter((meta) => meta.module === module);
}

/** The track a module belongs to. */
export function trackOf(module: ModuleId): TrackId {
  for (const track of TRACK_IDS) if (TRACKS[track].includes(module)) return track;
  return "foundations";
}

/** Every lesson in course order. */
export function courseOrder(): LessonMeta[] {
  return [...ORDERED];
}

/** The lessons whose text is written, in course order. */
export function writtenLessons(): LessonMeta[] {
  return ORDERED.filter((meta) => meta.written);
}

/** The next and previous lesson in course order (any, written or not). */
export function neighbours(id: LessonId): { previous: LessonMeta | null; next: LessonMeta | null } {
  const at = ORDERED.findIndex((meta) => meta.id === id);
  return { previous: at > 0 ? ORDERED[at - 1] : null, next: at >= 0 && at < ORDERED.length - 1 ? ORDERED[at + 1] : null };
}

/** The lesson's exercises that count towards passing it (see {@link countsTowardsPass}). */
export function requiredExercises(meta: LessonMeta, flopLibrary = false): GeneratedExerciseDef[] {
  return meta.exercises.filter((def): def is GeneratedExerciseDef => countsTowardsPass(def, flopLibrary));
}

/** The exercise of a lesson by id. */
export function exerciseOf(meta: LessonMeta, id: string): ExerciseDef | null {
  return meta.exercises.find((def) => def.id === id) ?? null;
}
