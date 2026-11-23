/**
 * The Analytics tabs' shared states (docs/ANALYTICS.md Step 12; board
 * AN-States): one quiet line each.
 *
 * - **Analysis still running**: "Targets fill in as hands are analysed",
 *   with the hands left - the checker's `pending` (hands analysed without
 *   checker rows yet: the desktop's background pass, the web's browser fill,
 *   whose live countdown is `filling`). The numbers shown meanwhile are a
 *   fair sample (both fill in hand id order, a random one).
 */
import { countIn } from "../hands/format";
import { useUiStrings } from "../i18n";
import type { CheckerResult } from "../model/checker";
import styles from "./Analytics.module.css";

/** Hands left before every analysed hand counts: the fill's countdown, else the checker's `pending`. */
export function pendingOf(result: CheckerResult | null, filling: number | null): number {
  if (filling !== null && filling > 0) return filling;
  return result?.pending ?? 0;
}

/** "Targets fill in as hands are analysed: 1,204 hands to go." (nothing when nothing is left). */
export function PendingLine({ left }: { left: number }) {
  const ui = useUiStrings();
  if (left <= 0) return null;
  return (
    <p className={styles.quiet} role="status">
      {ui.analytics.screen.stats.pendingLeft(countIn(ui.intlLocale, left), left)}
    </p>
  );
}
