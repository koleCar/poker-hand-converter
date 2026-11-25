/**
 * What the Trainer needs from the page it lives in. The web's
 * `/analysis/train` provides it from Next and Supabase
 * (`components/analysis/train/WebTrainer.tsx`: the dictionary, the trainer
 * worker, the leak finder over the account's rows, `trainer_results`); the
 * desktop app provides its own (`app/src/trainer/host.ts`: its language, its
 * own trainer worker, the local store's leak rows). Nothing under
 * `components/trainer` reaches Next, the web's i18n or Supabase itself, so
 * the app renders these components in place, as it does the Solver library.
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Dict } from "../../lib/i18n/types";
import type { GradedAnswer, TrainerAnswer, TrainerSpot } from "../../lib/training";
import type { PlayOptions, PlayStep } from "../../lib/training/play";
import type { RangeView } from "../../lib/training/rangeView";
import type { FocusArea } from "../../lib/training/plan";
import type { SpotRequest } from "./settings";
import type { SessionStore } from "./sessions";
import type { PlayedHand } from "./played";

export type TrainerDict = Dict["trainer"];

/** The player's leaks, as the leak finder groups them: what "For you" deals from. */
export type FocusState =
  | { status: "loading" }
  /** No account (or no database): nothing to read. */
  | { status: "signed-out" }
  | { status: "ready"; areas: FocusArea[] }
  | { status: "error"; message: string };

/** One answer, kept on the device (the app's history, T4). */
export interface KeptAnswer {
  /** ISO time. */
  at: string;
  street: string;
  /** The hero's cards. */
  cards: string[];
  /** The answer as its button read. */
  label: string;
  grade: string;
  evLoss: number;
}

export interface TrainerHost {
  t: TrainerDict;
  /** The reader's locale for numbers (`en-GB`, `hr-HR`). */
  locale: string;
  /** Deal a spot (the trainer worker); null when no spot matches. */
  deal(request: SpotRequest, seed: number): Promise<TrainerSpot | null>;
  /** Grade an answer with the analysis itself (the trainer worker). */
  grade(spot: TrainerSpot, menuIndex: number): Promise<GradedAnswer>;
  /**
   * A whole hand (T2): a new one played on to the hero's first decision, an
   * answer graded, an answer played on to the next decision or the end. All
   * three or none: without them the Trainer offers one spot only.
   */
  playStart?(options: PlayOptions, seed: number): Promise<PlayStep | null>;
  playGrade?(step: PlayStep, menuIndex: number): Promise<GradedAnswer>;
  playAnswer?(step: PlayStep, menuIndex: number): Promise<PlayStep | null>;
  /** The hero's range at a spot's decision (the range panel, T3), and at a whole hand's. Absent: no panel. */
  range?(spot: TrainerSpot): Promise<RangeView | null>;
  playRange?(step: PlayStep): Promise<RangeView | null>;
  /** Every graded answer, spot or whole hand, for a history kept on the device (the app's). */
  kept?(answer: KeptAnswer): void;
  /** The player's leaks. Asked once when "For you" opens. */
  focus(): Promise<FocusState>;
  /** A graded answer, to keep (the web's `trainer_results`); absent: kept nowhere. */
  record?(spot: TrainerSpot, answer: TrainerAnswer, handClass: string | null): void;
  /** Where training sessions are kept: the account (the web), this device (the app). */
  sessions: SessionStore;
  /** The session to open first (the address's `session`); absent: the list. */
  initialSession?: string | null;
  /** The open session changed (null: the list): keep it in the address. */
  onSession?(id: string | null): void;
  /**
   * More of the answer's study under the feedback: the web's whole chart or
   * range study and its Learn links. Absent: none. `spot` is null for a
   * whole hand's decision (no dealt chart spot: the range study only).
   */
  study?(graded: GradedAnswer, spot: TrainerSpot | null): ReactNode;
  /** More in the side column under the session's figures (the web's study plan card). */
  aside?: ReactNode;
  /** What sits beside the modes (the web's link to the drills of your own mistakes). */
  extraModes?: ReactNode;
  /**
   * A played hand and its analysed decisions, for "Play it ▸" from Analytics
   * (`played.ts`): the web's `get_hand` and `analysis_hand`, the desktop's
   * store. Null when the hand is not there. Absent: "Play it" deals the drill.
   */
  played?(handId: string): Promise<PlayedHand | null>;
  /** The address of a stat's drill-down in Analytics (the bar's way back). Absent: no link. */
  analyticsHref?(stat: string): string;
  /**
   * "Look up in Solver" after an answer (#420): the host's Solver opened at
   * the spot (the app's Solver tab). Resolves false when the Solver has no
   * spot for it. The table is kept as it was (`parked.ts`), so going back to
   * the session continues there. Absent: no button.
   */
  solver?(spot: TrainerSpot): Promise<boolean>;
}

const HostContext = createContext<TrainerHost | null>(null);

export function TrainerHostProvider({ host, children }: { host: TrainerHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useTrainerHost(): TrainerHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("the Trainer needs a TrainerHostProvider");
  return host;
}
