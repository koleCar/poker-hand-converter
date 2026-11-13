/**
 * What the Trainer shows after an answer, in the order a player reads it:
 *
 * 1. the verdict - the grade, the move, what it cost and the better move;
 * 2. what the reference does with *this* hand - every option's frequency and
 *    EV, the answer marked (GTO Wizard's strategy bars, for one hand);
 * 3. the hand's facts at the decision - equity against the range, the price
 *    (pot odds, how much must defend), the SPR, the made hand, the draws and
 *    blockers - the numbers the reason is made of;
 * 4. *why*: the analysis' own sentences for this decision (`explain`), built
 *    only from facts the engine computed, so they cannot invent a reason;
 * 5. the host's deeper study (the web's whole chart or range, Learn links).
 */

"use client";

import type { DecisionAnalysis, OptionAnalysis } from "../../lib/analysis/types";
import type { TrainerSpot } from "../../lib/training";
import { useTrainerHost } from "./host";
import { principleOf } from "./principles";
import type { TrainerSettings } from "./settings";
import styles from "./trainer.module.css";

const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };

function toneOf(option: OptionAnalysis): string {
  if (option.allIn) return "allin";
  return option.action;
}

export function useOptionText() {
  const { t } = useTrainerHost();
  return (option: OptionAnalysis) => t.words.option(option.action, option.sizeBb, option.allIn, option.sizePot);
}

export function Verdict({ decision }: { decision: DecisionAnalysis }) {
  const { t } = useTrainerHost();
  const label = useOptionText();
  const chosen = decision.chosen !== null ? decision.options[decision.chosen] : null;
  const best = bestIndex(decision);
  const playable = decision.grade === "perfect" || decision.grade === "good";
  return (
    <div className={styles.verdict} data-grade={decision.grade ?? undefined} aria-live="polite">
      <span className={styles.verdictGrade}>
        <span aria-hidden="true">{decision.grade ? GLYPH[decision.grade] : ""}</span>
        {decision.grade ? (t.words.grades[decision.grade] ?? decision.grade) : ""}
      </span>
      {chosen ? <span>{t.you(label(chosen))}</span> : null}
      <span className={styles.verdictLoss}>{decision.evLoss && decision.evLoss > 0.005 ? t.evLost(decision.evLoss) : t.noLoss}</span>
      {!playable && best !== null && best !== decision.chosen ? <span>{t.best(label(decision.options[best]))}</span> : null}
    </div>
  );
}

function bestIndex(decision: DecisionAnalysis): number | null {
  let best: number | null = null;
  decision.options.forEach((option, index) => {
    if (best === null || option.ev > decision.options[best].ev + 1e-9) best = index;
  });
  return best;
}

export function Feedback({ decision, spot, settings }: { decision: DecisionAnalysis; spot: TrainerSpot; settings: TrainerSettings }) {
  const { t, locale } = useTrainerHost();
  const label = useOptionText();
  const pct = (value: number) => `${Math.round(value * 100).toLocaleString(locale)}%`;
  const ev = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const graded = decision.grade !== null && decision.options.length > 0;
  if (!graded) {
    return <p className={styles.notice}>{t.notGraded(decision.reason ? (t.words.reasons[decision.reason] ?? decision.reason) : "—")}</p>;
  }
  const f = decision.facts;
  const best = bestIndex(decision);
  const facts: Array<[string, string]> = [];
  if (f.handClass || f.made) facts.push([t.fact.made, t.words.handFacts.hand(f)]);
  if (f.equity) facts.push([t.fact.equity, pct(f.equity.value)]);
  if (f.potOdds !== null && f.toCallBb > 0) facts.push([t.fact.potOdds, pct(f.potOdds)]);
  if (f.mdf !== null && f.toCallBb > 0) facts.push([t.fact.mdf, pct(f.mdf)]);
  if (f.spr !== null && f.street !== "preflop") facts.push([t.fact.spr, f.spr.toLocaleString(locale, { maximumFractionDigits: 1 })]);
  if (f.draws.length > 0) facts.push([t.fact.draws, f.draws.map((d) => t.words.handFacts.draws[d] ?? d).join(", ")]);
  if (f.blockers.length > 0) facts.push([t.fact.blockers, f.blockers.map((b) => t.words.handFacts.blockers[b] ?? b).join(", ")]);
  const why = t.words.explain(decision);
  const principleKey = principleOf(spot, decision);
  const principle = principleKey ? t.principles[principleKey] : undefined;

  return (
    <div className={styles.feedback}>
      {settings.strategy ? (
        <section className={styles.block} aria-label={t.strategyHeading}>
          <h3 className={styles.blockHead}>{t.strategyHeading}</h3>
          <ul className={styles.options}>
            {decision.options.map((option, index) => (
              <li
                key={index}
                className={styles.option}
                data-action={toneOf(option)}
                data-chosen={decision.chosen === index || undefined}
                data-best={best === index || undefined}
              >
                <span className={styles.optionLabel}>{label(option)}</span>
                <span className={styles.optionBar} aria-hidden="true">
                  <span style={{ inlineSize: `${Math.max(0, Math.min(1, option.freq)) * 100}%` }} />
                </span>
                <span className={styles.optionFreq}>{pct(option.freq)}</span>
                <span className={styles.optionEv} title={t.evHeading}>
                  {ev(option.ev)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {settings.facts && facts.length > 0 ? (
        <section className={styles.block} aria-label={t.factsHeading}>
          <h3 className={styles.blockHead}>{t.factsHeading}</h3>
          <dl className={styles.facts}>
            {facts.map(([name, value]) => (
              <div key={name} className={styles.fact}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {why.length > 0 || principle ? (
        <section className={styles.block} aria-label={t.whyHeading}>
          <h3 className={styles.blockHead}>{t.whyHeading}</h3>
          <div className={styles.why}>
            {why.map((sentence) => (
              <p key={sentence}>{sentence}</p>
            ))}
            {principle ? (
              <p className={styles.principle}>
                <strong>{t.ruleOfThumb}</strong> {principle}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
