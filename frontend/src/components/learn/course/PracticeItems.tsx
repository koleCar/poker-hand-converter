/**
 * One generated practice item, answered then revealed (Learn L1):
 *
 * - `CalcItemView`: a number to work out (`lib/learn/practice.ts`). The reader
 *   answers first; then the right number, the working, and the concept
 *   library's calculator opened on the item's numbers.
 * - `ClassifyItemView`: a board or a hand to sort into a bucket, graded by the
 *   analysis' own board and hand words or by range equity; then why, and the
 *   explorer on that board.
 *
 * Both call `onAnswer` once, with whether the answer was right; the exercise
 * around them counts, records and moves on.
 */

"use client";

import { useId, useState, type FormEvent } from "react";
import { GRADES, type Grade } from "../../../lib/analysis/types";
import { useDict } from "../../../lib/i18n/client";
import { gradeCalc, gradeClassify, type CalcItem, type ClassifyItem } from "../../../lib/learn/practice";
import { CardRow } from "../../replayer/PlayingCard";
import { useOptionLabel } from "../../analysis/train/AnswerResult";
import { ConceptWidget } from "../ConceptWidget";
import { useFormats } from "../controls";
import styles from "./course.module.css";

export interface ItemAnswer {
  correct: boolean;
  /** For the review schedule: a trainer spot's own grade; a sum or a sort is right (Perfect) or wrong (Mistake). */
  grade: Grade;
}

/* ------------------------------------------------------------------ calc - */

/** A number typed by the reader: a comma or a point, a trailing % or bb ignored. */
export function parseAnswer(text: string): number | null {
  const cleaned = text.trim().replace(/\s+/g, "").replace(/%|bb$/i, "").replace(",", ".");
  if (cleaned === "" || !/^[-−]?\d*\.?\d+$/.test(cleaned)) return null;
  return Number(cleaned.replace("−", "-"));
}

function useCalcWords(item: CalcItem) {
  const en = useDict();
  const t = en.course.calc;
  const f = useFormats();
  const p = item.params as Record<string, number & string & readonly string[]>;
  const bb = (value: number) => f.bb(value);
  const answerText = (value: number) => {
    switch (item.unit) {
      case "pct":
        return f.pct(value);
      case "bb":
        return item.kind === "per100" ? f.num(value, 2) : f.signedBb(value);
      case "ratio":
        return f.num(value, 2);
      case "count":
        return String(Math.round(value));
      default:
        return en.analysis.grades[GRADES[value]] ?? String(value);
    }
  };
  let question = "";
  let working = "";
  const w = item.working;
  switch (item.kind) {
    case "pot-odds":
      question = t.questions["pot-odds"](bb(p.pot), bb(p.bet));
      working = t.working["pot-odds"](bb(w.potAfterCall), bb(w.call), f.pct(item.answer));
      break;
    case "outs-equity":
      question = t.questions["outs-equity"];
      working = t.working["outs-equity"](w.outs, f.pct(w.ruleOf4), f.pct(item.answer));
      break;
    case "ev":
      question = t.questions.ev(bb(p.pot), bb(p.bet), f.pct(p.folds), f.pct(p.equity));
      working = t.working.ev(f.signedBb(w.foldPart), f.signedBb(w.callPart), f.signedBb(item.answer));
      break;
    case "combos":
      question = t.questions.combos(String(p.hand), t.combosShape[item.ask] ?? item.ask);
      working = t.working.combos(w.total, w.removed, item.answer);
      break;
    case "alpha-mdf":
      question = item.ask === "alpha" ? t.questions["alpha-mdf-alpha"](f.pct(p.size)) : t.questions["alpha-mdf-mdf"](f.pct(p.size));
      working = t.working.alpha(f.pct(w.alpha), f.pct(w.mdf));
      break;
    case "spr":
      question = t.questions.spr(bb(p.pot), bb(p.stack));
      working = t.working.spr(f.num(item.answer, 2));
      break;
    case "grade":
      question = t.questions.grade(bb(p.pot));
      working = t.working.grade(bb(w.evLoss), f.pct(w.evLossPot));
      break;
    case "steal":
      question = t.questions.steal(bb(p.open), bb(p.blinds));
      working = t.working.steal(f.pct(item.answer));
      break;
    case "blind-price":
      question = t.questions["blind-price"](bb(p.open));
      working = t.working["blind-price"](bb(w.pot), bb(w.call), f.pct(item.answer));
      break;
    case "per100":
      question = t.questions.per100(bb(p.lost), f.num(p.hands, 0));
      working = t.working.per100(f.num(item.answer, 2));
      break;
    case "allin-ev":
      question = t.questions["allin-ev"](bb(p.stack), bb(p.dead), f.pct(p.equity));
      working = t.working["allin-ev"](bb(w.win), bb(w.lose), f.pct(w.required), f.signedBb(item.answer));
      break;
    case "sample-size":
      if (item.ask === "margin") {
        question = t.questions["sample-margin"](f.pct(p.p), f.num(p.n, 0));
        working = t.working["sample-margin"](f.num(w.variance, 4), f.pct(item.answer));
      } else {
        question = t.questions["sample-needed"](f.pct(p.p), f.pct(p.margin));
        working = t.working["sample-needed"](f.num(w.variance, 4), f.num(Math.round(item.answer), 0));
      }
      break;
    case "multiway":
      question =
        item.ask === "all-fold"
          ? t.questions["multiway-all-fold"](p.opponents, f.pct(p.foldEach))
          : t.questions["multiway-mdf-split"](p.opponents, f.pct(p.bet / p.pot));
      working = t.working.multiway(f.pct(w.alpha), f.pct(item.answer));
      break;
  }
  const unit =
    item.unit === "pct" ? "%" : item.unit === "bb" ? (item.kind === "per100" ? "bb / 100" : "bb") : item.unit === "count" ? (item.kind === "sample-size" ? t.units.chances : t.units.count) : "";
  const tolerance = item.unit === "pct" ? f.pct(item.tolerance) : item.unit === "count" || item.unit === "grade" ? null : f.num(item.tolerance, 2);
  return { question, working, answerText, unit, tolerance };
}

export function CalcItemView({ item, onAnswer }: { item: CalcItem; onAnswer: (answer: ItemAnswer) => void }) {
  const en = useDict();
  const t = en.course;
  const label = useOptionLabel();
  const f = useFormats();
  const id = useId();
  const words = useCalcWords(item);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [given, setGiven] = useState<{ value: number; correct: boolean } | null>(null);

  const submit = (value: number) => {
    if (given) return;
    const verdict = gradeCalc(item, value);
    setGiven({ value, correct: verdict.correct });
    onAnswer({ correct: verdict.correct, grade: verdict.correct ? "perfect" : "mistake" });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAnswer(text);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    submit(item.unit === "pct" ? parsed / 100 : parsed);
  };

  const p = item.params as Record<string, unknown>;
  const cards: Array<[string, readonly string[]]> = [];
  if (item.kind === "outs-equity") {
    cards.push([t.calc.cards.flop, p.flop as string[]], [t.calc.cards.you, p.hero as string[]], [t.calc.cards.opponent, p.villain as string[]]);
  } else if (item.kind === "combos") {
    cards.push([t.calc.cards.board, p.board as string[]], [t.calc.cards.you, p.hero as string[]]);
  }

  return (
    <div className={styles.item}>
      {cards.length > 0 ? (
        <div className={styles.cardsLine}>
          {cards.map(([name, codes]) => (
            <span key={name} className={styles.cardsGroup}>
              <span className={styles.muted}>{name}</span>
              <CardRow cards={[...codes]} size="sm" />
            </span>
          ))}
        </div>
      ) : null}
      <p id={`${id}-q`} className={styles.question}>
        {words.question}
      </p>

      {item.kind === "grade" ? (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.optionTable}>
              <thead>
                <tr>
                  <th scope="col">{t.calc.optionsTable.option}</th>
                  <th scope="col">{t.calc.optionsTable.freq}</th>
                  <th scope="col">{t.calc.optionsTable.ev}</th>
                </tr>
              </thead>
              <tbody>
                {(p.options as Array<{ action: string; freq: number; ev: number; sizePot?: number }>).map((option, index) => (
                  <tr key={index} data-chosen={index === p.chosen || undefined}>
                    <th scope="row">
                      {label(option as never)}
                      {index === p.chosen ? <span className={styles.chosenTag}>{t.calc.optionsTable.chosen}</span> : null}
                    </th>
                    <td>{f.pct(option.freq)}</td>
                    <td>{f.signedBb(option.ev)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.choices} role="group" aria-labelledby={`${id}-q`}>
            {GRADES.map((grade, index) => (
              <button
                key={grade}
                type="button"
                className={`btn btn--sm ${styles.choice}`}
                data-state={!given ? undefined : index === item.answer ? "right" : index === given.value ? "wrong" : undefined}
                disabled={Boolean(given)}
                onClick={() => submit(index)}
              >
                {en.analysis.grades[grade]}
              </button>
            ))}
          </div>
        </>
      ) : (
        <form className={styles.answerForm} onSubmit={onSubmit}>
          <label className="field">
            <span className="field__label" id={`${id}-label`}>
              {t.calc.inputLabel(words.unit)}
            </span>
            <input
              aria-labelledby={`${id}-label ${id}-q`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              disabled={Boolean(given)}
              aria-invalid={invalid || undefined}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--primary btn--sm" disabled={Boolean(given)}>
            {t.exercise.check}
          </button>
          {words.tolerance ? <span className={styles.muted}>{t.calc.tolerance(words.tolerance)}</span> : null}
          {invalid ? <span className="notice notice--warn">{t.calc.invalid}</span> : null}
        </form>
      )}

      {given ? (
        <div className={styles.revealBox} aria-live="polite">
          <p className={given.correct ? styles.right : styles.wrong}>
            {given.correct ? t.exercise.correct : t.exercise.incorrect} · {t.exercise.answerWas(words.answerText(item.answer))}
          </p>
          <p>{words.working}</p>
          {item.widget ? (
            <div className={styles.reveal}>
              <p className={styles.muted}>{t.calc.revealWidget}</p>
              <ConceptWidget preset={item.widget} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- classify - */

export function ClassifyItemView({ item, onAnswer }: { item: ClassifyItem; onAnswer: (answer: ItemAnswer) => void }) {
  const en = useDict();
  const t = en.course.classify;
  const f = useFormats();
  const id = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const labels = t.buckets[item.kind] as Record<string, string>;
  const question = item.kind === "texture" ? (t.questions.texture[item.ask] ?? "") : (t.questions[item.kind] as string);

  const pick = (bucket: string) => {
    if (picked) return;
    setPicked(bucket);
    const correct = gradeClassify(item, bucket);
    onAnswer({ correct, grade: correct ? "perfect" : "mistake" });
  };

  const d = item.detail;
  const detail: string[] = [];
  if (item.kind === "texture" || item.kind === "dynamism") {
    detail.push(t.detail.volatility(f.pct(Number(d.volatility))));
    if (item.kind === "texture" && item.ask === "connectedness") detail.push(t.detail.straights(Number(d.straightCombos)));
  } else if (item.kind === "range-advantage") {
    detail.push(t.detail.equity(f.pct(Number(d.equity))));
  } else if (item.kind === "nut-advantage") {
    detail.push(t.detail.nuts(f.pct(Number(d.raiser)), f.pct(Number(d.caller))));
  } else if (item.kind === "turn-card") {
    detail.push(t.detail.shift(f.pct(Number(d.before)), f.pct(Number(d.after))));
  } else if (item.kind === "hand-class") {
    detail.push(t.detail.made(t.madeHand[String(d.made)] ?? String(d.made)));
  }
  const illustrative = item.kind === "range-advantage" || item.kind === "nut-advantage" || item.kind === "turn-card";

  return (
    <div className={styles.item}>
      <div className={styles.cardsLine}>
        <span className={styles.cardsGroup}>
          <span className={styles.muted}>{en.course.calc.cards.board}</span>
          <CardRow cards={[...item.board]} size="md" />
        </span>
        {item.hand ? (
          <span className={styles.cardsGroup}>
            <span className={styles.muted}>{en.course.calc.cards.you}</span>
            <CardRow cards={[...item.hand]} size="md" />
          </span>
        ) : null}
      </div>
      <p id={`${id}-q`} className={styles.question}>
        {question}
      </p>
      <div className={styles.choices} role="group" aria-labelledby={`${id}-q`}>
        {item.buckets.map((bucket) => (
          <button
            key={bucket}
            type="button"
            className={`btn btn--sm ${styles.choice}`}
            data-state={!picked ? undefined : bucket === item.answer ? "right" : bucket === picked ? "wrong" : undefined}
            disabled={Boolean(picked)}
            onClick={() => pick(bucket)}
          >
            {labels[bucket] ?? bucket}
          </button>
        ))}
      </div>
      {picked ? (
        <div className={styles.revealBox} aria-live="polite">
          <p className={picked === item.answer ? styles.right : styles.wrong}>
            {picked === item.answer ? en.course.exercise.correct : en.course.exercise.incorrect} ·{" "}
            {en.course.exercise.answerWas(labels[item.answer] ?? item.answer)}
          </p>
          {detail.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {illustrative ? <p className={styles.muted}>{t.illustrative}</p> : null}
          {item.widget ? (
            <div className={styles.reveal}>
              <ConceptWidget preset={item.widget} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
