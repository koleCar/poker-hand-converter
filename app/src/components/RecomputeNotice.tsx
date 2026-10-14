/**
 * A recompute's progress (R2.11, `stats_status`): after an upgrade changes
 * how a statistic, a segment or the all-in EV is worked out, the background
 * pass computes the new numbers beside the ones the screens show and swaps
 * them in, whole, when it is done (the screens then read again:
 * `stats-changed`). Reports, Hands, Players and Settings show it in their
 * usual notice line. A store that had no statistics yet fills as the job
 * goes; a screen passes its own words for that (`filling`).
 */
import { useEffect, useState } from "react";

import { useT } from "../i18n";
import { inApp, ipc, type StatsStatus } from "../lib/ipc";

/** A recompute is running (or waiting for open tables or an import). */
export function recomputing(status: StatsStatus | null): boolean {
  return status !== null && (status.rebuildTotal !== null || status.evRecomputeTotal !== null);
}

/** The pass's status, read again every few seconds while a recompute runs. */
export function useRecompute(): StatsStatus | null {
  const [status, setStatus] = useState<StatsStatus | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      ipc
        .statsStatus()
        .then((value) => {
          if (stopped) return;
          setStatus(value);
          if (recomputing(value)) timer = window.setTimeout(poll, 3000);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

export function RecomputeNotice({
  status,
  filling,
  className,
}: {
  status: StatsStatus | null;
  /** This screen's words while a store without statistics fills. */
  filling?: (done: number, total: number) => string;
  className: string;
}) {
  const t = useT();
  if (status === null || !recomputing(status)) return null;
  const r = t.recompute;
  const parts: string[] = [];
  if (status.rebuildTotal !== null) {
    const done = status.rebuildDone ?? 0;
    if (status.rebuildFills) {
      parts.push((filling ?? r.filling)(done, status.rebuildTotal));
    } else if (status.rebuildJob === "segments") {
      parts.push(r.segments(done, status.rebuildTotal));
    } else {
      parts.push(r.rows(done, status.rebuildTotal));
    }
  }
  if (status.evRecomputeTotal !== null) {
    parts.push(r.ev(status.evRecomputeDone ?? 0, status.evRecomputeTotal));
  }
  if (status.activity === "paused-tables") parts.push(r.pausedTables);
  if (status.activity === "paused-backfill") parts.push(r.pausedImport);
  return (
    <p className={className} role="status">
      {parts.join(" ")}
    </p>
  );
}
