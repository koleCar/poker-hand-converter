/**
 * The Cash | Tournaments switch as an Analysis filter field: the shared
 * `KindSwitch` under the shared label. Every Analysis screen that reads hands
 * shows it (`analysisKind.ts`).
 */

"use client";

import type { GameKind } from "@rail/ui/hands/gameKind";
import { KindSwitch } from "@rail/ui/hands/KindSwitch";
import { useUiStrings } from "@rail/ui/i18n";
import type { AnalysisKind } from "./analysisKind";

export function KindField({ kinds, onChange }: { kinds: AnalysisKind; onChange: (kind: GameKind) => void }) {
  const t = useUiStrings().hands.kinds;
  return (
    <div className="field">
      <span className="field__label">{t.label}</span>
      <KindSwitch kind={kinds.kind} counts={kinds.counts} onChange={onChange} />
    </div>
  );
}
