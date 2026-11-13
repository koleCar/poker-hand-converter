/**
 * A trainer spot in words: who did what before the hero, the pot and the
 * price. Learn's spot exercises print it beside the felt (`SpotItemView`).
 */

"use client";

import { useDict } from "../../../lib/i18n/client";
import type { TrainerSpot } from "../../../lib/training";
import { lineSteps } from "../chartSpots";
import own from "./train.module.css";

/** The spot in words: who did what before the hero, the pot and the price. */
export function SpotWords({ spot }: { spot: TrainerSpot }) {
  const en = useDict();
  const t = en.analysis.train;
  if (spot.kind === "preflop") {
    const label = en.analysis.charts.spotLabel(
      spot.hero,
      lineSteps(spot.line, spot.script.seats).map((step) => ({ position: step.position, verb: en.analysis.charts.verbs[step.verb] ?? step.verb })),
    );
    return (
      <>
        <p>{t.preflopSpot(label)}</p>
        <p className={own.muted}>{t.potLine(spot.potBb, spot.toCallBb, spot.script.stackBb)}</p>
      </>
    );
  }
  return (
    <>
      <p>{t.riverSpot(spot.pot, spot.hero, spot.villain, spot.seat === "ip")}</p>
      <p>
        {spot.facing
          ? spot.facing.kind === "raise" ||
            (spot.kind === "flop" && (spot.script.flop ?? []).some((act) => act.position === spot.hero && act.type === "bet"))
            ? en.course.spot.raised(spot.villain, spot.facing.to)
            : t.riverFacing(spot.villain, spot.facing.kind, spot.facing.to, spot.facing.sizePot)
          : spot.seat === "ip"
            ? t.riverChecked(spot.villain)
            : spot.kind === "turn"
              ? en.course.spot.turnFirst
              : spot.kind === "flop"
                ? en.course.spot.flopFirst
                : t.riverFirst}
      </p>
      <p className={own.muted}>{t.potLine(spot.potBb, spot.toCallBb, spot.stackBb)}</p>
    </>
  );
}
