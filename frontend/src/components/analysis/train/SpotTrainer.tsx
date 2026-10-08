/**
 * The preflop trainer and the river spot trainer: deal a spot, show it on the
 * felt, take an answer, grade it with the analysis, show why, deal the next.
 *
 * Dealing and grading run in the trainer's worker (`lib/trainer.ts`): a river
 * spot solves a river, and a river answer solves it again inside
 * `analyzeHand`. Every state change waits on a promise, never on an effect's
 * own body: the request key (`mode | settings | round`) says which deal an
 * answer belongs to, so a slow deal for old settings cannot overwrite a new one.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CHART_SETS, DEFAULT_CHART_SET, type ChartNode, type ChartSet } from "../../../lib/charts";
import { preflopChartSet } from "../../../lib/chartSet";
import { recordTrainerResults } from "../../../lib/db/training";
import { useDict } from "../../../lib/i18n/client";
import { dealPreflopSpot, dealRiverSpot, gradeSpotAnswer } from "../../../lib/trainer";
import {
  DEAL_BIASES,
  PREFLOP_FAMILIES,
  ALL_PREFLOP_SEATS,
  PREFLOP_SEATS,
  RIVER_POTS,
  RIVER_ROLES,
  RIVER_SEATS,
  handUpTo,
  nextSeed,
  type GradedAnswer,
  type TrainerAnswer,
  type TrainerSpot,
} from "../../../lib/training";
import { CardRow } from "../../replayer/PlayingCard";
import { ReplayViewer } from "../../replayer/ReplayViewer";
import { lineSteps } from "../chartSpots";
import { AnswerBar, type AnswerOption } from "./AnswerBar";
import { AnswerResult } from "./AnswerResult";
import { useTrainerKeys } from "./trainerKeys";
import { lastAction } from "./spotPosition";
import type { TrainState } from "./trainState";
import own from "./train.module.css";

/** Seeds tried before saying no spot matches. */
const DEAL_TRIES = 3;

type Dealt = { key: string; seed: number; spot: TrainerSpot | null; error: string | null };
type Answered = { key: string; picked: number; graded: GradedAnswer | null; error: string | null; saved: boolean };

interface SpotTrainerProps {
  mode: "preflop" | "river";
  state: TrainState;
  onChange: (patch: Partial<TrainState>) => void;
  /** A graded answer, for the session score. */
  onAnswer: (answer: TrainerAnswer) => void;
  signedIn: boolean;
  onHelp: () => void;
  /** An answer was kept in the trainer history. */
  onSaved: () => void;
}

export function SpotTrainer({ mode, state, onChange, onAnswer, signedIn, onHelp, onSaved }: SpotTrainerProps) {
  const en = useDict();
  const t = en.analysis.train;
  const [round, setRound] = useState(0);
  const [dealt, setDealt] = useState<Dealt | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [charts, setCharts] = useState<ChartSet | null>(null);

  const settings =
    mode === "preflop"
      ? { set: state.set, family: state.family, seat: state.seat, vs: state.vs, bias: state.deal }
      : { pot: state.pot, seat: state.side, role: state.role, bias: state.deal };
  const settingsKey = JSON.stringify(settings);
  const requestKey = `${mode}|${settingsKey}|${round}`;

  // Deal for the current settings and round.
  useEffect(() => {
    let live = true;
    const options = JSON.parse(settingsKey);
    (async () => {
      let lastSeed = 0;
      for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
        const seed = nextSeed();
        lastSeed = seed;
        const spot = mode === "preflop" ? await dealPreflopSpot(options, seed) : await dealRiverSpot(options, seed);
        if (spot) return { seed, spot };
      }
      return { seed: lastSeed, spot: null };
    })()
      .then(({ seed, spot }) => {
        if (live) setDealt({ key: requestKey, seed, spot, error: null });
      })
      .catch((error: unknown) => {
        if (live) setDealt({ key: requestKey, seed: 0, spot: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [mode, settingsKey, requestKey]);

  // The spot's chart set on the main thread, for the preflop chart grid.
  const spotSet = dealt?.spot?.kind === "preflop" ? dealt.spot.set : null;
  useEffect(() => {
    if (mode !== "preflop" || !spotSet || charts?.id === spotSet) return;
    let live = true;
    preflopChartSet(spotSet)
      .then((set) => {
        if (live && set) setCharts(set);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mode, charts, spotSet]);

  const current = dealt?.key === requestKey ? dealt : null;
  const spot = current?.spot ?? null;
  const answer = answered?.key === requestKey ? answered : null;
  const dealing = current === null;

  const options = useMemo<AnswerOption[]>(() => {
    if (!spot) return [];
    if (spot.kind === "preflop") {
      return spot.menu.map((item) => ({
        label: en.analysis.charts.action(item.action, item.toBb),
        alias: item.action === "raise" ? null : item.action,
      }));
    }
    return spot.menu.map((item) => {
      const action = item.kind === "allin" ? (spot.toCallBb > 0 ? "raise" : "bet") : item.kind;
      const sized = item.kind === "bet" || item.kind === "raise" || item.kind === "allin";
      return {
        label: en.analysis.sheet.option(action, sized ? item.to : undefined, item.kind === "allin", item.kind === "bet" ? item.sizePot : undefined),
        alias: item.kind === "fold" || item.kind === "check" || item.kind === "call" || item.kind === "allin" ? item.kind : null,
      };
    });
  }, [spot, en]);

  const pick = useCallback(
    (index: number) => {
      if (!spot || answer) return;
      const key = requestKey;
      setAnswered({ key, picked: index, graded: null, error: null, saved: false });
      gradeSpotAnswer(spot, index)
        .then((graded) => {
          setAnswered((prev) => (prev && prev.key === key ? { ...prev, graded } : prev));
          const d = graded.decision;
          if (!d || d.grade === null) return;
          const result: TrainerAnswer = {
            grade: d.grade,
            evLoss: d.evLoss ?? 0,
            evLossPot: d.evLossPot ?? 0,
            score: d.score ?? 0,
          };
          onAnswer(result);
          if (!signedIn) return;
          recordTrainerResults([
            {
              mode,
              family: spot.kind === "preflop" ? spot.family : spot.pot,
              spot: spot.kind === "preflop" ? spot.line : spot.lineId,
              position: spot.hero,
              handClass: d.facts.handClass,
              grade: d.grade,
              evLossBb: result.evLoss,
              evLossPot: result.evLossPot,
              score: result.score,
            },
          ])
            .then(() => {
              setAnswered((prev) => (prev && prev.key === key ? { ...prev, saved: true } : prev));
              onSaved();
            })
            .catch(() => undefined);
        })
        .catch((error: unknown) => {
          setAnswered((prev) =>
            prev && prev.key === key ? { ...prev, error: error instanceof Error ? error.message : String(error) } : prev,
          );
        });
    },
    [spot, answer, requestKey, onAnswer, signedIn, mode, onSaved],
  );

  const graded = answer?.graded ?? null;
  const next = useCallback(() => setRound((value) => value + 1), []);
  const aliases = useMemo(() => {
    const out: Partial<Record<"fold" | "check" | "call" | "allin", number>> = {};
    options.forEach((option, index) => {
      if (option.alias && out[option.alias] === undefined) out[option.alias] = index;
    });
    return out;
  }, [options]);

  useTrainerKeys({
    answering: Boolean(spot) && !answer,
    options: options.length,
    aliases,
    onPick: pick,
    onNext: answer && (graded || answer.error) ? next : null,
    onHelp,
  });

  const shownHand = useMemo(() => {
    if (graded) return handUpTo(graded.hand, graded.actionIndex + 1);
    return spot?.hand ?? null;
  }, [graded, spot]);

  const chartNode: ChartNode | null =
    spot?.kind === "preflop" && charts && charts.id === spot.set ? (charts.nodes.get(spot.line) ?? null) : null;

  return (
    <div className={own.trainer}>
      <Settings mode={mode} state={state} onChange={onChange} />

      {current?.error ? (
        <div className="notice notice--error">
          <p>{t.failed(current.error)}</p>
          <button type="button" className="btn btn--sm" onClick={next}>
            {t.retry}
          </button>
        </div>
      ) : null}
      {current && !current.error && !spot ? <p className="notice notice--warn">{t.noSpot}</p> : null}

      <section className={`card ${own.spot}`} aria-labelledby="train-spot" aria-busy={dealing}>
        <h3 id="train-spot" className={own.spotHead}>
          {t.spotHeading}
        </h3>
        {dealing ? (
          <p className={own.status} role="status">
            {mode === "river" ? t.solving : t.dealing}
          </p>
        ) : null}
        {spot && shownHand ? (
          <>
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
              <ReplayViewer
                key={`${current?.seed ?? 0}:${graded ? "after" : "before"}`}
                hand={shownHand}
                mode="embed"
                urlSync={false}
                initialPosition={lastAction(shownHand)}
              />
            </div>
            <AnswerBar options={options} picked={answer?.picked ?? null} disabled={Boolean(answer)} onPick={pick} />
            {spot.kind === "river" ? (
              <p className={own.note}>
                {t.rangesNote}
                {spot.sources.hero === "placeholder" || spot.sources.villain === "placeholder" ? ` ${t.placeholderNote}` : ""}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {answer && !graded && !answer.error ? (
        <p className={own.status} role="status">
          {t.grading}
        </p>
      ) : null}
      {answer?.error ? <p className="notice notice--error">{t.failed(answer.error)}</p> : null}

      {graded?.decision ? (
        <AnswerResult decision={graded.decision} hand={graded.hand} chartNode={chartNode} solveTurn={false}>
          <p className={own.muted}>{signedIn ? (answer?.saved ? t.result.saved : null) : t.result.signInToKeep}</p>
        </AnswerResult>
      ) : null}

      {answer && (graded || answer.error) ? (
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

/** The spot in words: who did what before the hero, the pot and the price. */
export function SpotWords({ spot }: { spot: TrainerSpot }) {
  const en = useDict();
  const t = en.analysis.train;
  if (spot.kind === "preflop") {
    const label = en.analysis.charts.spotLabel(
      spot.hero,
      lineSteps(spot.line, spot.script.seats).map((step) => ({ position: step.position, verb: en.analysis.charts.verbs[step.verb] ?? step.verb })),
    );
    return (
      <>
        <p>{t.preflopSpot(label)}</p>
        <p className={own.muted}>{t.potLine(spot.potBb, spot.toCallBb, spot.script.stackBb)}</p>
      </>
    );
  }
  return (
    <>
      <p>{t.riverSpot(spot.pot, spot.hero, spot.villain, spot.seat === "ip")}</p>
      <p>
        {spot.facing
          ? spot.facing.kind === "raise" ||
            (spot.kind === "flop" && (spot.script.flop ?? []).some((act) => act.position === spot.hero && act.type === "bet"))
            ? en.course.spot.raised(spot.villain, spot.facing.to)
            : t.riverFacing(spot.villain, spot.facing.kind, spot.facing.to, spot.facing.sizePot)
          : spot.seat === "ip"
            ? t.riverChecked(spot.villain)
            : spot.kind === "turn"
              ? en.course.spot.turnFirst
              : spot.kind === "flop"
                ? en.course.spot.flopFirst
                : t.riverFirst}
      </p>
      <p className={own.muted}>{t.potLine(spot.potBb, spot.toCallBb, spot.stackBb)}</p>
    </>
  );
}

function Settings({
  mode,
  state,
  onChange,
}: {
  mode: "preflop" | "river";
  state: TrainState;
  onChange: (patch: Partial<TrainState>) => void;
}) {
  const t = useDict().analysis.train.settings;
  // The chosen set's seats (A2c: 6-max or 9-max); the river trainer is 6-max 100bb.
  const spec = CHART_SETS.find((s) => s.id === state.set) ?? CHART_SETS.find((s) => s.id === DEFAULT_CHART_SET);
  const seats = spec?.players === 9 ? ALL_PREFLOP_SEATS : PREFLOP_SEATS;
  return (
    <div className={own.settings} role="group" aria-label={t.label}>
      <label className="field">
        <span className="field__label">{t.table}</span>
        {mode === "preflop" ? (
          <select
            value={state.set}
            onChange={(event) => {
              const set = event.target.value;
              const next = CHART_SETS.find((s) => s.id === set);
              const nine = next?.players === 9;
              // A seat the new table lacks is dropped.
              const keep = (seat: TrainState["seat"]) =>
                seat && (nine ? ALL_PREFLOP_SEATS : PREFLOP_SEATS).includes(seat) ? seat : null;
              onChange({ set, seat: keep(state.seat), vs: keep(state.vs) });
            }}
          >
            {CHART_SETS.map((s) => (
              <option key={s.id} value={s.id}>
                {t.tableValue(s.players, s.stackBb)}
              </option>
            ))}
          </select>
        ) : (
          <select value={DEFAULT_CHART_SET} onChange={() => undefined}>
            <option value={DEFAULT_CHART_SET}>{t.tableValue(6, 100)}</option>
          </select>
        )}
      </label>
      {mode === "preflop" ? (
        <>
          <label className="field">
            <span className="field__label">{t.family}</span>
            <select
              value={state.family}
              onChange={(event) => {
                const family = event.target.value as TrainState["family"];
                // Nobody has raised before a first-in decision: no raiser to face.
                onChange(family === "rfi" ? { family, vs: null } : { family });
              }}
            >
              {(["random", ...PREFLOP_FAMILIES] as const).map((family) => (
                <option key={family} value={family}>
                  {t.families[family]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t.seat}</span>
            <select
              value={state.seat ?? ""}
              onChange={(event) => onChange({ seat: (event.target.value || null) as TrainState["seat"] })}
            >
              <option value="">{t.anySeat}</option>
              {seats.map((seat) => (
                <option key={seat} value={seat}>
                  {seat}
                </option>
              ))}
            </select>
          </label>
          {state.family !== "rfi" ? (
            <label className="field">
              <span className="field__label">{t.vs}</span>
              <select
                value={state.vs ?? ""}
                onChange={(event) => onChange({ vs: (event.target.value || null) as TrainState["vs"] })}
              >
                <option value="">{t.anyRaiser}</option>
                {seats.map((seat) => (
                  <option key={seat} value={seat}>
                    {seat}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ) : (
        <>
          <label className="field">
            <span className="field__label">{t.pot}</span>
            <select value={state.pot} onChange={(event) => onChange({ pot: event.target.value as TrainState["pot"] })}>
              {(["any", ...RIVER_POTS] as const).map((pot) => (
                <option key={pot} value={pot}>
                  {t.pots[pot]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t.side}</span>
            <select value={state.side} onChange={(event) => onChange({ side: event.target.value as TrainState["side"] })}>
              {(["any", ...RIVER_SEATS] as const).map((side) => (
                <option key={side} value={side}>
                  {t.sides[side]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t.role}</span>
            <select value={state.role} onChange={(event) => onChange({ role: event.target.value as TrainState["role"] })}>
              {(["any", ...RIVER_ROLES] as const).map((role) => (
                <option key={role} value={role}>
                  {t.roles[role]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="field">
        <span className="field__label">{t.deal}</span>
        <select value={state.deal} onChange={(event) => onChange({ deal: event.target.value as TrainState["deal"] })}>
          {DEAL_BIASES.map((deal) => (
            <option key={deal} value={deal}>
              {t.deals[deal]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
