/**
 * The hand list, virtualised: rows have one fixed height, so the list is a
 * spacer as tall as every loaded row and only the rows in view (and a few
 * beyond) are in the DOM - a few dozen elements whether 300 or 500 000
 * hands are loaded. Scrolling near the end of what is loaded asks for the
 * next page.
 *
 * Keyboard: the list is an ARIA grid with one focusable row (roving
 * tabindex). Up / Down (and Page Up / Page Down) move the selection, which
 * opens the hand beside the list; Enter moves focus into the replayer, whose
 * keys (←/→, space, Home/End) then work as on the web.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";

import { useT } from "../../i18n";
import type { HandRow } from "../../lib/ipc";
import { bigBlinds, playedAt, signedMoney, stakes, unitOf } from "./format";
import styles from "./HandList.module.css";

/** Every row's height in px (`--row` in the stylesheet). */
export const ROW_HEIGHT = 40;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 8;
/** Ask for the next page when the view is this many rows from the end. */
const PREFETCH_ROWS = 60;

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
  onLoadMore: () => void;
}

export function HandList({
  rows,
  hasMore,
  loadingMore,
  total,
  selected,
  onSelect,
  onOpen,
  onLoadMore,
}: HandListProps) {
  const t = useT().hands;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  // A row to focus once it is rendered (keyboard moves).
  const focusKey = useRef<string | null>(null);

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (node) {
      setView({ top: node.scrollTop, height: node.clientHeight });
    }
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  // A new list (another filter) starts at the top.
  const firstKey = rows[0]?.handKey ?? null;
  const previousFirst = useRef(firstKey);
  useEffect(() => {
    if (previousFirst.current !== firstKey && rows.length <= 300) {
      const node = scrollRef.current;
      // Hands that arrived on top keep the reader where they were, unless
      // they were at the top already.
      if (node && node.scrollTop < ROW_HEIGHT) node.scrollTop = 0;
    }
    previousFirst.current = firstKey;
  }, [firstKey, rows.length]);

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
      const headerHeight = ROW_HEIGHT;
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
      onScroll={measure}
      role="grid"
      aria-label={t.listLabel}
      aria-rowcount={total !== null ? total + 1 : -1}
      aria-busy={loadingMore}
    >
      <div className={`${styles.row} ${styles.head}`} role="row" aria-rowindex={1}>
        <span role="columnheader">{t.columns.date}</span>
        <span role="columnheader">{t.columns.room}</span>
        <span role="columnheader">{t.columns.stakes}</span>
        <span role="columnheader">{t.columns.position}</span>
        <span role="columnheader">{t.columns.cards}</span>
        <span role="columnheader">{t.columns.board}</span>
        <span role="columnheader" className={styles.num}>
          {t.columns.result}
        </span>
        <span role="columnheader" className={styles.num}>
          {t.columns.bigBlinds}
        </span>
        <span role="columnheader">{t.columns.marks}</span>
      </div>
      <div className={styles.body} style={{ height: (rows.length + (hasMore ? 1 : 0)) * ROW_HEIGHT }}>
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          return (
            <Row
              key={row.handKey}
              row={row}
              index={index}
              selected={row.handKey === selected}
              tabbable={index === tabbable}
              onSelect={onSelect}
              onKeyDown={onKeyDown}
            />
          );
        })}
        {hasMore ? (
          <div className={styles.more} style={{ top: rows.length * ROW_HEIGHT }} role="row">
            <span role="gridcell">{loadingMore ? t.loadingMore : null}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface RowProps {
  row: HandRow;
  index: number;
  selected: boolean;
  tabbable: boolean;
  onSelect: (handKey: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number, row: HandRow) => void;
}

function Row({ row, index, selected, tabbable, onSelect, onKeyDown }: RowProps) {
  const t = useT().hands;
  const unit = unitOf(row);
  const date = playedAt(row.playedAt);
  const blinds = stakes(row);
  const result = row.heroNet === null ? t.noHero : signedMoney(unit, row.heroNet);
  const tone =
    row.heroNet === null || row.heroNet === 0 ? styles.even : row.heroNet > 0 ? styles.won : styles.lost;
  let allIn: string | null = null;
  if (row.allIn) {
    allIn = row.evPending
      ? t.allInPending
      : row.evNetBbMilli !== null
        ? t.allInEv(bigBlinds(row.evNetBbMilli))
        : t.allIn;
  }
  return (
    <div
      className={`${styles.row} ${selected ? styles.selected : ""}`}
      style={{ top: index * ROW_HEIGHT }}
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
      <span role="gridcell" className={styles.room} title={`${row.siteName} ${t.handId(row.siteHandId)}`}>
        {row.siteName}
        <small>{t.handId(row.siteHandId)}</small>
      </span>
      <span role="gridcell" className={styles.stakes}>
        {blinds}
      </span>
      <span role="gridcell" className={styles.position}>
        {row.heroPosition ?? t.noHero}
      </span>
      <span role="gridcell">
        {row.heroCards.length > 0 ? <CardRow cards={row.heroCards} size="xs" /> : <span className={styles.dim}>{t.noCards}</span>}
      </span>
      <span role="gridcell">
        {row.board.length > 0 ? <CardRow cards={row.board} size="xs" /> : <span className={styles.dim}>{t.preflop}</span>}
      </span>
      <span role="gridcell" className={`${styles.num} ${tone}`}>
        {result}
      </span>
      <span role="gridcell" className={`${styles.num} ${tone}`}>
        {row.heroNetBbMilli === null ? t.noHero : bigBlinds(row.heroNetBbMilli)}
      </span>
      <span role="gridcell" className={styles.marks}>
        {allIn !== null ? (
          <span className={`${styles.mark} ${styles.allIn}`} title={allIn}>
            {row.evNetBbMilli !== null && !row.evPending ? t.evShort(bigBlinds(row.evNetBbMilli)) : t.allIn}
          </span>
        ) : null}
        {row.showdown ? <span className={styles.mark}>{t.showdown}</span> : null}
        {row.hasNote ? (
          <span className={styles.mark} title={t.hasNote} aria-label={t.hasNote}>
            ✎
          </span>
        ) : null}
        {row.tags.map((tag) => (
          <span key={tag} className={`${styles.mark} ${styles.tag}`}>
            {tag}
          </span>
        ))}
      </span>
    </div>
  );
}
