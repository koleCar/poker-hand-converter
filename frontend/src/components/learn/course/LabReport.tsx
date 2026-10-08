/**
 * The exploit lab's result (Learn L4, `lib/training/lab.ts`), shared by the
 * `node-lock` exercise (`LockItemView`) and the lab widget (`ExploitLab`):
 *
 * - `LabSpot`: the river, the line, and what is locked (the solve's share
 *   against the locked one, at each locked decision);
 * - `LabQuestionView`: one hand to play against the lock, graded by the
 *   best response's own EVs (`gradeLab`), then revealed;
 * - `LabNumbers`: what the read is worth and what it risks;
 * - `LabViews`: the hero decisions the response changes most, by hand
 *   category, Rail's solve against the best response.
 */

"use client";

import { useId, useState } from "react";
import { useDict } from "../../../lib/i18n/client";
import { gradeLab, LAB_TOLERANCE, type LabItem, type LabStep } from "../../../lib/training";
import { CardRow } from "../../replayer/PlayingCard";
import { useFormats } from "../controls";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

function useStepText() {
  const t = useDict().course;
  return (steps: readonly LabStep[], villain: string) =>
    steps.length > 0 ? steps.map((step) => t.split.step(step.who === "hero" ? t.split.you : villain, step.kind, step.sizePot, step.who === "hero")).join(" ") : t.lab.first;
}

export function LabSpot({ item }: { item: LabItem }) {
  const en = useDict();
  const t = en.course.lab;
  const f = useFormats();
  const steps = useStepText();
  const value = item.lock === "fold-to-bet" ? `${item.value > 0 ? "+" : ""}${Math.round(item.value * 100)}` : f.pct(item.value);
  return (
    <div>
      <div className={styles.cardsLine}>
        <span className={styles.cardsGroup}>
          <span className={styles.muted}>{en.course.calc.cards.board}</span>
          <CardRow cards={[...item.board]} size="md" />
        </span>
      </div>
      <p>{en.analysis.train.riverSpot(item.pot, item.hero, item.villain, true)}</p>
      <p className={styles.muted}>{en.course.split.pot(f.bb(item.potBb), null)}</p>
      <p>
        <strong>{t.presets[item.preset]}.</strong> {t.lockLine[item.lock](value)}
      </p>
      <ul className={styles.list}>
        {item.locks.map((lock, k) => (
          <li key={k} className={styles.muted}>
            {t.lockAt(steps(lock.steps, item.villain), `${f.pct(lock.equilibrium)} ${t.lockWhat[item.lock]}`, f.pct(lock.locked))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LabQuestionView({ item, onAnswer }: { item: LabItem; onAnswer?: (answer: ItemAnswer) => void }) {
  const en = useDict();
  const t = en.course.lab;
  const f = useFormats();
  const id = useId();
  const steps = useStepText();
  const [picked, setPicked] = useState<number | null>(null);
  const q = item.question;
  const view = item.views[q.view];
  const label = (a: number) => t.action(view.actions[a].kind, view.actions[a].sizePot);
  const mix = (freq: readonly number[]) =>
    freq
      .map((x, a) => ({ x, a }))
      .filter(({ x }) => x >= 0.005)
      .map(({ x, a }) => `${label(a)} ${f.pct(x)}`)
      .join(" · ");
  const pick = (a: number) => {
    if (picked !== null) return;
    setPicked(a);
    const { correct } = gradeLab(item, a);
    onAnswer?.({ correct, grade: correct ? "perfect" : "mistake" });
  };
  const category = en.analysis.river.categories[q.category] ?? q.category;
  return (
    <div>
      <p>{steps(view.steps, item.villain)}</p>
      <p className={styles.muted}>{en.course.split.pot(f.bb(view.potBb), view.toCallBb > 0 ? f.bb(view.toCallBb) : null)}</p>
      <div className={styles.cardsLine}>
        <span className={styles.cardsGroup}>
          <span className={styles.muted}>{en.course.spot.ownCards}</span>
          <CardRow cards={[...q.cards]} size="md" />
        </span>
      </div>
      <p id={`${id}-q`} className={styles.question}>
        {t.question(category)}
      </p>
      <div className={styles.choices} role="group" aria-labelledby={`${id}-q`}>
        {view.actions.map((_, a) => (
          <button
            key={a}
            type="button"
            className={`btn btn--sm ${styles.choice}`}
            data-state={picked === null ? undefined : q.right.includes(a) ? "right" : a === picked ? "wrong" : undefined}
            disabled={picked !== null}
            onClick={() => pick(a)}
          >
            {label(a)}
          </button>
        ))}
      </div>
      {picked !== null ? (
        <div className={styles.revealBox} aria-live="polite">
          <p className={q.right.includes(picked) ? styles.right : styles.wrong}>
            {q.right.includes(picked) ? en.course.exercise.correct : en.course.exercise.incorrect} ·{" "}
            {en.course.exercise.answerWas(q.right.map(label).join(" / "))}
          </p>
          <p>{t.railAnswer(mix(q.eq), mix(q.best))}</p>
          <p className={styles.muted}>
            {t.evLine} {view.actions.map((_, a) => `${label(a)} ${f.signedBb(q.ev[a])}`).join(" · ")}
          </p>
          <p className={styles.muted}>{t.tolerance(f.pct(LAB_TOLERANCE))}</p>
        </div>
      ) : null}
    </div>
  );
}

export function LabNumbers({ item }: { item: LabItem }) {
  const t = useDict().course.lab;
  const f = useFormats();
  // The gain is signed; the costs are amounts given up.
  const money = (x: number, signed: boolean) => t.ofPot(signed ? f.signedBb(x) : f.bb(x), f.pct(item.potBb > 0 ? x / item.potBb : 0));
  const rows: Array<[string, string]> = [
    [t.gain, money(item.numbers.gain, true)],
    [t.riskEq, money(item.numbers.riskVsEquilibrium, false)],
    [t.riskCounter, money(item.numbers.riskVsCounter, false)],
    [t.baselineRisk, money(item.numbers.baselineRisk, false)],
  ];
  return (
    <div className={styles.tableWrap}>
      <table className={styles.optionTable}>
        <caption className={styles.muted}>{t.numbers}</caption>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LabViews({ item }: { item: LabItem }) {
  const en = useDict();
  const t = en.course.lab;
  const f = useFormats();
  const steps = useStepText();
  return (
    <>
      {item.views.map((view, v) => {
        const label = (a: number) => t.action(view.actions[a].kind, view.actions[a].sizePot);
        const mix = (freq: readonly number[]) =>
          freq
            .map((x, a) => ({ x, a }))
            .filter(({ x }) => x >= 0.005)
            .map(({ x, a }) => `${label(a)} ${f.pct(x)}`)
            .join(" · ") || "—";
        return (
          <div key={v} className={styles.tableWrap}>
            <table className={styles.optionTable}>
              <caption className={styles.muted}>{t.viewTitle(steps(view.steps, item.villain))}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.category}</th>
                  <th scope="col">{t.baseline}</th>
                  <th scope="col">{t.response}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t.overall}</th>
                  <td>{mix(view.overall.eq)}</td>
                  <td>{mix(view.overall.best)}</td>
                </tr>
                {view.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{en.analysis.river.categories[row.key] ?? row.key}</th>
                    <td>{mix(row.eq)}</td>
                    <td>{mix(row.best)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <p className={styles.muted}>{t.note(f.num(item.iterations, 0), f.num(item.exploitabilityPct, 2))}</p>
    </>
  );
}
