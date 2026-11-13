/**
 * The Trainer screen: the web's Trainer (`/analysis/train`) in the app - a
 * spot on a table, the moves as buttons, the grade, the strategy for the
 * hand and why; "For you" deals the spots of your own biggest leaks from
 * this computer's analysed hands. A Pro feature (`ROUTE_FEATURE`), and a
 * screen that helps with play: hidden while a poker table is open (A10).
 */
import { useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import { useT } from "../i18n";
import { useAppKind } from "../lib/gameKind";
import { Trainer as WebTrainer, TrainerHostProvider } from "../trainer/door";
import { storedSettings, useAppTrainerHost } from "../trainer/host";

export function Trainer() {
  const t = useT();
  const [initial] = useState(storedSettings);
  const kinds = useAppKind(null, true);
  const host = useAppTrainerHost(kinds.kind);
  // "For you" reads one kind of game's leaks: wait for the kind (a moment, once).
  if (kinds.kind === null) return <RailLoader size="page" centered label={t.analysis.loading} />;
  return (
    <TrainerHostProvider host={host}>
      <WebTrainer initial={initial} />
    </TrainerHostProvider>
  );
}
