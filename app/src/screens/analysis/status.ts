/**
 * The background analysis' status (R5.4): what `AnalysisStatus` shows - a
 * progress bar while hands are being analysed, and a short line otherwise
 * (why it waits, that every hand is done). Since 2026-11-18 the bar is the
 * month under way (which hands, how many are left of its hands, about how
 * long they take), with every month's state a click away and the whole
 * store's count beside them. Pure, so the tests read it in both languages.
 */
import type { Dict } from "../../i18n/types";
import type { RunnerStatus } from "../../analysis/runner";

export interface StatusLine {
  text: string;
  /** Said in the warning tone (offline, an error). */
  warn: boolean;
}

/** The run under way: the bar's numbers. */
export interface StatusProgress {
  /** The month under way (`YYYY-MM`, '' for hands without a date); null: no months known, the bar is every hand. */
  month: string | null;
  /** Of the month (else of every hand): analysed at the current version. */
  done: number;
  /** Of the month (else of every hand): still to analyse. */
  left: number;
  /** Of the month (else of every hand): done + left. */
  total: number;
  /** 0-1, for the bar. */
  share: number;
  /** Whole minutes the month's (else every hand's) rest should take at the last page's pace; null before the first page. */
  minutes: number | null;
  /** Every hand: still to analyse, of how many, about how long. */
  all: { left: number; total: number; minutes: number | null };
}

/** One month in the list under the bar. */
export interface MonthState {
  month: string;
  hands: number;
  left: number;
  /** done: every hand analysed; now: under way (or sent to the front); waiting: its turn comes. */
  state: "done" | "now" | "waiting";
}

function minutesFor(left: number, pace: number | null): number | null {
  return pace !== null && pace > 0 ? Math.round(left / pace / 60) : null;
}

/**
 * The month the run is in: the one sent to the front while it has hands
 * left, else the last page's month while it has, else the next one with
 * hands left in the walk's order (older, then the newest again).
 */
export function monthUnderWay(status: RunnerStatus): string | null {
  const months = status.months;
  if (!months || months.length === 0) return null;
  const hasLeft = (month: string | null) => month !== null && months.some((m) => m.month === month && m.hands > m.current);
  if (hasLeft(status.focus)) return status.focus;
  if (hasLeft(status.month)) return status.month;
  const at = status.month === null ? -1 : months.findIndex((m) => m.month === status.month);
  const older = months.slice(at + 1).find((m) => m.hands > m.current);
  return (older ?? months.find((m) => m.hands > m.current))?.month ?? null;
}

/** Every month, newest first, with its state; empty without months. */
export function monthsOf(status: RunnerStatus): MonthState[] {
  const now = monthUnderWay(status);
  return (status.months ?? []).map((m) => {
    const left = Math.max(0, m.hands - m.current);
    const state: MonthState["state"] =
      left === 0 ? "done" : m.month === now ? "now" : "waiting";
    return { month: m.month, hands: m.hands, left, state };
  });
}

/** The bar, while hands are being analysed (running, or about to); null otherwise. */
export function progressOf(status: RunnerStatus): StatusProgress | null {
  const counts = status.counts;
  if (!counts || counts.hands === 0 || counts.missing === 0) return null;
  if (status.phase === "waiting" || status.phase === "starting" || status.phase === "idle") return null;
  const pace = status.handsPerSecond;
  const all = { left: counts.missing, total: counts.current + counts.missing, minutes: minutesFor(counts.missing, pace) };
  const month = monthUnderWay(status);
  const row = month === null ? undefined : status.months?.find((m) => m.month === month);
  const done = row ? row.current : counts.current;
  const total = row ? row.hands : all.total;
  const left = Math.max(0, total - done);
  return {
    month: row ? row.month : null,
    done,
    left,
    total,
    share: total > 0 ? done / total : 0,
    minutes: minutesFor(left, pace),
    all,
  };
}

/** The words beside (or instead of) the bar. */
export function describeStatus(status: RunnerStatus, s: Dict["analysis"]["status"]): StatusLine[] {
  const lines: StatusLine[] = [];
  const counts = status.counts;
  const total = counts?.hands ?? 0;
  if (status.phase === "waiting" && status.reason) {
    lines.push({ text: s.waiting[status.reason], warn: false });
  } else if (status.phase === "starting" || !counts) {
    lines.push({ text: s.starting, warn: false });
  } else if (total === 0) {
    lines.push({ text: s.empty, warn: false });
  } else if (status.phase === "idle" || counts.missing === 0) {
    lines.push({ text: s.idle(counts.current), warn: false });
  }
  if (!status.library) lines.push({ text: s.offline, warn: true });
  if (status.phase === "error" && status.lastError) lines.push({ text: s.error(status.lastError), warn: true });
  return lines;
}
