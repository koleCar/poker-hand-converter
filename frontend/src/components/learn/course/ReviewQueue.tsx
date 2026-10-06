/**
 * The review queue (`/learn/review`, Learn L1, smart feature 3): quiz items
 * the learner missed in lessons, due again on the drills' SM-2 schedule and
 * mixed across lessons — interleaved practice for free.
 *
 * A card stores its item's spec (kind and seed); the item is regenerated here
 * exactly as the lesson dealt it, answered, and the card rescheduled: in the
 * account by `review_lesson_card` (the database's `drill_next`), in the
 * browser by the same arithmetic (`lib/training/schedule.ts`).
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchDueCards, reviewLessonCard } from "../../../lib/db/learn";
import { useDict } from "../../../lib/i18n/client";
import { reviewLocalCard, type Card } from "../../../lib/learn/progress";
import { paths } from "../../../lib/routes";
import { isDue } from "../../../lib/training/schedule";
import { CardItemView } from "./ExerciseBlock";
import { localDeck, saveLocalDeck, useLearn } from "./LearnStore";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

const QUEUE_SIZE = 30;

type Queue = { status: "loading" } | { status: "ready"; cards: Card[] } | { status: "error"; message: string };

export function ReviewQueue() {
  const en = useDict();
  const t = en.course.review;
  const store = useLearn();
  const [queue, setQueue] = useState<Queue>({ status: "loading" });
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState<{ answer: ItemAnswer | null; schedule: string | null } | null>(null);

  useEffect(() => {
    if (store.mode === "loading") return;
    let live = true;
    const load =
      store.mode === "account"
        ? fetchDueCards(QUEUE_SIZE)
        : Promise.resolve(
            localDeck()
              .filter((card) => isDue(card.state, new Date()))
              .sort((a, b) => Date.parse(a.state.dueAt) - Date.parse(b.state.dueAt))
              .slice(0, QUEUE_SIZE),
          );
    load
      .then((cards) => {
        if (live) setQueue({ status: "ready", cards });
      })
      .catch((error: unknown) => {
        if (live) setQueue({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [store.mode]);

  const card = queue.status === "ready" ? (queue.cards[at] ?? null) : null;

  const onAnswer = useCallback(
    (answer: ItemAnswer | null) => {
      if (!card) return;
      setAnswered({ answer, schedule: null });
      if (!answer) return;
      const days = (intervalDays: number, relearn: boolean) => (relearn ? t.backSoon : t.backIn(intervalDays));
      if (store.mode === "account") {
        reviewLessonCard(card.id, answer.grade)
          .then((review) => setAnswered((prev) => (prev ? { ...prev, schedule: days(review.intervalDays, review.relearn) } : prev)))
          .catch((error: unknown) =>
            setAnswered((prev) => (prev ? { ...prev, schedule: error instanceof Error ? error.message : String(error) } : prev)),
          );
      } else {
        const now = new Date();
        const reviewed = reviewLocalCard(card, answer.grade, now);
        saveLocalDeck(localDeck().map((c) => (c.key === card.key ? reviewed : c)));
        setAnswered((prev) =>
          prev ? { ...prev, schedule: days(reviewed.state.intervalDays, reviewed.state.intervalDays === 0) } : prev,
        );
      }
    },
    [card, store.mode, t],
  );

  if (queue.status === "loading") return <p className={styles.muted} role="status">{t.loading}</p>;
  if (queue.status === "error") return <p className="notice notice--error">{queue.message}</p>;
  if (queue.cards.length === 0) {
    return (
      <div className={styles.note}>
        <p>{t.empty}</p>
        <Link href={paths.learn()} className="btn btn--sm">
          {en.course.lesson.back}
        </Link>
      </div>
    );
  }
  if (!card) {
    return (
      <div className={styles.note}>
        <p>{t.done}</p>
        <Link href={paths.learn()} className="btn btn--sm">
          {en.course.lesson.back}
        </Link>
      </div>
    );
  }
  return (
    <div className={styles.session}>
      <p className={styles.muted}>
        {t.due(queue.cards.length - at)} · {t.fromLesson(en.course.titles[card.lesson] ?? card.lesson)}
      </p>
      <CardItemView key={card.id} item={card.item} signedIn={store.mode === "account"} onAnswer={onAnswer} />
      {answered ? (
        <div className={styles.nextRow}>
          {answered.schedule ? <span className={styles.muted}>{answered.schedule}</span> : null}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setAnswered(null);
              setAt((value) => value + 1);
            }}
          >
            {en.course.exercise.next}
          </button>
        </div>
      ) : null}
    </div>
  );
}
