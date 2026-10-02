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

import { useDict } from "../../lib/i18n/client";
import { rates, type SeatCounters, type SeatMoney } from "../../lib/stats";
import { countIn, fixedIn, numberFormat, useIntlLocale } from "./format";
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

/**
 * The plain-number fallback for a code `Intl` refuses. Kept in the same form as
 * the currency amounts it stands in for (see `format.ts`), not the reader's.
 */
const PLAIN = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

function currencyText(minor: number, code: string, minorUnits: number): string {
  const value = minor / (minorUnits || 1);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      signDisplay: "exceptZero",
    }).format(value);
  } catch {
    // Not every `CurrencyUnit.code` PHF carries is an ISO 4217 code — "CHIPS"
    // and "TCHIP" are not, and neither is whatever the next room invents.
    // `Intl` throws on those rather than degrading, so catch and print plainly.
    return `${value >= 0 ? "+" : ""}${PLAIN.format(value)} ${code}`;
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
  const t = useDict().stats;
  const en = t.hud;
  const tiles = en.tiles;
  const locale = useIntlLocale();
  const count = countIn(locale);
  const bb = numberFormat(locale, { maximumFractionDigits: 1 });
  const bb100 = numberFormat(locale, { maximumFractionDigits: 2, signDisplay: "exceptZero" });
  const totals = rates({ counters, money: money ?? zeroMoney(), moneyHands });
  const hands = counters.hands;
  const trusted = winRateIsMeaningful(moneyHands);

  return (
    <div className="stats-hud">
      {/* ------------------------------------------------------- headline */}
      <section className="stats-headline card">
        <div className="stats-headline__main">
          <span className="stats-headline__label">{t.common.winRate}</span>
          <span
            className={`stats-headline__value ${
              money === null ? "" : (totals.bb100 ?? 0) >= 0 ? "is-up" : "is-down"
            } ${trusted ? "" : "is-provisional"}`}
          >
            {money !== null && totals.bb100 !== null ? `${bb100.format(totals.bb100)}` : "—"}
            <span className="stats-headline__unit">{t.common.bb100}</span>
          </span>
          {money === null ? (
            <p className="stats-headline__note">
              {mixedUnitKind ? en.mixedUnitKind : en.noMoney}
            </p>
          ) : trusted ? null : (
            /* No "±" here, ever. A confidence interval on a win rate needs the
               variance of the per-hand result, and the engine stores sums, not
               sums of squares — so any band would be an assumed standard
               deviation dressed up as a measurement. See `uncertainty.ts`. */
            <p className="stats-headline__note">{en.provisional(moneyHands, WIN_RATE_SAMPLE_FLOOR)}</p>
          )}
        </div>

        <dl className="stats-headline__side">
          <div>
            <dt>{t.common.handsHead}</dt>
            <dd>{count(hands)}</dd>
          </div>
          <div>
            <dt>{t.common.result}</dt>
            <dd>{money !== null ? t.common.bb(bb.format(totals.netBb)) : "—"}</dd>
          </div>
          <div>
            <dt>{mixedCurrency ? en.currency : en.inMoney}</dt>
            <dd>
              {money !== null && currency && currencyMinorUnits ? (
                <span className="stats-nowrap">
                  {currencyText(totals.net, currency, currencyMinorUnits)}
                </span>
              ) : mixedCurrency ? (
                en.mixed
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>

        {mixedCurrency && !mixedUnitKind ? (
          <p className="notice notice--info stats-headline__refusal">{en.mixedCurrency}</p>
        ) : null}
      </section>

      {/* -------------------------------------------------------- preflop */}
      <section className="card stats-group">
        <div className="card__head">
          <h3>{en.preflop}</h3>
        </div>
        <div className="stats-grid">
          <StatTile {...tiles.vpip} made={counters.vpip} opportunities={counters.vpip_opp} />
          <StatTile {...tiles.pfr} made={counters.pfr} opportunities={counters.pfr_opp} />
          <StatTile {...tiles.rfi} made={counters.rfi} opportunities={counters.rfi_opp} />
          <StatTile {...tiles.threeBet} made={counters.three_bet} opportunities={counters.three_bet_opp} />
          <StatTile {...tiles.foldToThreeBet} made={counters.fold_to_three_bet} opportunities={counters.fold_to_three_bet_opp} />
          <StatTile {...tiles.fourBet} made={counters.four_bet} opportunities={counters.four_bet_opp} />
          <StatTile {...tiles.squeeze} made={counters.squeeze} opportunities={counters.squeeze_opp} />
          <StatTile {...tiles.coldCall} made={counters.cold_call} opportunities={counters.cold_call_opp} />
          <StatTile {...tiles.steal} made={counters.steal} opportunities={counters.steal_opp} />
          <StatTile {...tiles.foldToSteal} made={counters.fold_to_steal} opportunities={counters.fold_to_steal_opp} />
        </div>
      </section>

      {/* ------------------------------------------------------- postflop */}
      <section className="card stats-group">
        <div className="card__head">
          <h3>{en.postflop}</h3>
          <p className="muted">
            {en.postflopNote.before}
            <em>{en.postflopNote.emphasis}</em>
            {en.postflopNote.after}
          </p>
        </div>
        <div className="stats-grid">
          <StatTile {...tiles.cbetFlop} made={counters.cbet_flop} opportunities={counters.cbet_flop_opp} />
          <StatTile {...tiles.cbetTurn} made={counters.cbet_turn} opportunities={counters.cbet_turn_opp} />
          <StatTile {...tiles.cbetRiver} made={counters.cbet_river} opportunities={counters.cbet_river_opp} />
          <StatTile {...tiles.foldToCbet} made={counters.fold_to_cbet_flop} opportunities={counters.fold_to_cbet_flop_opp} />
          <StatTile {...tiles.raiseCbet} made={counters.raise_cbet_flop} opportunities={counters.fold_to_cbet_flop_opp} />
          <StatTile {...tiles.donkBet} made={counters.donk_flop} opportunities={counters.donk_flop_opp} />
          <StatTile {...tiles.checkRaise} made={counters.check_raise_flop} opportunities={counters.check_raise_flop_opp} />
          <StatTile {...tiles.sawFlop} made={counters.flop_seen} opportunities={counters.hands} />
        </div>
        <dl className="stats-inline">
          <div>
            <dt>{en.aggressionFactor}</dt>
            <dd>{totals.aggressionFactor === null ? "—" : fixedIn(locale, 2)(totals.aggressionFactor)}</dd>
          </div>
          <div>
            <dt>{en.aggressionFrequency}</dt>
            <dd>
              {totals.aggressionFrequency === null
                ? "—"
                : `${fixedIn(locale, 1)(totals.aggressionFrequency)}%`}
            </dd>
          </div>
        </dl>
      </section>

      {/* ------------------------------------------------------- showdown */}
      <section className="card stats-group">
        <div className="card__head">
          <h3>{en.showdown}</h3>
        </div>
        <div className="stats-grid">
          <StatTile {...tiles.wwsf} made={counters.wwsf} opportunities={counters.wwsf_opp} />
          <StatTile {...tiles.wtsd} made={counters.wtsd} opportunities={counters.wtsd_opp} />
          <StatTile {...tiles.wsd} made={counters.wsd} opportunities={counters.wsd_opp} />
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
