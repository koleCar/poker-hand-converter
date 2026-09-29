/**
 * Hand info — Tier 2.
 *
 * Everything that is constant for the whole hand and therefore has no business
 * on the felt: the structure the pot was built under, how deep it was really
 * played, where it came from, and — once the replay has got there — what it
 * cost and who took it.
 *
 * This is also where the header's meta strip goes when the box is too narrow
 * to carry it (#58, rung 6 of the drop ladder). Nothing is deleted by a drop;
 * it is moved here.
 *
 * **Spoiler discipline.** The sheet opens from frame 0, so every row derived
 * from `hand.results` is gated on `spoilersRevealed` and renders an em dash
 * until the award frame. The gate is a single predicate rather than a per-row
 * judgement call, because the header lost its outcome fields one at a time in
 * `fef6ff7` and a rule is the only thing that stops them coming back.
 */

import { useMemo } from "react";
import {
  toBigBlinds,
  toDisplayNumber,
  totalFees,
  type Amount,
  type PhfHand,
} from "../../lib/phf/types";
import type { ReplayFrame } from "../../lib/replay";
import { Overlay } from "../ui/Overlay";
import {
  gameLabel,
  playedAtLabel,
  stakesLabel,
  structureBadges,
  tableShapeLabel,
} from "./handFacts";
import type { NameMask } from "./replaySettings";
import {
  effectiveStack,
  spoilersRevealed,
  spokenPosition,
  type AmountFormatter,
} from "./tableMath";

interface HandInfoSheetProps {
  hand: PhfHand;
  frame: ReplayFrame;
  /** Frame the pot is first paid on; the spoiler gate's threshold. */
  awardAt: number;
  mask: NameMask;
  format: AmountFormatter;
  /** Room the hand was played in, when the caller knows a nicer name than PHF. */
  site?: string | null;
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
}

const FEE_LABELS: Array<{ key: keyof PhfHand["results"]["fees"]; label: string }> = [
  { key: "rake", label: "Rake" },
  { key: "jackpot", label: "Jackpot" },
  { key: "bingo", label: "Bingo" },
  { key: "fortune", label: "Fortune" },
  { key: "tax", label: "Tax" },
  { key: "other", label: "Other fees" },
];

/** One row. `null` values are dropped rather than printed as blanks. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rp__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A value the replay has not reached yet.
 *
 * An em dash plus a spoken reason, never a colour or a blur: the point is that
 * the row exists and is deliberately empty, which a reader who cannot see
 * still has to be told.
 */
function Hidden() {
  return (
    <span className="rp__fact-hidden">
      —<span className="rp-sr"> hidden until the pot is awarded</span>
    </span>
  );
}

export function HandInfoSheet({
  hand,
  frame,
  awardAt,
  mask,
  format,
  site,
  open,
  onClose,
  anchor,
}: HandInfoSheetProps) {
  const badges = useMemo(() => structureBadges(hand), [hand]);
  const revealed = spoilersRevealed(frame, awardAt);

  // Kept in minor units until the last moment, then handed to the same
  // formatter the felt uses so the big-blind toggle covers it too.
  const effective = useMemo(() => effectiveStack(hand), [hand]);
  const money = (amount: Amount) =>
    format(toDisplayNumber(amount, hand.game.unit), toBigBlinds(amount, hand.game.bigBlind));

  const hero = hand.players.find((player) => player.isHero) ?? null;
  const heroPosition = hero ? spokenPosition(hero.position) : null;
  const played = playedAtLabel(hand);
  const fees = FEE_LABELS.filter(({ key }) => hand.results.fees[key] > 0);
  const tournament = hand.tournament;

  const winners = revealed
    ? hand.results.winners.filter((winner) => winner.amount > 0)
    : [];

  return (
    <Overlay
      open={open}
      onClose={onClose}
      title="Hand info"
      anchor={anchor}
      className="rp-ov rp-ov--info"
    >
      <dl className="rp__facts">
        <Fact label="Game">
          {gameLabel(hand)} · {stakesLabel(hand)}
        </Fact>
        {badges.length > 0 ? (
          <Fact label="Structure">
            <span className="rp__fact-chips">
              {badges.map((badge) => (
                <span key={badge} className="rp__fact-chip">
                  {badge}
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
        <Fact label="Effective stack">{money(effective)}</Fact>
        <Fact label="Table">
          {[mask.tableName, tableShapeLabel(hand)].filter(Boolean).join(" · ")}
        </Fact>
        {hero ? (
          <Fact label="Hero">
            Seat {hero.seat}
            {heroPosition ? `, ${heroPosition}` : ""}
          </Fact>
        ) : null}
        {tournament ? (
          <Fact label="Tournament">
            {[
              tournament.name ?? `#${tournament.id}`,
              tournament.levelLabel ? `level ${tournament.levelLabel}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Fact>
        ) : null}
        <Fact label="Source">{site ?? hand.meta.siteName}</Fact>
        <Fact label="Hand id">
          <span className="rp__fact-id">{hand.meta.handId}</span>
        </Fact>
        {played ? <Fact label="Played">{played}</Fact> : null}

        {/* --- gated on frame position, not on which panel is open --- */}
        <Fact label="Total pot">{revealed ? money(hand.results.totalPot) : <Hidden />}</Fact>
        <Fact label="Fees">
          {!revealed ? (
            <Hidden />
          ) : totalFees(hand.results.fees) === 0 ? (
            <span className="rp__fact-none">none</span>
          ) : (
            <span className="rp__fact-chips">
              {fees.map(({ key, label }) => (
                <span key={key} className="rp__fact-chip">
                  {label} {money(hand.results.fees[key])}
                </span>
              ))}
            </span>
          )}
        </Fact>
        <Fact label="Winners">
          {!revealed ? (
            <Hidden />
          ) : winners.length === 0 ? (
            <span className="rp__fact-none">none reported</span>
          ) : (
            <span className="rp__fact-chips">
              {winners.map((winner, index) => (
                <span key={`${winner.player}-${winner.runoutIndex}-${index}`} className="rp__fact-chip">
                  {mask.seat(winner.player)} {money(winner.amount)}
                  {winner.runoutIndex > 0 ? ` (run ${winner.runoutIndex + 1})` : ""}
                </span>
              ))}
            </span>
          )}
        </Fact>
      </dl>
    </Overlay>
  );
}
