import type { StoredHandRow } from "../lib/handStore";
import { CardRow } from "./replayer/PlayingCard";

interface HandListProps {
  rows: StoredHandRow[];
  loading: boolean;
  activeId: string | null;
  onOpen: (row: StoredHandRow) => void;
}

function money(currency: string, amount: number | null): string {
  if (amount === null) {
    return "—";
  }
  const text = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  return `${currency}${text}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("hr-HR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HandList({ rows, loading, activeId, onOpen }: HandListProps) {
  if (loading && rows.length === 0) {
    return <div className="empty">Učitavam handove…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        Nema handova za zadane filtere. Konvertiraj fileove u Converter tabu ili uploadaj
        pojedinačni hand gore.
      </div>
    );
  }

  return (
    <div className="hand-table" role="table">
      <div className="hand-table__head" role="row">
        <span>Vrijeme</span>
        <span>Hero</span>
        <span>Board</span>
        <span>Stol</span>
        <span>Pot</span>
        <span>Hero P/L</span>
        <span />
      </div>
      {rows.map((row) => {
        const profit = row.hero_profit;
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
              {formatDate(row.played_at)}
              <small>#{row.hand_key}</small>
            </span>
            <span>
              {row.hero_cards.length ? (
                <CardRow cards={row.hero_cards} size="xs" />
              ) : (
                <span className="muted">—</span>
              )}
              {row.hero_hand_class ? (
                <small className="hand-table__class">{row.hero_hand_class}</small>
              ) : null}
            </span>
            <span>
              {row.board_cards.length ? (
                <CardRow cards={row.board_cards} size="xs" />
              ) : (
                <span className="muted">preflop</span>
              )}
            </span>
            <span className="hand-table__table">
              {row.table_name ?? "—"}
              <small>
                {money(row.currency, row.small_blind)}/{money(row.currency, row.big_blind)}
              </small>
            </span>
            <span>{money(row.currency, row.total_pot)}</span>
            <span
              className={
                profit === null ? "muted" : profit >= 0 ? "profit profit--win" : "profit profit--loss"
              }
            >
              {profit === null
                ? "—"
                : `${profit >= 0 ? "+" : "-"}${money(row.currency, Math.abs(profit))}`}
            </span>
            <span className="hand-table__actions">
              {row.went_to_showdown ? <span className="tag tag--sd">SD</span> : null}
              <button
                type="button"
                className="btn btn--sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(row);
                }}
              >
                Replay
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
