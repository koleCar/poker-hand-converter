/**
 * What the trainer shows after an answer: the grade, what it cost, the
 * reference's every option for the hand (the answer marked), the whole chart
 * or the whole river range at the node, and the *why* with its Learn links.
 *
 * The same pieces the hand view's Analysis sheet uses (`OptionsTable`,
 * `ChartGrid`, `RiverStudy`, `explain`), fed the analysis' own
 * `DecisionAnalysis` for the answer — a trainer answer reads exactly like a
 * graded decision of a real hand, because it is one.
 */

"use client";

import type { ReactNode } from "react";
import { bestOption } from "../../../lib/analysis/reference";
import type { DecisionAnalysis, OptionAnalysis } from "../../../lib/analysis/types";
import type { ChartNode } from "../../../lib/charts";
import { useDict } from "../../../lib/i18n/client";
import { conceptsForDecision } from "../../../lib/learn/links";
import type { PhfHand } from "../../../lib/phf/types";
import { OptionsTable } from "../AnalysisSheet";
import { ChartGrid } from "../ChartGrid";
import { GradeIcon } from "../GradeIcon";
import { LearnLinks } from "../LearnLinks";
import { RiverStudy } from "../RiverStudy";
import styles from "../analysis.module.css";
import own from "./train.module.css";

interface AnswerResultProps {
  decision: DecisionAnalysis;
  /** The hand the decision belongs to, for the river study's re-solve. */
  hand: PhfHand;
  /** The chart node of a preflop decision, to draw the whole chart. */
  chartNode?: ChartNode | null;
  /** Lines under the verdict (a drill's schedule, the "kept" note). */
  children?: ReactNode;
}

export function useOptionLabel() {
  const s = useDict().analysis.sheet;
  return (option: OptionAnalysis) => s.option(option.action, option.sizeBb, option.allIn, option.sizePot);
}

export function AnswerResult({ decision, hand, chartNode = null, children }: AnswerResultProps) {
  const t = useDict().analysis;
  const r = t.train.result;
  const label = useOptionLabel();
  const chosen = decision.chosen !== null ? decision.options[decision.chosen] : null;
  const best = bestOption(decision);
  // The better move is named only for a move the reference does not play
  // (worse than Good), as the hand view does: a Perfect mixed answer has no "better".
  const playable = decision.grade === "perfect" || decision.grade === "good";
  const bestLabel = !playable && best !== null && best !== decision.chosen ? label(decision.options[best]) : null;
  const graded = decision.grade !== null && decision.options.length > 0;

  if (!graded) {
    return (
      <section className={`card ${own.result}`} aria-live="polite">
        <p className="notice notice--warn">{r.notGraded(decision.reason ? (t.reasons[decision.reason] ?? decision.reason) : "—")}</p>
        {children}
      </section>
    );
  }

  return (
    <section className={`card ${own.result}`} aria-labelledby="train-result">
      <div className={own.verdict} aria-live="polite">
        <h3 id="train-result" className={own.verdictHead}>
          <span className={`${styles.gradeTag} ${decision.grade ? styles[decision.grade] : ""} ${own.verdictGrade}`}>
            {decision.grade ? <GradeIcon grade={decision.grade} /> : null}
            {decision.grade ? t.grades[decision.grade] : null}
          </span>
          {chosen ? <span className={own.verdictMove}>{r.youChose(label(chosen))}</span> : null}
        </h3>
        <p className={own.verdictLine}>
          <span>{decision.evLoss && decision.evLoss > 0 ? r.evLost(decision.evLoss, decision.evLossPot ?? 0) : r.noLoss}</span>
          {bestLabel ? <span>{r.best(bestLabel)}</span> : null}
          <span className={styles.muted}>{t.sheet.source[decision.source] ?? decision.source}</span>
        </p>
        {children}
      </div>

      {decision.approximations.length > 0 ? (
        <div className={styles.approx}>
          <strong>{r.approximate}</strong>
          <ul>
            {decision.approximations.map((code) => (
              <li key={code}>{t.approximations[code] ?? code}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <h4 className={styles.subhead}>{r.optionsHeading}</h4>
      <OptionsTable decision={decision} />

      {decision.source === "chart" && chartNode ? (
        <div className={own.study}>
          <h4 className={styles.subhead}>{r.chartHeading}</h4>
          <ChartGrid key={chartNode.line} node={chartNode} highlight={decision.facts.handClass} />
        </div>
      ) : null}
      {decision.source === "solver" ? (
        <div className={own.study}>
          <h4 className={styles.subhead}>{r.rangeHeading}</h4>
          <RiverStudy key={`${hand.meta.handKey}:${decision.actionIndex}`} decision={decision} hand={hand} initialOpen />
        </div>
      ) : null}

      <h4 className={styles.subhead}>{r.whyHeading}</h4>
      <div className={styles.why}>
        {t.explain(decision).map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
      <LearnLinks concepts={conceptsForDecision(decision)} />
    </section>
  );
}
