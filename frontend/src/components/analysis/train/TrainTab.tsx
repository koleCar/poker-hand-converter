/**
 * The trainer (`/analysis/train`, `docs/ANALYSIS-PLAN.md` §7, phase A7).
 *
 * Three trainers under one sub-nav entry:
 *
 * - **Preflop**: a chart node by family and seat, a hand dealt into it (as
 *   the range holds it, or tilted toward the close decisions), graded from
 *   the charts exactly as the analysis grades a real hand;
 * - **River**: a heads-up river from a chart line, a board and common flop
 *   and turn lines, solved on demand, the hero dealt a combo from their range
 *   at the node, graded by the solve;
 * - **Your mistakes**: drills of your own Mistakes and Blunders, scheduled by
 *   spaced repetition.
 *
 * The mode and settings live in the address (`trainState.ts`), so "Drill
 * this" on a leak is a link. The session score is per trainer and per page
 * visit; signed in, every graded answer is also kept (`trainer_results`).
 * Preflop and river work signed out (the charts are public); drills are your
 * own hands and need an account.
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
import { DrillTrainer } from "./DrillTrainer";
import { SessionPanel, TrainerHistory } from "./SessionPanel";
import { SpotTrainer } from "./SpotTrainer";
import { TrainerKeySheet } from "./TrainerKeySheet";
import { TRAIN_MODES, parseTrainState, trainQuery, type TrainMode, type TrainState } from "./trainState";
import own from "./train.module.css";
import "../../../styles/stats.css";

export function TrainTab({ initialQuery }: { initialQuery: Record<string, string | string[] | undefined> }) {
  const analysis = useDict().analysis;
  const t = analysis.train;
  const auth = useAuth();
  const [state, setState] = useState<TrainState>(() => parseTrainState(initialQuery));
  const [sessions, setSessions] = useState<Record<TrainMode, SessionStats>>(() => ({
    preflop: emptySession(),
    river: emptySession(),
    drills: emptySession(),
  }));
  const [keysOpen, setKeysOpen] = useState(false);
  const [kept, setKept] = useState(0);
  const signedIn = isDatabaseConfigured && auth.isSignedIn;

  const updateState = useCallback((patch: Partial<TrainState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", paths.analysisTrain(trainQuery(next)));
      }
      return next;
    });
  }, []);

  const mode = state.mode;
  const onAnswer = useCallback(
    (answer: TrainerAnswer) => {
      setSessions((current) => ({ ...current, [mode]: addAnswer(current[mode], answer) }));
    },
    [mode],
  );
  const onHelp = useCallback(() => setKeysOpen(true), []);
  const onSaved = useCallback(() => setKept((value) => value + 1), []);

  return (
    <div className="stats">
      <header className="stats__head">
        <h2>{t.heading}</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-haspopup="dialog"
          aria-keyshortcuts="?"
          onClick={() => setKeysOpen(true)}
        >
          {t.keys.button}
        </button>
      </header>
      <AnalysisNav current="train" />
      <p className={own.lede}>{t.intro}</p>

      <nav className={own.modes} aria-label={t.modesLabel}>
        <ul>
          {TRAIN_MODES.map((id) => (
            <li key={id}>
              <Link
                href={paths.analysisTrain(trainQuery({ ...state, mode: id, spots: id === "drills" ? state.spots : null }))}
                className={own.modeLink}
                aria-current={mode === id ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  updateState({ mode: id, spots: id === "drills" ? state.spots : null });
                }}
              >
                {t.modes[id]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className={own.layout}>
        <div className={own.main}>
          {mode === "drills" ? (
            !isDatabaseConfigured ? (
              <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
            ) : !auth.isSignedIn ? (
              <div className="card stats-empty">
                <p className="muted">{t.result.signInToKeep}</p>
                <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
                  {analysis.tab.signIn}
                </button>
              </div>
            ) : (
              <DrillTrainer key="drills" state={state} onChange={updateState} onAnswer={onAnswer} onHelp={onHelp} onSaved={onSaved} />
            )
          ) : (
            <SpotTrainer
              key={mode}
              mode={mode}
              state={state}
              onChange={updateState}
              onAnswer={onAnswer}
              signedIn={signedIn}
              onHelp={onHelp}
              onSaved={onSaved}
            />
          )}
        </div>
        <aside className={own.side}>
          <SessionPanel stats={sessions[mode]} onReset={() => setSessions((current) => ({ ...current, [mode]: emptySession() }))} />
          {signedIn ? <TrainerHistory refresh={kept} /> : null}
        </aside>
      </div>

      <TrainerKeySheet open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
