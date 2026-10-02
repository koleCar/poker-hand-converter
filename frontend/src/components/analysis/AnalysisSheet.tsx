/**
 * The Analysis sheet: what the replayer shows beside the felt on
 * `/analysis/h/<id>` (`docs/ANALYSIS-PLAN.md` §6.1).
 *
 *   header         the hand's grade word, EV loss and score — "Not graded" and
 *                  dashes until a reference exists, never zeros
 *   banner         the approximations, always shown when there are any (§3.5)
 *   decisions      one chip per hero decision, street by street, coloured
 *   selected       the spot's facts, its flags, and the *why* (§4)
 *
 * The selection follows the replayer: stepping onto a hero decision selects
 * it, and pressing a chip seeks there. Between decisions the last one stays
 * selected, so stepping through the villain's actions does not blank the
 * panel the reader is studying.
 */

"use client";

import { useState, type ReactNode } from "react";
import type { DecisionAnalysis, HandAnalysis } from "../../lib/analysis/types";
import { useDict } from "../../lib/i18n/client";
import type { ReplayFrame } from "../../lib/replay";
import { CardRow } from "../replayer/PlayingCard";
import type { ReplayPosition } from "../replayer/position";
import styles from "./analysis.module.css";
import { conceptsForDecision } from "../../lib/learn/links";
import { LearnLinks } from "./LearnLinks";
import { loudness, toneOf } from "./tone";

const STREETS = ["preflop", "flop", "turn", "river"] as const;

/** The decision the sheet opens on: the loudest, else the first. */
export function worstDecision(analysis: HandAnalysis): DecisionAnalysis | null {
  let worst: DecisionAnalysis | null = null;
  for (const decision of analysis.decisions) {
    if (!worst || loudness(toneOf(decision)) > loudness(toneOf(worst))) {
      worst = decision;
    }
  }
  return worst;
}

interface AnalysisSheetProps {
  analysis: HandAnalysis;
  frame: ReplayFrame;
  seek: (position: ReplayPosition) => void;
  /** The analysis was computed here, not read back from the database. */
  fresh: boolean;
}

export function AnalysisSheet({ analysis, frame, seek, fresh }: AnalysisSheetProps) {
  const t = useDict().analysis;
  const decisions = analysis.decisions;
  const [picked, setPicked] = useState<number | null>(() => worstDecision(analysis)?.order ?? null);

  // The replayer is the source of truth for "where are we": landing on a hero
  // decision selects it. Adjusted during render rather than in an effect, so
  // the panel never paints one frame of the previous decision.
  const atFrame = frame.actionIndex === null ? null : decisions.find((d) => d.actionIndex === frame.actionIndex) ?? null;
  const [lastFrameDecision, setLastFrameDecision] = useState<number | null>(atFrame?.order ?? null);
  if (atFrame && atFrame.order !== lastFrameDecision) {
    setLastFrameDecision(atFrame.order);
    setPicked(atFrame.order);
  }
  const selected = decisions.find((d) => d.order === picked) ?? decisions[0] ?? null;

  return (
    <div className={styles.sheet}>
      <div className={styles.sheetHead}>
        <span className={`${styles.gradeWord} ${analysis.grade ? styles[analysis.grade] : styles.neutral}`}>
          {analysis.grade ? t.grades[analysis.grade] : t.sheet.notGraded}
        </span>
        <span className={styles.headStat}>
          {t.sheet.evLoss}
          <strong>{analysis.evLoss === null ? "—" : t.sheet.bb(analysis.evLoss)}</strong>
        </span>
        <span className={styles.headStat}>
          {t.sheet.score}
          <strong>{analysis.score === null ? "—" : Math.round(analysis.score)}</strong>
        </span>
      </div>
      {analysis.grade === null ? <p className={styles.hint}>{t.sheet.notGradedHint}</p> : null}
      {fresh ? <p className={styles.hint}>{t.hand.fresh}</p> : null}

      {analysis.approximations.length > 0 ? (
        <div className={styles.approx}>
          <strong>{t.sheet.approximate}</strong>
          <ul>
            {analysis.approximations.map((code) => (
              <li key={code}>{t.approximations[code] ?? code}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.status === "not-analysed" && decisions.length === 0 ? (
        <p className={styles.hint}>{analysis.reason ? (t.reasons[analysis.reason] ?? analysis.reason) : t.sheet.noDecisions}</p>
      ) : null}

      {decisions.length > 0 ? (
        <section className={styles.section} aria-label={t.sheet.decisionsHeading}>
          <h3 className={styles.sectionTitle}>{t.sheet.decisionsHeading}</h3>
          <ul className={styles.streets}>
            {STREETS.filter((street) => decisions.some((d) => d.street === street)).map((street) => (
              <li key={street} className={styles.streetRow}>
                <span className={styles.streetName}>{t.streets[street]}</span>
                <span className={styles.chips}>
                  {decisions
                    .filter((d) => d.street === street)
                    .map((decision) => {
                      const tone = toneOf(decision);
                      const mark = markWord(decision, t);
                      return (
                        <button
                          key={decision.order}
                          type="button"
                          className={styles.chip}
                          aria-pressed={selected?.order === decision.order}
                          aria-label={t.sheet.mark(t.streets[street], t.actions[decision.action], mark)}
                          onClick={() => {
                            setPicked(decision.order);
                            seek({ kind: "action", actionIndex: decision.actionIndex });
                          }}
                        >
                          <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
                          <span className={tone === "skipped" ? styles.skipped : undefined}>
                            {t.actions[decision.action]}
                          </span>
                        </button>
                      );
                    })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {selected ? <DecisionDetail decision={selected} /> : null}
    </div>
  );
}

type Strings = ReturnType<typeof useDict>["analysis"];

/** The word a pip or chip is marked with: the grade, else the loudest flag's severity, else nothing. */
export function markWord(decision: DecisionAnalysis, t: Strings): string | null {
  if (decision.status === "not-analysed") return t.sheet.skipped;
  if (decision.grade) return t.grades[decision.grade] ?? null;
  if (decision.worstFlag) return t.severity[decision.worstFlag] ?? null;
  return null;
}

function DecisionDetail({ decision }: { decision: DecisionAnalysis }) {
  const t = useDict().analysis;
  const s = t.sheet;
  const facts = decision.facts;
  const rows: Array<[string, ReactNode]> = [];
  rows.push([s.facts.spot, s.spotValue(facts)]);
  if (facts.position) rows.push([s.facts.position, facts.position]);
  rows.push([s.facts.hand, facts.street === "preflop" ? (facts.handClass ?? facts.holeCards.join(" ")) : s.handValue(facts)]);
  if (facts.board.length > 0) {
    rows.push([
      s.facts.board,
      <>
        <CardRow cards={facts.board} size="xs" />
        {facts.texture ? <span className={styles.texture}>{s.textureValue(facts)}</span> : null}
      </>,
    ]);
  }
  if (facts.draws.length > 0) rows.push([s.facts.draws, s.drawsValue(facts)]);
  rows.push([s.facts.pot, s.bb(facts.potBb)]);
  if (facts.toCallBb > 0) rows.push([s.facts.toCall, s.bb(facts.toCallBb)]);
  if (facts.potOdds !== null) rows.push([s.facts.potOdds, s.pct(facts.potOdds)]);
  if (facts.mdf !== null) rows.push([s.facts.mdf, s.pct(facts.mdf)]);
  if (facts.betPot !== null) rows.push([s.facts.betPot, s.ofPot(facts.betPot)]);
  if (facts.spr !== null) rows.push([s.facts.spr, s.ratio(facts.spr)]);
  rows.push([s.facts.effStack, s.bb(facts.effStackBb)]);
  if (facts.blockers.length > 0) rows.push([s.facts.blockers, s.blockersValue(facts)]);
  if (facts.equity) rows.push([s.facts.equity, s.equityValue(facts.equity.value, facts.equity.range)]);

  return (
    <>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          {s.factsHeading} · {t.streets[decision.street]} · {t.actions[decision.action]}
        </h3>
        <dl className={styles.facts}>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{s.flagsHeading}</h3>
        {decision.flags.length === 0 ? (
          <p className={styles.hint}>{decision.status === "not-analysed" ? s.skipped : s.noFlags}</p>
        ) : (
          <ul className={styles.flagList}>
            {decision.flags.map((flag) => (
              <li key={flag.code}>
                <span className={`${styles.tag} ${styles[flag.severity]}`}>{t.severity[flag.severity]}</span>
                <span>{t.flags[flag.code] ?? flag.code}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{s.whyHeading}</h3>
        <div className={styles.why}>
          {t.explain(decision).map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
        <LearnLinks concepts={conceptsForDecision(decision)} />
      </section>
    </>
  );
}
