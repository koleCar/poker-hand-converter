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
import type { LabPreset } from "../training/labPresets";
import type { DealBias, PreflopFamily } from "../training/preflop";
import type { RiverPot, RiverRole, RiverSeat } from "../training/river";
import type { ConceptId } from "./concepts";

/* ------------------------------------------------------------- structure - */

export const TRACK_IDS = ["preflop", "flop", "turn", "river", "exploits"] as const;
export type TrackId = (typeof TRACK_IDS)[number];

/**
 * Modules by track, in the order of a hand (`docs/LEARN-PLAN.md` §2,
 * principle 9). A module id is its code in lower case: `p1` shows as `P1`,
 * and its lessons as `P1-L1`, `P1-L2`, …
 */
export const MODULE_IDS = ["p1", "p2", "p3", "f1", "f2", "f3", "f4", "f5", "t1", "t2", "t3", "r1", "r2", "r3", "x1", "x2", "x3", "x4"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const TRACKS: Readonly<Record<TrackId, readonly ModuleId[]>> = {
  preflop: ["p1", "p2", "p3"],
  flop: ["f1", "f2", "f3", "f4", "f5"],
  turn: ["t1", "t2", "t3"],
  river: ["r1", "r2", "r3"],
  exploits: ["x1", "x2", "x3", "x4"],
};

/** A module's code as the map shows it: `p1` → `P1`. */
export function moduleCode(module: ModuleId): string {
  return module.toUpperCase();
}

export const LESSON_IDS = [
  // ---- 1. Preflop
  // P1 opening
  "positions-and-opening-ranges",
  "open-sizing",
  "limpers-and-isolation",
  // P2 facing raises
  "facing-an-open",
  "three-betting",
  "facing-3bets-and-4bets",
  "squeezes-and-multiway-preflop",
  // P3 blinds and depth
  "blind-play-and-bvb",
  "multiway-preflop-choices",
  "preflop-by-stack-depth",
  // ---- 2. Flop
  // F1 single-raised pots, raiser in position
  "cbet-why-and-when",
  "cbet-by-texture",
  "hand-classes-on-the-flop",
  "checking-back-and-delayed-cbets",
  // F2 single-raised pots, raiser out of position
  "oop-as-the-raiser",
  "facing-a-check-raise",
  // F3 single-raised pots, the caller
  "defending-vs-cbets",
  "check-raising",
  "floating-and-stabbing-ip",
  "probes-and-donk-bets",
  "bb-vs-btn-blueprint",
  // F4 3-bet and 4-bet pots
  "spr-and-commitment",
  "cbetting-as-the-3bettor",
  "playing-3bp-as-the-caller",
  "range-splitting-ip-vs-checks-3bp",
  "four-bet-pots",
  // F5 multiway flops
  "multiway-principles",
  "multiway-as-the-raiser",
  "multiway-defence",
  // ---- 3. Turn
  // T1 betting again
  "turn-card-classes",
  "double-barreling",
  "turn-sizing-and-overbets",
  "turn-after-flop-checks-through",
  // T2 defending the turn
  "facing-turn-barrels",
  "turn-check-raise-and-probe",
  // T3 the turn in 3-bet pots
  "3bp-turn",
  // ---- 4. River
  // R1 betting the river
  "river-polarisation",
  "thin-value",
  "choosing-bluffs-blockers",
  "river-sizing",
  // R2 facing river bets
  "bluff-catching",
  "facing-river-raises",
  // R3 the river in 3-bet pots
  "3bp-river",
  // ---- 5. Exploits
  // X1 reading people
  "player-profiles",
  "reading-hud-stats",
  // X2 the pool
  "population-exploits",
  "exploiting-overfolders",
  "exploiting-calling-stations",
  "exploiting-aggressive-players",
  "underbluffed-rivers",
  // X3 the exploit lab
  "node-locking-in-rail",
  "when-not-to-exploit",
  // X4 live and deep
  "live-game-dynamics",
  "straddle-preflop",
  "straddle-postflop-low-spr",
  "deep-stacks-200bb",
] as const;
export type LessonId = (typeof LESSON_IDS)[number];

/**
 * Reference pages (`/learn/reference/<id>`): L1's orientation, maths and
 * range lessons, out of the course map since L1.1 (no basics in the course,
 * principle 8). Their text is kept, read-only, without practice or progress;
 * a lesson links one the first time it uses its term, and the map's intro
 * panel lists them. A learner's old progress rows for these ids stay in the
 * database untouched and are simply not shown (`isLessonId` drops them).
 */
export const REFERENCE_IDS = [
  // L1's M0 orientation
  "how-rail-teaches",
  "gto-mixing-and-simplifying",
  "reading-rail-reports",
  "variance-bankroll-and-tilt",
  // L1's M1 poker maths
  "pot-odds",
  "equity-and-outs",
  "expected-value",
  "combos-and-card-removal",
  "bluffing-math-alpha-mdf",
  "equity-realisation-and-implied-odds",
  // L1's M2 ranges
  "thinking-in-ranges",
  "range-advantage",
  "nut-advantage",
  "board-texture",
  "who-the-next-card-helps",
  "range-narrowing",
] as const;
export type ReferenceId = (typeof REFERENCE_IDS)[number];

export const REFERENCE_GROUPS = ["orientation", "maths", "ranges"] as const;
export type ReferenceGroup = (typeof REFERENCE_GROUPS)[number];

/** The reference pages by group, in reading order. */
export const REFERENCE_BY_GROUP: Readonly<Record<ReferenceGroup, readonly ReferenceId[]>> = {
  orientation: ["how-rail-teaches", "gto-mixing-and-simplifying", "reading-rail-reports", "variance-bankroll-and-tilt"],
  maths: ["pot-odds", "equity-and-outs", "expected-value", "combos-and-card-removal", "bluffing-math-alpha-mdf", "equity-realisation-and-implied-odds"],
  ranges: ["thinking-in-ranges", "range-advantage", "nut-advantage", "board-texture", "who-the-next-card-helps", "range-narrowing"],
};

/** The concept pages a reference page links, most useful first (what its lesson linked in L1). */
export const REFERENCE_CONCEPTS: Readonly<Record<ReferenceId, readonly ConceptId[]>> = {
  "how-rail-teaches": ["ev-and-grading", "gto-vs-exploitative"],
  "gto-mixing-and-simplifying": ["gto-vs-exploitative", "ev-and-grading"],
  "reading-rail-reports": ["ev-and-grading"],
  "variance-bankroll-and-tilt": ["ev-and-grading", "pot-odds"],
  "pot-odds": ["pot-odds", "mdf-alpha"],
  "equity-and-outs": ["pot-odds", "equity-realisation"],
  "expected-value": ["ev-and-grading", "pot-odds"],
  "combos-and-card-removal": ["blockers", "ranges"],
  "bluffing-math-alpha-mdf": ["mdf-alpha", "bluff-catching"],
  "equity-realisation-and-implied-odds": ["equity-realisation", "position", "spr"],
  "thinking-in-ranges": ["ranges", "rfi"],
  "range-advantage": ["range-advantage", "continuation-bet"],
  "nut-advantage": ["nut-advantage", "bet-sizing"],
  "board-texture": ["board-texture", "dynamic-boards"],
  "who-the-next-card-helps": ["dynamic-boards", "range-advantage"],
  "range-narrowing": ["ranges", "blockers", "bluff-catching"],
};

/**
 * Old lesson URLs that moved to another lesson: L1's `3bp-turn-and-river` was
 * split into `3bp-turn` and `3bp-river`. The lesson route redirects these (and
 * a reference id to its `/learn/reference/<id>` page).
 */
export const MOVED_LESSONS: Readonly<Record<string, LessonId>> = {
  "3bp-turn-and-river": "3bp-turn",
};

export function isReferenceId(value: unknown): value is ReferenceId {
  return typeof value === "string" && (REFERENCE_IDS as readonly string[]).includes(value);
}

/** Path segments under `/learn` that are not lessons. A lesson id may never be one. */
export const RESERVED_LEARN_SEGMENTS = ["review", "reference"] as const;

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
  // Learn L4: the 95% interval on a stat over n chances, or the chances a stat needs.
  "sample-size",
] as const;
export type CalcKind = (typeof CALC_KINDS)[number];

/** Sorting boards and hands into buckets, graded by `lib/analysis/texture.ts`, hand classes and range equity. */
export const CLASSIFY_KINDS = ["texture", "dynamism", "hand-class", "range-advantage", "nut-advantage", "turn-card"] as const;
export type ClassifyKind = (typeof CLASSIFY_KINDS)[number];

/**
 * Exercises that need a widget Rail does not have yet. They are typed so the
 * catalogue can name them now; the lesson page shows them as planned and they
 * never count towards passing a lesson. `range-paint` is built (L3,
 * {@link PaintDef}) and stays here for the paints that still wait for data
 * (straddle charts): a planned exercise is the one with `waitsFor`.
 * `node-lock`, planned since L1.1, is built (L4, {@link NodeLockDef}).
 */
export const PLANNED_KINDS = ["depth-split", "range-paint", "range-walk", "pot-tracking", "profile-quiz", "placement"] as const;
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

/**
 * Postflop trainer spots: river spots (A7), turn spots (`lib/training/turn.ts`)
 * and flop spots from the A5b library (`lib/training/flop.ts`, Learn L2).
 */
export interface SolverSpotDef extends ExerciseBase {
  kind: "solver-spot";
  street: "flop" | "turn" | "river";
  count: number;
  pass: number;
  pot: RiverPot | "any";
  seat: RiverSeat | "any";
  role: RiverRole | "any";
  /**
   * Turn and river, in position only: spots where the villain checked to the
   * hero (`check`) or bet (`bet`). The flop (`FlopFacing`): `check` in
   * position, `bet` a bet to answer from either seat, `raise` the hero's bet
   * raised.
   */
  facing?: "check" | "bet" | "raise" | "any";
  /** Flop only: one line of the library (`FLOP_LINES` id, `btn-bb`). */
  line?: string;
  /** Turn only (L3): after the flop checked through, or after a flop bet was called. */
  flop?: "checked" | "bet";
  bias: DealBias;
}

/**
 * The range split (Learn L2, `lib/training/split.ts`): the hand classes of
 * the hero's range at a node sorted into check / small / big, or fold / call
 * / raise, graded per class by the solve (the flop library, or a turn solve).
 */
export interface SplitDef extends ExerciseBase {
  kind: "range-split";
  /** The river (L3) adds an overbet group: its menu has a 150% size. */
  street: "flop" | "turn" | "river";
  count: number;
  /** Share of items right; an item is right when most of its classes are (`SPLIT_PASS`). */
  pass: number;
  pot: RiverPot | "any";
  seat: RiverSeat | "any";
  role: RiverRole | "any";
  facing?: "check" | "bet" | "raise" | "any";
  line?: string;
  /** Turn only (L3): after the flop checked through, or after a flop bet was called. */
  flop?: "checked" | "bet";
}

/**
 * The range paint (Learn L3, `lib/training/paint.ts`): paint a range on the
 * 13×13 grid, graded cell by cell — a chart set's first-in range for a seat
 * (`chart`), or the hero's range at a river node solved on demand (`river`):
 * the hands that bet, or that continue against a bet.
 */
export type PaintDef = ExerciseBase & {
  kind: "range-paint";
  count: number;
  /** Share of items right; an item is right at `PAINT_PASS` of the weight that matters. */
  pass: number;
} & (
    | { source: "chart"; set?: string; seat?: ChartPosition | null }
    | { source: "river"; pot: RiverPot | "any"; seat: RiverSeat | "any"; role: RiverRole | "any"; facing?: "check" | "bet" | "any" }
  );

/**
 * The exploit lab (Learn L4, `lib/training/lab.ts`): a river solved on
 * demand, one opponent tendency locked (a preset of `LAB_PRESETS`, or any),
 * and a hand to play against it — graded by the best response the solver
 * computes against the lock.
 */
export interface NodeLockDef extends ExerciseBase {
  kind: "node-lock";
  count: number;
  pass: number;
  preset: LabPreset | "any";
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

export type ExerciseDef = ChartQuizDef | SolverSpotDef | SplitDef | PaintDef | NodeLockDef | CalcDef | ClassifyDef | OwnHandsDef | PlannedDef;
export type GeneratedExerciseDef = ChartQuizDef | SolverSpotDef | SplitDef | PaintDef | NodeLockDef | CalcDef | ClassifyDef;

export function isPlanned(def: ExerciseDef): def is PlannedDef {
  return "waitsFor" in def;
}

/** Whether an exercise reads the flop library (a flop spot or a flop split). */
export function readsFlopLibrary(def: ExerciseDef): boolean {
  return (def.kind === "solver-spot" || def.kind === "range-split") && def.street === "flop";
}

/**
 * Whether an exercise counts towards passing its lesson: every generated
 * exercise Rail can grade today. Own hands and planned widgets do not; flop
 * spots and flop splits count while the flop library is on
 * (`FLOP_LIBRARY_ENABLED`, since `analysis/8`).
 */
export function countsTowardsPass(def: ExerciseDef, flopLibrary = false): def is GeneratedExerciseDef {
  if (def.kind === "own-hands" || isPlanned(def)) return false;
  if (readsFlopLibrary(def)) return flopLibrary;
  return true;
}

/* --------------------------------------------------------------- lessons - */

/**
 * Where an honesty banner is due: the analysis' own words for what the engine
 * cannot solve yet, or solves only approximately.
 *
 * - `flop-mapped`: the drills deal the flop library's own flops; a real hand
 *   on any other flop is read from its nearest solved flop by hand category
 *   (`flop-mapped`, `library-bucketed`), and only 6-max 100bb heads-up lines
 *   are in the library (L2);
 * - `multiway-heuristic`: the library is heads-up; multiway flops are read by
 *   the heuristic and the MDF split (A9), without a solver grade (L2);
 * - `turn-tree`: the turn is solved on A5a's coarse tree — one bet size, 75%
 *   of the pot, plus all-in up to three pots — so turn sizes other than those
 *   are taught in words (L3);
 * - `locked-read`: the exploit lab freezes the opponent everywhere but the
 *   lock and best-responds on a river solve: a read is a model of a player,
 *   and the lab is a river only (L4).
 */
export type LessonNote = "flop-mapped" | "multiway-heuristic" | "approximate-ranges" | "turn-tree" | "conceptual" | "straddle-not-analysed" | "locked-read";
export const LESSON_NOTES: readonly LessonNote[] = [
  "flop-mapped",
  "multiway-heuristic",
  "approximate-ranges",
  "turn-tree",
  "conceptual",
  "straddle-not-analysed",
  "locked-read",
];

/**
 * Which of the learner's own pool tendencies a lesson shows (Learn L4, the
 * opponents-panel tie-in, `lib/learn/pool.ts`): read at runtime from their
 * own opponent statistics, with sample sizes.
 */
export type PoolTopic = "all" | "overfold" | "station" | "aggro" | "underbluff";

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
  /** `P1-L1`: the module's code and the lesson's place in it. */
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
  /** The learner's own pool tendencies this lesson shows (L4). */
  pool?: PoolTopic;
}

/* ------------------------------------------------------------- shorthand - */

const TABLE_6_40 = "nlhe-cash-6max-40bb";
const TABLE_6_60 = "nlhe-cash-6max-60bb";
const TABLE_6_100 = "nlhe-cash-6max-100bb";
const TABLE_6_150 = "nlhe-cash-6max-150bb";
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
const split = (id: string, street: SplitDef["street"], count: number, extra: Partial<SplitDef> = {}): SplitDef => ({
  id,
  kind: "range-split",
  street,
  count,
  pass: 0.67,
  pot: "any",
  seat: "any",
  role: "any",
  ...extra,
});
const paintChart = (id: string, count: number, extra: { set?: string; seat?: ChartPosition | null } = {}): PaintDef => ({
  id,
  kind: "range-paint",
  source: "chart",
  count,
  pass: 0.5,
  ...extra,
});
const paintRiver = (
  id: string,
  count: number,
  extra: Partial<{ pot: RiverPot | "any"; seat: RiverSeat | "any"; role: RiverRole | "any"; facing: "check" | "bet" | "any" }> = {},
): PaintDef => ({
  id,
  kind: "range-paint",
  source: "river",
  count,
  pass: 0.5,
  pot: "any",
  seat: "any",
  role: "any",
  ...extra,
});
const hands = (extra: Omit<OwnHandsDef, "id" | "kind" | "count"> & { count?: number }): OwnHandsDef => ({
  id: "your-hands",
  kind: "own-hands",
  count: extra.count ?? 3,
  ...extra,
});
const lab = (id: string, preset: NodeLockDef["preset"], count: number, pass = 0.5): NodeLockDef => ({ id, kind: "node-lock", count, pass, preset });
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
  extra: Partial<Pick<LessonMeta, "written" | "notes" | "examples" | "pool">> = {},
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
    ...(extra.pool ? { pool: extra.pool } : {}),
  };
};
const WRITTEN = { written: true } as const;

/* ------------------------------------------------------------- catalogue - */

const LIST: LessonMeta[] = [
  /* ============================================================ 1. Preflop */

  // ---- P1 opening
  lesson(
    "positions-and-opening-ranges",
    "p1",
    [],
    ["rfi", "position", "steal", "ranges"],
    [chart("opens-6max", "rfi", 12, { set: TABLE_6_100 }), chart("opens-9max", "rfi", 12, { set: TABLE_9_100 }), paintChart("paint-a-seat", 2, { set: TABLE_6_100 })],
    { spots: [spot("preflop", ["unopened"])] },
    WRITTEN,
  ),
  lesson(
    "open-sizing",
    "p1",
    ["positions-and-opening-ranges"],
    ["rfi", "steal", "spr"],
    [calc("steal-price", "steal", 6), calc("blind-price", "blind-price", 6), hands({ spots: [spot("preflop", ["unopened"])] })],
    { spots: [spot("preflop", ["unopened"])] },
    WRITTEN,
  ),
  lesson(
    "limpers-and-isolation",
    "p1",
    ["positions-and-opening-ranges"],
    ["steal", "multiway-pots"],
    [chart("facing-limpers", "vs-limp", 10), solver("limped-rivers", "river", 3, { pot: "limped" })],
    { spots: [spot("preflop", ["vs-limp", "bb-option"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),

  // ---- P2 facing raises
  lesson(
    "facing-an-open",
    "p2",
    ["positions-and-opening-ranges"],
    ["three-bet", "blind-defence", "equity-realisation", "pot-odds"],
    [chart("call-3bet-fold", "vs-open", 12), hands({ spots: [spot("preflop", ["vs-open"])] })],
    { spots: [spot("preflop", ["vs-open"], { heroes: ["UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"] })] },
    WRITTEN,
  ),
  lesson(
    "three-betting",
    "p2",
    ["facing-an-open"],
    ["three-bet", "blockers"],
    [chart("three-bet-or-not", "vs-open", 12, { seat: "BTN" }), hands({ spots: [spot("preflop", ["vs-open"], { best: ["raise"] })] })],
    { spots: [spot("preflop", ["vs-open"], { best: ["raise"] })] },
    WRITTEN,
  ),
  lesson(
    "facing-3bets-and-4bets",
    "p2",
    ["three-betting"],
    ["three-bet", "spr", "blockers"],
    [chart("vs-3bet", "vs-3bet", 10), chart("vs-4bet", "vs-4bet", 6, { pass: 0.67 })],
    { spots: [spot("preflop", ["vs-3bet", "vs-3bet-cold", "vs-4bet"])] },
    WRITTEN,
  ),
  lesson(
    "squeezes-and-multiway-preflop",
    "p2",
    ["three-betting"],
    ["squeeze", "multiway-pots"],
    [chart("squeeze-spots", "squeeze", 10)],
    { spots: [spot("preflop", ["squeeze"])] },
    WRITTEN,
  ),

  // ---- P3 blinds and depth
  lesson(
    "blind-play-and-bvb",
    "p3",
    ["facing-an-open"],
    ["blind-defence", "steal", "pot-odds"],
    [chart("blind-vs-blind", "bvb", 10), chart("big-blind-defence", "vs-open", 10, { seat: "BB" })],
    { spots: [spot("preflop", ["vs-open"], { heroes: ["SB", "BB"] }), spot("preflop", ["bb-option"])] },
    WRITTEN,
  ),
  lesson(
    "multiway-preflop-choices",
    "p3",
    ["squeezes-and-multiway-preflop"],
    ["squeeze", "multiway-pots"],
    [chart("squeeze-or-call", "squeeze", 8), chart("limped-pots", "vs-limp", 8)],
    { spots: [spot("preflop", ["squeeze", "vs-limp"])] },
  ),
  lesson(
    "preflop-by-stack-depth",
    "p3",
    ["facing-an-open", "facing-3bets-and-4bets"],
    ["spr", "rfi", "three-bet"],
    [
      chart("opens-40bb", "rfi", 8, { set: TABLE_6_40 }),
      chart("opens-60bb", "rfi", 8, { set: TABLE_6_60 }),
      chart("vs-open-150bb", "vs-open", 8, { set: TABLE_6_150 }),
      chart("vs-3bet-200bb", "vs-3bet", 8, { set: TABLE_6_200 }),
    ],
    { spots: [spot("preflop", ["unopened", "vs-open", "vs-3bet"])] },
  ),

  /* =============================================================== 2. Flop */

  // ---- F1 single-raised pots, the raiser in position
  lesson(
    "cbet-why-and-when",
    "f1",
    ["positions-and-opening-ranges"],
    ["continuation-bet", "range-advantage", "nut-advantage"],
    [
      solver("flop-cbets", "flop", 6, { pot: "srp", role: "pfr", seat: "ip", facing: "check" }),
      hands({ spots: [spot("flop", ["pfr-ip-first"])], potType: "single-raised" }),
    ],
    { spots: [spot("flop", ["pfr-ip-first"], { best: ["bet"] })] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "cbet-by-texture",
    "f1",
    ["cbet-why-and-when"],
    ["board-texture", "range-advantage", "nut-advantage", "dynamic-boards", "bet-sizing"],
    [
      split("split-three-flops", "flop", 3, { pot: "srp", role: "pfr", seat: "ip", facing: "check" }),
      classify("who-is-ahead", "range-advantage", 6),
      classify("who-has-the-nuts", "nut-advantage", 6),
      hands({ spots: [spot("flop", ["pfr-ip-first"])], potType: "single-raised" }),
    ],
    { spots: [spot("flop", ["pfr-ip-first"])] },
    { ...WRITTEN, notes: ["flop-mapped", "approximate-ranges"] },
  ),
  lesson(
    "hand-classes-on-the-flop",
    "f1",
    ["cbet-by-texture"],
    ["continuation-bet", "thin-value"],
    [
      classify("name-the-hand", "hand-class", 8),
      split("split-one-flop", "flop", 2, { pot: "srp", role: "pfr", seat: "ip", facing: "check" }),
      hands({ spots: [spot("flop", ["pfr-*-first"])] }),
    ],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"], { best: ["check"] })], flags: ["free-fold"] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "checking-back-and-delayed-cbets",
    "f1",
    ["hand-classes-on-the-flop"],
    ["continuation-bet", "thin-value"],
    [
      solver("check-back-flops", "flop", 4, { pot: "srp", role: "pfr", seat: "ip", facing: "check", bias: "borderline" }),
      solver("delayed-turns", "turn", 3, { role: "pfr", seat: "ip", pot: "srp", facing: "check" }),
      hands({ flags: ["check-back-nuts"] }),
    ],
    { spots: [spot("turn", ["pfr-ip-first"])], flags: ["check-back-nuts"] },
    { ...WRITTEN, notes: ["flop-mapped", "approximate-ranges"] },
  ),

  // ---- F2 single-raised pots, the raiser out of position
  lesson(
    "oop-as-the-raiser",
    "f2",
    ["hand-classes-on-the-flop"],
    ["position", "check-raise"],
    [
      solver("oop-flops", "flop", 5, { role: "pfr", seat: "oop", pot: "srp" }),
      solver("oop-rivers", "river", 3, { role: "pfr", seat: "oop", pot: "srp" }),
      hands({ spots: [spot("flop", ["pfr-oop-first"])] }),
    ],
    { spots: [spot("flop", ["pfr-oop-first"])] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "facing-a-check-raise",
    "f2",
    ["hand-classes-on-the-flop"],
    ["check-raise", "mdf-alpha"],
    [solver("flop-vs-raise", "flop", 5, { role: "pfr", facing: "raise" }), hands({ spots: [spot("flop", ["pfr-*-vs-raise"])] })],
    { spots: [spot("flop", ["pfr-ip-vs-raise", "pfr-oop-vs-raise"])] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),

  // ---- F3 single-raised pots, the caller
  lesson(
    "defending-vs-cbets",
    "f3",
    ["hand-classes-on-the-flop"],
    ["mdf-alpha", "pot-odds", "equity-realisation"],
    [
      calc("sizing-quiz", "alpha-mdf", 8),
      solver("flop-defence", "flop", 6, { role: "caller", pot: "srp", facing: "bet" }),
      hands({ flags: ["call-without-odds", "fold-with-odds"], spots: [spot("flop", ["caller-*-vs-bet"])] }),
    ],
    {
      spots: [spot("flop", ["caller-ip-vs-bet", "caller-oop-vs-bet", "pfr-ip-vs-bet", "pfr-oop-vs-bet", "limped-*-vs-bet"])],
      flags: ["call-without-odds", "fold-with-odds"],
    },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "check-raising",
    "f3",
    ["defending-vs-cbets"],
    ["check-raise", "nut-advantage"],
    [
      split("fold-call-raise", "flop", 3, { pot: "srp", role: "caller", seat: "oop", facing: "bet" }),
      solver("raise-or-not", "flop", 4, { pot: "srp", role: "caller", seat: "oop", facing: "bet", bias: "borderline" }),
      hands({ spots: [spot("flop", ["caller-oop-vs-bet"])] }),
    ],
    { spots: [spot("flop", ["caller-oop-vs-bet"], { best: ["raise"] })] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "floating-and-stabbing-ip",
    "f3",
    ["defending-vs-cbets"],
    ["position", "continuation-bet"],
    [
      solver("float-flops", "flop", 3, { role: "caller", seat: "ip", pot: "srp", facing: "bet" }),
      solver("stab-flops", "flop", 3, { role: "caller", seat: "ip", pot: "srp", facing: "check" }),
      solver("stab-turns", "turn", 3, { role: "caller", seat: "ip", pot: "srp", facing: "check" }),
      hands({ spots: [spot("flop", ["caller-ip-*"]), spot("turn", ["caller-ip-first"])] }),
    ],
    { spots: [spot("turn", ["caller-ip-first"]), spot("flop", ["caller-ip-first"])] },
    { ...WRITTEN, notes: ["flop-mapped", "approximate-ranges"] },
  ),
  lesson(
    "probes-and-donk-bets",
    "f3",
    ["floating-and-stabbing-ip"],
    ["donk-bet", "range-advantage"],
    [
      solver("lead-or-check", "flop", 4, { role: "caller", seat: "oop", pot: "srp" }),
      solver("probe-turns", "turn", 3, { role: "caller", seat: "oop", pot: "srp" }),
      hands({ spots: [spot("flop", ["caller-oop-first"]), spot("turn", ["caller-oop-first"])] }),
    ],
    { spots: [spot("turn", ["caller-oop-first"]), spot("flop", ["caller-oop-first"])] },
    { ...WRITTEN, notes: ["flop-mapped", "approximate-ranges"] },
  ),
  lesson(
    "bb-vs-btn-blueprint",
    "f3",
    ["defending-vs-cbets", "check-raising", "floating-and-stabbing-ip", "probes-and-donk-bets"],
    ["blind-defence", "continuation-bet", "mdf-alpha"],
    [
      solver("bb-flops", "flop", 5, { line: "btn-bb", seat: "oop", facing: "bet" }),
      solver("mixed-turns", "turn", 3, { pot: "srp" }),
      solver("mixed-rivers", "river", 3, { pot: "srp" }),
      hands({ spots: everyStreet(["caller-*"]), potType: "single-raised" }),
    ],
    {},
    { ...WRITTEN, notes: ["flop-mapped", "approximate-ranges"] },
  ),

  // ---- F4 3-bet and 4-bet pots
  lesson(
    "spr-and-commitment",
    "f4",
    ["hand-classes-on-the-flop", "defending-vs-cbets"],
    ["spr", "bet-sizing"],
    [
      calc("spr-drill", "spr", 6),
      solver("3bp-commit", "flop", 4, { pot: "3bp", facing: "bet" }),
      hands({ flags: ["committed-fold", "thin-stack-behind"] }),
    ],
    { flags: ["committed-fold", "thin-stack-behind"] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "cbetting-as-the-3bettor",
    "f4",
    ["spr-and-commitment"],
    ["continuation-bet", "range-advantage", "spr"],
    [
      solver("3bp-flops", "flop", 6, { pot: "3bp", role: "pfr" }),
      solver("3bp-rivers", "river", 3, { pot: "3bp", role: "pfr" }),
      hands({ spots: [spot("flop", ["pfr-*-first"])], potType: "3bet" }),
    ],
    { spots: [spot("flop", ["pfr-ip-first", "pfr-oop-first"])] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "playing-3bp-as-the-caller",
    "f4",
    ["spr-and-commitment"],
    ["check-raise", "bluff-catching", "spr"],
    [
      solver("3bp-defence", "flop", 5, { pot: "3bp", role: "caller", facing: "bet" }),
      solver("3bp-caller-rivers", "river", 3, { pot: "3bp", role: "caller" }),
      hands({ spots: [spot("flop", ["caller-*"])], potType: "3bet" }),
    ],
    // The flop only: a river bluff-catching leak goes to R2, not to a 3-bet-pot lesson
    // (a leak area does not know the pot type).
    // Heads-up only: a multiway flop leak goes to F5.
    { spots: [spot("flop", ["caller-ip-vs-bet", "caller-oop-vs-bet"])] },
    { ...WRITTEN, notes: ["flop-mapped"] },
  ),
  lesson(
    "range-splitting-ip-vs-checks-3bp",
    "f4",
    ["spr-and-commitment", "cbetting-as-the-3bettor", "playing-3bp-as-the-caller", "cbet-by-texture"],
    ["continuation-bet", "bet-sizing", "range-advantage", "nut-advantage", "board-texture", "dynamic-boards", "spr", "check-raise"],
    [
      split("flop-split", "flop", 3, { pot: "3bp", seat: "ip", facing: "check" }),
      solver("turn-3bettor", "turn", 2, { pot: "3bp", seat: "ip", role: "pfr", facing: "check" }),
      solver("turn-caller", "turn", 2, { pot: "3bp", seat: "ip", role: "caller", facing: "check" }),
      solver("river-3bettor", "river", 3, { pot: "3bp", seat: "ip", role: "pfr", facing: "check" }),
      solver("river-caller", "river", 3, { pot: "3bp", seat: "ip", role: "caller", facing: "check" }),
      hands({ spots: everyStreet(["pfr-ip-first", "caller-ip-first"]), potType: "3bet" }),
    ],
    { spots: everyStreet(["pfr-ip-first", "caller-ip-first"]) },
    { ...WRITTEN, notes: ["flop-mapped", "approximate-ranges"] },
  ),
  lesson(
    "four-bet-pots",
    "f4",
    ["spr-and-commitment"],
    ["spr", "three-bet"],
    [chart("vs-4bet", "vs-4bet", 8), calc("4bp-spr", "spr", 5), hands({ spots: [spot("flop", ["pfr-*", "caller-*"])], potType: "4bet+" })],
    { spots: [spot("preflop", ["vs-4bet"])] },
    { ...WRITTEN, notes: ["conceptual"] },
  ),

  // ---- F5 multiway flops
  lesson(
    "multiway-principles",
    "f5",
    ["hand-classes-on-the-flop", "defending-vs-cbets"],
    ["multiway-pots"],
    [calc("multiway-maths", "multiway", 6), hands({ flags: ["multiway-bluff", "multiway-slowplay", "multiway-dominated-draw"] })],
    { spots: everyStreet(["*-mw-*"]), flags: ["multiway-bluff", "multiway-slowplay", "multiway-dominated-draw"] },
    { ...WRITTEN, notes: ["multiway-heuristic"] },
  ),
  lesson(
    "multiway-as-the-raiser",
    "f5",
    ["multiway-principles"],
    ["multiway-pots", "continuation-bet"],
    [calc("bluff-into-two", "multiway", 5), hands({ spots: [spot("flop", ["pfr-mw-*-first"])] })],
    { spots: [spot("flop", ["pfr-mw-ip-first", "pfr-mw-oop-first"])] },
    { ...WRITTEN, notes: ["multiway-heuristic"] },
  ),
  lesson(
    "multiway-defence",
    "f5",
    ["multiway-principles"],
    ["multiway-pots", "mdf-alpha"],
    [calc("mdf-split", "multiway", 6), hands({ spots: everyStreet(["*-mw-*-vs-bet"]) })],
    { spots: everyStreet(["caller-mw-*-vs-bet", "pfr-mw-*-vs-bet"]) },
    { ...WRITTEN, notes: ["multiway-heuristic"] },
  ),

  /* =============================================================== 3. Turn */

  // ---- T1 betting again
  lesson(
    "turn-card-classes",
    "t1",
    ["cbet-by-texture"],
    ["dynamic-boards", "range-advantage", "nut-advantage"],
    [
      classify("turn-cards", "turn-card", 8),
      solver("barrel-by-card", "turn", 4, { role: "pfr", seat: "ip", pot: "srp", facing: "check", flop: "bet" }),
      hands({ spots: [spot("turn", ["pfr-*-first", "caller-*-first"])] }),
    ],
    { spots: [spot("turn", ["pfr-*-first", "caller-*-first"])] },
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),
  lesson(
    "double-barreling",
    "t1",
    ["turn-card-classes"],
    ["bet-sizing", "blockers", "continuation-bet"],
    [
      split("barrel-split", "turn", 2, { role: "pfr", seat: "ip", pot: "srp", facing: "check", flop: "bet" }),
      solver("barrel-turns", "turn", 5, { role: "pfr", seat: "ip", pot: "srp", facing: "check", flop: "bet", bias: "borderline" }),
      hands({ spots: [spot("turn", ["pfr-*-first"])], potType: "single-raised" }),
    ],
    // The best action names the leak (a missed barrel, or a barrel that should have checked): ahead of F1's delayed c-bet.
    { spots: [spot("turn", ["pfr-ip-first", "pfr-oop-first"], { best: ["bet", "check"] })] },
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),
  lesson(
    "turn-sizing-and-overbets",
    "t1",
    ["double-barreling"],
    ["nut-advantage", "bet-sizing", "spr"],
    [
      solver("size-the-turn", "turn", 4, { role: "pfr", pot: "srp", seat: "ip", facing: "check", flop: "bet" }),
      split("overbet-split", "river", 2, { pot: "srp", seat: "ip", facing: "check" }),
      hands({ spots: [spot("turn", ["pfr-*-first", "caller-*-first"], { best: ["bet"] })] }),
    ],
    { spots: [spot("turn", ["pfr-*-first"], { best: ["bet"] })] },
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),
  lesson(
    "turn-after-flop-checks-through",
    "t1",
    ["turn-card-classes", "probes-and-donk-bets"],
    ["donk-bet", "continuation-bet"],
    [
      solver("delayed-bets", "turn", 4, { role: "pfr", seat: "ip", pot: "srp", facing: "check", flop: "checked" }),
      split("probe-split", "turn", 2, { role: "caller", seat: "oop", pot: "srp", flop: "checked" }),
      hands({ spots: [spot("turn", ["caller-oop-first", "pfr-ip-first"])], potType: "single-raised" }),
    ],
    { spots: [spot("turn", ["caller-oop-first", "pfr-ip-first"])] },
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),

  // ---- T2 defending the turn
  lesson(
    "facing-turn-barrels",
    "t2",
    ["defending-vs-cbets"],
    ["bluff-catching", "mdf-alpha", "pot-odds", "equity-realisation"],
    [
      split("defend-split", "turn", 2, { role: "caller", seat: "oop", pot: "srp", facing: "bet", flop: "bet" }),
      solver("turn-barrels", "turn", 5, { role: "caller", seat: "ip", pot: "srp", facing: "bet" }),
      hands({ flags: ["call-without-odds"], spots: [spot("turn", ["*-vs-bet"])] }),
    ],
    { spots: [spot("turn", ["caller-ip-vs-bet", "caller-oop-vs-bet", "pfr-ip-vs-bet", "pfr-oop-vs-bet", "limped-*-vs-bet"])], flags: ["call-without-odds"] },
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),
  lesson(
    "turn-check-raise-and-probe",
    "t2",
    ["facing-turn-barrels", "probes-and-donk-bets"],
    ["check-raise", "donk-bet", "nut-advantage"],
    [
      split("turn-fold-call-raise", "turn", 2, { role: "caller", seat: "oop", pot: "srp", facing: "bet" }),
      solver("probe-or-check", "turn", 4, { role: "caller", seat: "oop", pot: "srp", bias: "borderline" }),
      hands({ spots: [spot("turn", ["caller-oop-vs-bet", "caller-oop-first"])] }),
    ],
    { spots: [spot("turn", ["caller-oop-vs-bet"], { best: ["raise"] }), spot("turn", ["caller-oop-first"], { best: ["bet"] })] },
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),

  // ---- T3 the turn in 3-bet pots
  lesson(
    "3bp-turn",
    "t3",
    ["range-splitting-ip-vs-checks-3bp", "double-barreling"],
    ["spr", "bet-sizing", "continuation-bet"],
    [
      split("3bp-turn-split", "turn", 2, { pot: "3bp", role: "pfr", seat: "ip", facing: "check" }),
      solver("3bp-turns", "turn", 5, { pot: "3bp" }),
      hands({ spots: [spot("turn", ["pfr-*", "caller-*"])], potType: "3bet" }),
    ],
    // A leak area does not know the pot type (§9): a turn leak goes to the single-raised lessons, not here.
    {},
    { ...WRITTEN, notes: ["approximate-ranges", "turn-tree"] },
  ),

  /* ============================================================== 4. River */

  // ---- R1 betting the river
  lesson(
    "river-polarisation",
    "r1",
    ["double-barreling"],
    ["bet-sizing", "thin-value", "mdf-alpha"],
    [
      split("river-split", "river", 3, { pot: "srp", seat: "ip", facing: "check" }),
      paintRiver("paint-the-bets", 2, { pot: "srp", seat: "ip", facing: "check" }),
      solver("river-basics", "river", 5),
      hands({ spots: [spot("river", ["pfr-*-first", "caller-*-first"])] }),
    ],
    { spots: [spot("river", ["pfr-*-first", "caller-*-first"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "thin-value",
    "r1",
    ["river-polarisation"],
    ["thin-value", "bet-sizing"],
    [
      solver("thin-rivers", "river", 5, { seat: "ip", facing: "check", bias: "borderline" }),
      solver("thin-first", "river", 3, { seat: "oop", bias: "borderline" }),
      hands({ flags: ["check-back-nuts"], spots: [spot("river", ["*-first"])] }),
    ],
    { spots: [spot("river", ["pfr-*-first", "caller-*-first"], { best: ["bet"] })], flags: ["check-back-nuts"] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "choosing-bluffs-blockers",
    "r1",
    ["river-polarisation"],
    ["blockers", "bluff-catching", "ranges"],
    [
      calc("count-combos", "combos", 6),
      solver("bluff-rivers", "river", 5, { seat: "ip", facing: "check", bias: "borderline" }),
      hands({ spots: [spot("river", ["pfr-*-first", "caller-*-first"])] }),
    ],
    { spots: [spot("river", ["pfr-*-first", "caller-*-first"], { best: ["check"] })] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "river-sizing",
    "r1",
    ["thin-value"],
    ["bet-sizing", "nut-advantage"],
    [
      split("sizing-split", "river", 3, { pot: "srp", seat: "ip", facing: "check" }),
      solver("sizing-rivers", "river", 5, { bias: "borderline" }),
      hands({ spots: [spot("river", ["*-first"])] }),
    ],
    { spots: [spot("river", ["pfr-*-first", "caller-*-first"], { best: ["bet"] })] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),

  // ---- R2 facing river bets
  lesson(
    "bluff-catching",
    "r2",
    ["river-polarisation", "choosing-bluffs-blockers"],
    ["bluff-catching", "blockers", "mdf-alpha"],
    [
      calc("price-the-call", "pot-odds", 5),
      paintRiver("paint-the-calls", 2, { pot: "srp", facing: "bet" }),
      solver("catch-rivers", "river", 5, { seat: "ip", facing: "bet" }),
      hands({ flags: ["call-beats-nothing", "fold-with-odds", "fold-nuts"], spots: [spot("river", ["*-vs-bet"])] }),
    ],
    { spots: [spot("river", ["pfr-*-vs-bet", "caller-*-vs-bet", "limped-*-vs-bet"])], flags: ["call-beats-nothing", "fold-with-odds", "fold-nuts"] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),
  lesson(
    "facing-river-raises",
    "r2",
    ["bluff-catching"],
    ["bluff-catching", "gto-vs-exploitative"],
    [split("vs-raise-split", "river", 3, { pot: "srp", facing: "raise" }), hands({ spots: [spot("river", ["*-vs-raise"])] })],
    { spots: [spot("river", ["pfr-*-vs-raise", "caller-*-vs-raise"])] },
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),

  // ---- R3 the river in 3-bet pots
  lesson(
    "3bp-river",
    "r3",
    ["3bp-turn", "river-polarisation"],
    ["spr", "bluff-catching", "blockers"],
    [
      split("3bp-river-split", "river", 2, { pot: "3bp", seat: "ip", facing: "check" }),
      solver("3bp-rivers", "river", 5, { pot: "3bp" }),
      hands({ spots: [spot("river", ["pfr-*", "caller-*"])], potType: "3bet" }),
    ],
    // A leak area does not know the pot type (§9): a river leak goes to R1–R2, not here.
    {},
    { ...WRITTEN, notes: ["approximate-ranges"] },
  ),

  /* ============================================================ 5. Exploits */

  // ---- X1 reading people
  lesson(
    "player-profiles",
    "x1",
    ["bluff-catching", "thin-value"],
    ["gto-vs-exploitative"],
    [lab("profile-reads", "any", 4), planned("profile-quiz", "profile-quiz", "villain-stats")],
    {},
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"], pool: "all" },
  ),
  lesson(
    "reading-hud-stats",
    "x1",
    ["player-profiles"],
    ["gto-vs-exploitative", "ev-and-grading"],
    [calc("margin-of-error", "sample-size", 6)],
    {},
    { ...WRITTEN, pool: "all" },
  ),

  // ---- X2 the pool
  lesson(
    "population-exploits",
    "x2",
    ["reading-hud-stats"],
    ["gto-vs-exploitative", "bluff-catching"],
    [lab("pool-reads", "any", 4), hands({ spots: [spot("river", ["*-vs-bet"]), spot("river", ["*-first"])] })],
    {},
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"], pool: "all" },
  ),
  lesson(
    "exploiting-overfolders",
    "x2",
    ["population-exploits"],
    ["gto-vs-exploitative", "mdf-alpha", "steal"],
    [calc("bluff-break-even", "alpha-mdf", 6), lab("overfold-lock", "overfold", 4), hands({ spots: [spot("river", ["pfr-*-first", "caller-*-first"])] })],
    {},
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"], pool: "overfold" },
  ),
  lesson(
    "exploiting-calling-stations",
    "x2",
    ["population-exploits", "thin-value"],
    ["gto-vs-exploitative", "thin-value"],
    [
      lab("station-lock", "station", 4),
      lab("passive-lock", "passive", 3),
      solver("value-rivers", "river", 4, { seat: "ip", facing: "check" }),
      hands({ flags: ["check-back-nuts"], spots: [spot("river", ["*-first"])] }),
    ],
    {},
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"], pool: "station" },
  ),
  lesson(
    "exploiting-aggressive-players",
    "x2",
    ["population-exploits", "bluff-catching"],
    ["gto-vs-exploitative", "bluff-catching", "check-raise"],
    [
      lab("aggro-lock", "maniac", 4),
      solver("catch-barrels", "turn", 3, { seat: "ip", facing: "bet" }),
      hands({ flags: ["fold-with-odds"], spots: [spot("river", ["*-vs-bet"]), spot("turn", ["*-vs-bet"])] }),
    ],
    // After the defence lessons, which carry the flag first.
    { flags: ["fold-with-odds"] },
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges", "turn-tree"], pool: "aggro" },
  ),
  lesson(
    "underbluffed-rivers",
    "x2",
    ["population-exploits", "bluff-catching"],
    ["gto-vs-exploitative", "bluff-catching", "mdf-alpha"],
    [
      lab("underbluff-lock", "underbluff", 4),
      solver("river-calls", "river", 4, { seat: "ip", facing: "bet" }),
      hands({ flags: ["call-beats-nothing"], spots: [spot("river", ["*-vs-bet"])] }),
    ],
    // A river call the reference folds: the hand called a range with too few bluffs for it.
    { spots: [spot("river", ["pfr-*-vs-bet", "caller-*-vs-bet"], { best: ["fold"] })], flags: ["call-beats-nothing"] },
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"], pool: "underbluff" },
  ),

  // ---- X3 the exploit lab
  lesson(
    "node-locking-in-rail",
    "x3",
    ["population-exploits"],
    ["gto-vs-exploitative", "ev-and-grading"],
    [lab("lock-a-node", "any", 6)],
    {},
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"] },
  ),
  lesson(
    "when-not-to-exploit",
    "x3",
    ["node-locking-in-rail", "reading-hud-stats"],
    ["gto-vs-exploitative", "ev-and-grading"],
    [calc("sample-size", "sample-size", 5), lab("exploit-or-not", "any", 4)],
    {},
    { ...WRITTEN, notes: ["locked-read", "approximate-ranges"], pool: "all" },
  ),

  // ---- X4 live and deep
  lesson(
    "live-game-dynamics",
    "x4",
    ["open-sizing"],
    ["rfi", "spr"],
    [calc("live-spr", "spr", 5), calc("live-steal", "steal", 5), planned("pot-tracking", "pot-tracking")],
    {},
    WRITTEN,
  ),
  lesson(
    "straddle-preflop",
    "x4",
    ["open-sizing"],
    ["rfi", "blind-defence"],
    [calc("straddle-steal", "steal", 6), calc("straddle-price", "pot-odds", 5), planned("straddle-charts", "range-paint", "straddle-charts")],
    {},
    { ...WRITTEN, notes: ["straddle-not-analysed", "conceptual"] },
  ),
  lesson(
    "straddle-postflop-low-spr",
    "x4",
    ["straddle-preflop", "spr-and-commitment"],
    ["spr", "multiway-pots"],
    [calc("low-spr", "spr", 6), solver("low-spr-rivers", "river", 3, { pot: "3bp" })],
    {},
    { ...WRITTEN, notes: ["straddle-not-analysed", "approximate-ranges"] },
  ),
  lesson(
    "deep-stacks-200bb",
    "x4",
    ["spr-and-commitment"],
    ["spr", "equity-realisation", "bet-sizing"],
    [chart("deep-opens", "rfi", 12, { set: TABLE_6_200 }), chart("deep-defence", "vs-open", 12, { set: TABLE_6_200 }), planned("spr-toggle", "depth-split", "flop-library", "flop")],
    { spots: [spot("preflop", ["unopened", "vs-open"])] },
    WRITTEN,
  ),
];

/** Lessons in course order, with their `P1-L<k>`-style codes filled in. */
function withCodes(list: LessonMeta[]): LessonMeta[] {
  const counts = new Map<ModuleId, number>();
  return list.map((meta) => {
    const k = (counts.get(meta.module) ?? 0) + 1;
    counts.set(meta.module, k);
    return { ...meta, code: `${moduleCode(meta.module)}-L${k}` };
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
  return "preflop";
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
