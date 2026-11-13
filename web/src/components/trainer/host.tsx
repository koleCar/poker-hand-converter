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
import type { FocusArea } from "../../lib/training/plan";
import type { SpotRequest, TrainerSettings } from "./settings";

export type TrainerDict = Dict["trainer"];

/** The player's leaks, as the leak finder groups them: what "For you" deals from. */
export type FocusState =
  | { status: "loading" }
  /** No account (or no database): nothing to read. */
  | { status: "signed-out" }
  | { status: "ready"; areas: FocusArea[] }
  | { status: "error"; message: string };

export interface TrainerHost {
  t: TrainerDict;
  /** The reader's locale for numbers (`en-GB`, `hr-HR`). */
  locale: string;
  /** Deal a spot (the trainer worker); null when no spot matches. */
  deal(request: SpotRequest, seed: number): Promise<TrainerSpot | null>;
  /** Grade an answer with the analysis itself (the trainer worker). */
  grade(spot: TrainerSpot, menuIndex: number): Promise<GradedAnswer>;
  /** The player's leaks. Asked once when "For you" opens. */
  focus(): Promise<FocusState>;
  /** A graded answer, to keep (the web's `trainer_results`); absent: kept nowhere. */
  record?(spot: TrainerSpot, answer: TrainerAnswer, handClass: string | null): void;
  /** The settings changed: keep them (the address, local storage). */
  onSettings?(settings: TrainerSettings): void;
  /**
   * More of the answer's study under the feedback: the web's whole chart or
   * range study and its Learn links. Absent: none.
   */
  study?(graded: GradedAnswer, spot: TrainerSpot): ReactNode;
  /** What sits beside the modes (the web's link to the drills of your own mistakes). */
  extraModes?: ReactNode;
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
