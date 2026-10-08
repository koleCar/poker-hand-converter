/**
 * The placement test (`/learn/placement`, Learn L5): a short mixed test per
 * track, a few items from each module dealt from the lessons' own exercises
 * and graded by the same graders (`lib/learn/mixed.ts`). A module whose items
 * pass marks its written lessons "tested out" in the learner's progress — a
 * status of its own, never "passed" — through the same writer every exercise
 * uses (no migration). Missed items join the review cards, as in a lesson.
 */

"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useDict } from "../../../lib/i18n/client";
import { TRACK_IDS, TRACKS, lessonsIn, moduleCode, type TrackId } from "../../../lib/learn/course";
import {
  PLACEMENT_MIN_GRADED,
  PLACEMENT_PASS,
  PLACEMENT_PER_MODULE,
  placementItems,
  placementOutcome,
  testOutResults,
  type MixedItem,
  type ModuleOutcome,
} from "../../../lib/learn/mixed";
import { lessonDone } from "../../../lib/learn/progress";
import { paths } from "../../../lib/routes";
import { FLOP_DRILLS_AVAILABLE } from "../../../lib/trainer";
import { nextSeed } from "../../../lib/training/rng";
import { useFormats } from "../controls";
import { useLearn } from "./LearnStore";
import { MixedSession } from "./MixedSession";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

type Run = { track: TrackId; items: MixedItem[] };
type Result = { outcomes: ModuleOutcome[]; marked: Map<string, number>; cards: number; error: string | null };

export function PlacementTest() {
  const en = useDict();
  const t = en.course.placement;
  const f = useFormats();
  const store = useLearn();
  const [run, setRun] = useState<Run | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const start = (track: TrackId) => {
    setResult(null);
    setRun({ track, items: placementItems(track, nextSeed(), FLOP_DRILLS_AVAILABLE) });
  };

  const finish = useCallback(
    async (answers: ReadonlyArray<ItemAnswer | null>) => {
      if (!run) return;
      const outcomes = placementOutcome(
        run.track,
        run.items,
        answers.map((a) => (a ? a.correct : null)),
      );
      const results = testOutResults(store.progress, outcomes);
      // How many lessons each module marks now (a module whose lessons were all done already marks none).
      const perModule = new Map<string, number>();
      for (const outcome of outcomes) {
        perModule.set(outcome.module, lessonsIn(outcome.module).filter((meta) => results.some((r) => r.lesson === meta.id)).length);
      }
      const missed = run.items.filter((_, i) => answers[i] && !answers[i]?.correct).map((item) => item.card);
      try {
        await store.recordMany(results);
        const cards = await store.addCards(missed);
        setResult({ outcomes, marked: perModule, cards, error: null });
      } catch (error) {
        setResult({ outcomes, marked: perModule, cards: 0, error: error instanceof Error ? error.message : String(error) });
      }
    },
    [run, store],
  );

  const sessionItems = useMemo(
    () => (run ? run.items.map((item, i) => ({ key: `${item.card.key}:${i}`, item: item.card.item, lesson: item.lesson })) : []),
    [run],
  );

  if (!run) {
    return (
      <div className={styles.panel}>
        <h2 className={styles.panelHeading}>{t.pick}</h2>
        <p className={styles.muted}>{t.rules(PLACEMENT_PER_MODULE, f.pct(PLACEMENT_PASS), PLACEMENT_MIN_GRADED)}</p>
        {store.mode === "local" ? <p className={styles.muted}>{t.signedOut}</p> : null}
        <ul className={styles.outcomes}>
          {TRACK_IDS.map((track) => (
            <li key={track} className={styles.panelRow}>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => start(track)} disabled={store.mode === "loading"}>
                {t.start(en.course.tracks[track])}
              </button>
              <span className={styles.muted}>{t.track(TRACKS[track].length, TRACKS[track].length * PLACEMENT_PER_MODULE)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <MixedSession
      key={run.items.map((item) => item.card.key).join("|")}
      items={sessionItems}
      signedIn={store.mode === "account"}
      onFinish={(answers) => void finish(answers)}
      done={
        <div className={styles.panel} aria-live="polite">
          <h2 className={styles.panelHeading}>{t.resultTitle}</h2>
          {result ? (
            <>
              <ul className={styles.outcomes}>
                {result.outcomes.map((outcome) => {
                  const first = lessonsIn(outcome.module).find((meta) => meta.written && !lessonDone(store.progress[meta.id]));
                  const marked = result.marked.get(outcome.module) ?? 0;
                  return (
                    <li key={outcome.module} data-passed={outcome.passed || undefined}>
                      {t.module(moduleCode(outcome.module), en.course.modules[outcome.module], outcome.correct, outcome.graded)} —{" "}
                      {outcome.passed ? (
                        marked > 0 ? (
                          t.testedOut(marked)
                        ) : (
                          t.already
                        )
                      ) : outcome.graded < PLACEMENT_MIN_GRADED ? (
                        t.tooFew
                      ) : (
                        <>
                          {t.notYet}{" "}
                          {first ? <Link href={paths.lesson(first.id)}>{en.course.titles[first.id]}</Link> : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className={styles.muted}>
                {result.error ? en.course.exercise.saveFailed(result.error) : store.mode === "account" ? t.recorded : t.recordedLocal}
                {result.cards > 0 ? ` ${en.course.exercise.cardsAdded(result.cards)}` : ""}
              </p>
            </>
          ) : (
            <p className={styles.muted} role="status">
              {en.course.exercise.grading}
            </p>
          )}
          <div className={styles.panelRow}>
            <button type="button" className="btn btn--sm" onClick={() => setRun(null)}>
              {t.again}
            </button>
            <Link href={paths.learn()} className="btn btn--sm btn--ghost">
              {en.course.lesson.back}
            </Link>
          </div>
        </div>
      }
    />
  );
}
