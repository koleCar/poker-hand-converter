/**
 * A running solve's progress in words, wherever it shows (the tree's row,
 * the sidebar's card): the share and the time left once the engine has a
 * pace, the iteration and the exploitability reached before that, and
 * "Starting" until the first iteration.
 */
import type { Dict } from "../../i18n";
import type { RunningSolve } from "./session";

export function progressLine(t: Dict["nodelock"], running: RunningSolve): string {
  const progress = running.progress;
  if (!progress) return t.starting;
  if (running.share !== null) return t.progress(running.share, progress.etaMs === null ? null : progress.etaMs / 1000);
  return t.iterations(progress.iteration, progress.exploitabilityPct);
}
