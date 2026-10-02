/**
 * Hand analysis rows in the shape `save_hand_analysis` takes them, and back.
 *
 * Split out of `analysis.ts` for the same reason `statsRows.ts` is split out of
 * `stats.ts`: that module holds the browser client, and the analysis Web Worker
 * (`workers/analysis.worker.ts`) must be able to import this one without it.
 * Everything here is pure — `lib/analysis` for the derivation, and the mapping
 * between its records and the wire.
 *
 * The aggregates on a hand row (`decisions`, `analysed`, `flag_count`,
 * `worst_flag`) are deliberately **not** sent. The server computes them from
 * the decisions in the same call, so a stored hand row and its decision rows
 * cannot disagree, whatever a client sends.
 */

import {
  ANALYSIS_VERSION,
  analyzeHand,
  type DecisionAnalysis,
  type HandAnalysis,
  type SpotFacts,
} from "../analysis";
import type { ChartSet } from "../charts";
import type { PhfHand } from "../phf/types";

/** One decision as `save_hand_analysis` takes it. */
export interface DecisionAnalysisInsert {
  ord: number;
  action_index: number;
  street: DecisionAnalysis["street"];
  action: DecisionAnalysis["action"];
  status: DecisionAnalysis["status"];
  reason: string | null;
  node: string;
  scenario: string;
  source: DecisionAnalysis["source"];
  grade: string | null;
  score: number | null;
  ev_loss_bb: number | null;
  ev_loss_pot: number | null;
  freq_diff: number | null;
  options: DecisionAnalysis["options"];
  chosen: number | null;
  flags: DecisionAnalysis["flags"];
  approximations: string[];
  facing_bet: boolean;
  pot_bb: number;
  pot_odds: number | null;
  mdf: number | null;
  facts: SpotFacts;
}

/** One hand as `save_hand_analysis` takes it. */
export interface HandAnalysisInsert {
  /** `hands.id` — the server checks it belongs to the caller. */
  hand_id: string;
  analysis_version: string;
  status: HandAnalysis["status"];
  reason: string | null;
  hero_seat: number | null;
  grade: string | null;
  score: number | null;
  ev_loss_bb: number | null;
  ev_loss_pot: number | null;
  approximations: string[];
  pot_type: string;
  decisions: DecisionAnalysisInsert[];
}

const MAX_SCORE = 100;

function clampScore(score: number | null): number | null {
  return score === null ? null : Math.max(0, Math.min(MAX_SCORE, Math.round(score * 100) / 100));
}

export function decisionRow(decision: DecisionAnalysis): DecisionAnalysisInsert {
  return {
    ord: decision.order,
    action_index: decision.actionIndex,
    street: decision.street,
    action: decision.action,
    status: decision.status,
    reason: decision.reason,
    node: decision.node.slice(0, 200),
    scenario: decision.facts.scenario,
    source: decision.source,
    grade: decision.grade,
    score: clampScore(decision.score),
    ev_loss_bb: decision.evLoss,
    ev_loss_pot: decision.evLossPot,
    freq_diff: decision.freqDiff,
    options: decision.options,
    chosen: decision.chosen,
    flags: decision.flags,
    approximations: decision.approximations,
    facing_bet: decision.facts.potOdds !== null,
    pot_bb: decision.facts.potBb,
    pot_odds: decision.facts.potOdds,
    mdf: decision.facts.mdf,
    facts: decision.facts,
  };
}

/** A whole hand's analysis, in the writer's shape. */
export function handAnalysisRow(handId: string, analysis: HandAnalysis): HandAnalysisInsert {
  return {
    hand_id: handId,
    analysis_version: analysis.version,
    status: analysis.status,
    reason: analysis.reason,
    hero_seat: analysis.heroSeat,
    grade: analysis.grade,
    score: clampScore(analysis.score),
    ev_loss_bb: analysis.evLoss,
    ev_loss_pot: analysis.evLossPot,
    approximations: analysis.approximations,
    pot_type: analysis.potType,
    decisions: analysis.decisions.map(decisionRow),
  };
}

export interface AnalysedBatch {
  rows: HandAnalysisInsert[];
  /** Hand ids the engine threw on. A converter bug, never the reader's. */
  failed: string[];
}

/**
 * Analyses a page of stored hands. Never throws: a hand the engine cannot read
 * is reported in `failed` and stays "missing", so the next run tries it again
 * after the fix ships.
 *
 * `charts` is required, not optional: a row stored without them would grade
 * nothing preflop under a version that promises preflop grades. The caller
 * loads them once (`loadDefaultCharts()`), not once per page.
 */
export function analyseStoredHands(
  page: ReadonlyArray<{ id: string; phf: PhfHand }>,
  charts: ChartSet,
): AnalysedBatch {
  const rows: HandAnalysisInsert[] = [];
  const failed: string[] = [];
  for (const { id, phf } of page) {
    try {
      rows.push(handAnalysisRow(id, analyzeHand(phf, { charts })));
    } catch {
      failed.push(id);
    }
  }
  return { rows, failed };
}

/* ---------------------------------------------------------- the way back - */

type Row = Record<string, unknown>;

const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/** A stored decision (`analysis_hand` → `decisions[]`) as the engine's own record. */
export function decisionFromStored(row: Row): DecisionAnalysis {
  const facts = (row.facts ?? {}) as SpotFacts;
  return {
    order: Number(row.ord ?? 0),
    actionIndex: Number(row.actionIndex ?? 0),
    street: row.street as DecisionAnalysis["street"],
    action: row.action as DecisionAnalysis["action"],
    status: row.status === "not-analysed" ? "not-analysed" : "analysed",
    reason: (row.reason ?? null) as DecisionAnalysis["reason"],
    node: String(row.node ?? ""),
    options: Array.isArray(row.options) ? (row.options as DecisionAnalysis["options"]) : [],
    chosen: numOrNull(row.chosen),
    evLoss: numOrNull(row.evLossBb),
    evLossPot: numOrNull(row.evLossPot),
    freqDiff: numOrNull(row.freqDiff),
    grade: (row.grade ?? null) as DecisionAnalysis["grade"],
    score: numOrNull(row.score),
    source: (row.source ?? "heuristic") as DecisionAnalysis["source"],
    approximations: (Array.isArray(row.approximations) ? row.approximations : []) as DecisionAnalysis["approximations"],
    facts,
    flags: Array.isArray(row.flags) ? (row.flags as DecisionAnalysis["flags"]) : [],
    worstFlag: (row.worstFlag ?? null) as DecisionAnalysis["worstFlag"],
  };
}

/** A stored hand analysis (`analysis_hand`) as the engine's own record. */
export function handAnalysisFromStored(row: Row): HandAnalysis {
  const decisions = Array.isArray(row.decisions) ? (row.decisions as Row[]).map(decisionFromStored) : [];
  return {
    version: (row.analysisVersion ?? ANALYSIS_VERSION) as HandAnalysis["version"],
    status: (row.status ?? "not-analysed") as HandAnalysis["status"],
    reason: (row.reason ?? null) as HandAnalysis["reason"],
    heroSeat: numOrNull(row.heroSeat),
    potType: String(row.potType ?? ""),
    grade: (row.grade ?? null) as HandAnalysis["grade"],
    score: numOrNull(row.score),
    evLoss: numOrNull(row.evLossBb),
    evLossPot: numOrNull(row.evLossPot),
    decisions,
    approximations: (Array.isArray(row.approximations) ? row.approximations : []) as HandAnalysis["approximations"],
    flagCount: Number(row.flagCount ?? 0),
    worstFlag: (row.worstFlag ?? null) as HandAnalysis["worstFlag"],
  };
}
