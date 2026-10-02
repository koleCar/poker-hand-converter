/**
 * Builds and saves a week's study plan in the browser (phase A8b): the leak
 * finder's rows for the whole library at the current analysis version, the
 * plan's pure logic (`lib/training/plan.ts`), then the hands and drills the
 * chosen areas need, and one `save_study_plan`.
 *
 * Run on the week's first visit (the rollover) and by "Rebuild". Rebuilding a
 * week keeps the ticks of the tasks it keeps (the database matches them by
 * kind and reference).
 */

import { ANALYSIS_VERSION } from "../../../lib/analysis";
import { fetchLeakHands, fetchLeaks } from "../../../lib/db/analysisLeaks";
import { saveStudyPlan, type StoredPlan } from "../../../lib/db/studyPlan";
import { fetchDrillSummary, fetchDrillsBySpot } from "../../../lib/db/training";
import {
  fundamentalsTasks,
  planFocus,
  planTasks,
  withReviews,
  type FocusArea,
  type PlanTask,
  type PreviousPlan,
  type ReviewHand,
} from "../../../lib/training/plan";

/** Hands fetched per area: enough to skip last week's reviewed ones and still offer three. */
const HANDS_PER_AREA = 12;

/** Last week's stored plan, as the rollover reads it. */
export function previousOf(plan: StoredPlan | null): PreviousPlan | null {
  if (!plan) return null;
  return {
    focus: plan.focus,
    tasks: plan.tasks.map((task) => ({ kind: task.kind, ref: task.ref, focus: task.focus, done: task.done, handId: task.handId })),
  };
}

export async function buildPlan(week: string, previous: StoredPlan | null): Promise<void> {
  const report = await fetchLeaks({});
  const rows = report?.rows ?? [];
  const hands = report?.hands ?? 0;
  const graded = report?.graded ?? 0;
  const prior = previousOf(previous);
  const focus = planFocus({ rows, hands, graded, previous: prior });

  let areas: FocusArea[] = focus.areas;
  let tasks: PlanTask[];
  if (focus.kind === "leaks") {
    const [drills, handPages] = await Promise.all([
      fetchDrillsBySpot().catch(() => new Map<string, { items: number; due: number }>()),
      Promise.all(
        areas.map((area) =>
          fetchLeakHands({}, { keys: area.keys, deviations: true, sort: "ev_loss", limit: HANDS_PER_AREA }).catch(() => ({
            total: 0,
            rows: [],
          })),
        ),
      ),
    ]);
    // What each hand looks like: fresh rows first, then last week's snapshot (a hand carried over).
    const known = new Map<string, ReviewHand>();
    for (const area of previous?.focus ?? []) for (const hand of area.reviews) known.set(hand.handId, hand);
    const handIds: Record<string, string[]> = {};
    areas.forEach((area, index) => {
      const ids: string[] = [];
      for (const row of handPages[index].rows) {
        if (!ids.includes(row.handId)) ids.push(row.handId);
        known.set(row.handId, {
          handId: row.handId,
          cards: row.heroCards,
          handClass: row.handClass,
          position: row.position,
          evLossBb: row.evLossBb,
          playedAt: row.playedAt,
        });
      }
      handIds[area.id] = ids;
    });
    tasks = planTasks({ areas, hands: handIds, drills, previous: prior });
    areas = withReviews(areas, tasks, known);
  } else {
    const summary = await fetchDrillSummary().catch(() => null);
    tasks = fundamentalsTasks(summary ? summary.due + summary.candidates : 0, prior);
  }

  await saveStudyPlan({
    weekStart: week,
    kind: focus.kind,
    analysisVersion: ANALYSIS_VERSION,
    focus: areas,
    baseline: {
      hands,
      graded,
      last: report?.last ?? null,
      evLossBb: Math.round(rows.reduce((sum, row) => sum + row.evLossBb, 0) * 1000) / 1000,
      reason: focus.reason,
    },
    tasks,
  });
}
