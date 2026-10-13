/**
 * The Phase-1 HUD: the fifteen-odd numbers a player recognises, grouped the way
 * they are read.
 *
 * Every number comes from the display definitions (`config/stats/`, R2.4) via
 * `STANDARD_STATS` - the same definitions the desktop app and the HUD read, held
 * to `rates()` over the corpus - rather than from dividing here. That is not
 * ceremony: a second implementation of "3-bet percentage" in a component is a
 * second definition, and the first time the two disagree nobody will be able to
 * say which one the tests covered (guideline §14; `statDisplay.test.ts` scans
 * for it). A tile takes its `made / opportunities` from the definition's
 * `pct(made, opportunities)`, the win rate its decimals and its sample floor.
 *
 * What this file decides is only which statistics are worth a tile and what they
 * are called. The order is the order a player thinks in: money first (it is the
 * only number that is the point), then preflop, then postflop, then showdown.
 */

import { useDict } from "../../lib/i18n/client";
import {
  STANDARD_STATS,
  statById,
  statFull,
  statRate,
  statValue,
  type DisplaySums,
  type SeatCounters,
  type SeatMoney,
} from "../../lib/stats";
import { countIn, fixedIn, numberFormat, useIntlLocale } from "./format";
import { StatTile } from "./StatTile";

const stat = (id: string) => statById(STANDARD_STATS, id);
const BB_PER_100 = stat("bb_per_100");
const NET_BB = stat("net_bb");
const AF = stat("aggression_factor");
const AFQ = stat("aggression_frequency");

/** A tile's `made` and `opportunities`: the definition's `pct(made, opportunities)`. */
function sample(id: string, sums: DisplaySums): { made: number; opportunities: number } {
  const rate = statRate(stat(id), sums);
  return { made: rate?.made ?? 0, opportunities: rate?.opportunities ?? 0 };
}

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
  const bb = numberFormat(locale, { maximumFractionDigits: NET_BB.def.format.decimals });
  const bb100 = numberFormat(locale, {
    maximumFractionDigits: BB_PER_100.def.format.decimals,
    signDisplay: "exceptZero",
  });
  const sums: DisplaySums = { counters, money: money ?? zeroMoney(), moneyHands };
  const winRate = statValue(BB_PER_100, sums);
  const netBb = statValue(NET_BB, sums);
  const aggressionFactor = statValue(AF, sums);
  const aggressionFrequency = statValue(AFQ, sums);
  const hands = counters.hands;
  const trusted = statFull(BB_PER_100, sums);
  const s = (id: string) => sample(id, sums);

  return (
    <div className="stats-hud">
      {/* ------------------------------------------------------- headline */}
      <section className="stats-headline card">
        <div className="stats-headline__main">
          <span className="stats-headline__label">{t.common.winRate}</span>
          <span
            className={`stats-headline__value ${
              money === null ? "" : (winRate ?? 0) >= 0 ? "is-up" : "is-down"
            } ${trusted ? "" : "is-provisional"}`}
          >
            {money !== null && winRate !== null ? `${bb100.format(winRate)}` : "—"}
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
            <p className="stats-headline__note">{en.provisional(moneyHands, BB_PER_100.def.sample.min)}</p>
          )}
        </div>

        <dl className="stats-headline__side">
          <div>
            <dt>{t.common.handsHead}</dt>
            <dd>{count(hands)}</dd>
          </div>
          <div>
            <dt>{t.common.result}</dt>
            <dd>{money !== null && netBb !== null ? t.common.bb(bb.format(netBb)) : "—"}</dd>
          </div>
          <div>
            <dt>{mixedCurrency ? en.currency : en.inMoney}</dt>
            <dd>
              {money !== null && currency && currencyMinorUnits ? (
                <span className="stats-nowrap">
                  {currencyText(money.net, currency, currencyMinorUnits)}
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
          <StatTile {...tiles.vpip} {...s("vpip")} />
          <StatTile {...tiles.pfr} {...s("pfr")} />
          <StatTile {...tiles.rfi} {...s("rfi")} />
          <StatTile {...tiles.threeBet} {...s("three_bet")} />
          <StatTile {...tiles.foldToThreeBet} {...s("fold_to_three_bet")} />
          <StatTile {...tiles.fourBet} {...s("four_bet")} />
          <StatTile {...tiles.squeeze} {...s("squeeze")} />
          <StatTile {...tiles.coldCall} {...s("cold_call")} />
          <StatTile {...tiles.steal} {...s("steal")} />
          <StatTile {...tiles.foldToSteal} {...s("fold_to_steal")} />
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
          <StatTile {...tiles.cbetFlop} {...s("cbet_flop")} />
          <StatTile {...tiles.cbetTurn} {...s("cbet_turn")} />
          <StatTile {...tiles.cbetRiver} {...s("cbet_river")} />
          <StatTile {...tiles.foldToCbet} {...s("fold_to_cbet_flop")} />
          <StatTile {...tiles.raiseCbet} {...s("raise_cbet_flop")} />
          <StatTile {...tiles.donkBet} {...s("donk_flop")} />
          <StatTile {...tiles.checkRaise} {...s("check_raise_flop")} />
          <StatTile {...tiles.sawFlop} {...s("saw_flop")} />
        </div>
        <dl className="stats-inline">
          <div>
            <dt>{en.aggressionFactor}</dt>
            <dd>{aggressionFactor === null ? "—" : fixedIn(locale, AF.def.format.decimals)(aggressionFactor)}</dd>
          </div>
          <div>
            <dt>{en.aggressionFrequency}</dt>
            <dd>
              {aggressionFrequency === null
                ? "—"
                : `${fixedIn(locale, AFQ.def.format.decimals)(aggressionFrequency)}%`}
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
          <StatTile {...tiles.wwsf} {...s("wwsf")} />
          <StatTile {...tiles.wtsd} {...s("wtsd")} />
          <StatTile {...tiles.wsd} {...s("wsd")} />
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
