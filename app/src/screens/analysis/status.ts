/**
 * The background analysis' status in words (R5.4): what `AnalysisStatus`
 * shows. Pure, so the tests read it in both languages.
 */
import type { Dict } from "../../i18n/types";
import type { RunnerStatus } from "../../analysis/runner";

export interface StatusLine {
  text: string;
  /** Said in the warning tone (offline, an error). */
  warn: boolean;
}

export function describeStatus(status: RunnerStatus, s: Dict["analysis"]["status"], pace: (perSecond: number) => string): StatusLine[] {
  const lines: StatusLine[] = [];
  const counts = status.counts;
  const total = counts?.hands ?? 0;
  const done = counts?.current ?? 0;
  if (status.phase === "waiting" && status.reason) {
    lines.push({ text: s.waiting[status.reason], warn: false });
  } else if (status.phase === "starting" || !counts) {
    lines.push({ text: s.starting, warn: false });
  } else if (total === 0) {
    lines.push({ text: s.empty, warn: false });
  } else if (status.phase === "idle" || counts.missing === 0) {
    lines.push({ text: s.idle(total), warn: false });
  } else {
    lines.push({ text: s.running(done, total), warn: false });
    if (status.phase === "running" && status.handsPerSecond !== null) {
      lines.push({ text: s.pace(pace(status.handsPerSecond)), warn: false });
    }
  }
  if (counts && counts.notAnalysable > 0) lines.push({ text: s.notAnalysable(counts.notAnalysable), warn: false });
  if (!status.library) lines.push({ text: s.offline, warn: true });
  if (status.phase === "error" && status.lastError) lines.push({ text: s.error(status.lastError), warn: true });
  return lines;
}
