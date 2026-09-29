/**
 * The Phase-1 HUD: the fifteen-odd numbers a player recognises, grouped the way
 * they are read.
 *
 * The rates are computed by `rates()` from `lib/stats` — the same function the
 * corpus suite asserts against — rather than by dividing here. That is not
 * ceremony: a second implementation of "3-bet percentage" in a component is a
 * second definition, and the first time the two disagree nobody will be able to
 * say which one the tests covered.
 *
 * What this file decides is only which counters are worth a tile and what they
 * are called. The order is the order a player thinks in: money first (it is the
 * only number that is the point), then preflop, then postflop, then showdown.
 */

import { rates, type SeatCounters, type SeatMoney } from "../../lib/stats";
import { StatTile } from "./StatTile";
import { winRateIsMeaningful, WIN_RATE_SAMPLE_FLOOR } from "./uncertainty";

interface HudGridProps {
  counters: SeatCounters;
  /** Null when the sample's units refuse to be summed. */
  money: SeatMoney | null;
  moneyHands: number;
  /** ISO code when the whole sample shares one, else null. */
  currency: string | null;
  currencyMinorUnits: number | null;
  mixedCurrency: boolean;
  mixedUnitKind: boolean;
}

const COUNT = new Intl.NumberFormat("en-GB");
const BB = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const BB100 = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

function currencyText(minor: number, code: string, minorUnits: number): string {
  const value = minor / (minorUnits || 1);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code,
      signDisplay: "exceptZero",
    }).format(value);
  } catch {
    // Not every `CurrencyUnit.code` PHF carries is an ISO 4217 code — "CHIPS"
    // and "TCHIP" are not, and neither is whatever the next room invents.
    // `Intl` throws on those rather than degrading, so catch and print plainly.
    return `${value >= 0 ? "+" : ""}${BB.format(value)} ${code}`;
  }
}

export function HudGrid({
  counters,
  money,
  moneyHands,
  currency,
  currencyMinorUnits,
  mixedCurrency,
  mixedUnitKind,
}: HudGridProps) {
  const totals = rates({ counters, money: money ?? zeroMoney(), moneyHands });
  const hands = counters.hands;
  const trusted = winRateIsMeaningful(moneyHands);

  return (
    <div className="stats-hud">
      {/* ------------------------------------------------------- headline */}
      <section className="stats-headline card">
        <div className="stats-headline__main">
          <span className="stats-headline__label">Win rate</span>
          <span
            className={`stats-headline__value ${
              money === null ? "" : (totals.bb100 ?? 0) >= 0 ? "is-up" : "is-down"
            } ${trusted ? "" : "is-provisional"}`}
          >
            {money !== null && totals.bb100 !== null ? `${BB100.format(totals.bb100)}` : "—"}
            <span className="stats-headline__unit">bb/100</span>
          </span>
          {money === null ? (
            <p className="stats-headline__note">
              {mixedUnitKind
                ? "This sample mixes tournament chips with cash. Chips are not money — their value is the payout structure — so there is no total to show. Filter to one game format."
                : "No money figure for this sample."}
            </p>
          ) : trusted ? null : (
            /* No "±" here, ever. A confidence interval on a win rate needs the
               variance of the per-hand result, and the engine stores sums, not
               sums of squares — so any band would be an assumed standard
               deviation dressed up as a measurement. See `uncertainty.ts`. */
            <p className="stats-headline__note">
              {COUNT.format(moneyHands)} hands. A win rate does not settle down until
              somewhere past {COUNT.format(WIN_RATE_SAMPLE_FLOOR)}, so read this as a
              direction rather than a number.
            </p>
          )}
        </div>

        <dl className="stats-headline__side">
          <div>
            <dt>Hands</dt>
            <dd>{COUNT.format(hands)}</dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd>{money !== null ? `${BB.format(totals.netBb)} bb` : "—"}</dd>
          </div>
          <div>
            <dt>{mixedCurrency ? "Currency" : "In money"}</dt>
            <dd>
              {money !== null && currency && currencyMinorUnits
                ? currencyText(totals.net, currency, currencyMinorUnits)
                : mixedCurrency
                  ? "mixed"
                  : "—"}
            </dd>
          </div>
        </dl>

        {mixedCurrency && !mixedUnitKind ? (
          <p className="notice notice--info stats-headline__refusal">
            This sample spans more than one currency, so the cash total is withheld —
            adding dollars to euros gives a number with no unit. The big-blind figures
            above are unaffected: a big blind is a unit of the game, not of a currency,
            which is exactly what it is stored in.
          </p>
        ) : null}
      </section>

      {/* -------------------------------------------------------- preflop */}
      <section className="card stats-group">
        <div className="card__head">
          <h3>Preflop</h3>
        </div>
        <div className="stats-grid">
          <StatTile label="VPIP" made={counters.vpip} opportunities={counters.vpip_opp} hint="Money in voluntarily" />
          <StatTile label="PFR" made={counters.pfr} opportunities={counters.pfr_opp} hint="Raised preflop" />
          <StatTile label="RFI" made={counters.rfi} opportunities={counters.rfi_opp} hint="Opened an unopened pot" />
          <StatTile label="3-bet" made={counters.three_bet} opportunities={counters.three_bet_opp} hint="Facing one raise" />
          <StatTile label="Fold to 3-bet" made={counters.fold_to_three_bet} opportunities={counters.fold_to_three_bet_opp} hint="After opening" />
          <StatTile label="4-bet" made={counters.four_bet} opportunities={counters.four_bet_opp} hint="Facing two raises" />
          <StatTile label="Squeeze" made={counters.squeeze} opportunities={counters.squeeze_opp} hint="Raise over a raise and a caller" />
          <StatTile label="Cold call" made={counters.cold_call} opportunities={counters.cold_call_opp} hint="Call a raise, no money in" />
          <StatTile label="Steal" made={counters.steal} opportunities={counters.steal_opp} hint="CO / BTN / SB, folded to you" />
          <StatTile label="Fold to steal" made={counters.fold_to_steal} opportunities={counters.fold_to_steal_opp} hint="In a blind, facing a steal" />
        </div>
      </section>

      {/* ------------------------------------------------------- postflop */}
      <section className="card stats-group">
        <div className="card__head">
          <h3>Postflop</h3>
          <p className="muted">
            The continuation-bet chain follows PokerTracker&rsquo;s rule: a turn cbet
            counts only when the flop cbet was <em>called</em>, which is the definition
            that answers &ldquo;do I barrel&rdquo;.
          </p>
        </div>
        <div className="stats-grid">
          <StatTile label="Cbet flop" made={counters.cbet_flop} opportunities={counters.cbet_flop_opp} hint="As the preflop raiser" />
          <StatTile label="Cbet turn" made={counters.cbet_turn} opportunities={counters.cbet_turn_opp} hint="After the flop cbet was called" />
          <StatTile label="Cbet river" made={counters.cbet_river} opportunities={counters.cbet_river_opp} hint="Third barrel" />
          <StatTile label="Fold to cbet" made={counters.fold_to_cbet_flop} opportunities={counters.fold_to_cbet_flop_opp} hint="On the flop" />
          <StatTile label="Raise cbet" made={counters.raise_cbet_flop} opportunities={counters.fold_to_cbet_flop_opp} hint="On the flop" />
          <StatTile label="Donk bet" made={counters.donk_flop} opportunities={counters.donk_flop_opp} hint="Into the previous aggressor" />
          <StatTile label="Check-raise" made={counters.check_raise_flop} opportunities={counters.check_raise_flop_opp} hint="On the flop" />
          <StatTile label="Saw flop" made={counters.flop_seen} opportunities={counters.hands} hint="Of all hands dealt" />
        </div>
        <dl className="stats-inline">
          <div>
            <dt>Aggression factor</dt>
            <dd>{totals.aggressionFactor === null ? "—" : totals.aggressionFactor.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Aggression frequency</dt>
            <dd>
              {totals.aggressionFrequency === null
                ? "—"
                : `${totals.aggressionFrequency.toFixed(1)}%`}
            </dd>
          </div>
        </dl>
      </section>

      {/* ------------------------------------------------------- showdown */}
      <section className="card stats-group">
        <div className="card__head">
          <h3>Showdown</h3>
        </div>
        <div className="stats-grid">
          <StatTile label="WWSF" made={counters.wwsf} opportunities={counters.wwsf_opp} hint="Won when saw flop" />
          <StatTile label="WTSD" made={counters.wtsd} opportunities={counters.wtsd_opp} hint="Went to showdown, having seen a flop" />
          <StatTile label="W$SD" made={counters.wsd} opportunities={counters.wsd_opp} hint="Won at showdown" />
        </div>
      </section>
    </div>
  );
}

/** A zero money row, for the case where the units refused to be summed. */
function zeroMoney(): SeatMoney {
  return {
    won: 0,
    contributed: 0,
    net: 0,
    net_bb_milli: 0,
    rake_paid: 0,
    out_of_pot: 0,
    cashout_risk: 0,
  };
}
