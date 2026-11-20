/**
 * The price of the spot, printed faintly on the cloth just above the hero's
 * cards — only while the hero has a decision (design 7, round 2).
 *
 * No box and no pill: a box over the felt competed with the board for the
 * eye, and the number is something you glance at, not read. Facing a bet it is
 * the equity a call needs and the price (`29% to call · 2.5 : 1`); when hero's
 * own bet is the one standing, the fold rate a bluff needs
 * (`40% folds for a bluff`). The maths is `potOdds.ts`.
 *
 * Not a live region: it changes on most steps, and the replayer's caption
 * (read to a screen reader only) already narrates the action.
 */

import { useUiStrings } from "../i18n";
import type { PotOdds } from "./potOdds";

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function ratioText(ratio: number): string {
  return ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1);
}

export function PotOddsPrint({ odds }: { odds: PotOdds }) {
  const words = useUiStrings().replayer.odds;

  if (odds.kind === "facing") {
    const share = percent(odds.equity);
    const ratio = ratioText(odds.pot / odds.toCall);
    return (
      <span className="pseat__odds" role="note" aria-label={words.facingLabel(share, ratio)}>
        <b aria-hidden="true">{share}</b>
        <span aria-hidden="true">{`${words.toCall} · ${ratio} : 1`}</span>
      </span>
    );
  }

  const share = percent(odds.foldEquity);
  return (
    <span className="pseat__odds" role="note" aria-label={words.bluffLabel(share)}>
      <b aria-hidden="true">{share}</b>
      <span aria-hidden="true">{words.bluff}</span>
    </span>
  );
}
