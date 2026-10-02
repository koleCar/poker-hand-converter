/**
 * The stored-hand library, one row per hand.
 *
 * Reads `HandSummary` from the data layer directly rather than the legacy
 * shim, which mattered for money: the database stores integer minor units, and
 * the shim divided them back into floats that then printed as "$0.1" instead
 * of "$0.10". `formatAmount` with the row's own `CurrencyUnit` gets both cash
 * and chip tables right without the round trip.
 */

import { formatAmount, type CurrencyUnit } from "../lib/phf/types";
import { handUnit, type HandSummary } from "../lib/db";
import { useDict, useLocale } from "../lib/i18n/client";
import { INTL_LOCALE } from "../lib/i18n/dictionaries";
import { getParser } from "../lib/phf";
import { CardRow } from "./replayer/PlayingCard";

/**
 * Money for a list column.
 *
 * Cash gets two decimals because a column of "$2.1 / $0.5 / $12.5" reads as
 * sloppy next to the trackers this app feeds; chips get no decimals and
 * thousands separators, because "21,929" is the only sane way to show a
 * tournament stack.
 */
function money(unit: CurrencyUnit, amount: number | null): string {
  if (amount === null) {
    return "—";
  }
  return formatAmount(amount, unit, unit.minorUnits > 1 ? "fixed2" : "minimal", true);
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "PokerStars", not "pokerstars".
 *
 * `standard` is our own re-import format rather than a poker room, and its
 * registry name ("Rail standard") is far too long for a list cell,
 * so it gets a short one here.
 */
function siteLabel(id: string, standardFormat: string): string {
  if (id === "standard") {
    return standardFormat;
  }
  return getParser(id)?.name ?? id;
}

interface HandListProps {
  rows: HandSummary[];
  loading: boolean;
  activeId: string | null;
  onOpen: (row: HandSummary) => void;
}

export function HandList({ rows, loading, activeId, onOpen }: HandListProps) {
  const t = useDict().converter.list;
  const locale = INTL_LOCALE[useLocale()];

  if (loading && rows.length === 0) {
    return <div className="empty">{t.loading}</div>;
  }

  if (rows.length === 0) {
    return <div className="empty">{t.empty}</div>;
  }

  return (
    <div className="hand-table" role="table">
      <div className="hand-table__head" role="row">
        <span>{t.columns.time}</span>
        <span>{t.columns.hero}</span>
        <span>{t.columns.board}</span>
        <span>{t.columns.table}</span>
        <span>{t.columns.pot}</span>
        <span>{t.columns.heroNet}</span>
        <span />
      </div>
      {rows.map((row) => {
        const unit = handUnit(row);
        const profit = row.heroProfit;
        // Only `positional` earns the badge. `opaque-id` rooms still hand out
        // per-seat tokens you can read and follow within a session, and that
        // covers most of the library — badging all of it would be noise.
        const positional = row.anonymization === "positional";
        return (
          <div
            key={row.id}
            role="row"
            className={`hand-table__row ${activeId === row.id ? "is-active" : ""}`}
            onClick={() => onOpen(row)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onOpen(row);
            }}
            tabIndex={0}
          >
            <span className="hand-table__time">
              {formatDate(row.playedAt, locale)}
              {/* The room, not the internal key: "#standard:HD75320833" told the
                  user nothing and leaked a parser id into the interface. */}
              <small>
                {siteLabel(row.site, t.standardFormat)}
                {row.siteHandId ? ` · #${row.siteHandId}` : ""}
              </small>
            </span>
            <span>
              {row.heroCards.length ? (
                <CardRow cards={row.heroCards} size="xs" />
              ) : (
                <span className="muted">—</span>
              )}
              {row.heroHandClass ? (
                <small className="hand-table__class">{row.heroHandClass}</small>
              ) : null}
              {row.heroPosition ? (
                <small className="hand-table__pos">{row.heroPosition}</small>
              ) : null}
            </span>
            <span>
              {row.boardCards.length ? (
                <CardRow cards={row.boardCards} size="xs" />
              ) : (
                <span className="muted">{t.preflop}</span>
              )}
            </span>
            <span className="hand-table__table">
              {row.tableName ?? "—"}
              <small>
                {row.smallBlind !== null || row.bigBlind !== null
                  ? `${money(unit, row.smallBlind)}/${money(unit, row.bigBlind)}`
                  : row.stakesLabel ?? "—"}
              </small>
            </span>
            <span>{money(unit, row.totalPot)}</span>
            <span
              className={
                profit === null ? "muted" : profit >= 0 ? "profit profit--win" : "profit profit--loss"
              }
            >
              {profit === null ? "—" : `${profit >= 0 ? "+" : "-"}${money(unit, Math.abs(profit))}`}
            </span>
            <span className="hand-table__actions">
              {positional ? (
                <span
                  className="tag tag--anon"
                  title={t.anonTitle}
                >
                  {t.anon}
                </span>
              ) : null}
              {row.wentToShowdown ? <span className="tag tag--sd">{t.showdown}</span> : null}
              <button
                type="button"
                className="btn btn--sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(row);
                }}
              >
                {t.replay}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
