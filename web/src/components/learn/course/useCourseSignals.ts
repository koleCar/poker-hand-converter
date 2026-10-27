/**
 * What the learner's own analysed hands say about the course, for the map and
 * the daily dose (Learn L1, L5):
 *
 * - `useRecommendations`: lessons recommended from leaks and flags (smart
 *   feature 1, `recommend.ts`), never one already passed or tested out;
 * - `useRechecks`: lessons passed (or tested out) whose decisions in their
 *   own spots got worse since, past the noise (`recheck.ts`, on L3's mastery).
 *
 * Both need a signed-in learner with a database; otherwise they stay empty.
 * Reads only: the leak finder's report and the overview (invoker, under RLS).
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import type { FlagCode } from "../../../lib/analysis/types";
import { fetchAnalysisOverview } from "../../../lib/db";
import { fetchLeaks } from "../../../lib/db/analysisLeaks";
import { LESSONS, type LessonId } from "../../../lib/learn/course";
import { masteryFrom } from "../../../lib/learn/mastery";
import { lessonDone } from "../../../lib/learn/progress";
import { recheckGroups, recheckNudge, type RecheckNudge } from "../../../lib/learn/recheck";
import { recommend, type Recommendation } from "../../../lib/learn/recommend";
import { focusAreas, pickFocus } from "../../../lib/training/plan";
import { useLearn } from "./LearnStore";

/** The lessons the learner is done with (passed or tested out), as a stable key. */
function useDoneKey(): string {
  const store = useLearn();
  return useMemo(
    () =>
      (Object.keys(store.progress) as LessonId[])
        .filter((id) => lessonDone(store.progress[id]))
        .sort()
        .join(","),
    [store.progress],
  );
}

export function useRecommendations(): Map<LessonId, Recommendation> {
  const store = useLearn();
  const doneKey = useDoneKey();
  const [recs, setRecs] = useState<Map<LessonId, Recommendation>>(new Map());
  useEffect(() => {
    if (store.mode !== "account") return;
    let live = true;
    Promise.all([fetchLeaks({}), fetchAnalysisOverview({})])
      .then(([report, overview]) => {
        if (!live || !report) return;
        const areas = pickFocus(focusAreas(report.rows, report.hands), 5);
        const flagTotals = new Map<string, number>();
        for (const flag of overview?.flags ?? []) flagTotals.set(flag.code, (flagTotals.get(flag.code) ?? 0) + flag.count);
        const flags = [...flagTotals].map(([code, decisions]) => ({ code: code as FlagCode, decisions }));
        const done = new Set(doneKey ? (doneKey.split(",") as LessonId[]) : []);
        setRecs(new Map(recommend(areas, flags, { passed: done }).map((rec) => [rec.lesson, rec])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [store.mode, doneKey]);
  return recs;
}

/** The progress fields re-checks depend on, as a stable key: a lesson and its settled day. */
function useSettledKey(): string {
  const store = useLearn();
  return useMemo(() => JSON.stringify(recheckGroups(store.progress)), [store.progress]);
}

export function useRechecks(): Map<LessonId, RecheckNudge> {
  const store = useLearn();
  const groupsKey = useSettledKey();
  const [nudges, setNudges] = useState<Map<LessonId, RecheckNudge>>(new Map());
  useEffect(() => {
    if (store.mode !== "account") return;
    const groups = JSON.parse(groupsKey) as ReturnType<typeof recheckGroups>;
    if (groups.length === 0) return;
    let live = true;
    Promise.all(
      groups.map((group) => {
        const base = group.potType ? { potType: group.potType } : {};
        return Promise.all([fetchLeaks({ ...base, to: group.day }), fetchLeaks({ ...base, from: group.day })]).then(([before, after]) =>
          group.lessons.map((lesson) => recheckNudge(lesson, masteryFrom(LESSONS[lesson], before?.rows ?? [], after?.rows ?? [], group.day))),
        );
      }),
    )
      .then((lists) => {
        if (!live) return;
        const out = new Map<LessonId, RecheckNudge>();
        for (const nudge of lists.flat()) if (nudge) out.set(nudge.lesson, nudge);
        setNudges(out);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [store.mode, groupsKey]);
  return nudges;
}
