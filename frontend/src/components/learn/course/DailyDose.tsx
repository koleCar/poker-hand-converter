/**
 * The daily five-minute dose (Learn L5): a few review cards that are due and
 * one new item from the lesson Rail points the learner to — the first
 * recommended lesson not yet done, else the next lesson in course order
 * (`doseLesson`, `doseItems`). Played like the review queue: a review card is
 * rescheduled by its answer (the account's `review_lesson_card`, or the same
 * SM-2 in the browser); the new item, missed, becomes a card.
 *
 * "Done for today" is a per-browser convenience, kept in the browser's
 * storage and wrapped like every other storage access.
 */

"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { fetchDueCards, reviewLessonCard } from "../../../lib/db/learn";
import { useDict } from "../../../lib/i18n/client";
import type { LessonId } from "../../../lib/learn/course";
import { DOSE_REVIEWS, doseDay, doseItems, doseLesson, newItem, type DoseItem } from "../../../lib/learn/mixed";
import { reviewLocalCard } from "../../../lib/learn/progress";
import { FLOP_DRILLS_AVAILABLE } from "../../../lib/trainer";
import { isDue } from "../../../lib/training/schedule";
import { nextSeed } from "../../../lib/training/rng";
import { localDeck, readLocal, saveLocalDeck, useLearn, writeLocal } from "./LearnStore";
import type { ItemAnswer } from "./PracticeItems";
import { useRecommendations } from "./useCourseSignals";
import styles from "./course.module.css";

// The items' views (the felt, the trainer, the calculators) load when a dose starts, not with the map.
const MixedSession = dynamic(() => import("./MixedSession").then((m) => m.MixedSession), { ssr: false });

/** The browser's note of the last day a dose was finished. */
export const LOCAL_DOSE_KEY = "rail.learn.dose.v1";

type State = { status: "idle" } | { status: "loading" } | { status: "running"; items: DoseItem[] } | { status: "error"; message: string };

/** The dose with recommendations read here (the review page); the map passes its own. */
export function DailyDoseWithRecommendations() {
  const recs = useRecommendations();
  return <DailyDose recommended={[...recs.keys()]} />;
}

export function DailyDose({ recommended }: { recommended: readonly LessonId[] }) {
  const en = useDict();
  const t = en.course.dose;
  const store = useLearn();
  const [state, setState] = useState<State>({ status: "idle" });
  const [result, setResult] = useState<{ correct: number; graded: number } | null>(null);
  const [doneDay, setDoneDay] = useState<string | null>(() => readLocal(LOCAL_DOSE_KEY));
  const today = doseDay(new Date());
  const lesson = useMemo(() => doseLesson(store.progress, recommended, FLOP_DRILLS_AVAILABLE), [store.progress, recommended]);
  const reviews = Math.min(DOSE_REVIEWS, store.due ?? 0);

  const start = () => {
    setResult(null);
    setState({ status: "loading" });
    const due =
      store.mode === "account"
        ? fetchDueCards(DOSE_REVIEWS)
        : Promise.resolve(localDeck().filter((card) => isDue(card.state, new Date())));
    due
      .then((cards) => {
        const fresh = lesson ? newItem(lesson, nextSeed(), FLOP_DRILLS_AVAILABLE) : null;
        setState({ status: "running", items: doseItems(cards, fresh) });
      })
      .catch((error: unknown) => setState({ status: "error", message: error instanceof Error ? error.message : String(error) }));
  };

  const items = state.status === "running" ? state.items : null;

  const onItemAnswer = useCallback(
    (index: number, answer: ItemAnswer | null) => {
      const item = items?.[index];
      if (!item || !answer) return;
      if (item.kind === "new") {
        if (!answer.correct) store.addCards([item.item.card]).catch(() => undefined);
        return;
      }
      if (store.mode === "account") {
        reviewLessonCard(item.card.id, answer.grade).catch(() => undefined);
      } else {
        const reviewed = reviewLocalCard(item.card, answer.grade, new Date());
        saveLocalDeck(localDeck().map((c) => (c.key === item.card.key ? reviewed : c)));
      }
    },
    [items, store],
  );

  const onFinish = useCallback(
    (answers: ReadonlyArray<ItemAnswer | null>) => {
      const graded = answers.filter((a): a is ItemAnswer => a !== null);
      setResult({ correct: graded.filter((a) => a.correct).length, graded: graded.length });
      writeLocal(LOCAL_DOSE_KEY, today);
      setDoneDay(today);
    },
    [today],
  );

  const sessionItems = useMemo(
    () =>
      (items ?? []).map((item) =>
        item.kind === "review"
          ? { key: `r:${item.card.id}`, item: item.card.item, lesson: item.card.lesson, tag: en.course.mixed.review }
          : { key: `n:${item.item.card.key}`, item: item.item.card.item, lesson: item.item.lesson, tag: en.course.mixed.new },
      ),
    [items, en],
  );

  if (store.mode === "loading") return null;

  return (
    <section className={styles.panel} aria-labelledby="learn-dose">
      <h2 id="learn-dose" className={styles.panelHeading}>
        {t.heading}
      </h2>
      {state.status === "running" ? (
        sessionItems.length === 0 ? (
          <p className={styles.muted}>{t.nothing}</p>
        ) : (
          <MixedSession
            key={sessionItems.map((item) => item.key).join("|")}
            items={sessionItems}
            signedIn={store.mode === "account"}
            onItemAnswer={onItemAnswer}
            onFinish={onFinish}
            done={
              <div className={styles.result} aria-live="polite">
                <p>{result ? t.done(result.correct, result.graded) : t.doneToday}</p>
                <button type="button" className="btn btn--sm btn--ghost" onClick={start}>
                  {t.again}
                </button>
              </div>
            }
          />
        )
      ) : (
        <>
          <p className={styles.muted}>{t.intro}</p>
          {reviews === 0 && !lesson ? (
            <p>{t.nothing}</p>
          ) : (
            <p>{t.plan(reviews, lesson ? (en.course.titles[lesson] ?? lesson) : null)}</p>
          )}
          {doneDay === today ? <p className={styles.muted}>{t.doneToday}</p> : null}
          {state.status === "error" ? <p className="notice notice--error">{state.message}</p> : null}
          {reviews > 0 || lesson ? (
            <div className={styles.panelRow}>
              <button
                type="button"
                className={doneDay === today ? "btn btn--sm btn--ghost" : "btn btn--sm btn--primary"}
                onClick={start}
                disabled={state.status === "loading"}
              >
                {state.status === "loading" ? t.loading : doneDay === today ? t.again : t.start}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
