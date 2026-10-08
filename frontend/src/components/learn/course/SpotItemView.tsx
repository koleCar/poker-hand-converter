/**
 * One trainer spot inside a lesson or a review card (Learn L1): a preflop
 * spot from Rail's charts, or a river or turn spot solved on demand, dealt
 * from a seed and graded by the analysis itself (`lib/trainer.ts`, the A7
 * trainer's worker). The same felt, answer buttons and result as
 * `/analysis/train`; a lesson counts an answer the reference plays (Perfect
 * or Good) as right.
 *
 * Signed in, a preflop or river answer is also kept in the trainer history
 * (`trainer_results`), so lesson practice counts towards the study plan's
 * trainer tasks like any other.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChartNode, ChartSet } from "../../../lib/charts";
import { preflopChartSet } from "../../../lib/chartSet";
import { recordTrainerResults } from "../../../lib/db/training";
import { useDict } from "../../../lib/i18n/client";
import { dealFlopSpot, dealPreflopSpot, dealRiverSpot, dealTurnSpot, gradeSpotAnswer } from "../../../lib/trainer";
import { handUpTo, type GradedAnswer, type PreflopSpotOptions, type RiverSpotOptions, type TrainerSpot, type TurnSpotOptions } from "../../../lib/training";
import type { CardItem } from "../../../lib/learn/progress";
import { CardRow } from "../../replayer/PlayingCard";
import { ReplayViewer } from "../../replayer/ReplayViewer";
import { AnswerBar, type AnswerOption } from "../../analysis/train/AnswerBar";
import { AnswerResult } from "../../analysis/train/AnswerResult";
import { SpotWords } from "../../analysis/train/SpotTrainer";
import { lastAction } from "../../analysis/train/spotPosition";
import own from "../../analysis/train/train.module.css";
import { useFormats } from "../controls";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

/** Seeds tried after the item's own before saying no spot matches; the same on every replay, so a card deals the same spot. */
const DEAL_TRIES = 3;

export type SpotItem = Extract<CardItem, { k: "chart" | "river" | "turn" | "flop" }>;

async function deal(item: SpotItem): Promise<TrainerSpot | null> {
  for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
    const seed = (item.seed + attempt * 0x9e3779b1) >>> 0;
    let spot: TrainerSpot | null;
    if (item.k === "flop") {
      spot = await dealFlopSpot(
        { pot: item.pot, seat: item.seat, role: item.role, facing: item.facing, line: item.line, bias: item.bias },
        seed,
      );
    } else if (item.k === "chart") {
      const options: PreflopSpotOptions = { family: item.family, set: item.set ?? null, seat: item.seat ?? null, vs: item.vs ?? null, bias: item.bias };
      spot = await dealPreflopSpot(options, seed);
    } else {
      const options: RiverSpotOptions & TurnSpotOptions = { pot: item.pot, seat: item.seat, role: item.role, bias: item.bias, facing: item.facing };
      spot = item.k === "turn" ? await dealTurnSpot(options, seed) : await dealRiverSpot(options, seed);
    }
    if (spot) return spot;
  }
  return null;
}

type Dealt = { spot: TrainerSpot | null; error: string | null };
type Answered = { picked: number; graded: GradedAnswer | null; error: string | null };

export function SpotItemView({ item, signedIn, onAnswer }: { item: SpotItem; signedIn: boolean; onAnswer: (answer: ItemAnswer | null) => void }) {
  const en = useDict();
  const t = en.analysis.train;
  const c = en.course.exercise;
  const f = useFormats();
  const [attempt, setAttempt] = useState(0);
  const [dealt, setDealt] = useState<Dealt | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [charts, setCharts] = useState<ChartSet | null>(null);
  const itemKey = JSON.stringify(item);

  useEffect(() => {
    let live = true;
    deal(JSON.parse(itemKey) as SpotItem)
      .then((spot) => {
        if (live) setDealt({ spot, error: null });
      })
      .catch((error: unknown) => {
        if (live) setDealt({ spot: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [itemKey, attempt]);

  const spot = dealt?.spot ?? null;
  const spotSet = spot?.kind === "preflop" ? spot.set : null;
  useEffect(() => {
    if (!spotSet || charts?.id === spotSet) return;
    let live = true;
    preflopChartSet(spotSet)
      .then((set) => {
        if (live && set) setCharts(set);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [charts, spotSet]);

  const options = useMemo<AnswerOption[]>(() => {
    if (!spot) return [];
    if (spot.kind === "preflop") {
      return spot.menu.map((m) => ({ label: en.analysis.charts.action(m.action, m.toBb), alias: m.action === "raise" ? null : m.action }));
    }
    return spot.menu.map((m) => {
      const action = m.kind === "allin" ? (spot.toCallBb > 0 ? "raise" : "bet") : m.kind;
      const sized = m.kind === "bet" || m.kind === "raise" || m.kind === "allin";
      return {
        label: en.analysis.sheet.option(action, sized ? m.to : undefined, m.kind === "allin", m.kind === "bet" ? m.sizePot : undefined),
        alias: m.kind === "fold" || m.kind === "check" || m.kind === "call" || m.kind === "allin" ? m.kind : null,
      };
    });
  }, [spot, en]);

  const pick = useCallback(
    (index: number) => {
      if (!spot || answered) return;
      setAnswered({ picked: index, graded: null, error: null });
      gradeSpotAnswer(spot, index)
        .then((graded) => {
          setAnswered((prev) => (prev ? { ...prev, graded } : prev));
          const d = graded.decision;
          if (!d || d.grade === null) {
            onAnswer(null);
            return;
          }
          onAnswer({ correct: d.grade === "perfect" || d.grade === "good", grade: d.grade });
          // The trainer history keeps preflop and river answers (its modes); turn and flop spots are Learn's own.
          if (!signedIn || spot.kind === "turn" || spot.kind === "flop") return;
          recordTrainerResults([
            {
              mode: spot.kind,
              family: spot.kind === "preflop" ? spot.family : spot.pot,
              spot: spot.kind === "preflop" ? spot.line : spot.lineId,
              position: spot.hero,
              handClass: d.facts.handClass,
              grade: d.grade,
              evLossBb: d.evLoss ?? 0,
              evLossPot: d.evLossPot ?? 0,
              score: d.score ?? 0,
            },
          ]).catch(() => undefined);
        })
        .catch((error: unknown) => {
          setAnswered((prev) => (prev ? { ...prev, error: error instanceof Error ? error.message : String(error) } : prev));
          onAnswer(null);
        });
    },
    [spot, answered, onAnswer, signedIn],
  );

  const graded = answered?.graded ?? null;
  const shownHand = useMemo(() => (graded ? handUpTo(graded.hand, graded.actionIndex + 1) : (spot?.hand ?? null)), [graded, spot]);
  const chartNode: ChartNode | null =
    spot?.kind === "preflop" && charts && charts.id === spot.set ? (charts.nodes.get(spot.line) ?? null) : null;

  if (dealt?.error) {
    return (
      <div className="notice notice--error">
        <p>{c.failed(dealt.error)}</p>
        <button type="button" className="btn btn--sm" onClick={() => setAttempt((value) => value + 1)}>
          {c.retry}
        </button>
      </div>
    );
  }
  if (!dealt) {
    return (
      <p className={styles.muted} role="status">
        {item.k === "chart" ? c.generating : c.solving}
      </p>
    );
  }
  if (!spot || !shownHand) {
    return <p className="notice notice--warn">{c.noSpot}</p>;
  }

  return (
    <div className={styles.item}>
      <div className={own.prompt}>
        <div className={own.hero}>
          <span className={own.heroLabel}>{t.yourHand}</span>
          <CardRow cards={spot.cards} size="md" />
        </div>
        <div className={own.promptText}>
          <SpotWords spot={spot} />
          <p className={own.question}>{t.question}</p>
        </div>
      </div>
      <div className={own.table}>
        <ReplayViewer key={`${spot.seed}:${graded ? "after" : "before"}`} hand={shownHand} mode="embed" urlSync={false} initialPosition={lastAction(shownHand)} />
      </div>
      <AnswerBar options={options} picked={answered?.picked ?? null} disabled={Boolean(answered)} onPick={pick} />
      {spot.kind !== "preflop" ? (
        <p className={own.note}>
          {spot.kind === "turn"
            ? `${en.course.spot.turnNote} ${en.course.spot.turnRanges}`
            : spot.kind === "flop"
              ? en.course.spot.flopNote(en.course.spot.lineName(spot.lineId), f.num(spot.iterations, 0), f.num(spot.exploitabilityPct, 2))
              : t.rangesNote}
          {spot.sources.hero === "placeholder" || spot.sources.villain === "placeholder" ? ` ${t.placeholderNote}` : ""}
        </p>
      ) : null}
      {answered && !graded && !answered.error ? (
        <p className={styles.muted} role="status">
          {c.grading}
        </p>
      ) : null}
      {answered?.error ? <p className="notice notice--error">{c.failed(answered.error)}</p> : null}
      {graded?.decision ? <AnswerResult decision={graded.decision} hand={graded.hand} chartNode={chartNode} solveTurn={false} /> : null}
    </div>
  );
}
