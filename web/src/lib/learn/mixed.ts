/**
 * Mixed sets of practice items across lessons (Learn L5, `docs/LEARN-PLAN.md`
 * §4 and §14): the placement test, the module capstones and the daily
 * five-minute dose.
 *
 * All three deal items exactly as a lesson's own exercises do: a card spec
 * (`cardFor`) from one of a lesson's generated exercises and a seed. The same
 * views play them and the same graders grade them (the analysis, the solver,
 * `math.ts`, the board reader), so a mixed item is right exactly when the
 * same item in its lesson would be. Interleaving is the point: items from
 * different lessons alternate, so the learner has to tell which idea a spot
 * asks for before applying it.
 *
 * - **Placement test** (`/learn/placement`): per track, a few items from each
 *   module. A module whose items pass tests out its written lessons: a
 *   `tested-out` entry in each lesson's progress (`TESTED_OUT`), a status of
 *   its own, never "passed". No database change: the existing writer carries it.
 * - **Module capstone**: at the end of a module (on its last written lesson),
 *   a mixed review of its lessons' exercise kinds. Missed items become review
 *   cards; the score is not stored.
 * - **Daily dose**: due review cards and one new item from the recommended
 *   lesson, a few minutes' work, on the map and on `/learn/review`.
 *
 * Pure: the screens own the storage and the network.
 */

import { seeded, type Rng } from "../training/rng";
import { TRACKS, lessonsIn, requiredExercises, type GeneratedExerciseDef, type LessonId, type LessonMeta, type ModuleId, type TrackId, LESSONS, courseOrder } from "./course";
import { cardFor, lessonDone, TESTED_OUT, type Card, type LessonResult, type NewCard, type ProgressMap } from "./progress";

/** One item of a mixed set: the lesson and module it comes from, and the card spec it is dealt from. */
export interface MixedItem {
  lesson: LessonId;
  module: ModuleId;
  card: NewCard;
}

/**
 * The exercises a mixed set may draw from in a lesson: the ones that count
 * towards passing it (a flop one only where the flop library can be played).
 * Only written lessons have practice.
 */
export function drawable(meta: LessonMeta, flopLibrary: boolean): GeneratedExerciseDef[] {
  return meta.written ? requiredExercises(meta, flopLibrary) : [];
}

const seedOf = (rng: Rng) => Math.floor(rng() * 0x1_0000_0000) >>> 0;

/** Fisher–Yates with the set's own generator. */
function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * `count` items from a module, interleaved by lesson: the lessons in a
 * shuffled order, one item from each in turn, each from one of the lesson's
 * exercises at random and a fresh seed. Deterministic in `seed`. Empty when
 * no written lesson of the module has an exercise to draw from.
 */
export function moduleItems(module: ModuleId, count: number, seed: number, flopLibrary: boolean): MixedItem[] {
  const rng = seeded(seed >>> 0);
  const lessons = shuffled(
    lessonsIn(module).filter((meta) => drawable(meta, flopLibrary).length > 0),
    rng,
  );
  if (lessons.length === 0) return [];
  const out: MixedItem[] = [];
  const used = new Map<LessonId, Set<string>>();
  for (let i = 0; i < count; i += 1) {
    const meta = lessons[i % lessons.length];
    const defs = drawable(meta, flopLibrary);
    // Prefer an exercise of this lesson not dealt yet in the set: more kinds, more interleaving.
    const seen = used.get(meta.id) ?? new Set<string>();
    const fresh = defs.filter((def) => !seen.has(def.id));
    const from = fresh.length > 0 ? fresh : defs;
    const def = from[Math.floor(rng() * from.length)];
    seen.add(def.id);
    used.set(meta.id, seen);
    out.push({ lesson: meta.id, module, card: cardFor(meta, def, seedOf(rng)) });
  }
  return out;
}

/** Round-robin over several lists: one from each in turn, so neighbours come from different lists. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i += 1) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

/* ------------------------------------------------------------ placement - */

/** Items per module in a placement test. */
export const PLACEMENT_PER_MODULE = 4;
/**
 * Share of a module's graded items a placement test needs to test it out:
 * three of four, above every exercise's own pass share (at most 70%), since
 * it stands in for all of them.
 */
export const PLACEMENT_PASS = 0.75;
/** Graded items a module needs at least before it can be tested out (a spot that cannot be dealt is not counted). */
export const PLACEMENT_MIN_GRADED = 3;

/** A track's placement test: `PLACEMENT_PER_MODULE` items per module, interleaved across modules. */
export function placementItems(track: TrackId, seed: number, flopLibrary: boolean): MixedItem[] {
  const rng = seeded(seed >>> 0);
  return interleave(TRACKS[track].map((module) => moduleItems(module, PLACEMENT_PER_MODULE, seedOf(rng), flopLibrary)));
}

export interface ModuleOutcome {
  module: ModuleId;
  /** Items dealt from the module. */
  asked: number;
  /** Items answered and graded (a skipped item or one that could not be dealt is not). */
  graded: number;
  correct: number;
  /** Whether the module tests out: enough graded, and `PLACEMENT_PASS` of them right. */
  passed: boolean;
}

/**
 * Per module, how the placement test went. `answers[i]` is item `i`'s verdict:
 * right, wrong, or null when it was not graded.
 */
export function placementOutcome(track: TrackId, items: readonly MixedItem[], answers: ReadonlyArray<boolean | null | undefined>): ModuleOutcome[] {
  return TRACKS[track].map((module) => {
    let asked = 0;
    let graded = 0;
    let correct = 0;
    items.forEach((item, index) => {
      if (item.module !== module) return;
      asked += 1;
      const answer = answers[index];
      if (answer === null || answer === undefined) return;
      graded += 1;
      if (answer) correct += 1;
    });
    const passed = graded >= PLACEMENT_MIN_GRADED && correct >= Math.ceil(PLACEMENT_PASS * graded - 1e-9);
    return { module, asked, graded, correct, passed };
  });
}

/**
 * The results a placement test records: for every written lesson of every
 * module that tested out, a `tested-out` entry with the module's score —
 * unless the lesson is passed or tested out already. Never `lessonPassed`:
 * testing out is not passing.
 */
export function testOutResults(progress: ProgressMap, outcomes: readonly ModuleOutcome[]): LessonResult[] {
  const out: LessonResult[] = [];
  for (const outcome of outcomes) {
    if (!outcome.passed) continue;
    for (const meta of lessonsIn(outcome.module)) {
      if (!meta.written || lessonDone(progress[meta.id])) continue;
      out.push({ lesson: meta.id, exercise: TESTED_OUT, correct: outcome.correct, total: outcome.graded, passed: true, lessonPassed: false });
    }
  }
  return out;
}

/* ------------------------------------------------------------- capstone - */

/** Items in a module capstone. */
export const CAPSTONE_COUNT = 6;

/** The lesson whose page closes a module with its capstone: its last written lesson, or null when none is written. */
export function capstoneLesson(module: ModuleId): LessonId | null {
  const written = lessonsIn(module).filter((meta) => meta.written);
  return written.length > 0 ? written[written.length - 1].id : null;
}

/** A module capstone: `CAPSTONE_COUNT` items across its lessons' exercises, interleaved by lesson. */
export function capstoneItems(module: ModuleId, seed: number, flopLibrary: boolean): MixedItem[] {
  return moduleItems(module, CAPSTONE_COUNT, seed, flopLibrary);
}

/* ---------------------------------------------------------------- dose - */

/** Review cards in a daily dose, at most. */
export const DOSE_REVIEWS = 4;

/**
 * The lesson a daily dose takes its new item from: the first recommended
 * lesson that is not done and has practice, else the first such lesson in
 * course order. Null when every lesson is done.
 */
export function doseLesson(progress: ProgressMap, recommended: readonly LessonId[], flopLibrary: boolean): LessonId | null {
  const open = (id: LessonId) => !lessonDone(progress[id]) && drawable(LESSONS[id], flopLibrary).length > 0;
  for (const id of recommended) if (open(id)) return id;
  for (const meta of courseOrder()) if (open(meta.id)) return meta.id;
  return null;
}

/** One new item from a lesson, for the dose: one of its exercises and a seed, by `seed`. */
export function newItem(lesson: LessonId, seed: number, flopLibrary: boolean): MixedItem | null {
  const meta = LESSONS[lesson];
  const defs = drawable(meta, flopLibrary);
  if (defs.length === 0) return null;
  const rng = seeded(seed >>> 0);
  const def = defs[Math.floor(rng() * defs.length)];
  return { lesson, module: meta.module, card: cardFor(meta, def, seedOf(rng)) };
}

/** An item of the dose: a due review card (rescheduled when answered), or the new item. */
export type DoseItem = { kind: "review"; card: Card } | { kind: "new"; item: MixedItem };

/**
 * A daily dose: the `DOSE_REVIEWS` cards due longest, and the new item in the
 * middle of them, so it is not the last thing seen.
 */
export function doseItems(due: readonly Card[], fresh: MixedItem | null): DoseItem[] {
  const reviews: DoseItem[] = [...due]
    .sort((a, b) => Date.parse(a.state.dueAt) - Date.parse(b.state.dueAt))
    .slice(0, DOSE_REVIEWS)
    .map((card) => ({ kind: "review", card }));
  if (!fresh) return reviews;
  const at = Math.floor(reviews.length / 2);
  return [...reviews.slice(0, at), { kind: "new", item: fresh }, ...reviews.slice(at)];
}

/** The day a dose belongs to, in the learner's own time zone: `YYYY-MM-DD`. */
export function doseDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
