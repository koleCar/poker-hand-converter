/**
 * The limp counters of the per-villain limp study (analysis/21 candidates,
 * `docs/ANALYSIS-PLAN.md` §10 2026-10-11): what each seat did with its first
 * preflop decision in an unraised pot, by position group, and what a limper
 * did when a raise came behind. Not statistics counters the app keeps -
 * counted here, from the hands, for the study only (`limp.mjs`).
 *
 *   lo_opp_G / lo_G   first in, nobody in yet (an open limp), position group G
 *                     (EP: UTG..UTG+2, MP: MP/LJ/HJ, LP: CO/BTN, SB): chances / limps
 *   ol_opp / ol       first decision behind a limper, no raise, not the small
 *                     blind: chances / limps
 *   lr_opp            limped (open or over, not the small blind), then faced a raise
 *   lf / lc / lr      ...and folded / called / re-raised
 *
 * The big blind and a straddler never limp (they can check); a bomb pot counts
 * nothing.
 */

import type { Position } from "../../../frontend/src/lib/phf/types.js";
import type { StatsContext } from "../../../frontend/src/lib/stats/context.js";

export type LimpGroup = "EP" | "MP" | "LP" | "SB";

export function limpGroup(position: Position | null | undefined): LimpGroup | null {
  switch (position) {
    case "UTG":
    case "UTG+1":
    case "UTG+2":
      return "EP";
    case "MP":
    case "LJ":
    case "HJ":
      return "MP";
    case "CO":
    case "BTN":
      return "LP";
    case "SB":
      return "SB";
    default:
      return null;
  }
}

/** Every seat's limp counters in one hand (only non-zero keys). */
export function limpCounters(context: StatsContext): Map<number, Record<string, number>> {
  const out = new Map<number, Record<string, number>>();
  if (context.isBombPot) return out;
  const preflop = context.byStreet.get("preflop") ?? [];
  const bump = (seat: number, key: string) => {
    const c = out.get(seat) ?? {};
    c[key] = (c[key] ?? 0) + 1;
    out.set(seat, c);
  };
  for (const seat of context.dealtInSeats) {
    if (seat === context.bigBlindSeat || context.straddleSeats.has(seat)) continue;
    const mine = preflop.filter((d) => d.seat === seat);
    const first = mine[0];
    if (!first || first.raisesBefore !== 0 || first.type === "check") continue;
    const group = limpGroup(context.position.get(seat));
    if (!group) continue;
    const limped = first.type === "call";
    if (first.enteredBefore.length === 0) {
      bump(seat, `lo_opp_${group}`);
      if (limped) bump(seat, `lo_${group}`);
    } else {
      if (group === "SB") continue;
      bump(seat, "ol_opp");
      if (limped) bump(seat, "ol");
    }
    if (!limped || group === "SB") continue;
    const next = mine[1];
    if (!next || next.raisesBefore === 0) continue;
    bump(seat, "lr_opp");
    if (next.type === "fold") bump(seat, "lf");
    else if (next.type === "call") bump(seat, "lc");
    else if (next.type === "raise") bump(seat, "lr");
  }
  return out;
}
