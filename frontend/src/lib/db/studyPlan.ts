/**
 * The database side of the study plan (phase A8b,
 * `20270215090000_analysis_study_plan.sql`).
 *
 * The browser builds a week's plan (`lib/training/plan.ts`) and writes it with
 * `save_study_plan`; `study_plan` reads it back with each task's progress —
 * trainer answers and drill reviews inside the week are counted by the
 * database, so playing the trainer ticks the box; concepts and hands are
 * ticked by hand (`set_study_task`).
 */

import { parseFocus, rpcTask, type FocusArea, type PlanKind, type PlanTask, type TaskKind } from "../training/plan";
import { currentUserId, rpc } from "./client";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
const TASK_KINDS: readonly TaskKind[] = ["read", "train", "drill", "review", "lesson"];

export interface StoredTask {
  id: string;
  ord: number;
  focus: number | null;
  kind: TaskKind;
  ref: string;
  target: number;
  handId: string | null;
  matchMode: string | null;
  matchFamily: string | null;
  matchPosition: string | null;
  matchSpots: string[] | null;
  spotKeys: string[] | null;
  /** Trainer answers or drills counted inside the week (uncapped). */
  counted: number;
  /** Towards the target: the count, capped, or the whole target once ticked. */
  progress: number;
  doneAt: string | null;
  done: boolean;
}

export interface StoredPlan {
  id: string;
  weekStart: string;
  /** The window progress is counted in, ISO. */
  from: string;
  to: string;
  kind: PlanKind;
  analysisVersion: string;
  focus: FocusArea[];
  baseline: PlanBaseline;
  createdAt: string;
  updatedAt: string;
  tasks: StoredTask[];
}

/** What the plan was built from: the sample behind its numbers. */
export interface PlanBaseline {
  hands: number;
  graded: number;
  /** The last graded hand in the sample, ISO. */
  last: string | null;
  evLossBb: number;
  /** Why a fundamentals plan (`planFocus`'s reason). */
  reason: string | null;
}

function baselineOf(value: unknown): PlanBaseline {
  const b = (value && typeof value === "object" ? value : {}) as Row;
  return {
    hands: num(b.hands),
    graded: num(b.graded),
    last: str(b.last),
    evLossBb: num(b.evLossBb),
    reason: str(b.reason),
  };
}

function taskOf(row: Row): StoredTask | null {
  const kind = row.kind as TaskKind;
  if (!TASK_KINDS.includes(kind)) return null;
  return {
    id: String(row.id ?? ""),
    ord: num(row.ord),
    focus: row.focus === null || row.focus === undefined ? null : num(row.focus),
    kind,
    ref: String(row.ref ?? ""),
    target: Math.max(1, num(row.target)),
    handId: str(row.handId),
    matchMode: str(row.matchMode),
    matchFamily: str(row.matchFamily),
    matchPosition: str(row.matchPosition),
    matchSpots: strings(row.matchSpots),
    spotKeys: strings(row.spotKeys),
    counted: num(row.counted),
    progress: num(row.progress),
    doneAt: str(row.doneAt),
    done: row.done === true,
  };
}

/** A week's plan with its progress; null when the week has none (or nobody is signed in). */
export async function fetchStudyPlan(weekStart: string, from: string): Promise<StoredPlan | null> {
  if (!(await currentUserId())) return null;
  const payload = await rpc<Row | null>("study_plan", { p_week_start: weekStart, p_from: from });
  if (!payload) return null;
  return {
    id: String(payload.id ?? ""),
    weekStart: String(payload.weekStart ?? weekStart),
    from: String(payload.from ?? from),
    to: String(payload.to ?? ""),
    kind: payload.kind === "fundamentals" ? "fundamentals" : "leaks",
    analysisVersion: String(payload.analysisVersion ?? ""),
    focus: parseFocus(payload.focus),
    baseline: baselineOf(payload.baseline),
    createdAt: String(payload.createdAt ?? ""),
    updatedAt: String(payload.updatedAt ?? ""),
    tasks: (Array.isArray(payload.tasks) ? (payload.tasks as Row[]) : [])
      .map(taskOf)
      .filter((task): task is StoredTask => task !== null),
  };
}

export interface SavePlanInput {
  weekStart: string;
  kind: PlanKind;
  analysisVersion: string;
  focus: readonly FocusArea[];
  baseline: PlanBaseline;
  tasks: readonly PlanTask[];
}

export interface SavedPlan {
  id: string;
  created: boolean;
  kept: number;
  removed: number;
}

/** Writes (or rebuilds) the week's plan. Tasks kept by (kind, ref) keep their ticks. */
export async function saveStudyPlan(input: SavePlanInput): Promise<SavedPlan> {
  const payload = await rpc<Row | null>("save_study_plan", {
    p_week_start: input.weekStart,
    p_kind: input.kind,
    p_analysis_version: input.analysisVersion,
    p_focus: input.focus,
    p_baseline: input.baseline,
    p_tasks: input.tasks.map(rpcTask),
  });
  return {
    id: String(payload?.id ?? ""),
    created: payload?.created === true,
    kept: num(payload?.kept),
    removed: num(payload?.removed),
  };
}

/** Ticks or unticks one task. */
export async function setStudyTask(id: string, done: boolean): Promise<string | null> {
  const payload = await rpc<Row | null>("set_study_task", { p_task: id, p_done: done });
  return str(payload?.doneAt);
}
