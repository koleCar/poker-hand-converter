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
 *
 * The verdict sits in the row under the table; 2-5 are tabs that fold
 * (`InfoTabs`), with the hero's whole range beside them.
 */

"use client";

import type { ReactNode } from "react";
import type { DecisionAnalysis, OptionAnalysis } from "../../lib/analysis/types";
import type { TrainerSpot } from "../../lib/training";
import { useTrainerHost } from "./host";
import type { InfoTab } from "./InfoTabs";
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

export function Verdict({
  decision,
  note = null,
  compact = false,
}: {
  decision: DecisionAnalysis;
  /** A line of its own: a mix's accuracy, "out of time". */
  note?: string | null;
  /** One of several tables: the grade and what it cost only. */
  compact?: boolean;
}) {
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
      {note ? <span>{note}</span> : chosen && !compact ? <span>{t.you(label(chosen))}</span> : null}
      <span className={styles.verdictLoss}>{decision.evLoss && decision.evLoss > 0.005 ? t.evLost(decision.evLoss) : t.noLoss}</span>
      {!compact && !playable && best !== null && best !== decision.chosen ? <span>{t.best(label(decision.options[best]))}</span> : null}
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

type Words = ReturnType<typeof useTrainerHost>["t"];

/** The hand's facts at the decision: the numbers the reason is made of. */
export function factsOf(decision: DecisionAnalysis, t: Words, locale: string): Array<[string, string]> {
  const pct = (value: number) => `${Math.round(value * 100).toLocaleString(locale)}%`;
  const f = decision.facts;
  const facts: Array<[string, string]> = [];
  if (f.handClass || f.made) facts.push([t.fact.made, t.words.handFacts.hand(f)]);
  if (f.equity) facts.push([t.fact.equity, pct(f.equity.value)]);
  if (f.potOdds !== null && f.toCallBb > 0) facts.push([t.fact.potOdds, pct(f.potOdds)]);
  if (f.mdf !== null && f.toCallBb > 0) facts.push([t.fact.mdf, pct(f.mdf)]);
  if (f.spr !== null && f.street !== "preflop") facts.push([t.fact.spr, f.spr.toLocaleString(locale, { maximumFractionDigits: 1 })]);
  if (f.draws.length > 0) facts.push([t.fact.draws, f.draws.map((d) => t.words.handFacts.draws[d] ?? d).join(", ")]);
  if (f.blockers.length > 0) facts.push([t.fact.blockers, f.blockers.map((b) => t.words.handFacts.blockers[b] ?? b).join(", ")]);
  return facts;
}

const isGraded = (decision: DecisionAnalysis) => decision.grade !== null && decision.options.length > 0;

/** What the reference does with this hand: every option's frequency and EV, the answer marked. */
export function StrategyPanel({ decision, mix = null }: { decision: DecisionAnalysis; mix?: number[] | null }) {
  const { t, locale } = useTrainerHost();
  const label = useOptionText();
  const pct = (value: number) => `${Math.round(value * 100).toLocaleString(locale)}%`;
  const ev = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!isGraded(decision)) return <NotGraded decision={decision} />;
  const best = bestIndex(decision);
  return (
    <ul className={styles.options} data-mix={mix ? true : undefined} aria-label={t.strategyHeading}>
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
          {mix ? (
            <span className={styles.optionMix} title={t.mixYours}>
              {pct(mix[index] ?? 0)}
            </span>
          ) : null}
          <span className={styles.optionEv} title={t.evHeading}>
            {ev(option.ev)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The hand's facts at the decision. */
export function FactsPanel({ decision }: { decision: DecisionAnalysis }) {
  const { t, locale } = useTrainerHost();
  const facts = factsOf(decision, t, locale);
  return (
    <dl className={styles.facts} aria-label={t.factsHeading}>
      {facts.map(([name, value]) => (
        <div key={name} className={styles.fact}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Why: the analysis' own sentences, the rule of thumb, and the host's deeper study. */
export function WhyPanel({ decision, spot, extra = null }: { decision: DecisionAnalysis; spot: TrainerSpot | null; extra?: ReactNode }) {
  const { t } = useTrainerHost();
  if (!isGraded(decision)) return <NotGraded decision={decision} />;
  const why = t.words.explain(decision);
  const principleKey = principleOf(spot, decision);
  const principle = principleKey ? t.principles[principleKey] : undefined;
  return (
    <div className={styles.why} aria-label={t.whyHeading}>
      {why.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      {principle ? (
        <p className={styles.principle}>
          <strong>{t.ruleOfThumb}</strong> {principle}
        </p>
      ) : null}
      {extra}
    </div>
  );
}

function NotGraded({ decision }: { decision: DecisionAnalysis }) {
  const { t } = useTrainerHost();
  return <p className={styles.notice}>{t.notGraded(decision.reason ? (t.words.reasons[decision.reason] ?? decision.reason) : "—")}</p>;
}

/**
 * The tabs under a decision: the range always (read when opened), the rest
 * once the answer is graded. The settings' strategy and facts switches still
 * leave their tab out.
 */
export function useDecisionTabs({
  decision,
  spot,
  settings,
  mix = null,
  range,
  study = null,
}: {
  decision: DecisionAnalysis | null;
  spot: TrainerSpot | null;
  settings: TrainerSettings;
  mix?: number[] | null;
  /** The range panel; absent: no range tab (the host reads none). */
  range?: ReactNode;
  /** The host's deeper study, under the why. */
  study?: ReactNode;
}): InfoTab[] {
  const { t, locale } = useTrainerHost();
  const tabs: InfoTab[] = [];
  if (range !== undefined) tabs.push({ id: "range", label: t.tabs.range, content: range });
  if (settings.strategy) tabs.push({ id: "strategy", label: t.tabs.strategy, content: decision ? <StrategyPanel decision={decision} mix={mix} /> : null });
  if (settings.facts) {
    const has = decision !== null && isGraded(decision) && factsOf(decision, t, locale).length > 0;
    tabs.push({ id: "facts", label: t.tabs.facts, content: has && decision ? <FactsPanel decision={decision} /> : null });
  }
  tabs.push({ id: "why", label: t.tabs.why, content: decision ? <WhyPanel decision={decision} spot={spot} extra={study} /> : null });
  return tabs;
}
