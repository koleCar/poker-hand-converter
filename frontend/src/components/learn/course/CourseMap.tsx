/**
 * The course map (`/learn`, Learn L1): tracks → modules → lessons, each with
 * the learner's status (not started, in progress, mastered), "coming soon"
 * for lessons not written yet, and a "recommended" badge where the learner's
 * own leaks point (smart feature 1).
 *
 * The structure and the words come from the server as props (titles from the
 * dictionary, summaries from the outline); the status and the badges are the
 * learner's and are read here. Recommendations need a signed-in learner with
 * analysed hands: the leak finder's rows at the current analysis version,
 * gathered into focus areas (A8b) and matched to lessons (`recommend.ts`),
 * plus heuristic flags that keep coming up.
 */

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import { TRACK_IDS, TRACKS, lessonsIn, moduleCode, writtenLessons, type LessonId } from "../../../lib/learn/course";
import { capstoneLesson } from "../../../lib/learn/mixed";
import { lessonStatus, type LessonStatus } from "../../../lib/learn/progress";
import type { Recommendation } from "../../../lib/learn/recommend";
import { paths } from "../../../lib/routes";
import { useFormats } from "../controls";
import { DailyDose } from "./DailyDose";
import { useLearn } from "./LearnStore";
import { useRechecks, useRecommendations } from "./useCourseSignals";
import styles from "./course.module.css";

export function CourseMap({ summaries }: { summaries: Readonly<Record<string, string>> }) {
  const en = useDict();
  const t = en.course;
  const f = useFormats();
  const store = useLearn();
  const auth = useAuth();
  const recs = useRecommendations();
  const rechecks = useRechecks();
  const recommended = useMemo(() => [...recs.keys()] as LessonId[], [recs]);
  const [merged, setMerged] = useState<string | null>(null);

  const written = writtenLessons();
  const statuses = written.map((meta) => lessonStatus(store.progress[meta.id]));
  const mastered = statuses.filter((status) => status === "mastered").length;
  const tested = statuses.filter((status) => status === "tested-out").length;

  const badge = (rec: Recommendation | undefined) => {
    if (!rec) return null;
    const text =
      rec.reason === "leak" && rec.per100 !== undefined
        ? t.map.recommendedLeak(f.num(rec.per100, 2))
        : rec.reason === "flag" && rec.flag
          ? t.map.recommendedFlag(rec.count ?? 0, en.analysis.flags[rec.flag] ?? rec.flag)
          : t.map.recommended;
    return <span className={styles.recommended}>{text}</span>;
  };

  return (
    <div className={styles.map}>
      <div className={styles.mapBar}>
        <p>{store.mode === "loading" ? " " : tested > 0 ? t.map.progressTested(mastered, tested, written.length) : t.map.progress(mastered, written.length)}</p>
        <p>
          {store.due !== null && store.due > 0 ? (
            <Link href={paths.learnReview()} className="btn btn--sm btn--primary">
              {t.map.reviewLink} · {t.map.review(store.due)}
            </Link>
          ) : (
            <Link href={paths.learnReview()} className="btn btn--sm btn--ghost">
              {t.map.reviewLink}
            </Link>
          )}
        </p>
      </div>

      {store.mode === "local" ? (
        <div className={styles.note}>
          <p>{t.map.localNote}</p>
          {auth.configured ? (
            <button type="button" className="btn btn--sm" onClick={() => auth.requestSignIn()}>
              {t.map.signIn}
            </button>
          ) : null}
        </div>
      ) : null}
      {store.mode === "account" && store.localLessons > 0 ? (
        <div className={styles.note} role="status">
          <p>{t.map.merge.body(store.localLessons)}</p>
          <div className={styles.noteActions}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() =>
                store
                  .mergeLocal()
                  .then(() => setMerged(t.map.merge.done))
                  .catch((error: unknown) => setMerged(error instanceof Error ? error.message : String(error)))
              }
            >
              {t.map.merge.add}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={store.discardLocal}>
              {t.map.merge.discard}
            </button>
          </div>
        </div>
      ) : null}
      {merged ? <p className={styles.muted}>{merged}</p> : null}
      <DailyDose recommended={recommended} />
      <p className={styles.panelRow}>
        <Link href={paths.learnPlacement()} className="btn btn--sm">
          {t.map.placement}
        </Link>
        <span className={styles.muted}>{t.map.placementHint}</span>
      </p>
      {recs.size > 0 ? <p className={styles.muted}>{t.map.recommendedNote}</p> : null}
      {rechecks.size > 0 ? <p className={styles.muted}>{t.map.recheckNote}</p> : null}

      {TRACK_IDS.map((track) => (
        <section key={track} className={styles.track} aria-labelledby={`track-${track}`}>
          <h2 id={`track-${track}`} className={styles.trackTitle}>
            {t.tracks[track]}
          </h2>
          {TRACKS[track].map((module) => {
            const lessons = lessonsIn(module);
            const ready = lessons.filter((meta) => meta.written).length;
            const closing = capstoneLesson(module);
            return (
              <section key={module} className={styles.module} aria-labelledby={`module-${module}`}>
                <h3 id={`module-${module}`} className={styles.moduleTitle}>
                  <span className={styles.moduleCode}>{t.moduleCode(moduleCode(module))}</span>
                  <span>{t.modules[module]}</span>
                  {ready < lessons.length ? <span className={styles.muted}>{t.map.lessonCount(ready, lessons.length)}</span> : null}
                </h3>
                {closing ? (
                  <p className={styles.moduleReview}>
                    <Link href={`${paths.lesson(closing)}#capstone-${module}`}>{t.map.capstone(moduleCode(module))}</Link>
                  </p>
                ) : null}
                <ol className={styles.lessons}>
                  {lessons.map((meta) => {
                    const status: LessonStatus = lessonStatus(store.progress[meta.id]);
                    return (
                      <li key={meta.id}>
                        <Link href={paths.lesson(meta.id)} className={styles.lessonCard} data-written={meta.written || undefined}>
                          <span className={styles.lessonHead}>
                            <span className={styles.lessonCode}>{meta.code}</span>
                            <span className={styles.lessonTitle}>{t.titles[meta.id]}</span>
                          </span>
                          <span className={styles.lessonSummary}>{summaries[meta.id]}</span>
                          <span className={styles.lessonTags}>
                            {meta.written ? (
                              store.mode === "loading" ? null : (
                                <span className={styles.status} data-status={status}>
                                  {t.map.status[status]}
                                </span>
                              )
                            ) : (
                              <span className={styles.tag}>{t.map.comingSoon}</span>
                            )}
                            {badge(recs.get(meta.id))}
                            {rechecks.has(meta.id) ? (
                              <span className={styles.recheck}>
                                {t.map.recheck(rechecks.get(meta.id)?.before ?? 0, rechecks.get(meta.id)?.after ?? 0)}
                              </span>
                            ) : null}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </section>
      ))}
    </div>
  );
}
