/**
 * Mastery from real-hand improvement (Learn L3, `lib/learn/mastery.ts`): once
 * a signed-in learner has passed a lesson, their own graded decisions in its
 * spots before and after the day they passed it, side by side, and whether
 * the change is bigger than the sample's noise — or "not enough hands yet".
 *
 * Reads the leak finder's report twice (`analysis_leaks`, invoker, under
 * RLS: only the learner's own rows), nothing stored. A signed-out reader, or
 * one who has not passed the lesson, sees nothing here.
 */

"use client";

import { useEffect, useState } from "react";
import { fetchLeaks } from "../../../lib/db/analysisLeaks";
import { useDict } from "../../../lib/i18n/client";
import { LESSONS, type LessonId } from "../../../lib/learn/course";
import { lessonPotType, lessonSpots, MASTERY_MIN_DECISIONS, masteryFrom, passDay, type Mastery, type MasterySide } from "../../../lib/learn/mastery";
import { useFormats } from "../controls";
import { useLearn } from "./LearnStore";
import styles from "./course.module.css";

type State = { status: "ready"; mastery: Mastery } | { status: "error"; message: string };

export function LessonMastery({ lesson }: { lesson: LessonId }) {
  const t = useDict().course.mastery;
  const store = useLearn();
  const meta = LESSONS[lesson];
  const record = store.progress[lesson];
  const passedAt = record?.status === "passed" ? record.passedAt : null;
  const day = passedAt ? passDay(passedAt) : null;
  const hasSpots = lessonSpots(meta).length > 0;
  const [state, setState] = useState<State | null>(null);
  const account = store.mode === "account";

  useEffect(() => {
    if (!account || !day || !hasSpots) return;
    let live = true;
    const potType = lessonPotType(meta);
    const base = potType ? { potType } : {};
    Promise.all([fetchLeaks({ ...base, to: day }), fetchLeaks({ ...base, from: day })])
      .then(([before, after]) => {
        if (live) setState({ status: "ready", mastery: masteryFrom(meta, before?.rows ?? [], after?.rows ?? [], day) });
      })
      .catch((error: unknown) => {
        if (live) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [account, day, hasSpots, meta]);

  if (!account || !day) return null;
  if (!hasSpots) {
    return (
      <div className={styles.masteryBox}>
        <strong>{t.title}</strong>
        <p className={styles.muted}>{t.noSpots}</p>
      </div>
    );
  }
  return (
    <section className={styles.masteryBox} aria-live="polite">
      <strong>{t.title}</strong>
      {!state ? (
        <p className={styles.muted} role="status">
          {t.loading}
        </p>
      ) : state.status === "error" ? (
        <p className="notice notice--warn">{t.failed(state.message)}</p>
      ) : (
        <MasteryBody mastery={state.mastery} />
      )}
    </section>
  );
}

function MasteryBody({ mastery }: { mastery: Mastery }) {
  const t = useDict().course.mastery;
  const f = useFormats();
  const side = (label: string, s: MasterySide) => (
    <div>
      <span className={styles.muted}>{label}</span>
      {s.decisions > 0 ? (
        <>
          <span>{t.decisions(s.decisions)}</span>
          <span>{t.perDecision(f.bb(s.perDecisionBb ?? 0), f.pct(s.perDecisionPot ?? 0))}</span>
          <span>{t.mistakes(f.pct(s.mistakeRate ?? 0))}</span>
        </>
      ) : (
        <span>{t.none}</span>
      )}
    </div>
  );
  return (
    <>
      <p className={styles.muted}>{t.since(mastery.since)}</p>
      <div className={styles.masteryGrid}>
        {side(t.before, mastery.before)}
        {side(t.after, mastery.after)}
      </div>
      <p>{mastery.enough ? t.trend[mastery.trend] : t.tooFew(MASTERY_MIN_DECISIONS)}</p>
      <p className={styles.muted}>{t.method}</p>
    </>
  );
}
