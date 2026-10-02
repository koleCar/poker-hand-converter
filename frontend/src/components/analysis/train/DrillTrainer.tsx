/**
 * Drills: your own Mistakes and Blunders, replayed as "what would you do?"
 * until they are right (phase A7).
 *
 * - **Building the deck.** On arrival the page asks the database to make a
 *   drill of every graded decision of yours that is a Mistake or worse
 *   (`sync_drill_items`, idempotent), then reads the queue: what is due, or
 *   — from a leak's "Drill this", or with "practise all" — every drill in due
 *   order.
 * - **The spot** is your own hand up to the decision (`handUpTo`: the
 *   forum's spoiler-free rule — nothing after the decision, no one else's
 *   cards). The options are the ones stored with the grade.
 * - **The answer** is graded against those options (`gradeDrill`: the move
 *   you actually made keeps its stored grade; any other one gets `grade()`
 *   with the analysis' caps), then `review_drill` reschedules it (SM-2,
 *   computed by the database) and the screen says when it comes back.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DecisionAnalysis } from "../../../lib/analysis/types";
import type { ChartNode, ChartSet } from "../../../lib/charts";
import { preflopChartSet } from "../../../lib/chartSet";
import { fetchHandAnalysis, getHand, isMissingSchemaError } from "../../../lib/db";
import {
  fetchDrillQueue,
  fetchDrillSummary,
  recordTrainerResults,
  reviewDrill,
  syncDrills,
  type DrillItem,
  type DrillReview,
  type DrillSummary,
} from "../../../lib/db/training";
import { useDict } from "../../../lib/i18n/client";
import type { PhfHand } from "../../../lib/phf/types";
import { paths } from "../../../lib/routes";
import { asAnswered, gradeDrill, handUpTo, type TrainerAnswer } from "../../../lib/training";
import { CardRow } from "../../replayer/PlayingCard";
import { ReplayViewer } from "../../replayer/ReplayViewer";
import { dateFormat, useIntlLocale } from "../../stats/format";
import { AnswerBar, type AnswerOption } from "./AnswerBar";
import { AnswerResult, useOptionLabel } from "./AnswerResult";
import { useTrainerKeys } from "./trainerKeys";
import { lastAction } from "./spotPosition";
import type { TrainState } from "./trainState";
import own from "./train.module.css";

/** The migration the drills need, named in the not-installed notice. An identifier, not prose. */
const TRAINING_MIGRATION = "supabase/migrations/20270208090000_analysis_training.sql";
const QUEUE_SIZE = 50;

type Deck =
  | { key: string; status: "ready"; summary: DrillSummary | null; queue: DrillItem[] }
  | { key: string; status: "not-installed" | "error"; message: string };

type Loaded =
  | { id: string; status: "ready"; phf: PhfHand; playedAt: string | null; decision: DecisionAnalysis }
  | { id: string; status: "gone" | "not-analysed" | "error"; message?: string };

type Answered = {
  id: string;
  picked: number;
  shown: DecisionAnalysis;
  review: DrillReview | null;
  error: string | null;
};

interface DrillTrainerProps {
  state: TrainState;
  onChange: (patch: Partial<TrainState>) => void;
  onAnswer: (answer: TrainerAnswer) => void;
  onHelp: () => void;
  /** An answer was kept in the trainer history. */
  onSaved: () => void;
}

export function DrillTrainer({ state, onChange, onAnswer, onHelp, onSaved }: DrillTrainerProps) {
  const en = useDict();
  const t = en.analysis.train;
  const d = t.drills;
  const locale = useIntlLocale();
  const label = useOptionLabel();
  const [attempt, setAttempt] = useState(0);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [position, setPosition] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [done, setDone] = useState(0);
  const [charts, setCharts] = useState<ChartSet | null>(null);

  const deckKey = JSON.stringify({ spots: state.spots, all: state.all, inaccurate: state.inaccurate, attempt });

  // Build the deck: sync, then read the counts and the queue.
  useEffect(() => {
    let live = true;
    const want = JSON.parse(deckKey) as { spots: string[] | null; all: boolean; inaccurate: boolean };
    (async () => {
      await syncDrills(want.inaccurate ? "inaccurate" : "mistake");
      const [summary, queue] = await Promise.all([
        fetchDrillSummary(),
        fetchDrillQueue({ keys: want.spots, dueOnly: !want.all && !want.spots, limit: QUEUE_SIZE }),
      ]);
      return { summary, queue };
    })()
      .then(({ summary, queue }) => {
        if (!live) return;
        setDeck({ key: deckKey, status: "ready", summary, queue });
        setPosition(0);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setDeck({
          key: deckKey,
          status: isMissingSchemaError(error) ? "not-installed" : "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      live = false;
    };
  }, [deckKey]);

  const ready = deck && deck.key === deckKey && deck.status === "ready" ? deck : null;
  const item = ready ? (ready.queue[position] ?? null) : null;

  // The hand behind the current drill.
  useEffect(() => {
    if (!item) return;
    let live = true;
    Promise.all([getHand(item.handId), fetchHandAnalysis(item.handId)])
      .then(([record, analysis]) => {
        if (!live) return;
        if (!record) {
          setLoaded({ id: item.id, status: "gone" });
          return;
        }
        const decision = analysis?.decisions.find((x) => x.actionIndex === item.actionIndex) ?? null;
        if (!decision || decision.grade === null || decision.chosen === null || decision.options.length === 0) {
          setLoaded({ id: item.id, status: "not-analysed" });
          return;
        }
        setLoaded({ id: item.id, status: "ready", phf: record.phf, playedAt: record.playedAt, decision });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ id: item.id, status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [item]);

  const current = loaded && item && loaded.id === item.id ? loaded : null;
  const spot = current?.status === "ready" ? current : null;
  const answer = answered && item && answered.id === item.id ? answered : null;

  // The chart set the drill's grade names (table and depth, A2c), for its chart grid.
  const drillSet = spot?.decision.source === "chart" ? (spot.decision.facts.chart?.set ?? null) : null;
  useEffect(() => {
    if (!drillSet || charts?.id === drillSet) return;
    let live = true;
    preflopChartSet(drillSet)
      .then((set) => {
        if (live && set) setCharts(set);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [charts, drillSet]);

  const options = useMemo<AnswerOption[]>(
    () =>
      spot
        ? spot.decision.options.map((option) => ({
            label: label(option),
            alias: option.allIn ? "allin" : option.action === "fold" || option.action === "check" || option.action === "call" ? option.action : null,
          }))
        : [],
    [spot, label],
  );
  const aliases = useMemo(() => {
    const out: Partial<Record<"fold" | "check" | "call" | "allin", number>> = {};
    options.forEach((option, index) => {
      if (option.alias && out[option.alias] === undefined) out[option.alias] = index;
    });
    return out;
  }, [options]);

  const pick = useCallback(
    (index: number) => {
      if (!spot || !item || answer) return;
      const decision = spot.decision;
      const result = gradeDrill(
        {
          options: decision.options,
          chosen: decision.chosen ?? 0,
          grade: decision.grade ?? "mistake",
          evLoss: decision.evLoss ?? 0,
          evLossPot: decision.evLossPot ?? 0,
          freqDiff: decision.freqDiff ?? 0,
          score: decision.score ?? 0,
          potBb: decision.facts.potBb,
          source: decision.source,
          approximations: decision.approximations,
        },
        index,
      );
      const shown = asAnswered(decision, index, result);
      setAnswered({ id: item.id, picked: index, shown, review: null, error: null });
      setDone((value) => value + 1);
      onAnswer({ grade: result.grade, evLoss: result.evLoss, evLossPot: result.evLossPot, score: result.score });
      reviewDrill(item.id, index, result.grade, result.evLoss)
        .then((review) => setAnswered((prev) => (prev && prev.id === item.id ? { ...prev, review } : prev)))
        .catch((error: unknown) =>
          setAnswered((prev) =>
            prev && prev.id === item.id ? { ...prev, error: error instanceof Error ? error.message : String(error) } : prev,
          ),
        );
      recordTrainerResults([
        {
          mode: "drill",
          family: decision.street,
          spot: item.spotKey,
          position: decision.facts.position,
          handClass: decision.facts.handClass,
          grade: result.grade,
          evLossBb: result.evLoss,
          evLossPot: result.evLossPot,
          score: result.score,
        },
      ])
        .then(onSaved)
        .catch(() => undefined);
    },
    [spot, item, answer, onAnswer, onSaved],
  );

  const next = useCallback(() => setPosition((value) => value + 1), []);
  const skippable = current !== null && current.status !== "ready";

  useTrainerKeys({
    answering: Boolean(spot) && !answer,
    options: options.length,
    aliases,
    onPick: pick,
    onNext: answer || skippable ? next : null,
    onHelp,
  });

  const shownHand = useMemo(() => {
    if (!spot) return null;
    // The felt stays at the decision after the answer too: the move really
    // made is in words under the verdict, and on the felt it would read as
    // the answer just given.
    return handUpTo(spot.phf, spot.decision.actionIndex);
  }, [spot]);
  const chartNode: ChartNode | null =
    spot?.decision.facts.chart && charts && charts.id === spot.decision.facts.chart.set
      ? (charts.nodes.get(spot.decision.facts.chart.line) ?? null)
      : null;

  if (deck && deck.key === deckKey && deck.status === "not-installed") {
    return (
      <div className="card stats-empty">
        <h3>{d.notInstalledHeading}</h3>
        <p className="muted">
          {d.notInstalledBefore}
          <code>{TRAINING_MIGRATION}</code>
          {d.notInstalledAfter}
        </p>
      </div>
    );
  }
  if (deck && deck.key === deckKey && deck.status === "error") {
    return (
      <div className="notice notice--error">
        <p>{deck.message}</p>
        <button type="button" className="btn btn--sm" onClick={() => setAttempt((value) => value + 1)}>
          {t.retry}
        </button>
      </div>
    );
  }

  const summary = ready?.summary ?? null;
  const when = (iso: string | null) =>
    iso ? d.fromHand(dateFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso))) : d.fromHandUndated;

  return (
    <div className={own.trainer}>
      <p className={own.lede}>{d.intro}</p>

      <div className={own.settings} role="group" aria-label={t.settings.label}>
        <label className={own.check}>
          <input type="checkbox" checked={state.all} disabled={Boolean(state.spots)} onChange={(event) => onChange({ all: event.target.checked })} />
          <span>{d.practiseAll}</span>
        </label>
        <label className={own.check}>
          <input type="checkbox" checked={state.inaccurate} onChange={(event) => onChange({ inaccurate: event.target.checked })} />
          <span>{d.includeInaccurate}</span>
        </label>
        {state.spots ? (
          <p className={own.leakFilter}>
            <span>{d.leak(state.spots.length)}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange({ spots: null })}>
              {d.allDrills}
            </button>
          </p>
        ) : null}
      </div>

      {summary ? (
        <dl className={own.counts}>
          <div>
            <dt>{d.counts.due}</dt>
            <dd>{summary.due}</dd>
          </div>
          <div>
            <dt>{d.counts.dueToday}</dt>
            <dd>{summary.dueToday}</dd>
          </div>
          <div>
            <dt>{d.counts.items}</dt>
            <dd>{summary.items}</dd>
          </div>
          <div>
            <dt>{d.counts.learning}</dt>
            <dd>{summary.learning}</dd>
          </div>
          <div>
            <dt>{d.counts.mature}</dt>
            <dd>{summary.mature}</dd>
          </div>
        </dl>
      ) : null}

      {!ready ? (
        <p className={own.status} role="status">
          {d.syncing}
        </p>
      ) : null}

      {ready && ready.queue.length === 0 ? (
        <div className="card stats-empty">
          <p className="muted">{state.spots ? d.emptyLeak : summary && summary.items > 0 ? d.empty : d.noneYet}</p>
          {summary && summary.items === 0 && !state.spots ? (
            <Link href={paths.analysis()} className="btn btn--primary">
              {d.goToAnalysis}
            </Link>
          ) : null}
        </div>
      ) : null}

      {ready && ready.queue.length > 0 && !item ? (
        <div className="card stats-empty">
          <p>{d.done(done)}</p>
          <button type="button" className="btn btn--primary" onClick={() => setAttempt((value) => value + 1)}>
            {t.result.next}
          </button>
        </div>
      ) : null}

      {item ? (
        <section className={`card ${own.spot}`} aria-labelledby="drill-spot" aria-busy={!current}>
          <h3 id="drill-spot" className={own.spotHead}>
            {t.spotHeading}
            <span className={own.muted}>
              {position + 1} / {ready?.queue.length ?? 0}
            </span>
          </h3>
          {!current ? (
            <p className={own.status} role="status">
              {d.loading}
            </p>
          ) : null}
          {current && current.status !== "ready" ? (
            <div className="notice notice--warn">
              <p>{current.status === "gone" ? d.handGone : current.status === "not-analysed" ? d.notAnalysed : current.message}</p>
              <button type="button" className="btn btn--sm" onClick={next}>
                {d.skip}
              </button>
            </div>
          ) : null}
          {spot && shownHand ? (
            <>
              <div className={own.prompt}>
                <div className={own.hero}>
                  <span className={own.heroLabel}>{t.yourHand}</span>
                  <CardRow cards={spot.decision.facts.holeCards} size="md" />
                </div>
                <div className={own.promptText}>
                  <p>
                    {en.analysis.streets[spot.decision.street]} · {en.analysis.sheet.spotValue(spot.decision.facts)}
                  </p>
                  <p className={own.muted}>
                    {when(spot.playedAt)} · {d.reviews(item.reviews)}
                  </p>
                  <p className={own.question}>{t.question}</p>
                </div>
              </div>
              <div className={own.table}>
                <ReplayViewer
                  key={item.id}
                  hand={shownHand}
                  mode="embed"
                  urlSync={false}
                  initialPosition={lastAction(shownHand)}
                />
              </div>
              <AnswerBar options={options} picked={answer?.picked ?? null} disabled={Boolean(answer)} onPick={pick} />
            </>
          ) : null}
        </section>
      ) : null}

      {spot && answer ? (
        <AnswerResult decision={answer.shown} hand={spot.phf} chartNode={chartNode}>
          <p className={own.muted}>
            {d.youPlayed(
              spot.decision.chosen !== null ? label(spot.decision.options[spot.decision.chosen]) : "—",
              spot.decision.grade ? (en.analysis.grades[spot.decision.grade] ?? spot.decision.grade) : "—",
            )}{" "}
            <Link href={paths.analysisHand(item?.handId ?? "", `t=a${spot.decision.actionIndex}`)}>{d.openHand}</Link>
          </p>
          {answer.review ? (
            <p className={own.schedule}>{answer.review.relearn ? d.backSoon : d.backIn(answer.review.intervalDays)}</p>
          ) : null}
          {answer.error ? <p className="notice notice--error">{answer.error}</p> : null}
        </AnswerResult>
      ) : null}

      {answer ? (
        <div className={own.nextRow}>
          <button type="button" className="btn btn--primary" onClick={next} aria-keyshortcuts="N Enter">
            {t.result.next}
            <kbd className={own.inlineKey} aria-hidden="true">
              N
            </kbd>
          </button>
        </div>
      ) : null}
    </div>
  );
}
