/**
 * A run through a mixed set of items from several lessons (Learn L5): the
 * placement test, a module capstone and the daily dose all play their items
 * here, one after another, each through the same view a lesson uses
 * (`CardItemView`) and graded by the same graders.
 *
 * An item that cannot be dealt or rebuilt can be skipped; it is reported as
 * not graded (null), never as wrong. When the last item is answered the
 * session calls `onFinish` once with every verdict, and shows `done`.
 */

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDict } from "../../../lib/i18n/client";
import type { LessonId } from "../../../lib/learn/course";
import type { CardItem } from "../../../lib/learn/progress";
import { CardItemView } from "./ExerciseBlock";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

export interface SessionItem {
  key: string;
  item: CardItem;
  lesson: LessonId;
  /** A short tag above the item ("New", "Review"); none by default. */
  tag?: string;
}

export function MixedSession({
  items,
  signedIn,
  onItemAnswer,
  onFinish,
  done,
}: {
  items: readonly SessionItem[];
  signedIn: boolean;
  /** Each verdict as it comes (a review card is rescheduled here). */
  onItemAnswer?: (index: number, answer: ItemAnswer | null) => void;
  onFinish: (answers: ReadonlyArray<ItemAnswer | null>) => void;
  /** What to show after the last item. */
  done: ReactNode;
}) {
  const en = useDict();
  const t = en.course;
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Array<ItemAnswer | null | undefined>>([]);
  const finished = useRef(false);

  const current = items[at] ?? null;
  useEffect(() => {
    if (current || finished.current || items.length === 0) return;
    finished.current = true;
    onFinish(items.map((_, i) => answers[i] ?? null));
  }, [current, answers, items, onFinish]);

  if (!current) return <>{done}</>;

  const answered = answers[at] !== undefined;
  const record = (answer: ItemAnswer | null) => {
    if (answers[at] !== undefined) return;
    setAnswers((prev) => {
      const next = [...prev];
      next[at] = answer;
      return next;
    });
    onItemAnswer?.(at, answer);
  };
  const right = answers.filter((a) => a?.correct).length;
  const graded = answers.filter((a) => a !== undefined && a !== null).length;

  return (
    <div className={styles.session}>
      <p className={styles.muted}>
        {t.exercise.progress(at + 1, items.length)} · {t.exercise.score(right, graded)} · {t.review.fromLesson(t.titles[current.lesson] ?? current.lesson)}
        {current.tag ? <span className={styles.tag}>{current.tag}</span> : null}
      </p>
      <CardItemView key={current.key} item={current.item} signedIn={signedIn} onAnswer={record} />
      <div className={styles.nextRow}>
        {answered ? (
          <button type="button" className="btn btn--primary" onClick={() => setAt((value) => value + 1)}>
            {t.exercise.next}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              record(null);
              setAt((value) => value + 1);
            }}
          >
            {t.mixed.skip}
          </button>
        )}
      </div>
    </div>
  );
}
