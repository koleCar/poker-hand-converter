/**
 * Re-check nudges (Learn L5, `docs/LEARN-PLAN.md` §4): when the learner's own
 * graded decisions in a lesson's spots got worse after they passed it (or
 * tested out of it), the map recommends the lesson again.
 *
 * It rests on mastery from real hands (L3, `mastery.ts`): the leak finder's
 * report read before and after the day the lesson was settled, and its own
 * Welch z on the mean move score. A nudge needs the same evidence the lesson
 * page calls "worse": at least `MASTERY_MIN_DECISIONS` graded decisions on
 * each side and a change past the leak finder's clear line. A lean, or too
 * few hands, is not a nudge. The nudge carries both sample sizes, so the map
 * can say how many decisions it rests on.
 *
 * The map reads two reports per (day, pot type) group; `recheckGroups` caps
 * the groups at `RECHECK_MAX_GROUPS`, the most recently settled first, so a
 * learner with many lessons is not sent dozens of requests.
 *
 * Pure: the screen fetches the reports.
 */

import { LESSONS, type LessonId } from "./course";
import { lessonPotType, lessonSpots, passDay, type Mastery } from "./mastery";
import { lessonDone, settledAt, type ProgressMap } from "./progress";

/** Groups of lessons (one day, one pot type) a map reads at most. */
export const RECHECK_MAX_GROUPS = 6;

export interface RecheckGroup {
  /** The day the lessons were settled: the reports' `to` / `from` bound. */
  day: string;
  potType?: string;
  lessons: LessonId[];
}

/**
 * The lessons to measure, grouped by the day they were settled and by the
 * pot type their own hands are read in: done lessons that name spots, the
 * most recent days first, at most `max` groups.
 */
export function recheckGroups(progress: ProgressMap, max = RECHECK_MAX_GROUPS): RecheckGroup[] {
  const groups = new Map<string, RecheckGroup>();
  for (const [id, record] of Object.entries(progress) as [LessonId, ProgressMap[LessonId]][]) {
    const meta = LESSONS[id];
    if (!meta || !lessonDone(record) || lessonSpots(meta).length === 0) continue;
    const at = settledAt(record);
    const day = at ? passDay(at) : null;
    if (!day) continue;
    const potType = lessonPotType(meta);
    const key = `${day}|${potType ?? ""}`;
    const group = groups.get(key) ?? { day, ...(potType ? { potType } : {}), lessons: [] };
    group.lessons.push(id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, max);
}

export interface RecheckNudge {
  lesson: LessonId;
  /** Graded decisions before and after the day, the sample the nudge rests on. */
  before: number;
  after: number;
  since: string;
}

/** A nudge when the lesson's own hands got worse past the noise; null otherwise (better, steady, a lean, or too few). */
export function recheckNudge(lesson: LessonId, mastery: Mastery): RecheckNudge | null {
  if (!mastery.enough || mastery.trend !== "worse") return null;
  return { lesson, before: mastery.before.decisions, after: mastery.after.decisions, since: mastery.since };
}
