/**
 * The interactive example on a concept page: the one client island in an
 * otherwise server-rendered page. The catalogue (`lib/learn/concepts.ts`)
 * names the widget and the numbers it opens on.
 */

"use client";

import type { WidgetPreset } from "../../lib/learn/concepts";
import type { RangeId } from "../../lib/learn/presets";
import { BetMath } from "./BetMath";
import { BoardExplorer, ComboCounter, EquityDemo, RangeVsRange } from "./CardWidgets";
import { BluffCatcher, GradeExplorer, SprCalculator, ValueBet } from "./SimpleCalcs";

export function ConceptWidget({ preset }: { preset: WidgetPreset }) {
  const { pot = 10, bet = 5, stack = 100, share = 0.5 } = preset;
  switch (preset.id) {
    case "bet-math": {
      const focus = preset.focus === "mdf" || preset.focus === "polar" || preset.focus === "alpha" || preset.focus === "steal" ? preset.focus : "pot-odds";
      return <BetMath focus={focus} pot={pot} bet={bet} share={share} />;
    }
    case "spr":
      return <SprCalculator pot={pot} stack={stack} />;
    case "board-texture":
      return <BoardExplorer board={preset.board ?? []} focus={preset.focus === "dynamism" ? "dynamism" : "texture"} />;
    case "equity":
      return (
        <EquityDemo
          hand={preset.hand ?? ["Ah", "Kh"]}
          preset={(preset.preset ?? "open-btn") as RangeId}
          focus={preset.focus === "realisation" ? "realisation" : "range"}
          realisation={preset.share ?? 1}
        />
      );
    case "range-vs-range":
      return <RangeVsRange preset={preset.preset ?? "btn-vs-bb"} board={preset.board ?? []} focus={preset.focus === "nuts" ? "nuts" : "range"} />;
    case "combos":
      return <ComboCounter hand={preset.hand ?? ["As", "5s"]} preset={preset.preset ?? "premium"} />;
    case "grading":
      return <GradeExplorer />;
    case "bluff-catcher":
      return <BluffCatcher pot={pot} bet={bet} share={share} />;
    case "value-bet":
      return <ValueBet pot={pot} bet={bet} share={share} />;
    default:
      return null;
  }
}
