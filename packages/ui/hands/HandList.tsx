/**
 * The hand list, virtualised: rows have one fixed height - `--row`, the
 * density's on the desktop (R2.8), taller where the list is narrow and each
 * row becomes a two-line card (R4.5b, a phone) - read back from the
 * stylesheet, so the list is a spacer as tall as every loaded row and only the
 * rows in view (and a few beyond) are in the DOM - a few dozen elements
 * whether 300 or 500 000 hands are loaded. Scrolling near the end of what is
 * loaded asks for the next page.
 *
 * Keyboard: the list is an ARIA grid with one focusable row (roving
 * tabindex). Up / Down (and Page Up / Page Down) move the selection, which
 * opens the hand; Enter moves focus into the replayer, whose keys (←/→,
 * space, Home/End) then work.
 *
 * The desktop app's (R2.7a); in the shared package since R4.5b.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CardRow } from "../cards/PlayingCard";
import { useUiStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import { useListEnter } from "../loader/useListEnter";
import { handFormat, money as moneyText, signedMoney, stakes, unitOf, type HandFormat } from "./format";
import styles from "./HandList.module.css";
import type { HandRow, HandSort } from "./model";

/** Rows rendered above and below the visible ones. */
/** A sortable column's orders: the first click's, then the other direction's. */
type SortColumn = "date" | "stakes" | "position" | "pot" | "result";
const COLUMN_SORTS: Record<SortColumn, readonly [HandSort, HandSort]> = {
  date: ["newest", "oldest"],
  stakes: ["stakes", "stakesAsc"],
  position: ["position", "positionDesc"],
  pot: ["pot", "potAsc"],
  result: ["won", "lost"],
};

const OVERSCAN = 8;
/** Ask for the next page when the view is this many rows from the end. */
const PREFETCH_ROWS = 60;
/** Until the stylesheet is read. */
const FALLBACK_ROW = 40;

interface HandListProps {
  rows: HandRow[];
  hasMore: boolean;
  loadingMore: boolean;
  /** Hands the filter matches, when counted. */
  total: number | null;
  selected: string | null;
  onSelect: (handKey: string) => void;
  /** Enter on a row: the reader wants the replayer. */
  onOpen: (handKey: string) => void;
  /** A click opens too, not only Enter (the desktop: the replayer's own window). */
  openOnClick?: boolean;
  onLoadMore: () => void;
  /** The list's order, in words, for its accessible name ("Newest first"). */
  orderLabel: string;
  /** The order in force, and the ones the source can give: their columns' headers sort. */
  sort?: HandSort;
  sorts?: readonly HandSort[];
  onSort?: (sort: HandSort) => void;
  /** The pots and results in big blinds or in each hand's money (the screen's switch). */
  unit?: "bb" | "money";
  /**
   * Changes when the surface changes the row height without resizing the
   * list (the desktop's density setting): the height is read again.
   */
  densityKey?: unknown;
  /**
   * Names the list shown (its filter): a new value lets the rows in view
   * arrive again (`.rail-stagger`); a reload of the same list does not.
   */
  enterKey?: unknown;
}

export function HandList({
  rows,
  hasMore,
  loadingMore,
  total,
  selected,
  onSelect,
  onOpen,
  openOnClick = false,
  onLoadMore,
  orderLabel,
  sort = "newest",
  sorts = ["newest"],
  onSort,
  unit = "money",
  densityKey,
  enterKey,
}: HandListProps) {
  const strings = useUiStrings();
  const t = strings.hands;
  const format = useMemo(() => handFormat(strings.intlLocale), [strings.intlLocale]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [ROW_HEIGHT, setRowHeight] = useState(FALLBACK_ROW);
  // A row to focus once it is rendered (keyboard moves).
  const focusKey = useRef<string | null>(null);
  const enter = useListEnter(enterKey);

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (node) {
      setView({ top: node.scrollTop, height: node.clientHeight });
    }
    const probe = probeRef.current?.offsetHeight;
    if (probe) {
      setRowHeight(probe);
    }
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, densityKey]);

  // Another row height: the same row stays at the top of the view.
  const previousRow = useRef(ROW_HEIGHT);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && previousRow.current !== ROW_HEIGHT) {
      node.scrollTop = (node.scrollTop / previousRow.current) * ROW_HEIGHT;
      previousRow.current = ROW_HEIGHT;
      measure();
    }
  }, [ROW_HEIGHT, measure]);

  // A new list (another filter) starts at the top.
  const firstKey = rows[0]?.handKey ?? null;
  const previousFirst = useRef(firstKey);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const before = previousFirst.current;
    if (node && before !== firstKey) {
      // Hands that arrived on top: a reader down the list keeps the rows they
      // were looking at (the view moves down by what arrived); one at the top
      // sees them come in.
      const arrived = before === null ? -1 : rows.findIndex((row) => row.handKey === before);
      if (arrived > 0 && node.scrollTop >= ROW_HEIGHT) {
        node.scrollTop += arrived * ROW_HEIGHT;
      } else if (node.scrollTop < ROW_HEIGHT || arrived < 0) {
        node.scrollTop = 0;
      }
    }
    previousFirst.current = firstKey;
  }, [firstKey, rows, ROW_HEIGHT]);

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    if (hasMore && !loadingMore && last + PREFETCH_ROWS >= rows.length) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, last, rows.length, onLoadMore]);

  // Focus the row a keyboard move selected, once it is in the DOM.
  useEffect(() => {
    const key = focusKey.current;
    if (key === null || key !== selected) return;
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (node) {
      node.focus({ preventScroll: true });
      focusKey.current = null;
    }
  });

  const selectedIndex = selected === null ? -1 : rows.findIndex((row) => row.handKey === selected);

  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    const node = scrollRef.current;
    if (node) {
      const at = rows.indexOf(row) * ROW_HEIGHT;
      const headerHeight = node.querySelector<HTMLElement>(`.${styles.head}`)?.offsetHeight ?? 0;
      if (at < node.scrollTop) {
        node.scrollTop = at;
      } else if (at + ROW_HEIGHT > node.scrollTop + node.clientHeight - headerHeight) {
        node.scrollTop = at + ROW_HEIGHT - node.clientHeight + headerHeight;
      }
    }
    focusKey.current = row.handKey;
    onSelect(row.handKey);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, row: HandRow) => {
    const page = Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 2);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(index - 1);
        break;
      case "PageDown":
        event.preventDefault();
        moveTo(index + page);
        break;
      case "PageUp":
        event.preventDefault();
        moveTo(index - page);
        break;
      case "Enter":
        event.preventDefault();
        onSelect(row.handKey);
        onOpen(row.handKey);
        break;
      default:
    }
  };

  // The one row in the tab order: the selected one, else the first.
  const tabbable = selectedIndex >= 0 ? selectedIndex : 0;

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      onScroll={(event) => {
        measure();
        // The reader scrolled (not the list going back to the top): rows just appear.
        if (event.currentTarget.scrollTop > 0) enter.stop();
      }}
      role="grid"
      aria-label={t.listLabel(orderLabel)}
      aria-rowcount={total !== null ? total + 1 : -1}
      aria-busy={loadingMore}
    >
      <div className={`${styles.row} ${styles.head}`} role="row" aria-rowindex={1}>
        <Header column="date" label={t.columns.date} className={styles.date} sort={sort} sorts={sorts} onSort={onSort} />
        <Header column="stakes" label={t.columns.stakes} className={styles.stakes} sort={sort} sorts={sorts} onSort={onSort} />
        <Header column="position" label={t.columns.position} className={styles.position} sort={sort} sorts={sorts} onSort={onSort} />
        <span role="columnheader" className={styles.cards}>
          {t.columns.cards}
        </span>
        <span role="columnheader" className={styles.board}>
          {t.columns.board}
        </span>
        <Header column="pot" label={t.columns.pot} className={`${styles.num} ${styles.pot}`} sort={sort} sorts={sorts} onSort={onSort} />
        <Header column="result" label={t.columns.result} className={`${styles.num} ${styles.result}`} sort={sort} sorts={sorts} onSort={onSort} />
        <span role="columnheader" className={styles.marks}>
          {t.columns.marks}
        </span>
        <span role="columnheader" className={styles.arrow}>
          <span className={styles.visuallyHidden}>{t.columns.open}</span>
        </span>
      </div>
      <div
        key={enter.enterKey}
        className={`${styles.body} ${enter.staggerClass}`}
        style={{ height: (rows.length + (hasMore ? 1 : 0)) * ROW_HEIGHT }}
      >
        <div ref={probeRef} className={styles.probe} aria-hidden="true" />
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          return (
            <Row
              key={row.handKey}
              row={row}
              index={index}
              top={index * ROW_HEIGHT}
              selected={row.handKey === selected}
              tabbable={index === tabbable}
              format={format}
              unit={unit}
              onSelect={
                openOnClick
                  ? (handKey: string) => {
                      onSelect(handKey);
                      onOpen(handKey);
                    }
                  : onSelect
              }
              onKeyDown={onKeyDown}
            />
          );
        })}
        {hasMore ? (
          <div className={styles.more} style={{ top: rows.length * ROW_HEIGHT }} role="row">
            <span role="gridcell">
              {loadingMore ? <RailLoader size="inline" label={t.loadingMore} showLabel /> : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A column header: a button that sorts by it where the source can (the first
 * click's order, then the other direction's), plain words where it cannot.
 */
function Header({
  column,
  label,
  className,
  sort,
  sorts,
  onSort,
}: {
  column: SortColumn;
  label: string;
  className: string;
  sort: HandSort;
  sorts: readonly HandSort[];
  onSort: ((sort: HandSort) => void) | undefined;
}) {
  const t = useUiStrings().hands;
  const [first, second] = COLUMN_SORTS[column];
  const offered = [first, second].filter((value) => sorts.includes(value));
  const active = sort === first ? "first" : sort === second ? "second" : null;
  const descending = column === "position" ? active === "second" : active === "first";
  if (!onSort || offered.length === 0) {
    return (
      <span role="columnheader" className={className}>
        {label}
      </span>
    );
  }
  const next = active === "first" && sorts.includes(second) ? second : active === "second" && sorts.includes(first) ? first : (offered[0] as HandSort);
  return (
    <span
      role="columnheader"
      className={className}
      aria-sort={active === null ? "none" : descending ? "descending" : "ascending"}
    >
      <button
        type="button"
        className={active === null ? styles.sort : `${styles.sort} ${styles.sorted}`}
        title={active === null ? t.sortable(label) : t.sortBy(label, descending ? t.descending : t.ascending)}
        onClick={() => onSort(next)}
      >
        {label}
        <span className={styles.sortMark} aria-hidden="true">
          {active === null ? "↕" : descending ? "↓" : "↑"}
        </span>
      </button>
    </span>
  );
}

interface RowProps {
  row: HandRow;
  index: number;
  /** Where the row sits in the spacer, px. */
  top: number;
  selected: boolean;
  tabbable: boolean;
  format: HandFormat;
  unit: "bb" | "money";
  onSelect: (handKey: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number, row: HandRow) => void;
}

function Row({ row, index, top, selected, tabbable, format, unit, onSelect, onKeyDown }: RowProps) {
  const t = useUiStrings().hands;
  const money = unitOf(row);
  const date = format.playedAt(row.playedAt);
  const blinds = stakes(row);
  const inMoney = unit === "money" && row.heroNet !== null;
  const value = inMoney ? row.heroNet : row.heroNetBbMilli;
  const result =
    value === null ? t.noHero : inMoney ? signedMoney(money, value) : `${format.bigBlinds(value)} bb`;
  const tone = value === null || value === 0 ? styles.even : value > 0 ? styles.won : styles.lost;
  // The pot follows the screen's switch too: the hand's money, or big blinds.
  const pot =
    unit === "money"
      ? moneyText(money, row.totalPot)
      : row.bigBlind > 0
        ? `${format.pot(row.totalPot / row.bigBlind)} bb`
        : t.noHero;
  // An all-in's EV is the result's tooltip, not a mark (2026-11-05).
  let resultTitle: string | undefined;
  if (row.allIn) {
    resultTitle = row.evPending
      ? t.allInPending
      : row.evNetBbMilli !== null
        ? t.allInEv(format.bigBlinds(row.evNetBbMilli))
        : t.allIn;
  }
  return (
    <div
      className={`${styles.row} ${selected ? styles.selected : ""}`}
      style={{ top }}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-label={t.rowLabel(date, row.siteName, blinds, result)}
      tabIndex={tabbable ? 0 : -1}
      data-key={row.handKey}
      onClick={() => onSelect(row.handKey)}
      onKeyDown={(event) => onKeyDown(event, index, row)}
    >
      <span role="gridcell" className={styles.date}>
        {date}
      </span>
      <span
        role="gridcell"
        className={styles.stakes}
        title={row.siteHandId ? `${row.siteName} ${t.handId(row.siteHandId)}` : row.siteName}
      >
        <span className={styles.stakesValue}>{blinds}</span>
        <small className={styles.roomName}>{row.siteName}</small>
      </span>
      <span role="gridcell" className={styles.position}>
        {row.heroPosition ?? t.noHero}
      </span>
      <span role="gridcell" className={styles.cards}>
        {row.heroCards.length > 0 ? (
          <CardRow cards={row.heroCards} size="xs" />
        ) : (
          <span className={styles.dim}>{t.noCards}</span>
        )}
      </span>
      <span role="gridcell" className={styles.board}>
        {row.board.length > 0 ? <CardRow cards={row.board} size="xs" /> : <span className={styles.dim}>{t.preflop}</span>}
      </span>
      <span role="gridcell" className={`${styles.num} ${styles.pot}`}>
        {pot}
      </span>
      <span role="gridcell" className={`${styles.num} ${styles.result} ${tone}`} title={resultTitle}>
        {result}
      </span>
      <span role="gridcell" className={styles.marks}>
        {row.positionalNames ? (
          <span className={styles.mark} title={t.positionalNamesTitle}>
            {t.positionalNames}
          </span>
        ) : null}
        {row.hasNote ? (
          <span className={styles.mark} title={t.hasNote} aria-label={t.hasNote}>
            ✎
          </span>
        ) : null}
        {row.tags.length > 0 ? (
          <span className={`${styles.mark} ${styles.tag}`} title={row.tags.join(", ")}>
            #{row.tags.length}
          </span>
        ) : null}
      </span>
      <span role="gridcell" className={styles.arrow} aria-hidden="true">
        ›
      </span>
    </div>
  );
}
