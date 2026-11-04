/**
 * The background analysis' status (R5.4): what `AnalysisStatus` shows - a
 * progress bar while hands are being analysed (how many are left of how
 * many, and about how long the rest takes), and a short line otherwise (why
 * it waits, that every hand is done). Pure, so the tests read it in both
 * languages.
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
  /** Hands analysed at the current version. */
  done: number;
  /** Hands still to analyse. */
  left: number;
  /** Every hand the analysis covers (done + left). */
  total: number;
  /** 0-1, for the bar. */
  share: number;
  /** Whole minutes the rest should take at the last page's pace; null before the first page. */
  minutes: number | null;
}

/** The bar, while hands are being analysed (running, or about to); null otherwise. */
export function progressOf(status: RunnerStatus): StatusProgress | null {
  const counts = status.counts;
  if (!counts || counts.hands === 0 || counts.missing === 0) return null;
  if (status.phase === "waiting" || status.phase === "starting" || status.phase === "idle") return null;
  const done = counts.current;
  const left = counts.missing;
  const total = done + left;
  const pace = status.handsPerSecond;
  return {
    done,
    left,
    total,
    share: total > 0 ? done / total : 0,
    minutes: pace !== null && pace > 0 ? Math.round(left / pace / 60) : null,
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
