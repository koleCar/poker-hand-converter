/**
 * What the Trainer shows after an answer, in the order a player reads it:
 *
 * 1. the verdict - the grade, the move, what it cost and the better move -
 *    in the row under the table;
 * 2. one panel (`DecisionPanel`, canvas `ideas-trainer` A): the hero's whole
 *    range on the left, and on the right the short *why* (`Brief`) - what
 *    the hand is and what to do, what the play is worth, at most three
 *    points, example hands from the range with the EV of their play - and,
 *    folded under Details, what those do not say already (#424): the
 *    analysis' sentences without the spot, the mix and the solve's caveats
 *    (`details`), the size against the other options, a river bluff's good
 *    and bad blockers, the rule of thumb and the host's deeper study.
 *
 * Every word is built only from facts the engine computed, so it cannot
 * invent a reason.
 */

"use client";

import { useState, type ReactNode } from "react";
import type { DecisionAnalysis, OptionAnalysis } from "../../lib/analysis/types";
import type { TrainerSpot } from "../../lib/training";
import { briefGain, briefHead, briefPoints, rangeExamples } from "../../lib/training/brief";
import { bluffBlockers, sizingNotes } from "../../lib/training/details";
import type { RangeView } from "../../lib/training/rangeView";
import { useTrainerHost } from "./host";
import { principleOf } from "./principles";
import { CardsText } from "./RangeGrid";
import type { TrainerSettings } from "./settings";
import styles from "./trainer.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };

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
  // Short of Perfect the best move is named, a Good move mixed in too (#417).
  const perfect = decision.grade === "perfect";
  return (
    <div className={styles.verdict} data-grade={decision.grade ?? undefined} aria-live="polite">
      <span className={styles.verdictGrade}>
        <span aria-hidden="true">{decision.grade ? GLYPH[decision.grade] : ""}</span>
        {decision.grade ? (t.words.grades[decision.grade] ?? decision.grade) : ""}
      </span>
      {note ? <span>{note}</span> : chosen && !compact ? <span>{t.you(label(chosen))}</span> : null}
      <span className={styles.verdictLoss}>{decision.evLoss && decision.evLoss > 0.005 ? t.evLost(decision.evLoss) : t.noLoss}</span>
      {!compact && !perfect && best !== null && best !== decision.chosen ? <span>{t.best(label(decision.options[best]))}</span> : null}
    </div>
  );
}

export function bestIndex(decision: DecisionAnalysis): number | null {
  let best: number | null = null;
  decision.options.forEach((option, index) => {
    if (best === null || option.ev > decision.options[best].ev + 1e-9) best = index;
  });
  return best;
}

export const isGraded = (decision: DecisionAnalysis) => decision.grade !== null && decision.options.length > 0;

const DETAILS_KEY = "rail.trainer.details";

function readDetails(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

const DASH = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);

/**
 * The short why: the headline, what the play is worth, at most three
 * points, example hands from the range, and the rest of the reasoning
 * folded under Details.
 */
export function Brief({
  decision,
  spot,
  settings,
  view,
  highlight,
  onHighlight,
  extra = null,
}: {
  decision: DecisionAnalysis;
  spot: TrainerSpot | null;
  settings: TrainerSettings;
  /** The range at the decision, for the example hands; null while it is read (or where there is none). */
  view: RangeView | null;
  highlight: number | null;
  onHighlight: (cell: number | null) => void;
  /** The host's deeper study, under Details. */
  extra?: ReactNode;
}) {
  const { t, locale } = useTrainerHost();
  const label = useOptionText();
  const [details, setDetails] = useState(readDetails);
  if (!isGraded(decision)) return <NotGraded decision={decision} />;

  const head = briefHead(decision);
  const gain = settings.strategy ? briefGain(decision) : null;
  const points = briefPoints(decision);
  const groups = settings.strategy && view ? rangeExamples(view) : [];
  const sizing = sizingNotes(decision);
  const bluff = bluffBlockers(decision);
  // A bluff's blockers get their own words; anything else's, only where the points above do not say them.
  const blockerLines = bluff
    ? t.details.blockers(bluff)
    : decision.facts.blockers.length > 0 && !points.some((point) => point.kind === "blockers")
      ? [t.details.blocks(decision.facts.blockers.map((b) => t.words.handFacts.blockers[b] ?? b))]
      : [];
  const principleKey = principleOf(spot, decision);
  const principle = principleKey ? t.principles[principleKey] : undefined;
  const ev = (value: number) =>
    `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} bb`;
  const pct = (value: number) => `${Math.round(value * 100).toLocaleString(locale)}%`;
  const gainText = gain
    ? t.brief.gain(
        gain.kind,
        label(decision.options[gain.best]),
        label(decision.options[gain.other]),
        gain.kind === "equal" ? 0 : gain.bb,
      )
    : null;
  const toggleDetails = () => {
    const next = !details;
    setDetails(next);
    try {
      window.localStorage.setItem(DETAILS_KEY, next ? "1" : "0");
    } catch {
      // No storage: it stays as set for the visit.
    }
  };

  return (
    <div className={styles.brief} aria-label={t.whyHeading}>
      {head ? (
        <div className={styles.briefHead}>
          <strong>{t.brief.head(head.role ? (t.brief.roles[head.role] ?? head.role) : null, head.play ? (t.brief.plays[head.play] ?? head.play) : null)}</strong>
          {gainText ? (
            <span className={styles.briefGain}>
              {gainText.before}
              {gainText.value ? <span className={styles.briefWorth}>{gainText.value}</span> : null}
              {gainText.after}
            </span>
          ) : null}
        </div>
      ) : null}
      {points.length > 0 ? (
        <ul className={styles.briefPoints}>
          {points.map((point, i) => {
            const words = t.brief.point(point);
            return (
              <li key={i}>
                {DASH}
                <span>
                  <strong>{words.lead}</strong> {words.text}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {groups.length > 0 ? (
        <div className={styles.examples} role="group" aria-label={t.brief.examples}>
          {groups.map((group) => (
            <div key={group.key} className={styles.exampleRow}>
              <span className={styles.exampleLabel} data-group={group.key}>
                <i aria-hidden="true" />
                {t.brief.groups[group.key] ?? group.key}
              </span>
              {group.hands.map((hand) => {
                const option = view?.options[hand.option];
                const optionLabel = option ? t.words.option(option.action, option.sizeBb, option.allIn, option.sizePot) : "";
                return (
                  <button
                    key={hand.hand}
                    type="button"
                    className={styles.exampleHand}
                    data-me={hand.me || undefined}
                    aria-pressed={highlight === hand.cell}
                    aria-label={t.brief.showHand(hand.hand)}
                    onClick={() => onHighlight(highlight === hand.cell ? null : hand.cell)}
                  >
                    <CardsText cards={hand.hand} />
                    {hand.ev !== null ? (
                      <span className={hand.ev >= 0 ? styles.pos : styles.neg} title={t.brief.evOf(optionLabel)}>
                        {ev(hand.ev)}
                      </span>
                    ) : (
                      <span className={styles.muted} title={optionLabel}>
                        {pct(hand.freq)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      <div className={styles.details}>
        <button type="button" className={styles.detailsToggle} aria-expanded={details} onClick={toggleDetails}>
          {t.brief.details}
          <span className={styles.foldChevron} aria-hidden="true" />
        </button>
        {details ? (
          <div className={styles.detailsBody}>
            {[
              ...sizing.map((note) => t.details.sizing(note, (index) => label(decision.options[index]))),
              ...t.words.details(decision),
              ...blockerLines,
            ].map((sentence) => (
              <p key={sentence}>{sentence}</p>
            ))}
            {principle ? (
              <p className={styles.principle}>
                <strong>{t.ruleOfThumb}</strong> {principle}
              </p>
            ) : null}
            {extra}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotGraded({ decision }: { decision: DecisionAnalysis }) {
  const { t } = useTrainerHost();
  return <Dismissible className={styles.notice}>{t.notGraded(decision.reason ? (t.words.reasons[decision.reason] ?? decision.reason) : "—")}</Dismissible>;
}
