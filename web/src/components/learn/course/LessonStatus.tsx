/**
 * A lesson's status as the learner sees it at the top of the page (not
 * started, in progress, mastered) and the banner when it is mastered. Read
 * from `useLearn()`, so it changes the moment the last exercise passes.
 */

"use client";

import { useDict } from "../../../lib/i18n/client";
import type { LessonId } from "../../../lib/learn/course";
import { lessonStatus } from "../../../lib/learn/progress";
import { useLearn } from "./LearnStore";
import styles from "./course.module.css";

export function LessonStatusChip({ lesson }: { lesson: LessonId }) {
  const t = useDict().course.map;
  const store = useLearn();
  if (store.mode === "loading") return null;
  const status = lessonStatus(store.progress[lesson]);
  return (
    <span className={styles.status} data-status={status}>
      {t.status[status]}
    </span>
  );
}

export function MasteredBanner({ lesson }: { lesson: LessonId }) {
  const t = useDict().course.lesson;
  const store = useLearn();
  if (store.progress[lesson]?.status !== "passed") return null;
  return (
    <div className={styles.mastered} role="status">
      <strong>{t.mastered}</strong>
      <span>{t.masteredBody}</span>
    </div>
  );
}

/** Where progress is kept: the account, or this browser only (with a sign-in button). */
export function StorageNote() {
  const t = useDict().course.map;
  const store = useLearn();
  if (store.mode === "loading") return null;
  if (store.mode === "account") return <p className={styles.muted}>{t.accountNote}</p>;
  return <p className={styles.muted}>{t.localNote}</p>;
}
