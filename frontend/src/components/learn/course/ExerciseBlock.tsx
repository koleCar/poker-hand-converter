/**
 * One exercise of a lesson (Learn L1): a short session of generated items,
 * then the score, whether it passed, and — for every item missed — a review
 * card for later (smart feature 3: the drills' SM-2 schedule).
 *
 * - `chart-quiz` and `solver-spot`: trainer spots (`SpotItemView`);
 * - `calc` and `classify`: generated items (`PracticeItems.tsx`);
 * - `own-hands`: the learner's own decisions (`OwnHandsExercise`);
 * - planned kinds: what they will be, and what they wait for.
 *
 * Passing is automatic: the result goes to the learner's progress
 * (`useLearn().record`), and the lesson is passed when every exercise that
 * counts is (`exerciseResult` computes that). Nothing to tick.
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import { FLOP_LIBRARY_ENABLED } from "../../../lib/analysis/flopLibrary";
import { useDict } from "../../../lib/i18n/client";
import { countsTowardsPass, isPlanned, type ExerciseDef, type GeneratedExerciseDef, type LessonMeta } from "../../../lib/learn/course";
import { generateCalc, generateClassify, needed, passes } from "../../../lib/learn/practice";
import { cardFor, exerciseResult, type NewCard } from "../../../lib/learn/progress";
import { nextSeed } from "../../../lib/training/rng";
import { useLearn } from "./LearnStore";
import { OwnHandsExercise } from "./OwnHandsExercise";
import { CalcItemView, ClassifyItemView, type ItemAnswer } from "./PracticeItems";
import { SpotItemView, type SpotItem } from "./SpotItemView";
import styles from "./course.module.css";

interface ExerciseBlockProps {
  meta: LessonMeta;
  def: ExerciseDef;
  /** 1-based, for the heading. */
  index: number;
  /** The lesson's line above this exercise (server text, passed down). */
  intro: string;
}

export function ExerciseBlock({ meta, def, index, intro }: ExerciseBlockProps) {
  const t = useDict().course;
  const store = useLearn();
  const record = store.progress[meta.id]?.exercises[def.id];
  const counts = countsTowardsPass(def, FLOP_LIBRARY_ENABLED);
  const label = t.lesson.exerciseLabel(index);

  return (
    <section className={styles.exercise} aria-labelledby={`ex-${def.id}`} data-passed={record?.passed || undefined}>
      <header className={styles.exerciseHead}>
        <h3 id={`ex-${def.id}`}>{label}</h3>
        {counts && "count" in def ? <span className={styles.muted}>{t.lesson.passRule(needed(def.count, def.pass), def.count)}</span> : null}
        {!counts ? <span className={styles.tag}>{def.kind === "own-hands" ? t.lesson.optional : t.lesson.notCounted}</span> : null}
        {record ? (
          <span className={record.passed ? styles.passedTag : styles.tag}>
            {record.passed ? t.lesson.passed : t.lesson.notYet} · {t.lesson.best(record.correct, record.total)}
          </span>
        ) : null}
      </header>
      {intro ? <p>{intro}</p> : null}
      <ExerciseBody meta={meta} def={def} />
    </section>
  );
}

function ExerciseBody({ meta, def }: { meta: LessonMeta; def: ExerciseDef }) {
  const t = useDict().course.exercise;
  if (isPlanned(def)) {
    return (
      <div className={styles.planned}>
        <p>{t.planned[def.kind]}</p>
        <p className={styles.muted}>{t.waits[def.waitsFor]}</p>
      </div>
    );
  }
  if (def.kind === "own-hands") return <OwnHandsExercise meta={meta} def={def} />;
  if (def.kind === "solver-spot" && def.street === "flop" && !FLOP_LIBRARY_ENABLED) {
    return <p className="notice notice--warn">{t.flopOff}</p>;
  }
  return <Session meta={meta} def={def} />;
}

/** One run through a generated exercise. */
function Session({ meta, def }: { meta: LessonMeta; def: GeneratedExerciseDef }) {
  const t = useDict().course.exercise;
  const store = useLearn();
  const [run, setRun] = useState<{ seeds: number[] } | null>(null);
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Array<ItemAnswer | null>>([]);
  const [saved, setSaved] = useState<{ cards: number; error: string | null } | null>(null);

  const start = () => {
    setRun({ seeds: Array.from({ length: def.count }, () => nextSeed()) });
    setAt(0);
    setAnswers([]);
    setSaved(null);
  };

  const finish = useCallback(
    async (all: Array<ItemAnswer | null>, seeds: number[]) => {
      const graded = all.filter((a): a is ItemAnswer => a !== null);
      const correct = graded.filter((a) => a.correct).length;
      const passed = passes(correct, graded.length, def.count, def.pass);
      const missed: NewCard[] = [];
      all.forEach((answer, i) => {
        if (answer && !answer.correct) missed.push(cardFor(meta, def, seeds[i]));
      });
      try {
        await store.record(exerciseResult(store.progress, meta, def.id, correct, graded.length, passed, FLOP_LIBRARY_ENABLED));
        const cards = await store.addCards(missed);
        setSaved({ cards, error: null });
      } catch (error) {
        setSaved({ cards: 0, error: error instanceof Error ? error.message : String(error) });
      }
    },
    [def, meta, store],
  );

  const onAnswer = useCallback(
    (answer: ItemAnswer | null) => {
      setAnswers((prev) => {
        const next = [...prev];
        next[at] = answer;
        return next;
      });
    },
    [at],
  );

  if (!run) {
    return (
      <button type="button" className="btn btn--primary" onClick={start}>
        {t.start}
      </button>
    );
  }

  const done = at >= run.seeds.length;
  if (done) {
    const graded = answers.filter((a): a is ItemAnswer => a !== null);
    const correct = graded.filter((a) => a.correct).length;
    const passed = passes(correct, graded.length, def.count, def.pass);
    return (
      <div className={styles.result} aria-live="polite">
        <p className={passed ? styles.right : styles.wrong}>
          {passed ? t.resultPassed(correct, graded.length) : t.resultFailed(correct, graded.length, needed(def.count, def.pass))}
        </p>
        {saved ? (
          <p className={styles.muted}>
            {saved.error ? t.saveFailed(saved.error) : store.mode === "account" ? t.saved : t.savedLocal}
            {saved.cards > 0 ? ` ${t.cardsAdded(saved.cards)}` : ""}
          </p>
        ) : null}
        <button type="button" className="btn btn--sm" onClick={start}>
          {t.restart}
        </button>
      </div>
    );
  }

  const seed = run.seeds[at];
  const answered = answers[at] !== undefined;
  const last = at === run.seeds.length - 1;
  const next = () => {
    if (last) void finish(answers, run.seeds);
    setAt((value) => value + 1);
  };

  return (
    <div className={styles.session}>
      <p className={styles.muted}>
        {t.progress(at + 1, run.seeds.length)} · {t.score(answers.filter((a) => a?.correct).length, answers.filter((a) => a !== undefined && a !== null).length)}
      </p>
      <Item key={`${seed}:${at}`} meta={meta} def={def} seed={seed} signedIn={store.mode === "account"} onAnswer={onAnswer} />
      {answered ? (
        <div className={styles.nextRow}>
          <button type="button" className="btn btn--primary" onClick={next}>
            {t.next}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Item({
  meta,
  def,
  seed,
  signedIn,
  onAnswer,
}: {
  meta: LessonMeta;
  def: GeneratedExerciseDef;
  seed: number;
  signedIn: boolean;
  onAnswer: (answer: ItemAnswer | null) => void;
}) {
  const card = useMemo(() => cardFor(meta, def, seed), [meta, def, seed]);
  return <CardItemView item={card.item} signedIn={signedIn} onAnswer={onAnswer} />;
}

/** Any stored item, regenerated from its spec: what a lesson deals and what a review card replays. */
export function CardItemView({
  item,
  signedIn,
  onAnswer,
}: {
  item: NewCard["item"];
  signedIn: boolean;
  onAnswer: (answer: ItemAnswer | null) => void;
}) {
  const generated = useMemo(() => {
    try {
      if (item.k === "calc") return { kind: "calc" as const, item: generateCalc(item.calc, item.seed) };
      if (item.k === "classify") return { kind: "classify" as const, item: generateClassify(item.classify, item.seed) };
      return null;
    } catch {
      return { kind: "error" as const };
    }
  }, [item]);
  const t = useDict().course.review;
  if (generated?.kind === "calc") return <CalcItemView item={generated.item} onAnswer={onAnswer} />;
  if (generated?.kind === "classify") return <ClassifyItemView item={generated.item} onAnswer={onAnswer} />;
  if (generated?.kind === "error") return <p className="notice notice--warn">{t.stale}</p>;
  return <SpotItemView item={item as SpotItem} signedIn={signedIn} onAnswer={onAnswer} />;
}
