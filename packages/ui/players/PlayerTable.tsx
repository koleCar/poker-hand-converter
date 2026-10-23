/**
 * The opponents as a virtualised grid (R2.8; a plain table in R2.7c): colour
 * (where the surface keeps colours), name with labels and a note mark, room,
 * hands together, your result against them in big blinds, last seen. The
 * store sorts and cuts the list (500 rows at most, "show more" asks for the
 * next 200), and only the rows in view are in the DOM, as in the Hands list:
 * rows are `--row` tall (the density's `--density-row` on the desktop,
 * taller on a narrow list), read back from the stylesheet through `.probe`,
 * positioned in a spacer.
 *
 * Keyboard, as the Hands list: an ARIA grid with one focusable row (roving
 * tabindex); Up / Down, Page Up / Page Down, Home / End move the selection,
 * which opens the profile beside the list; Enter moves focus into the
 * profile.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { handFormat } from "../hands/format";
import { useUiStrings } from "../i18n";
import type { PlayerRef, PlayerRow } from "./model";
import styles from "./Players.module.css";

/** Rows rendered above and below the visible ones. */
const OVERSCAN = 8;
/** Until the stylesheet answers. */
const FALLBACK_ROW = 40;

const keyOf = (row: Pick<PlayerRow, "site" | "player">) => `${row.site}:${row.player}`;

export function PlayerTable({
  rows,
  selected,
  showColours,
  onSelect,
  onOpen,
  more,
  onMore,
  densityKey,
}: {
  rows: PlayerRow[];
  selected: PlayerRef | null;
  /** The surface keeps colour tags (the web does not). */
  showColours: boolean;
  onSelect: (row: PlayerRow) => void;
  /** Enter on a row: the reader wants the profile. */
  onOpen: (row: PlayerRow) => void;
  more: boolean;
  onMore: () => void;
  /** Changes when the surface changes the row height without resizing the list (the desktop's density). */
  densityKey?: unknown;
}) {
  const strings = useUiStrings();
  const p = strings.players;
  const { bigBlinds, count, playedAt } = useMemo(() => handFormat(strings.intlLocale), [strings.intlLocale]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW);
  const [view, setView] = useState({ top: 0, height: 600 });
  // A row to focus once it is rendered (keyboard moves).
  const focusKey = useRef<string | null>(null);

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (node) setView({ top: node.scrollTop, height: node.clientHeight });
    const probe = probeRef.current?.offsetHeight;
    if (probe) setRowHeight(probe);
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, densityKey]);

  // Another density: the same row stays at the top of the view.
  const previousRow = useRef(rowHeight);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && previousRow.current !== rowHeight) {
      node.scrollTop = (node.scrollTop / previousRow.current) * rowHeight;
      previousRow.current = rowHeight;
      measure();
    }
  }, [rowHeight, measure]);

  const selectedKey = selected === null ? null : keyOf(selected);
  const selectedIndex = selectedKey === null ? -1 : rows.findIndex((row) => keyOf(row) === selectedKey);

  // Focus the row a keyboard move selected, once it is in the DOM.
  useEffect(() => {
    const key = focusKey.current;
    if (key === null || key !== selectedKey) return;
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (node) {
      node.focus({ preventScroll: true });
      focusKey.current = null;
    }
  });

  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN);

  const moveTo = (index: number) => {
    const target = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[target];
    if (!row) return;
    const node = scrollRef.current;
    if (node) {
      const at = target * rowHeight;
      // The sticky header covers the first row's height.
      const header = rowHeight;
      if (at < node.scrollTop) node.scrollTop = at;
      else if (at + rowHeight > node.scrollTop + node.clientHeight - header) {
        node.scrollTop = at + rowHeight - node.clientHeight + header;
      }
    }
    focusKey.current = keyOf(row);
    onSelect(row);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, row: PlayerRow) => {
    const page = Math.max(1, Math.floor(view.height / rowHeight) - 2);
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      PageDown: index + page,
      PageUp: index - page,
      Home: 0,
      End: rows.length - 1,
    };
    const to = moves[event.key];
    if (to !== undefined) {
      event.preventDefault();
      moveTo(to);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onSelect(row);
      onOpen(row);
    }
  };

  // The one row in the tab order: the selected one, else the first.
  const tabbable = selectedIndex >= 0 ? selectedIndex : 0;
  const tone = (value: number | null) => (value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down);

  return (
    <div className={styles.tableWrap}>
      <div
        ref={scrollRef}
        className={styles.grid}
        onScroll={measure}
        role="grid"
        aria-label={p.listLabel}
        aria-rowcount={rows.length + 1}
      >
        <div ref={probeRef} className={styles.probe} aria-hidden="true" />
        <div className={`${styles.gridRow} ${styles.gridHead}`} role="row" aria-rowindex={1}>
          <span role="columnheader">{p.columns.name}</span>
          <span role="columnheader">{p.columns.room}</span>
          <span role="columnheader" className={styles.number}>
            {p.columns.hands}
          </span>
          <span role="columnheader" className={styles.number}>
            {p.columns.result}
          </span>
          <span role="columnheader">{p.columns.lastSeen}</span>
        </div>
        <div className={styles.gridBody} style={{ height: rows.length * rowHeight }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const key = keyOf(row);
            const current = key === selectedKey;
            return (
              <div
                key={key}
                className={`${styles.gridRow}${current ? ` ${styles.gridSelected}` : ""}`}
                style={{ top: index * rowHeight }}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={current}
                tabIndex={index === tabbable ? 0 : -1}
                data-key={key}
                onClick={() => onSelect(row)}
                onKeyDown={(event) => onKeyDown(event, index, row)}
              >
                <span role="gridcell" className={styles.nameCell}>
                  {showColours ? (
                    <span
                      className={styles.swatch}
                      data-colour={row.colour ?? "none"}
                      role={row.colour ? "img" : undefined}
                      aria-label={row.colour ? p.colourOf(p.colours[row.colour]) : undefined}
                    />
                  ) : null}
                  <span className={styles.nameText}>{row.player}</span>
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
                </span>
                <span role="gridcell" className={styles.dim}>
                  {row.siteName}
                </span>
                <span role="gridcell" className={styles.number}>
                  {count(row.hands)}
                </span>
                <span role="gridcell" className={`${styles.number} ${tone(row.netBbMilli)}`}>
                  {row.netBbMilli === null ? "—" : bigBlinds(row.netBbMilli)}
                </span>
                <span role="gridcell" className={styles.dim}>
                  {playedAt(row.lastPlayedAt)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {more ? (
        <button type="button" className={`chip-btn ${styles.more}`} onClick={onMore}>
          {p.showMore}
        </button>
      ) : null}
    </div>
  );
}
