/**
 * Lesson progress and review cards, as data (Learn L1).
 *
 * One model for both places progress lives: the database for a signed-in
 * learner (`20270317090000_learn_progress.sql`, which applies exactly these
 * rules in `record_lesson_results`) and the browser's storage for a
 * signed-out one. Pure: the components own the storage and the network.
 *
 * - **An exercise** keeps its latest score; whether it was ever passed sticks.
 * - **A lesson is passed** when every exercise that counts towards it
 *   (`requiredExercises`: what Rail can generate and grade today) has been
 *   passed. That status sticks too: failing a later retry never un-passes a
 *   lesson. Automatic, with no "mark as seen".
 * - **Status on the map**: not started, in progress (anything recorded),
 *   mastered (passed). "Recommended" is a badge on top, from the leaks.
 * - **A review card** is a missed quiz item: its spec (kind and seed, from
 *   which the item is regenerated), scheduled by the drills' SM-2
 *   (`lib/training/schedule.ts`).
 */

import { nextDrillState, newDrillState, QUALITY, type DrillState } from "../training/schedule";
import type { Grade } from "../analysis/types";
import type { DealBias, PreflopFamily } from "../training/preflop";
import type { RiverPot, RiverRole, RiverSeat } from "../training/river";
import { isLabPreset, type LabPreset } from "../training/labPresets";
import type { FlopFacing } from "../training/flop";
import type { ChartPosition } from "../charts";
import {
  CALC_KINDS,
  CLASSIFY_KINDS,
  LESSONS,
  isLessonId,
  requiredExercises,
  type CalcKind,
  type ClassifyKind,
  type GeneratedExerciseDef,
  type LessonId,
  type LessonMeta,
} from "./course";

/* --------------------------------------------------------------- progress - */

export interface ExerciseRecord {
  correct: number;
  total: number;
  /** Ever passed. */
  passed: boolean;
  attempts: number;
  at: string;
}

export interface LessonRecord {
  status: "started" | "passed";
  exercises: Record<string, ExerciseRecord>;
  startedAt: string;
  passedAt: string | null;
}

export type ProgressMap = Partial<Record<LessonId, LessonRecord>>;

/**
 * Map status. `tested-out` (L5): the placement test passed the lesson's
 * module, a status of its own, distinct from passing the lesson's exercises
 * (which still makes it `mastered`).
 */
export type LessonStatus = "not-started" | "in-progress" | "tested-out" | "mastered";

/**
 * The progress key a placement test writes for each lesson of a module it
 * passes (L5): an entry in the lesson's `exercises` map with `passed: true`.
 * It is no exercise of any lesson (`course.test.ts` holds that), so it never
 * counts towards passing; the existing model and writer carry it, with no
 * migration.
 */
export const TESTED_OUT = "tested-out";

/** One result as the database's writer takes it (`record_lesson_results`). */
export interface LessonResult {
  lesson: LessonId;
  exercise: string | null;
  correct?: number;
  total?: number;
  passed?: boolean;
  lessonPassed?: boolean;
}

/** The map after one result. Pure; the database applies the same rules. */
export function applyResult(map: ProgressMap, result: LessonResult, now: Date): ProgressMap {
  const at = now.toISOString();
  const before = map[result.lesson];
  const exercises = { ...(before?.exercises ?? {}) };
  if (result.exercise) {
    const old = exercises[result.exercise];
    exercises[result.exercise] = {
      correct: result.correct ?? 0,
      total: result.total ?? 0,
      passed: Boolean(old?.passed) || Boolean(result.passed),
      attempts: (old?.attempts ?? 0) + 1,
      at,
    };
  }
  const passed = before?.status === "passed" || Boolean(result.lessonPassed);
  return {
    ...map,
    [result.lesson]: {
      status: passed ? "passed" : "started",
      exercises,
      startedAt: before?.startedAt ?? at,
      passedAt: before?.passedAt ?? (passed ? at : null),
    },
  };
}

/** Whether every exercise that counts towards the lesson has been passed. A lesson with none never passes by exercises. */
export function lessonComplete(meta: LessonMeta, exercises: Readonly<Record<string, ExerciseRecord>>, flopLibrary = false): boolean {
  const required = requiredExercises(meta, flopLibrary);
  return required.length > 0 && required.every((def) => exercises[def.id]?.passed === true);
}

export function lessonStatus(record: LessonRecord | undefined): LessonStatus {
  if (!record) return "not-started";
  if (record.status === "passed") return "mastered";
  return record.exercises[TESTED_OUT]?.passed ? "tested-out" : "in-progress";
}

/** When a placement test tested the lesson out (ISO), or null. */
export function testedOutAt(record: LessonRecord | undefined): string | null {
  const entry = record?.exercises[TESTED_OUT];
  return entry?.passed && entry.at ? entry.at : null;
}

/** Whether the learner is done with a lesson: passed it, or tested out of it. */
export function lessonDone(record: LessonRecord | undefined): boolean {
  const status = lessonStatus(record);
  return status === "mastered" || status === "tested-out";
}

/**
 * The day a lesson's real-hand mastery is measured from (L3, L5): when it was
 * passed, else when it was tested out. Null for neither.
 */
export function settledAt(record: LessonRecord | undefined): string | null {
  if (record?.status === "passed" && record.passedAt) return record.passedAt;
  return testedOutAt(record);
}

/**
 * The result to record when an exercise finishes, with `lessonPassed` set
 * when this pass completes the lesson.
 */
export function exerciseResult(
  map: ProgressMap,
  meta: LessonMeta,
  exercise: string,
  correct: number,
  total: number,
  passed: boolean,
  flopLibrary = false,
): LessonResult {
  const exercises = { ...(map[meta.id]?.exercises ?? {}) };
  const old = exercises[exercise];
  exercises[exercise] = { correct, total, passed: Boolean(old?.passed) || passed, attempts: 0, at: "" };
  return {
    lesson: meta.id,
    exercise,
    correct,
    total,
    passed,
    lessonPassed: map[meta.id]?.status !== "passed" && lessonComplete(meta, exercises, flopLibrary),
  };
}

/** Lesson progress rows from the database (`lesson_progress`), read back as a map; unknown lessons are dropped. */
export function progressFromRows(rows: ReadonlyArray<Record<string, unknown>>): ProgressMap {
  const map: ProgressMap = {};
  for (const row of rows) {
    const id = row.lesson_id;
    if (!isLessonId(id)) continue;
    map[id] = {
      status: row.status === "passed" ? "passed" : "started",
      exercises: exerciseRecords(row.exercises),
      startedAt: typeof row.started_at === "string" ? row.started_at : "",
      passedAt: typeof row.passed_at === "string" ? row.passed_at : null,
    };
  }
  return map;
}

function exerciseRecords(value: unknown): Record<string, ExerciseRecord> {
  const out: Record<string, ExerciseRecord> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || !raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    out[id] = {
      correct: n(r.correct),
      total: n(r.total),
      passed: r.passed === true,
      attempts: n(r.attempts),
      at: typeof r.at === "string" ? r.at : "",
    };
  }
  return out;
}

/* ----------------------------------------------------------------- cards - */

/** What a review card stores to regenerate its item. Small and plain: the database caps it at 2 KB. */
export type CardItem =
  | { k: "calc"; calc: CalcKind; seed: number }
  | { k: "classify"; classify: ClassifyKind; seed: number }
  | {
      k: "chart";
      seed: number;
      family: PreflopFamily | "random";
      seat?: ChartPosition | null;
      vs?: ChartPosition | null;
      set?: string | null;
      bias: DealBias;
    }
  | {
      k: "river" | "turn";
      seed: number;
      pot: RiverPot | "any";
      seat: RiverSeat | "any";
      role: RiverRole | "any";
      facing?: "check" | "bet" | "any";
      /** The turn only (L3): the flop line before it. */
      flop?: "checked" | "bet";
      bias: DealBias;
    }
  | {
      /** A flop spot from the flop library (L2). */
      k: "flop";
      seed: number;
      pot: RiverPot | "any";
      seat: RiverSeat | "any";
      role: RiverRole | "any";
      facing?: FlopFacing;
      line?: string;
      bias: DealBias;
    }
  | {
      /** A range split (L2; the river since L3): stored as a `solver-spot` card, since a solve grades it. */
      k: "split";
      street: "flop" | "turn" | "river";
      seed: number;
      pot: RiverPot | "any";
      seat: RiverSeat | "any";
      role: RiverRole | "any";
      facing?: FlopFacing;
      line?: string;
      /** The turn only (L3): the flop line before it. */
      flop?: "checked" | "bet";
    }
  | {
      /** A range paint of a chart's first-in range (L3): a `chart-quiz` card, since the chart grades it. */
      k: "paint";
      source: "chart";
      seed: number;
      set?: string | null;
      seat?: ChartPosition | null;
    }
  | {
      /** An exploit-lab item (L4): a `solver-spot` card, since the solver's best response grades it. */
      k: "lock";
      seed: number;
      preset: LabPreset | "any";
    }
  | {
      /** A range paint of a river node (L3): a `solver-spot` card. */
      k: "paint";
      source: "river";
      seed: number;
      pot: RiverPot | "any";
      seat: RiverSeat | "any";
      role: RiverRole | "any";
      facing?: "check" | "bet" | "any";
    };

export type CardKind = "chart-quiz" | "solver-spot" | "calc" | "classify";

export interface NewCard {
  lesson: LessonId;
  exercise: string;
  kind: CardKind;
  key: string;
  item: CardItem;
}

export interface Card extends NewCard {
  /** The database id, or the key for a card kept in the browser. */
  id: string;
  state: DrillState;
  reviews: number;
  lastGrade: Grade | null;
}

/** The card spec of an exercise's item. */
export function cardFor(meta: LessonMeta, def: GeneratedExerciseDef, seed: number): NewCard {
  const key = `${meta.id}:${def.id}:${seed >>> 0}`;
  const base = { lesson: meta.id, exercise: def.id, key };
  switch (def.kind) {
    case "calc":
      return { ...base, kind: "calc", item: { k: "calc", calc: def.calc, seed: seed >>> 0 } };
    case "classify":
      return { ...base, kind: "classify", item: { k: "classify", classify: def.classify, seed: seed >>> 0 } };
    case "chart-quiz":
      return {
        ...base,
        kind: "chart-quiz",
        item: { k: "chart", seed: seed >>> 0, family: def.family, seat: def.seat ?? null, vs: def.vs ?? null, set: def.set ?? null, bias: def.bias },
      };
    case "range-split":
      return {
        ...base,
        kind: "solver-spot",
        item: {
          k: "split",
          street: def.street,
          seed: seed >>> 0,
          pot: def.pot,
          seat: def.seat,
          role: def.role,
          ...(def.facing ? { facing: def.facing } : {}),
          ...(def.line ? { line: def.line } : {}),
          ...(def.flop ? { flop: def.flop } : {}),
        },
      };
    case "node-lock":
      return { ...base, kind: "solver-spot", item: { k: "lock", seed: seed >>> 0, preset: def.preset } };
    case "range-paint":
      if (def.source === "chart") {
        return { ...base, kind: "chart-quiz", item: { k: "paint", source: "chart", seed: seed >>> 0, set: def.set ?? null, seat: def.seat ?? null } };
      }
      return {
        ...base,
        kind: "solver-spot",
        item: {
          k: "paint",
          source: "river",
          seed: seed >>> 0,
          pot: def.pot,
          seat: def.seat,
          role: def.role,
          ...(def.facing ? { facing: def.facing } : {}),
        },
      };
    default:
      if (def.street === "flop") {
        return {
          ...base,
          kind: "solver-spot",
          item: {
            k: "flop",
            seed: seed >>> 0,
            pot: def.pot,
            seat: def.seat,
            role: def.role,
            ...(def.facing ? { facing: def.facing } : {}),
            ...(def.line ? { line: def.line } : {}),
            bias: def.bias,
          },
        };
      }
      return {
        ...base,
        kind: "solver-spot",
        item: {
          k: def.street === "turn" ? "turn" : "river",
          seed: seed >>> 0,
          pot: def.pot,
          seat: def.seat,
          role: def.role,
          ...(def.facing === "check" || def.facing === "bet" || def.facing === "any" ? { facing: def.facing } : {}),
          ...(def.street === "turn" && def.flop ? { flop: def.flop } : {}),
          bias: def.bias,
        },
      };
  }
}

const FACINGS = ["check", "bet", "raise", "any"] as const;
const isFacing = (x: unknown): x is FlopFacing => (FACINGS as readonly unknown[]).includes(x);
const isLine = (x: unknown): x is string => typeof x === "string" && /^[a-z0-9-]{1,32}$/.test(x);

/** A stored item read back, or null when it is not one this version understands. */
export function parseCardItem(value: unknown): CardItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const seed = typeof v.seed === "number" && Number.isInteger(v.seed) && v.seed >= 0 ? v.seed : null;
  if (seed === null) return null;
  if (v.k === "calc" && (CALC_KINDS as readonly unknown[]).includes(v.calc)) return { k: "calc", calc: v.calc as CalcKind, seed };
  if (v.k === "classify" && (CLASSIFY_KINDS as readonly unknown[]).includes(v.classify)) {
    return { k: "classify", classify: v.classify as ClassifyKind, seed };
  }
  const bias: DealBias = v.bias === "borderline" ? "borderline" : "range";
  if (v.k === "chart" && typeof v.family === "string") {
    return {
      k: "chart",
      seed,
      family: v.family as PreflopFamily,
      seat: typeof v.seat === "string" ? (v.seat as ChartPosition) : null,
      vs: typeof v.vs === "string" ? (v.vs as ChartPosition) : null,
      set: typeof v.set === "string" ? v.set : null,
      bias,
    };
  }
  if ((v.k === "river" || v.k === "turn") && typeof v.pot === "string" && typeof v.seat === "string" && typeof v.role === "string") {
    return {
      k: v.k,
      seed,
      pot: v.pot as RiverPot | "any",
      seat: v.seat as RiverSeat | "any",
      role: v.role as RiverRole | "any",
      ...(v.facing === "check" || v.facing === "bet" ? { facing: v.facing } : {}),
      ...(v.k === "turn" && (v.flop === "checked" || v.flop === "bet") ? { flop: v.flop } : {}),
      bias,
    };
  }
  const postflop = typeof v.pot === "string" && typeof v.seat === "string" && typeof v.role === "string";
  if (v.k === "flop" && postflop) {
    return {
      k: "flop",
      seed,
      pot: v.pot as RiverPot | "any",
      seat: v.seat as RiverSeat | "any",
      role: v.role as RiverRole | "any",
      ...(isFacing(v.facing) ? { facing: v.facing } : {}),
      ...(isLine(v.line) ? { line: v.line } : {}),
      bias,
    };
  }
  if (v.k === "lock" && (v.preset === "any" || isLabPreset(v.preset))) return { k: "lock", seed, preset: v.preset };
  if (v.k === "paint" && v.source === "chart") {
    return {
      k: "paint",
      source: "chart",
      seed,
      set: typeof v.set === "string" && /^[a-z0-9-]{1,64}$/.test(v.set) ? v.set : null,
      seat: typeof v.seat === "string" ? (v.seat as ChartPosition) : null,
    };
  }
  if (v.k === "paint" && v.source === "river" && postflop) {
    return {
      k: "paint",
      source: "river",
      seed,
      pot: v.pot as RiverPot | "any",
      seat: v.seat as RiverSeat | "any",
      role: v.role as RiverRole | "any",
      ...(v.facing === "check" || v.facing === "bet" || v.facing === "any" ? { facing: v.facing } : {}),
    };
  }
  if (v.k === "split" && (v.street === "flop" || v.street === "turn" || v.street === "river") && postflop) {
    return {
      k: "split",
      street: v.street,
      seed,
      pot: v.pot as RiverPot | "any",
      seat: v.seat as RiverSeat | "any",
      role: v.role as RiverRole | "any",
      ...(isFacing(v.facing) ? { facing: v.facing } : {}),
      ...(isLine(v.line) ? { line: v.line } : {}),
      ...(v.street === "turn" && (v.flop === "checked" || v.flop === "bet") ? { flop: v.flop } : {}),
    };
  }
  return null;
}

/** A card row from the database (`lesson_cards`), or null when its lesson or item is unknown. */
export function cardFromRow(row: Record<string, unknown>): Card | null {
  const lesson = row.lesson_id;
  const item = parseCardItem(row.item);
  if (!isLessonId(lesson) || !item) return null;
  const kind = row.kind;
  if (kind !== "chart-quiz" && kind !== "solver-spot" && kind !== "calc" && kind !== "classify") return null;
  const n = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : 0);
  return {
    id: String(row.id ?? ""),
    lesson,
    exercise: String(row.exercise_id ?? ""),
    kind,
    key: String(row.item_key ?? ""),
    item,
    state: {
      reps: n(row.reps),
      lapses: n(row.lapses),
      ease: n(row.ease) || 2.5,
      intervalDays: n(row.interval_days),
      dueAt: String(row.due_at ?? new Date(0).toISOString()),
    },
    reviews: n(row.reviews),
    lastGrade: typeof row.last_grade === "string" ? (row.last_grade as Grade) : null,
  };
}

/** A quiz answer as a grade for the schedule: a trainer spot keeps the analysis' grade; a sum or a sort is right or wrong. */
export function quizGrade(correct: boolean): Grade {
  return correct ? "perfect" : "mistake";
}

/** A card kept in the browser, after a review. */
export function reviewLocalCard(card: Card, grade: Grade, now: Date): Card {
  return {
    ...card,
    state: nextDrillState(card.state, QUALITY[grade], now),
    reviews: card.reviews + 1,
    lastGrade: grade,
  };
}

/** A new card kept in the browser: due now. */
export function localCard(card: NewCard, now: Date): Card {
  return { ...card, id: card.key, state: newDrillState(now), reviews: 0, lastGrade: null };
}

/* ------------------------------------------------------- browser storage - */

/** Keys in the browser's storage. Versioned: a new shape gets a new key rather than misreading the old one. */
export const LOCAL_PROGRESS_KEY = "rail.learn.progress.v1";
export const LOCAL_CARDS_KEY = "rail.learn.cards.v1";
/** Cards kept in the browser at most (the database keeps 2,000 per account). */
export const MAX_LOCAL_CARDS = 500;

/** Stored progress read back; anything malformed is dropped, never thrown. */
export function parseLocalProgress(text: string | null): ProgressMap {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const map: ProgressMap = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isLessonId(id) || !value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      map[id] = {
        status: v.status === "passed" ? "passed" : "started",
        exercises: exerciseRecords(v.exercises),
        startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
        passedAt: typeof v.passedAt === "string" ? v.passedAt : null,
      };
    }
    return map;
  } catch {
    return {};
  }
}

export function parseLocalCards(text: string | null): Card[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: Card[] = [];
    for (const value of raw) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const item = parseCardItem(v.item);
      const state = v.state as Record<string, unknown> | undefined;
      if (!item || !isLessonId(v.lesson) || typeof v.key !== "string" || !state) continue;
      const kind = v.kind;
      if (kind !== "chart-quiz" && kind !== "solver-spot" && kind !== "calc" && kind !== "classify") continue;
      out.push({
        id: v.key,
        key: v.key,
        lesson: v.lesson,
        exercise: typeof v.exercise === "string" ? v.exercise : "",
        kind,
        item,
        state: {
          reps: Number(state.reps) || 0,
          lapses: Number(state.lapses) || 0,
          ease: Number(state.ease) || 2.5,
          intervalDays: Number(state.intervalDays) || 0,
          dueAt: typeof state.dueAt === "string" ? state.dueAt : new Date(0).toISOString(),
        },
        reviews: Number(v.reviews) || 0,
        lastGrade: typeof v.lastGrade === "string" ? (v.lastGrade as Grade) : null,
      });
    }
    return out.slice(0, MAX_LOCAL_CARDS);
  } catch {
    return [];
  }
}

/** Cards added to a local deck: a card already there (missed again) is due now. */
export function addLocalCards(deck: readonly Card[], cards: readonly NewCard[], now: Date): Card[] {
  const out = [...deck];
  for (const card of cards) {
    const at = out.findIndex((c) => c.key === card.key);
    if (at >= 0) {
      const due = Math.min(Date.parse(out[at].state.dueAt) || 0, now.getTime());
      out[at] = { ...out[at], state: { ...out[at].state, dueAt: new Date(due).toISOString() } };
    } else {
      out.push(localCard(card, now));
    }
  }
  return out.slice(-MAX_LOCAL_CARDS);
}

/** The local progress as the database's writer takes it, for "add it to this account". */
export function progressAsResults(map: ProgressMap): LessonResult[] {
  const out: LessonResult[] = [];
  for (const [id, record] of Object.entries(map) as [LessonId, LessonRecord][]) {
    if (!LESSONS[id]) continue;
    const entries = Object.entries(record.exercises);
    if (entries.length === 0) out.push({ lesson: id, exercise: null, lessonPassed: record.status === "passed" });
    entries.forEach(([exercise, r], index) => {
      out.push({
        lesson: id,
        exercise,
        correct: Math.min(r.correct, r.total),
        total: Math.max(0, Math.min(1000, r.total)),
        passed: r.passed,
        lessonPassed: index === entries.length - 1 && record.status === "passed",
      });
    });
  }
  return out;
}
