/**
 * The app's recent trainer answers (T4), under the session's figures: the
 * last ten, kept on this computer (`host.ts`), each with its grade and the
 * EV it lost, in a section that folds; a new answer slides in at the top.
 * The web keeps its answers in the account instead (`trainer_results`, the
 * study plan counts them).
 */
import { useEffect, useState } from "react";

import { useLocale } from "../i18n";
import { Fold, RecentAnswers, trainerEn, trainerHr, type KeptAnswer } from "./door";
import { onHistory, readHistory } from "./host";

export function TrainerHistory() {
  const locale = useLocale();
  const t = locale === "hr" ? trainerHr : trainerEn;
  const [rows, setRows] = useState<KeptAnswer[]>(() => readHistory());
  useEffect(() => onHistory(() => setRows(readHistory())), []);
  return (
    <Fold id="recent" label={t.history.heading} defaultOpen>
      <RecentAnswers rows={rows} empty={t.history.none} evLost={t.evLost} noLoss={t.noLoss} />
    </Fold>
  );
}
