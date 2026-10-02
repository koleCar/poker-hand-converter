/**
 * A hand's analysis on somebody else's screen (A7.1, `docs/ANALYSIS-PLAN.md`
 * §6.1): grade pips on the replayer rail and the Analysis sheet, read-only,
 * on a published hand, a forum thread or poll, and a share link — only when
 * the hand's owner shared it, which the database decides
 * (`read_shared_analysis`).
 *
 * The sheet starts closed. A stranger opened the page to see the hand, and
 * the pips already say where the mistakes are; the analysis is one press away
 * and never in the way of the replay.
 *
 * The analysis is only drawn when its decisions land on the hero's actions of
 * the copy being shown (`analysisFitsHand`); otherwise the page shows the
 * hand alone.
 */

"use client";

import { useMemo, useState } from "react";
import { analysisFitsHand } from "../../lib/analysis/share";
import type { HandAnalysis } from "../../lib/analysis/types";
import { handAnalysisFromStored } from "../../lib/db/analysisRows";
import { useDict } from "../../lib/i18n/client";
import type { PhfHand } from "../../lib/phf/types";
import type { ReplayPosition } from "../replayer/position";
import { ReplayViewer, type ReplayMark, type ReplaySheet } from "../replayer/ReplayViewer";
import { AnalysisSheet, markWord } from "./AnalysisSheet";
import { toneOf } from "./tone";

/** The sheet's button glyph. Decoration; the button is named in words. */
export const ANALYSIS_SHEET_ICON = "◎";

type Strings = ReturnType<typeof useDict>["analysis"];

/** One rail pip per hero decision, coloured by its grade (or loudest flag), named in words. */
export function gradeMarks(analysis: HandAnalysis, t: Strings): ReplayMark[] {
  return analysis.decisions.map((decision) => {
    const street = t.streets[decision.street] ?? decision.street;
    const action = t.actions[decision.action] ?? decision.action;
    const tone = toneOf(decision);
    return {
      position: { kind: "action", actionIndex: decision.actionIndex },
      count: 1,
      label: `${street} ${action}`,
      tone: tone === "skipped" ? "neutral" : tone,
      ariaLabel: t.sheet.mark(street, action, markWord(decision, t)),
    };
  });
}

/** A stored row as the database projected it, or an analysis already mapped, as a `HandAnalysis`. */
export function asHandAnalysis(value: HandAnalysis | Record<string, unknown> | null | undefined): HandAnalysis | null {
  if (!value) return null;
  return "version" in value && Array.isArray(value.decisions) && "evLoss" in value
    ? (value as HandAnalysis)
    : handAnalysisFromStored(value as Record<string, unknown>);
}

/**
 * The pips and the read-only sheet for a shared analysis on `hand`, or null
 * when there is nothing to show (none shared, or it does not fit the copy).
 */
export function useSharedAnalysis(
  value: HandAnalysis | Record<string, unknown> | null | undefined,
  hand: PhfHand | null,
): { marks: ReplayMark[]; sheet: ReplaySheet } | null {
  const t = useDict().analysis;
  const [open, setOpen] = useState(false);
  const analysis = useMemo(() => {
    const mapped = asHandAnalysis(value);
    return mapped && hand && mapped.decisions.length > 0 && analysisFitsHand(mapped, hand) ? mapped : null;
  }, [value, hand]);
  return useMemo<{ marks: ReplayMark[]; sheet: ReplaySheet } | null>(() => {
    if (!analysis || !hand) return null;
    return {
      marks: gradeMarks(analysis, t),
      sheet: {
        label: t.sheet.title,
        buttonTitle: t.sheet.toggleTitle,
        icon: ANALYSIS_SHEET_ICON,
        open,
        onOpenChange: setOpen,
        render: ({ frame, seek }) => (
          <AnalysisSheet analysis={analysis} frame={frame} seek={seek} fresh={false} hand={hand} readOnly />
        ),
      },
    };
  }, [analysis, hand, t, open]);
}

/** The replayer of a public page, with the shared analysis when there is one. */
export function SharedAnalysisReplay({
  hand,
  site,
  initialPosition,
  analysis,
}: {
  hand: PhfHand;
  site?: string | null;
  initialPosition?: ReplayPosition | null;
  analysis: Record<string, unknown> | null;
}) {
  const shared = useSharedAnalysis(analysis, hand);
  return (
    <ReplayViewer
      hand={hand}
      site={site}
      initialPosition={initialPosition}
      marks={shared?.marks}
      sheet={shared?.sheet}
    />
  );
}
