/**
 * The database side of Learn (L1, `20270317090000_learn_progress.sql`).
 *
 * Reads are plain selects under RLS (a reader sees only their own rows);
 * writes are the three definer RPCs. The browser grades the exercises
 * (`lib/learn/practice.ts`, `lib/training`); the database keeps the results
 * and schedules the review cards (SM-2, the drills' `drill_next`).
 */

import type { Grade } from "../analysis/types";
import { LESSON_IDS } from "../learn/course";
import { progressFromRows, cardFromRow, type Card, type LessonResult, type NewCard, type ProgressMap } from "../learn/progress";
import { currentUserId, requireDb, rpc } from "./client";

type Row = Record<string, unknown>;

/** The signed-in learner's progress, or null when there is no session. */
export async function fetchLessonProgress(): Promise<ProgressMap | null> {
  if (!(await currentUserId())) return null;
  const { data, error } = await requireDb().from("lesson_progress").select("lesson_id, status, exercises, started_at, passed_at");
  if (error) throw new Error(error.message);
  return progressFromRows((data ?? []) as Row[]);
}

/** Records exercise results (and lessons passed); at most 100 at a time. */
export async function recordLessonResults(results: readonly LessonResult[]): Promise<number> {
  let recorded = 0;
  for (let i = 0; i < results.length; i += 100) {
    const batch = results.slice(i, i + 100).map((r) => ({
      lesson: r.lesson,
      exercise: r.exercise,
      ...(r.exercise ? { correct: r.correct ?? 0, total: r.total ?? 0, passed: Boolean(r.passed) } : {}),
      lesson_passed: Boolean(r.lessonPassed),
    }));
    const payload = await rpc<Row | null>("record_lesson_results", { p_rows: batch });
    recorded += Number(payload?.recorded ?? 0);
  }
  return recorded;
}

/** Makes review cards of missed quiz items; at most 20 at a time. */
export async function addLessonCards(cards: readonly NewCard[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < cards.length; i += 20) {
    const batch = cards.slice(i, i + 20).map((c) => ({ lesson: c.lesson, exercise: c.exercise, kind: c.kind, key: c.key, item: c.item }));
    const payload = await rpc<Row | null>("add_lesson_cards", { p_cards: batch });
    inserted += Number(payload?.inserted ?? 0);
  }
  return inserted;
}

export interface CardReview {
  intervalDays: number;
  dueAt: string;
  relearn: boolean;
}

export async function reviewLessonCard(id: string, grade: Grade): Promise<CardReview> {
  const payload = await rpc<Row | null>("review_lesson_card", { p_card: id, p_grade: grade });
  return {
    intervalDays: Number(payload?.intervalDays ?? 0),
    dueAt: String(payload?.dueAt ?? ""),
    relearn: payload?.relearn === true,
  };
}

const CARD_COLUMNS =
  "id, lesson_id, exercise_id, kind, item_key, item, reps, lapses, ease, interval_days, due_at, reviews, last_grade";

/**
 * Lessons whose cards are shown: those on the map. Cards (and progress rows)
 * of L1 lessons that left the map in L1.1 stay in the database untouched;
 * they are just not dealt or counted.
 */
const SHOWN_LESSONS: readonly string[] = LESSON_IDS;

/** Cards due by `until` (now by default), soonest first. */
export async function fetchDueCards(limit = 20, until: Date = new Date()): Promise<Card[]> {
  if (!(await currentUserId())) return [];
  const { data, error } = await requireDb()
    .from("lesson_cards")
    .select(CARD_COLUMNS)
    .in("lesson_id", SHOWN_LESSONS)
    .lte("due_at", until.toISOString())
    .order("due_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map(cardFromRow).filter((card): card is Card => card !== null);
}

export interface CardCounts {
  due: number;
  dueToday: number;
  total: number;
}

export async function fetchCardCounts(endOfDay: Date): Promise<CardCounts | null> {
  if (!(await currentUserId())) return null;
  const client = requireDb();
  const count = async (until: Date | null) => {
    let query = client.from("lesson_cards").select("id", { count: "exact", head: true }).in("lesson_id", SHOWN_LESSONS);
    if (until) query = query.lte("due_at", until.toISOString());
    const { count: n, error } = await query;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const [due, dueToday, total] = await Promise.all([count(new Date()), count(endOfDay), count(null)]);
  return { due, dueToday, total };
}
