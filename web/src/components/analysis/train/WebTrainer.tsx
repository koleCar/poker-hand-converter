/**
 * The Trainer (`components/trainer`) on the web: its host from Next and
 * Supabase. Deals and grades in the trainer worker (`lib/trainer.ts`), reads
 * "For you" from the leak finder over the account's own analysed hands (one
 * kind of game, `analysisKind.ts`), keeps each graded answer in
 * `trainer_results` (the study plan counts them), keeps the settings in the
 * address and in this browser, and under each answer adds what only the web
 * has: the whole chart or range study and the Learn links.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameKind } from "@rail/ui/hands/gameKind";
import type { ChartNode, ChartSet } from "../../../lib/charts";
import { preflopChartSet } from "../../../lib/chartSet";
import { isDatabaseConfigured } from "../../../lib/db";
import { fetchLeaks } from "../../../lib/db/analysisLeaks";
import { recordTrainerResults } from "../../../lib/db/training";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import { conceptsForDecision } from "../../../lib/learn/links";
import { paths } from "../../../lib/routes";
import { dealFlopSpot, dealPreflopSpot, dealRiverSpot, dealTurnSpot, gradeSpotAnswer } from "../../../lib/trainer";
import type { GradedAnswer, TrainerSpot } from "../../../lib/training";
import { focusAreas } from "../../../lib/training/plan";
import { TrainerHostProvider, type FocusState, type TrainerHost } from "../../trainer/host";
import { settingsFields } from "../../trainer/settings";
import { initialSettings } from "./trainerQuery";
import { Trainer } from "../../trainer/Trainer";
import { useIntlLocale } from "../../stats/format";
import { ChartGrid } from "../ChartGrid";
import { LearnLinks } from "../LearnLinks";
import { RiverStudy } from "../RiverStudy";
import { useAnalysisKind } from "../analysisKind";
import { hasRangeStudy } from "./AnswerResult";
import { trainerResultOf, trainQuery, DEFAULT_TRAIN_STATE } from "./trainState";
import own from "../../trainer/trainer.module.css";

const STORAGE_KEY = "rail.trainer.settings";

function readStored(): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function WebTrainer({ query }: { query: Record<string, string | string[] | undefined> }) {
  const dict = useDict();
  const locale = useIntlLocale();
  const auth = useAuth();
  const signedIn = isDatabaseConfigured && auth.isSignedIn;
  const [initial] = useState(() => initialSettings(query, typeof window === "undefined" ? null : readStored()));

  // One kind of game's leaks: wait for the kind before reading them.
  const kinds = useAnalysisKind(null, signedIn);
  const kindRef = useRef<{ kind: GameKind | null; waiters: Array<(kind: GameKind) => void> }>({ kind: null, waiters: [] });
  useEffect(() => {
    kindRef.current.kind = kinds.kind;
    if (kinds.kind) {
      const kind = kinds.kind;
      kindRef.current.waiters.splice(0).forEach((resolve) => resolve(kind));
    }
  }, [kinds.kind]);

  const focus = useCallback(async (): Promise<FocusState> => {
    if (!signedIn) return { status: "signed-out" };
    const kind = kindRef.current.kind ?? (await new Promise<GameKind>((resolve) => kindRef.current.waiters.push(resolve)));
    const report = await fetchLeaks({ gameKind: kind });
    if (!report) return { status: "signed-out" };
    return { status: "ready", areas: focusAreas(report.rows, report.hands) };
  }, [signedIn]);

  const host = useMemo<TrainerHost>(
    () => ({
      t: dict.trainer,
      locale,
      deal: (request, seed) =>
        request.kind === "preflop"
          ? dealPreflopSpot(request.options, seed)
          : request.kind === "flop"
            ? dealFlopSpot(request.options, seed)
            : request.kind === "turn"
              ? dealTurnSpot(request.options, seed)
              : dealRiverSpot(request.options, seed),
      grade: gradeSpotAnswer,
      focus,
      record: signedIn
        ? (spot, answer, handClass) => {
            const row = trainerResultOf(spot, answer, handClass);
            if (row) recordTrainerResults([row]).catch(() => undefined);
          }
        : undefined,
      onSettings: (settings) => {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsFields(settings)));
        } catch {
          // Private mode: the settings live for the visit only.
        }
        const params = new URLSearchParams(settingsFields(settings));
        const search = params.toString();
        window.history.replaceState(window.history.state, "", `${paths.analysisTrain()}${search ? `?${search}` : ""}`);
      },
      study: (graded, spot) => <WebStudy graded={graded} spot={spot} />,
      extraModes: signedIn ? (
        <Link href={paths.analysisTrain(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "drills" }))} className={own.modeLink}>
          {dict.analysis.train.modes.drills}
        </Link>
      ) : null,
    }),
    [dict, locale, focus, signedIn],
  );

  return (
    <TrainerHostProvider host={host}>
      <Trainer initial={initial} />
    </TrainerHostProvider>
  );
}

/** The web's deeper study of an answer: the whole chart (preflop) or range (postflop), and what to read. */
function WebStudy({ graded, spot }: { graded: GradedAnswer; spot: TrainerSpot }) {
  const decision = graded.decision;
  const [charts, setCharts] = useState<ChartSet | null>(null);
  const set = spot.kind === "preflop" ? spot.set : null;
  useEffect(() => {
    if (!set) return;
    let live = true;
    preflopChartSet(set)
      .then((loaded) => live && loaded && setCharts(loaded))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [set]);
  if (!decision || decision.grade === null) return null;
  const node: ChartNode | null = spot.kind === "preflop" && charts && charts.id === spot.set ? (charts.nodes.get(spot.line) ?? null) : null;
  return (
    <>
      {decision.source === "chart" && node ? (
        <section className={own.block}>
          <ChartGrid key={node.line} node={node} highlight={decision.facts.handClass} />
        </section>
      ) : null}
      {hasRangeStudy(decision, graded.study ?? null) ? (
        <section className={own.block}>
          <RiverStudy
            key={`${graded.hand.meta.handKey}:${decision.actionIndex}`}
            decision={decision}
            hand={graded.hand}
            initialOpen={false}
            street={decision.street === "turn" ? "turn" : decision.street === "flop" ? "flop" : "river"}
            solveTurn={false}
            study={decision.street === "flop" ? (graded.study ?? null) : undefined}
          />
        </section>
      ) : null}
      <LearnLinks concepts={conceptsForDecision(decision)} />
    </>
  );
}
