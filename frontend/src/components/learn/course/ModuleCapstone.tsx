/**
 * A module capstone (Learn L5): at the end of a module, on its last written
 * lesson, a mixed review drawn from every lesson of the module — the spots,
 * sums and sorts of different lessons interleaved, so the learner has to
 * recognise which idea an item asks for. Graded by the same graders as the
 * lessons; missed items become review cards; the score is shown, not kept.
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import { useDict } from "../../../lib/i18n/client";
import { moduleCode, type ModuleId } from "../../../lib/learn/course";
import { CAPSTONE_COUNT, capstoneItems, type MixedItem } from "../../../lib/learn/mixed";
import { FLOP_DRILLS_AVAILABLE } from "../../../lib/trainer";
import { nextSeed } from "../../../lib/training/rng";
import { useLearn } from "./LearnStore";
import { MixedSession } from "./MixedSession";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

export function ModuleCapstone({ module }: { module: ModuleId }) {
  const en = useDict();
  const t = en.course.capstone;
  const store = useLearn();
  const [items, setItems] = useState<MixedItem[] | null>(null);
  const [result, setResult] = useState<{ correct: number; graded: number; cards: number; error: string | null } | null>(null);
  const code = moduleCode(module);

  const start = () => {
    setResult(null);
    setItems(capstoneItems(module, nextSeed(), FLOP_DRILLS_AVAILABLE));
  };

  const finish = useCallback(
    async (answers: ReadonlyArray<ItemAnswer | null>) => {
      if (!items) return;
      const graded = answers.filter((a): a is ItemAnswer => a !== null);
      const correct = graded.filter((a) => a.correct).length;
      const missed = items.filter((_, i) => answers[i] && !answers[i]?.correct).map((item) => item.card);
      try {
        const cards = await store.addCards(missed);
        setResult({ correct, graded: graded.length, cards, error: null });
      } catch (error) {
        setResult({ correct, graded: graded.length, cards: 0, error: error instanceof Error ? error.message : String(error) });
      }
    },
    [items, store],
  );

  const sessionItems = useMemo(
    () => (items ?? []).map((item, i) => ({ key: `${item.card.key}:${i}`, item: item.card.item, lesson: item.lesson })),
    [items],
  );

  return (
    <section className={styles.panel} id={`capstone-${module}`} aria-labelledby={`capstone-${module}-title`}>
      <h2 id={`capstone-${module}-title`} className={styles.panelHeading}>
        {t.heading(code)} · {en.course.modules[module]}
      </h2>
      <p className={styles.muted}>{t.intro(CAPSTONE_COUNT)}</p>
      {!items ? (
        <div className={styles.panelRow}>
          <button type="button" className="btn btn--primary" onClick={start}>
            {t.start}
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className={styles.muted}>{t.empty}</p>
      ) : (
        <MixedSession
          key={sessionItems.map((item) => item.key).join("|")}
          items={sessionItems}
          signedIn={store.mode === "account"}
          onFinish={(answers) => void finish(answers)}
          done={
            <div className={styles.result} aria-live="polite">
              {result ? (
                <>
                  <p>{t.result(result.correct, result.graded)}</p>
                  {result.error || result.cards > 0 ? (
                    <p className={styles.muted}>{result.error ? en.course.exercise.saveFailed(result.error) : en.course.exercise.cardsAdded(result.cards)}</p>
                  ) : null}
                </>
              ) : null}
              <button type="button" className="btn btn--sm" onClick={start}>
                {t.again}
              </button>
            </div>
          }
        />
      )}
    </section>
  );
}
