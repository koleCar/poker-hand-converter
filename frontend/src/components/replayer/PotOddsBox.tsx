/**
 * Top-left of the stage: the price of the spot, from hero's chair.
 *
 * Only there while hero is facing a bet or has one standing; the maths is in
 * `potOdds.ts`. Not a live region — it changes on every step, and the caption
 * under the felt already narrates the action.
 */

import { useDict } from "../../lib/i18n/client";
import type { PotOdds } from "./potOdds";
import type { AmountFormatter } from "./tableMath";

interface PotOddsBoxProps {
  odds: PotOdds;
  format: AmountFormatter;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function PotOddsBox({ odds, format }: PotOddsBoxProps) {
  const words = useDict().replayer.odds;

  if (odds.kind === "facing") {
    const ratio = odds.pot / odds.toCall;
    return (
      <div className="rp__odds" role="group" aria-label={words.facingTitle}>
        <span className="rp__odds-title">{words.facingTitle}</span>
        <span className="rp__odds-line">{words.callToWin(format(odds.toCall), format(odds.pot))}</span>
        <span className="rp__odds-main">
          <span className="rp__odds-value">{`${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} : 1`}</span>
          <span className="rp__odds-need">{words.needEquity(percent(odds.equity))}</span>
        </span>
      </div>
    );
  }

  const title = odds.raise
    ? words.raiseTitle(format(odds.bet))
    : words.betTitle(percent(odds.bet / odds.potBefore));
  return (
    <div className="rp__odds rp__odds--betting" role="group" aria-label={title}>
      <span className="rp__odds-title">{title}</span>
      <span className="rp__odds-line">{words.betInto(format(odds.risk), format(odds.potBefore))}</span>
      {odds.callerEquity !== null ? (
        <span className="rp__odds-row">
          {words.callerNeeds}
          <strong className="rp__odds-strong">{percent(odds.callerEquity)}</strong>
        </span>
      ) : null}
      <span className="rp__odds-row">
        {words.bluffNeeds}
        <strong className="rp__odds-strong">{percent(odds.foldEquity)}</strong>
      </span>
    </div>
  );
}
