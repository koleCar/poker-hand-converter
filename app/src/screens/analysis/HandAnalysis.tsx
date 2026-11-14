/**
 * One hand's analysis in the app (R5.4, redesigned 2026-11-14): the hand at
 * a glance, its decisions street by street, and the decision picked in
 * full - what every option is worth against the best one, what the
 * reference mixes, the spot in words (the web's `explain()`), its facts and
 * notes - beside the Solver at that decision, where every combo of the range
 * shows what it plays and what each action is worth (`SolverPanel`).
 *
 * The stored row at the app's version when there is one (`hand_analysis`),
 * else the hand analysed now in a worker (and left for the background run to
 * store). Reached from Hands ("Analysis" in a hand's panel) and from the
 * session review's and the charts' lists, at the decision they name. An
 * analysis screen: hidden while a table is open (A10).
 *
 * The words of the analysis itself (option labels, facts, flags, the *why*)
 * are the web sheet's (`analysis/sheetWords.ts`), so both say the same.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { useDataSource } from "@rail/ui/data";
import type { PhfHand } from "@rail/ui/model/phf";

import { StateMessage } from "../../components/StateMessage";
import { useLocale, useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import type { DecisionAnalysis, HandAnalysis as Analysis } from "../../analysis/library";
import { handAnalysisOf } from "../../analysis/service";
import { analysisEn, analysisHr, bestOption, betterAlternative, type OptionAnalysis } from "../../analysis/sheetWords";
import { go, screenHref } from "../../lib/router";
import { solverSpotOf } from "../../solver/spot";
import styles from "./HandAnalysis.module.css";
import { IcmBlock } from "./IcmBlock";
import { SolverPanel } from "./SolverPanel";

export type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      analysis: Analysis;
      stored: boolean;
      /** (R5.5) When the hand was played: a players-left point is kept at it. */
      playedAt?: string | null;
      /** The hand itself: its cards and result above, and the Solver follows its line to a turn or river decision. */
      hand?: PhfHand;
    };

type Words = typeof analysisEn;

const TWO = liveNumberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ONE = liveNumberFormat({ minimumFractionDigits: 0, maximumFractionDigits: 1 });
const STREETS = ["preflop", "flop", "turn", "river"] as const;
const GLYPHS: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };
/** Louder first: the decision the screen opens on when no list named one. */
const LOUDNESS: Record<string, number> = { blunder: 5, mistake: 4, inaccurate: 3, good: 2, perfect: 1 };
/** Under this, an EV difference reads as none: two decimals show it as 0.00. */
const EV_EPSILON = 0.005;

/** A decision's EV lost reads red only when its grade is worse than Good: a mixed Perfect gives up a little by design. */
function costly(d: Pick<DecisionAnalysis, "grade" | "evLoss">): boolean {
  return d.evLoss !== null && d.evLoss >= EV_EPSILON && (d.grade === "inaccurate" || d.grade === "mistake" || d.grade === "blunder");
}

/** "+1.25 bb", "−0.40 bb", "0.00 bb". */
function signedBb(value: number): string {
  if (Math.abs(value) < EV_EPSILON) return `${TWO.format(0)} bb`;
  return `${value > 0 ? "+" : "−"}${TWO.format(Math.abs(value))} bb`;
}

function percent(value: number): string {
  return `${ONE.format(value * 100)} %`;
}

/** The web sheet's words in the app's language. */
function useWords(): Words {
  return (useLocale() === "hr" ? analysisHr : analysisEn) as Words;
}

export function HandAnalysis({
  handKey,
  actionIndex,
  back,
}: {
  handKey: string;
  actionIndex: number | null;
  /** The analysis view it came from (`view.ts`), for the Back link. */
  back: string | null;
}) {
  const data = useDataSource();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const phf = (await data.hand(handKey)) as PhfHand | null;
        if (!phf) {
          if (live) setLoaded({ status: "missing" });
          return;
        }
        const result = await handAnalysisOf(handKey, phf as never);
        if (live) setLoaded(result ? { status: "ready", ...result, playedAt: phf.playedAt ?? null, hand: phf } : { status: "missing" });
      } catch (error) {
        if (live) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [data, handKey]);

  return <HandAnalysisView handKey={handKey} actionIndex={actionIndex} back={back} loaded={loaded} />;
}

/** The hand's grades as loaded: the view the tests render. */
export function HandAnalysisView({
  handKey,
  actionIndex,
  back,
  loaded,
}: {
  handKey: string;
  actionIndex: number | null;
  back: string | null;
  loaded: Loaded;
}) {
  const h = useT().analysis.hand;
  const decisions = loaded.status === "ready" ? loaded.analysis.decisions : null;
  const hand = loaded.status === "ready" ? loaded.hand : undefined;
  /** The decision shown in full: picked in the strip; at first the one the hand was opened at, else the worst. */
  const [picked, setPicked] = useState<number | null>(null);
  const selected = useMemo(() => {
    if (!decisions) return null;
    const at = picked ?? actionIndex;
    return decisions.find((d) => d.actionIndex === at) ?? worstOf(decisions) ?? decisions[0] ?? null;
  }, [decisions, picked, actionIndex]);
  const spot = useMemo(() => (decisions && selected ? solverSpotOf(decisions, selected, hand) : null), [decisions, selected, hand]);
  /** The hero's cards, marked in the Solver's grid where they act. */
  const hero = useMemo(() => {
    const facts = selected?.facts;
    return facts && facts.holeCards.length === 2 && facts.position ? { cards: facts.holeCards.join(""), position: facts.position } : null;
  }, [selected]);

  const links = (
    <div className={styles.links}>
      {back && (
        <a className={styles.link} href={screenHref("analysis", back)}>
          ← {h.backToList}
        </a>
      )}
      <button type="button" className={styles.link} onClick={() => go("hands", handKey)}>
        {h.back}
      </button>
    </div>
  );

  let body: ReactNode;
  if (loaded.status === "loading") body = <StateMessage kind="loading">{h.loading}</StateMessage>;
  else if (loaded.status === "missing") body = <StateMessage kind="empty">{h.notFound}</StateMessage>;
  else if (loaded.status === "error") body = <StateMessage kind="error">{h.failed(loaded.message)}</StateMessage>;
  else {
    const a = loaded.analysis;
    body = (
      <>
        <HandHead analysis={a} hand={loaded.hand} links={links} />
        {!loaded.stored && <p className={styles.note}>{h.notStored}</p>}
        {a.decisions.length > 0 && (
          <Timeline decisions={a.decisions} selected={selected} actionIndex={actionIndex} onSelect={setPicked} />
        )}
        {selected ? (
          <div className={spot ? styles.split : styles.single}>
            <DecisionDetail key={selected.order} decision={selected} playedAt={loaded.playedAt ?? null} />
            <SolverPanel spot={spot} hero={hero} />
          </div>
        ) : (
          <p className={styles.muted}>{a.status === "not-analysed" ? h.notAnalysed(a.reason ?? "") : h.noGrade}</p>
        )}
      </>
    );
  }

  return (
    <section className={styles.page} aria-labelledby="hand-analysis-title">
      {/* No visible title (the sidebar says where you are); named for assistive tech. */}
      <h1 id="hand-analysis-title" className={styles.visuallyHidden}>
        {h.title}
      </h1>
      {loaded.status === "ready" ? null : links}
      {body}
    </section>
  );
}

/** The loudest graded decision, else null. */
function worstOf(decisions: readonly DecisionAnalysis[]): DecisionAnalysis | null {
  let worst: DecisionAnalysis | null = null;
  for (const d of decisions) {
    const loud = d.grade ? (LOUDNESS[d.grade] ?? 0) : 0;
    if (loud > 0 && (!worst || loud > (LOUDNESS[worst.grade ?? ""] ?? 0))) worst = d;
  }
  return worst;
}

/** The hand at a glance: the hero's cards and seat, the board, the result; the hand's grade, EV lost and score. */
function HandHead({ analysis: a, hand, links }: { analysis: Analysis; hand?: PhfHand; links: ReactNode }) {
  const h = useT().analysis.hand;
  const first = a.decisions[0]?.facts;
  const holeCards = first?.holeCards ?? [];
  const position = first?.position ?? null;
  const board = boardOf(hand) ?? a.decisions[a.decisions.length - 1]?.facts.board ?? [];
  const result = resultBb(hand);
  return (
    <header className={styles.head}>
      <div className={styles.headHand}>
        {holeCards.length > 0 && <CardRow cards={holeCards} size="sm" />}
        {position && <span className={styles.seat}>{position}</span>}
        {board.length > 0 && <CardRow cards={board} size="sm" className={styles.board} />}
      </div>
      <dl className={styles.headStats}>
        {a.grade ? (
          <div>
            <dt>{h.worst}</dt>
            <dd>
              <GradeTag grade={a.grade} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{h.evLoss}</dt>
          <dd className={costly(a) ? styles.loss : undefined}>
            {a.evLoss === null ? "–" : signedBb(-a.evLoss)}
          </dd>
        </div>
        {a.score !== null && (
          <div>
            <dt>{h.score}</dt>
            <dd>{Math.round(a.score)}</dd>
          </div>
        )}
        {result !== null && (
          <div>
            <dt>{h.result}</dt>
            <dd className={result >= EV_EPSILON ? styles.profit : result <= -EV_EPSILON ? styles.loss : undefined}>{signedBb(result)}</dd>
          </div>
        )}
      </dl>
      {links}
    </header>
  );
}

/** The hand's whole board (the first run's), from the hand itself. */
function boardOf(hand?: PhfHand): string[] | null {
  const runouts = (hand as { board?: { runouts?: Array<{ summaryCards?: string[] }> } } | undefined)?.board?.runouts;
  const cards = runouts?.[0]?.summaryCards;
  return Array.isArray(cards) && cards.length > 0 ? cards : null;
}

/** The hero's net result in big blinds, when the hand says. */
function resultBb(hand?: PhfHand): number | null {
  const h = hand as { results?: { heroNet?: number | null }; game?: { bigBlind?: number } } | undefined;
  const net = h?.results?.heroNet;
  const bb = h?.game?.bigBlind;
  return typeof net === "number" && typeof bb === "number" && bb > 0 ? net / bb : null;
}

function GradeTag({ grade, approx = false }: { grade: string; approx?: boolean }) {
  const h = useT().analysis.hand;
  const w = useWords();
  return (
    <span className={`${styles.grade} ${styles[`grade-${grade}`] ?? ""}`}>
      <span aria-hidden="true">{GLYPHS[grade] ?? ""}</span> {h.grades[grade] ?? grade}
      {approx ? ` ${w.sheet.approxMark}` : null}
    </span>
  );
}

/** The decisions street by street: one chip each, its grade, what it cost and the better play under a bad one. */
function Timeline({
  decisions,
  selected,
  actionIndex,
  onSelect,
}: {
  decisions: readonly DecisionAnalysis[];
  selected: DecisionAnalysis | null;
  actionIndex: number | null;
  onSelect: (actionIndex: number) => void;
}) {
  const h = useT().analysis.hand;
  const w = useWords();
  return (
    <ol className={styles.timeline} aria-label={h.decisions}>
      {STREETS.filter((street) => decisions.some((d) => d.street === street)).map((street) => (
        <li key={street} className={styles.streetCol}>
          <span className={styles.streetName}>{h.streets[street]}</span>
          <ol className={styles.chips}>
            {decisions
              .filter((d) => d.street === street)
              .map((d) => {
                const better = betterAlternative(d);
                const chosen = d.chosen !== null ? d.options[d.chosen] : undefined;
                const tone = d.status === "not-analysed" ? "skipped" : (d.grade ?? "neutral");
                return (
                  <li key={d.order} data-action-index={d.actionIndex}>
                    <button
                      type="button"
                      className={[styles.chip, styles[`tone-${tone}`] ?? "", d.actionIndex === actionIndex ? styles.opened : ""]
                        .filter(Boolean)
                        .join(" ")}
                      aria-pressed={d === selected}
                      onClick={() => onSelect(d.actionIndex)}
                    >
                      <span className={styles.chipTop}>
                        <span className={styles.chipGlyph} aria-hidden="true">
                          {d.grade ? GLYPHS[d.grade] : "•"}
                        </span>
                        <span className={styles.chipAction}>
                          {chosen ? w.sheet.option(chosen.action, chosen.sizeBb, chosen.allIn, chosen.sizePot) : (h.actions[d.action] ?? d.action)}
                        </span>
                      </span>
                      <span className={styles.chipSub}>
                        {d.status === "not-analysed" ? (
                          w.sheet.skipped
                        ) : d.grade ? (
                          <>
                            <span className={styles.visuallyHidden}>{h.grades[d.grade]} </span>
                            <span className={costly(d) ? styles.loss : undefined}>
                              {d.evLoss === null ? "–" : signedBb(-d.evLoss)}
                            </span>
                          </>
                        ) : (
                          h.ungraded
                        )}
                      </span>
                      {better && (
                        <span className={styles.chipBetter}>
                          → {w.sheet.option(better.action, better.sizeBb, better.allIn, better.sizePot)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** One decision in full: its verdict, every option against the best, the spot in words, the facts and the notes. */
function DecisionDetail({ decision: d, playedAt }: { decision: DecisionAnalysis; playedAt: string | null }) {
  const h = useT().analysis.hand;
  const w = useWords();
  const chosen = d.chosen !== null ? d.options[d.chosen] : undefined;
  const why = w.explain(d);
  const facts = factRows(d, w);
  return (
    <article className={styles.detail} aria-labelledby="decision-title">
      <header className={styles.detailHead}>
        <h2 id="decision-title" className={styles.detailTitle}>
          <span className={styles.muted}>{h.streets[d.street]} · </span>
          {chosen ? w.sheet.option(chosen.action, chosen.sizeBb, chosen.allIn, chosen.sizePot) : (h.actions[d.action] ?? d.action)}
        </h2>
        <p className={styles.verdict}>
          {d.status === "not-analysed" ? (
            <span className={styles.muted}>{h.skipped(w.reasons[d.reason ?? ""] ?? d.reason ?? "")}</span>
          ) : d.grade ? (
            <GradeTag grade={d.grade} approx={d.source === "approx"} />
          ) : (
            <span className={styles.muted}>{h.ungraded}</span>
          )}
          {d.grade && d.evLoss !== null && (
            <span>
              <span className={costly(d) ? styles.loss : undefined}>{signedBb(-d.evLoss)}</span>
              {d.evLossPot !== null && d.evLoss >= EV_EPSILON ? <span className={styles.muted}> · {h.evLossPot(percent(d.evLossPot))}</span> : null}
            </span>
          )}
          <span className={styles.muted}>{h.sources[d.source] ?? d.source}</span>
        </p>
      </header>

      {d.options.length > 0 && <OptionsTable decision={d} />}

      {why.length > 0 && (
        <section className={styles.why} aria-label={h.why}>
          <span className={styles.label}>{h.why}</span>
          <p className={styles.whyLead}>{why[0]}</p>
          {why.slice(1).map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </section>
      )}

      {facts.length > 0 && (
        <section aria-label={h.spot}>
          <span className={styles.label}>{h.spot}</span>
          <dl className={styles.facts}>
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {d.flags.length > 0 && (
        <section aria-label={h.flags}>
          <span className={styles.label}>{h.flags}</span>
          <ul className={styles.flags}>
            {d.flags.map((flag) => (
              <li key={flag.code}>
                <span className={`${styles.severity} ${styles[`severity-${flag.severity}`] ?? ""}`}>{w.severity[flag.severity] ?? flag.severity}</span>
                <span>{w.flags[flag.code] ?? flag.code}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.facts.icm && (
        <section aria-label={h.icm.heading}>
          <span className={styles.label}>{h.icm.heading}</span>
          <IcmBlock decision={d} playedAt={playedAt} />
        </section>
      )}

      {d.approximations.length > 0 && (
        <details className={styles.approx}>
          <summary>{h.approximate}</summary>
          <ul>
            {d.approximations.map((code) => (
              <li key={code}>{w.approximations[code] ?? code}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

const ACTION_TONE: Record<string, string> = { fold: "fold", check: "check", call: "call", bet: "raise", raise: "raise" };

/** Every option: how often the reference plays it, its EV and what it gives up against the best; yours and the best marked. */
function OptionsTable({ decision: d }: { decision: DecisionAnalysis }) {
  const h = useT().analysis.hand;
  const w = useWords();
  const best = bestOption(d);
  const bestEv = best === null ? null : d.options[best].ev;
  const worstGap = bestEv === null ? 0 : Math.max(...d.options.map((o) => bestEv - o.ev), 0);
  const label = (o: OptionAnalysis) => w.sheet.option(o.action, o.sizeBb, o.allIn, o.sizePot);
  return (
    <section aria-label={h.options}>
      <span className={styles.label}>{h.options}</span>
      <table className={styles.options}>
        <thead>
          <tr>
            <th scope="col">{h.option}</th>
            <th scope="col">{h.frequency}</th>
            <th scope="col" className={styles.num}>
              {h.ev}
            </th>
            <th scope="col" className={styles.num}>
              {h.delta}
            </th>
          </tr>
        </thead>
        <tbody>
          {d.options.map((o, i) => {
            const mine = i === d.chosen;
            const gap = bestEv === null ? 0 : bestEv - o.ev;
            const tone = o.allIn ? "allin" : (ACTION_TONE[o.action] ?? "fold");
            return (
              <tr key={i} className={mine ? styles.mine : undefined} aria-current={mine ? "true" : undefined}>
                <th scope="row">
                  <span className={styles.optionName}>
                    <span className={`${styles.swatch} ${styles[`act-${tone}`] ?? ""}`} aria-hidden="true" />
                    {label(o)}
                  </span>
                  {mine && <span className={`${styles.tag} ${styles.tagYou}`}>{h.you}</span>}
                  {i === best && <span className={`${styles.tag} ${styles.tagBest}`}>{h.bestTag}</span>}
                </th>
                <td>
                  <span className={styles.freq}>
                    <span className={styles.freqBar} aria-hidden="true">
                      <span className={styles[`act-${tone}`]} style={{ inlineSize: `${Math.max(0, Math.min(1, o.freq)) * 100}%` }} />
                    </span>
                    <span className={styles.num}>{percent(o.freq)}</span>
                  </span>
                </td>
                <td className={styles.num}>{signedBb(o.ev)}</td>
                <td className={styles.num}>
                  {i === best || gap < EV_EPSILON ? (
                    <span className={styles.muted}>–</span>
                  ) : (
                    <span className={styles.gap}>
                      <span className={styles.gapBar} aria-hidden="true">
                        <span style={{ inlineSize: `${worstGap > 0 ? (gap / worstGap) * 100 : 0}%` }} />
                      </span>
                      <span className={styles.loss}>{signedBb(-gap)}</span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {d.source === "approx" && <p className={styles.hint}>{w.sheet.approxNote}</p>}
    </section>
  );
}

/** The spot's facts as the web's sheet lists them, in its words. */
function factRows(d: DecisionAnalysis, w: Words): Array<[string, ReactNode]> {
  const s = w.sheet;
  const facts = d.facts;
  const rows: Array<[string, ReactNode]> = [];
  rows.push([s.facts.spot, s.spotValue(facts)]);
  if (facts.position) rows.push([s.facts.position, facts.position]);
  rows.push([s.facts.hand, facts.street === "preflop" ? (facts.handClass ?? facts.holeCards.join(" ")) : s.handValue(facts)]);
  if (facts.board.length > 0 && facts.texture) rows.push([s.facts.board, s.textureValue(facts)]);
  if (facts.draws.length > 0) rows.push([s.facts.draws, s.drawsValue(facts)]);
  rows.push([s.facts.pot, s.bb(facts.potBb)]);
  if (facts.toCallBb > 0) rows.push([s.facts.toCall, s.bb(facts.toCallBb)]);
  if (facts.potOdds !== null) rows.push([s.facts.potOdds, s.pct(facts.potOdds)]);
  if (facts.equity) rows.push([s.facts.equity, s.equityValue(facts.equity.value, facts.equity.range)]);
  // MDF is postflop only (§4), even when an older row carries one.
  if (facts.mdf !== null && facts.street !== "preflop") rows.push([s.facts.mdf, s.pct(facts.mdf)]);
  if (facts.betPot !== null) rows.push([s.facts.betPot, s.ofPot(facts.betPot)]);
  if (facts.spr !== null) rows.push([s.facts.spr, s.ratio(facts.spr)]);
  rows.push([s.facts.effStack, s.bb(facts.effStackBb)]);
  if (facts.blockers.length > 0) rows.push([s.facts.blockers, s.blockersValue(facts)]);
  if (facts.villain) rows.push([s.facts.villain, s.villainValue(facts.villain.range, facts.villain.passive, facts.villain.hands)]);
  const mw = facts.multiway;
  if (mw && mw.players >= 3) {
    rows.push([s.facts.players, s.playersValue(mw.players, mw.behind)]);
    const each = mw.opponents.filter((o) => o.equity !== null).map((o) => ({ equity: o.equity ?? 0, range: o.range }));
    if (each.length > 0) rows.push([s.facts.vsEach, s.vsEachValue(each)]);
    if (mw.mdfSplit) rows.push([s.facts.mdfSplit, s.mdfSplitValue(mw.mdfSplit.mdf, mw.mdfSplit.defenders, mw.mdfSplit.each)]);
    if (mw.foldEquity) rows.push([s.facts.foldEquity, s.foldEquityValue(mw.foldEquity.all, mw.foldEquity.needed)]);
    if (mw.outs) rows.push([s.facts.outs, s.outsValue(mw.outs.nut, mw.outs.nonNut, mw.outs.cards)]);
  }
  return rows;
}
