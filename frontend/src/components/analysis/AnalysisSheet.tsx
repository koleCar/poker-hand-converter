/**
 * The Analysis sheet: what the replayer shows beside the felt on
 * `/analysis/h/<id>` (`docs/ANALYSIS-PLAN.md` §6.1).
 *
 *   header         the hand's grade word, EV loss in bb and % of the pot, and
 *                  score — "Not graded" and dashes when nothing was graded,
 *                  never zeros
 *   banner         the approximations, always shown when there are any (§3.5)
 *   decisions      one chip per hero decision, street by street, with its
 *                  grade icon; a bad move shows the better option under it
 *   selected       the reference's options (action · frequency bar · EV) with
 *                  the hero's move marked, the spot's facts, its flags, the
 *                  *why* (§4), and the 13×13 study: the chart for a chart
 *                  grade, the hero's solved turn or river range for a
 *                  solver grade
 *
 * The selection follows the replayer: stepping onto a hero decision selects
 * it, and pressing a chip seeks there. Between decisions the last one stays
 * selected, so stepping through the villain's actions does not blank the
 * panel the reader is studying.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { bestOption, betterAlternative } from "../../lib/analysis/reference";
import { ANALYSIS_VERSION, type DecisionAnalysis, type HandAnalysis, type OptionAnalysis } from "../../lib/analysis/types";
import type { ChartSet } from "../../lib/charts";
import { preflopChartSet } from "../../lib/chartSet";
import { useDict } from "../../lib/i18n/client";
import { conceptsForDecision } from "../../lib/learn/links";
import type { PhfHand } from "../../lib/phf/types";
import type { ReplayFrame } from "../../lib/replay";
import { paths } from "../../lib/routes";
import { CardRow } from "../replayer/PlayingCard";
import type { ReplayPosition } from "../replayer/position";
import styles from "./analysis.module.css";
import { ChartGrid } from "./ChartGrid";
import { GradeIcon } from "./GradeIcon";
import { LearnLinks } from "./LearnLinks";
import { RiverStudy } from "./RiverStudy";
import { loudness, toneOf } from "./tone";

const STREETS = ["preflop", "flop", "turn", "river"] as const;
/** Decoration before a bad move's better option. */
const ARROW = "→";

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
  /** The hand itself, for the turn and river studies' re-solve. Without it there is no solver study. */
  hand?: PhfHand;
  /**
   * A stranger's view of a shared analysis (A7.1): the hero is "the hero",
   * not "you", in the sheet's own labels, and a line says whose analysis it
   * is. Nothing else changes: the same grades, options, facts and *why*.
   */
  readOnly?: boolean;
}

type Strings = ReturnType<typeof useDict>["analysis"];

/** The sheet's strings: the owner's, or — read-only — with the hero named in the third person. */
function useSheetStrings(readOnly = false): Strings {
  const t = useDict().analysis;
  return useMemo(() => {
    if (!readOnly) return t;
    const voice = t.share.sheet;
    return {
      ...t,
      sheet: {
        ...t.sheet,
        yourMove: voice.heroMove,
        decisionsHeading: voice.decisionsHeading,
        noDecisions: voice.noDecisions,
        facts: { ...t.sheet.facts, hand: voice.heroHand },
      },
    };
  }, [t, readOnly]);
}

export function AnalysisSheet({ analysis, frame, seek, fresh, hand, readOnly = false }: AnalysisSheetProps) {
  const t = useSheetStrings(readOnly);
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
          {analysis.grade ? <GradeIcon grade={analysis.grade} /> : null}
          {analysis.grade ? t.grades[analysis.grade] : t.sheet.notGraded}
        </span>
        <span className={styles.headStat}>
          {t.sheet.evLoss}
          <strong>{analysis.evLoss === null ? "—" : t.sheet.bb(analysis.evLoss)}</strong>
          {analysis.evLossPot !== null ? <span>{t.sheet.evLossPot(analysis.evLossPot)}</span> : null}
        </span>
        <span className={styles.headStat}>
          {t.sheet.score}
          <strong>{analysis.score === null ? "—" : Math.round(analysis.score)}</strong>
        </span>
      </div>
      {analysis.grade === null && decisions.length > 0 ? <p className={styles.hint}>{t.sheet.notGradedHint}</p> : null}
      {fresh && !readOnly ? <p className={styles.hint}>{t.hand.fresh}</p> : null}
      {readOnly ? <p className={styles.hint}>{t.share.sheet.note}</p> : null}
      {readOnly && analysis.version !== ANALYSIS_VERSION ? (
        <p className={styles.hint}>{t.share.sheet.stale(analysis.version)}</p>
      ) : null}

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
                      const better = betterAlternative(decision);
                      const betterLabel = better
                        ? t.sheet.option(better.action, better.sizeBb, better.allIn, better.sizePot)
                        : null;
                      return (
                        <span key={decision.order} className={styles.chipStack}>
                          <button
                            type="button"
                            className={styles.chip}
                            aria-pressed={selected?.order === decision.order}
                            aria-label={`${t.sheet.mark(t.streets[street], t.actions[decision.action], mark)}${
                              betterLabel ? `. ${t.sheet.better(betterLabel)}` : ""
                            }`}
                            onClick={() => {
                              setPicked(decision.order);
                              seek({ kind: "action", actionIndex: decision.actionIndex });
                            }}
                          >
                            {decision.grade ? (
                              <GradeIcon grade={decision.grade} />
                            ) : (
                              <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
                            )}
                            <span className={tone === "skipped" ? styles.skipped : undefined}>
                              {t.actions[decision.action]}
                            </span>
                            {decision.source === "approx" ? (
                              <span className={styles.approxMark} aria-hidden="true">
                                ≈
                              </span>
                            ) : null}
                          </button>
                          {betterLabel ? (
                            <span className={styles.better} aria-hidden="true">
                              {ARROW} {betterLabel}
                            </span>
                          ) : null}
                        </span>
                      );
                    })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {selected ? <DecisionDetail key={selected.order} decision={selected} hand={hand} readOnly={readOnly} /> : null}
    </div>
  );
}

/** The word a pip or chip is marked with: the grade, else the loudest flag's severity, else nothing. */
export function markWord(decision: DecisionAnalysis, t: Strings): string | null {
  if (decision.status === "not-analysed") return t.sheet.skipped;
  // An approximate multiway grade (A9) says so wherever its grade word is read.
  if (decision.grade && decision.source === "approx") return `${t.grades[decision.grade] ?? decision.grade} ${t.sheet.approxMark}`;
  if (decision.grade) return t.grades[decision.grade] ?? null;
  if (decision.worstFlag) return t.severity[decision.worstFlag] ?? null;
  return null;
}

/** The reference's options at the node: action · frequency bar · EV, the hero's move marked. */
export function OptionsTable({ decision, readOnly = false }: { decision: DecisionAnalysis; readOnly?: boolean }) {
  const t = useSheetStrings(readOnly);
  const s = t.sheet;
  const best = bestOption(decision);
  const label = (option: OptionAnalysis) => s.option(option.action, option.sizeBb, option.allIn, option.sizePot);
  return (
    <div className="stats-table-wrap">
      <table className={`stats-table ${styles.options}`}>
        <thead>
          <tr>
            <th scope="col">{s.colAction}</th>
            <th scope="col">{s.colFreq}</th>
            <th scope="col" className="num">
              {s.colEv}
            </th>
          </tr>
        </thead>
        <tbody>
          {decision.options.map((option, index) => {
            const mine = index === decision.chosen;
            return (
              <tr key={index} className={mine ? styles.chosenRow : undefined} aria-current={mine ? "true" : undefined}>
                <th scope="row">
                  <span className={styles.optionName}>{label(option)}</span>
                  {mine ? <span className={`${styles.tag} ${decision.grade ? styles[decision.grade] : ""}`}>{s.yourMove}</span> : null}
                  {index === best ? <span className={`${styles.tag} ${styles.perfect}`}>{s.best}</span> : null}
                </th>
                <td>
                  <span className={styles.freqCell}>
                    <span className={styles.freqBar} aria-hidden="true">
                      <span style={{ inlineSize: `${Math.max(0, Math.min(1, option.freq)) * 100}%` }} />
                    </span>
                    <span className={styles.num}>{s.freq(option.freq)}</span>
                  </span>
                </td>
                <td className="num">{s.signedBb(option.ev)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The 13×13 chart for a chart-graded decision, loaded when asked for. */
function Study({ decision }: { decision: DecisionAnalysis }) {
  const t = useDict().analysis;
  const ref = decision.facts.chart;
  const [open, setOpen] = useState(false);
  const [charts, setCharts] = useState<ChartSet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setId = ref?.set ?? null;
  useEffect(() => {
    if (!open || charts || !setId) return;
    let live = true;
    // The set the grade names (one per table and depth, charts/3).
    preflopChartSet(setId)
      .then((set) => {
        if (live) {
          if (set) setCharts(set);
          else setError(setId);
        }
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [open, charts, setId]);

  if (!ref) return null;
  // The stored row names its chart set; a set that has since changed would
  // draw a different chart than the one graded against, so it is not drawn.
  const node = charts && charts.id === ref.set ? (charts.nodes.get(ref.line) ?? null) : null;
  return (
    <div className={styles.study}>
      <div className={styles.studyActions}>
        <button type="button" className="btn btn--sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? t.sheet.hideStudy : t.sheet.study}
        </button>
        <Link className={styles.learnInline} href={paths.analysisCharts(ref.line, decision.facts.handClass, ref.set)}>
          {t.sheet.openBrowser}
        </Link>
      </div>
      {open && error ? <p className="notice notice--error">{t.charts.failed(error)}</p> : null}
      {open && !error && !charts ? <p className={styles.hint}>{t.charts.loading}</p> : null}
      {open && node ? <ChartGrid key={ref.line} node={node} highlight={decision.facts.handClass} /> : null}
    </div>
  );
}

function DecisionDetail({ decision, hand, readOnly = false }: { decision: DecisionAnalysis; hand?: PhfHand; readOnly?: boolean }) {
  const t = useSheetStrings(readOnly);
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
  // MDF is postflop only (§4), even when an older row carries one.
  if (facts.mdf !== null && facts.street !== "preflop") rows.push([s.facts.mdf, s.pct(facts.mdf)]);
  if (facts.betPot !== null) rows.push([s.facts.betPot, s.ofPot(facts.betPot)]);
  if (facts.spr !== null) rows.push([s.facts.spr, s.ratio(facts.spr)]);
  rows.push([s.facts.effStack, s.bb(facts.effStackBb)]);
  if (facts.blockers.length > 0) rows.push([s.facts.blockers, s.blockersValue(facts)]);
  if (facts.equity) rows.push([s.facts.equity, s.equityValue(facts.equity.value, facts.equity.range)]);
  // analysis/20: an opponent's range moved by their own statistics, with the sample it was moved on.
  // The owner's own view only: a shared sheet does not show what the owner's statistics say about a player.
  if (facts.villain && !readOnly) rows.push([s.facts.villain, s.villainValue(facts.villain.range, facts.villain.passive, facts.villain.hands)]);
  // Multiway (A9): the table, each range and the field, the MDF split, fold equity, the next card.
  const mw = facts.multiway;
  if (mw && mw.players >= 3) {
    rows.push([s.facts.players, s.playersValue(mw.players, mw.behind)]);
    const each = mw.opponents.filter((o) => o.equity !== null).map((o) => ({ equity: o.equity ?? 0, range: o.range }));
    if (each.length > 0) rows.push([s.facts.vsEach, s.vsEachValue(each)]);
    if (mw.mdfSplit) rows.push([s.facts.mdfSplit, s.mdfSplitValue(mw.mdfSplit.mdf, mw.mdfSplit.defenders, mw.mdfSplit.each)]);
    if (mw.foldEquity) rows.push([s.facts.foldEquity, s.foldEquityValue(mw.foldEquity.all, mw.foldEquity.needed)]);
    if (mw.outs) rows.push([s.facts.outs, s.outsValue(mw.outs.nut, mw.outs.nonNut, mw.outs.cards)]);
  }

  const graded = decision.grade !== null && decision.options.length > 0;

  return (
    <>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          {t.streets[decision.street]} · {t.actions[decision.action]}
        </h3>
        <p className={styles.sourceLine}>
          {decision.grade ? (
            <span className={`${styles.gradeTag} ${styles[decision.grade]}`}>
              <GradeIcon grade={decision.grade} />
              {t.grades[decision.grade]}
              {decision.source === "approx" ? ` ${s.approxMark}` : null}
            </span>
          ) : null}
          {decision.evLoss !== null && decision.evLoss > 0 ? (
            <span>
              {s.evLoss} {s.bb(decision.evLoss)}
              {decision.evLossPot !== null ? ` · ${s.evLossPot(decision.evLossPot)}` : ""}
            </span>
          ) : null}
          <span className={styles.muted}>
            {decision.status === "not-analysed" ? s.skipped : (s.source[decision.source] ?? decision.source)}
          </span>
        </p>
        {graded ? (
          <>
            <h4 className={styles.subhead}>{decision.source === "approx" ? s.optionsHeadingApprox : s.optionsHeading}</h4>
            {decision.source === "approx" ? <p className={styles.hint}>{s.approxNote}</p> : null}
            <OptionsTable decision={decision} readOnly={readOnly} />
            {decision.source === "solver" ? (
              hand ? (
                <RiverStudy
                  key={`${decision.street}-${decision.actionIndex}`}
                  decision={decision}
                  hand={hand}
                  street={decision.street === "turn" ? "turn" : "river"}
                />
              ) : null
            ) : (
              <Study decision={decision} />
            )}
          </>
        ) : null}
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

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{s.factsHeading}</h3>
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
    </>
  );
}
