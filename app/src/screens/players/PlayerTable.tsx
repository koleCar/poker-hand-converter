/**
 * The opponents as a table: colour, name with labels and a note mark, room,
 * hands together, your result against them in big blinds, last seen. At
 * most a few hundred rows (the store sorts and cuts the list), so it is a
 * plain table; each name is a button that opens the profile.
 */
import { useT } from "../../i18n";
import type { PlayerRef, PlayerRow } from "../../lib/ipc";
import { bigBlinds, count, playedAt } from "../hands/format";
import styles from "./Players.module.css";

export function PlayerTable({
  rows,
  selected,
  onSelect,
  more,
  onMore,
}: {
  rows: PlayerRow[];
  selected: PlayerRef | null;
  onSelect: (row: PlayerRow) => void;
  more: boolean;
  onMore: () => void;
}) {
  const p = useT().players;
  const tone = (value: number | null) =>
    value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.hidden}>{p.listLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{p.columns.name}</th>
            <th scope="col">{p.columns.room}</th>
            <th scope="col" className={styles.number}>
              {p.columns.hands}
            </th>
            <th scope="col" className={styles.number}>
              {p.columns.result}
            </th>
            <th scope="col">{p.columns.lastSeen}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = selected !== null && selected.site === row.site && selected.player === row.player;
            return (
              <tr key={`${row.site}:${row.player}`} aria-current={current ? "true" : undefined}>
                <th scope="row" className={styles.nameCell}>
                  <button
                    type="button"
                    className={styles.name}
                    onClick={() => onSelect(row)}
                  >
                    <span
                      className={styles.swatch}
                      data-colour={row.colour ?? "none"}
                      role={row.colour ? "img" : undefined}
                      aria-label={row.colour ? p.colourOf(p.colours[row.colour]) : undefined}
                    />
                    <span className={styles.nameText}>{row.player}</span>
                  </button>
                  {row.labels.map((label) => (
                    <span key={label} className={styles.label}>
                      {label}
                    </span>
                  ))}
                  {row.hasNote ? (
                    <span className={styles.noteMark} role="img" aria-label={p.hasNote} title={p.hasNote}>
                      ✎
                    </span>
                  ) : null}
                </th>
                <td>{row.siteName}</td>
                <td className={styles.number}>{count(row.hands)}</td>
                <td className={`${styles.number} ${tone(row.netBbMilli)}`}>
                  {row.netBbMilli === null ? "—" : bigBlinds(row.netBbMilli)}
                </td>
                <td>{playedAt(row.lastPlayedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {more ? (
        <button type="button" className={`chip-btn ${styles.more}`} onClick={onMore}>
          {p.showMore}
        </button>
      ) : null}
    </div>
  );
}
