/**
 * The trainer (`/analysis/train`, `docs/TRAINER.md`).
 *
 * Two views under one sub-nav entry:
 *
 * - **The Trainer** (`components/trainer`, on the web through
 *   `WebTrainer`): a spot on a table, the moves as buttons, the grade, the
 *   strategy for the hand and why; "For you" deals from your own leaks,
 *   Preflop / Flop / Turn / River one street each. The same component is the
 *   desktop app's Trainer screen.
 * - **Your mistakes** (`?mode=drills`): drills of your own Mistakes and
 *   Blunders, scheduled by spaced repetition (A7); "Drill this" on a leak
 *   links here with the leak's spot keys.
 *
 * Signed in, every graded answer is kept (`trainer_results`); the drills
 * are your own hands and need an account. A Pro feature: the Analysis tab's
 * plan gate (`AppFrame`, feature `analysis`) covers this page.
 */

"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { DATABASE_NOT_CONFIGURED_MESSAGE, isDatabaseConfigured } from "../../../lib/db";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { addAnswer, emptySession, type SessionStats, type TrainerAnswer } from "../../../lib/training";
import { AnalysisNav } from "../AnalysisNav";
import { PlanCard } from "../plan/PlanCard";
import an from "../ui/an.module.css";
import { useAnalysisKind } from "../analysisKind";
import { KindField } from "../KindField";
import { DrillTrainer } from "./DrillTrainer";
import { SessionPanel, TrainerHistory } from "./SessionPanel";
import { TrainerKeySheet } from "./TrainerKeySheet";
import { parseTrainState, trainQuery, type TrainState } from "./trainState";
import { WebTrainer } from "./WebTrainer";
import own from "./train.module.css";
import "../../../styles/stats.css";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Whether an address opens the drills of your own mistakes (a leak's "Drill this", the plan's drill task). */
export function isDrillsQuery(query: Record<string, string | string[] | undefined>): boolean {
  return first(query.mode) === "drills" || Boolean(first(query.spots));
}

export function TrainTab({ initialQuery }: { initialQuery: Record<string, string | string[] | undefined> }) {
  const drills = isDrillsQuery(initialQuery);
  return (
    <div className="stats">
      {drills ? (
        <DrillsView key="drills" initialQuery={initialQuery} />
      ) : (
        <>
          <AnalysisNav current="train" />
          <WebTrainer key="trainer" query={initialQuery} />
        </>
      )}
    </div>
  );
}

/** Your mistakes: drills of your own Mistakes and Blunders (A7), with their own session panel. */
function DrillsView({ initialQuery }: { initialQuery: Record<string, string | string[] | undefined> }) {
  const dict = useDict();
  const analysis = dict.analysis;
  const t = analysis.train;
  const auth = useAuth();
  const [state, setState] = useState<TrainState>(() => ({ ...parseTrainState(initialQuery), mode: "drills" }));
  const [session, setSession] = useState<SessionStats>(emptySession);
  const [keysOpen, setKeysOpen] = useState(false);
  const [kept, setKept] = useState(0);

  const updateState = useCallback((patch: Partial<TrainState>) => {
    setState((current) => {
      const next = { ...current, ...patch, mode: "drills" as const };
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", paths.analysisTrain(trainQuery(next)));
      }
      return next;
    });
  }, []);

  const kinds = useAnalysisKind(state.kind, isDatabaseConfigured && auth.isSignedIn);
  const onAnswer = useCallback((answer: TrainerAnswer) => setSession((current) => addAnswer(current, answer)), []);
  const onHelp = useCallback(() => setKeysOpen(true), []);
  const onSaved = useCallback(() => setKept((value) => value + 1), []);

  return (
    <>
      <AnalysisNav current="train">
        <div className={an.tools} role="group" aria-label={dict.trainer.modesLabel}>
          <Link href={paths.analysisTrain()} className={an.chip}>
            {dict.trainer.modes.focus}
          </Link>
          <span className={`${an.chip} ${an.chipOn}`} aria-current="page">
            {t.modes.drills}
          </span>
        </div>
        <button type="button" className={an.chip} aria-haspopup="dialog" aria-keyshortcuts="?" onClick={() => setKeysOpen(true)}>
          {t.keys.button}
        </button>
      </AnalysisNav>

      <div className={own.layout}>
        <div className={`${own.main} rail-fade`}>
          {!isDatabaseConfigured ? (
            <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
          ) : !auth.isSignedIn ? (
            <div className="card stats-empty">
              <p className="muted">{t.result.signInToKeep}</p>
              <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
                {analysis.tab.signIn}
              </button>
            </div>
          ) : (
            <>
              <KindField kinds={kinds} onChange={(kind) => updateState({ kind })} />
              <DrillTrainer
                key="drills"
                state={state}
                kind={kinds.kind}
                onChange={updateState}
                onAnswer={onAnswer}
                onHelp={onHelp}
                onSaved={onSaved}
              />
            </>
          )}
        </div>
        <aside className={own.side}>
          <SessionPanel stats={session} onReset={() => setSession(emptySession())} />
          {isDatabaseConfigured && auth.isSignedIn ? <PlanCard generation={kept} /> : null}
          {isDatabaseConfigured && auth.isSignedIn ? <TrainerHistory refresh={kept} /> : null}
        </aside>
      </div>

      <TrainerKeySheet open={keysOpen} onClose={() => setKeysOpen(false)} />
    </>
  );
}
