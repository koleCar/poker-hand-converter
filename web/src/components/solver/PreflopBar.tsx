/**
 * The top of the Solver library ("Studio"): the table selector and the
 * action strip's preflop half.
 *
 * - `TableSelect`: `Cash · 6-max · 100 bb ⌄`, a popover of the format, the
 *   players and the stack depth.
 * - `Strip`: the action strip, one position card per decision in the order
 *   they are made, scrolled to keep the card being decided in view (the cut
 *   card fades out at a scrolled edge).
 * - `PreflopCards`: a card per preflop decision (`SpotCard`): a seat that acts
 *   twice has two. A past card lists every option the seat had with its
 *   share, the one taken highlighted - its head shows that decision's range
 *   in the grid, another option takes it instead; the decision to make lists
 *   its options to pick; after it, dashed, the decisions later seats would
 *   face if everyone between folded. Once the line has reached a solved flop
 *   the preflop folds into one summary card (`Preflop · BTN Raise 2.5 · BB
 *   Call · UTG, HJ, CO, SB fold`), opened again by a click.
 */

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { actionTotals, playedOptions } from "../analysis/chartSpots";
import { useSolverDict } from "./host";
import type { PreflopState } from "./preflop";
import { actionColours } from "./StrategyView";
import { ChevronDown, Popover, Segmented } from "./ui";
import styles from "./solver.module.css";

/** A table's game: no ante or straddle, an ante from every seat, or a straddle (`chartSetKind`). */
export type TableFormat = "classic" | "ante" | "straddle";
const FORMATS: readonly TableFormat[] = ["classic", "ante", "straddle"];

export interface TableOption {
  id: string;
  players: number;
  stackBb: number;
  format: TableFormat;
}

/**
 * Marks the strip's scrolled-off sides (`data-more`): the cut card fades out
 * there, so a narrow strip reads as scrolled, not broken.
 */
function edges(element: HTMLElement) {
  const left = element.scrollLeft > 1;
  const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
  const more = left && right ? "both" : left ? "left" : right ? "right" : "";
  if ((element.dataset.more ?? "") !== more) {
    if (more) element.dataset.more = more;
    else delete element.dataset.more;
  }
}

/** The action strip: the cards in a row that scrolls, the one being decided (`data-current`) kept in view. */
export function Strip({ children, label }: { children: ReactNode; label: string }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const current = element.querySelector<HTMLElement>("[data-current]");
    if (current) {
      const outer = element.getBoundingClientRect();
      const inner = current.getBoundingClientRect();
      if (inner.right > outer.right) element.scrollLeft += inner.right - outer.right + 8;
      else if (inner.left < outer.left) element.scrollLeft -= outer.left - inner.left + 8;
    }
    edges(element);
  });
  return (
    <div className={styles.strip} ref={bar} role="group" aria-label={label} onScroll={(event) => edges(event.currentTarget)}>
      {children}
    </div>
  );
}

/** The table: its summary as a button, the format, players and depth in a popover under it. */
export function TableSelect({ tables, table, onTable }: { tables: readonly TableOption[]; table: TableOption; onTable: (id: string) => void }) {
  const t = useSolverDict();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className={styles.anchor}>
      <button
        ref={button}
        type="button"
        className={styles.selector}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t.top.table}
        onClick={() => setOpen((x) => !x)}
      >
        {t.settings.cash} · {t.settings.summary(table.players, table.stackBb)}
        {table.format !== "classic" ? ` · ${t.settings[table.format]}` : ""}
        <ChevronDown />
      </button>
      {open ? (
        <Popover label={t.settings.title} anchor={button} onClose={() => setOpen(false)}>
          <TableSettings tables={tables} table={table} onTable={onTable} />
        </Popover>
      ) : null}
    </div>
  );
}

function TableSettings({ tables, table, onTable }: { tables: readonly TableOption[]; table: TableOption; onTable: (id: string) => void }) {
  const t = useSolverDict().settings;
  const formats = FORMATS.filter((f) => tables.some((x) => x.format === f));
  const sameFormat = tables.filter((x) => x.format === table.format);
  const counts = [...new Set(sameFormat.map((x) => x.players))].sort((a, b) => a - b);
  const depths = sameFormat.filter((x) => x.players === table.players);
  return (
    <div className={styles.settings}>
      {formats.length > 1 ? (
        <div className={styles.settingsRow}>
          <span>{t.format}</span>
          <Segmented
            label={t.format}
            size="sm"
            value={table.format}
            options={formats.map((format) => ({ value: format, label: t[format] }))}
            onChange={(format) => {
              const pool = tables.filter((x) => x.format === format);
              const same = pool.find((x) => x.players === table.players && x.stackBb === table.stackBb);
              onTable((same ?? pool.find((x) => x.players === table.players) ?? pool[0]).id);
            }}
          />
        </div>
      ) : null}
      <div className={styles.settingsRow}>
        <span>{t.players}</span>
        <Segmented
          label={t.players}
          size="sm"
          value={String(table.players)}
          options={counts.map((players) => ({ value: String(players), label: t.playersName(players) }))}
          onChange={(value) => {
            const players = Number(value);
            const same = sameFormat.find((x) => x.players === players && x.stackBb === table.stackBb);
            onTable((same ?? sameFormat.find((x) => x.players === players)!).id);
          }}
        />
      </div>
      <div className={styles.settingsRow}>
        <span>{t.depth}</span>
        <Segmented
          label={t.depth}
          size="sm"
          value={table.id}
          options={depths.map((x) => ({ value: x.id, label: t.depthName(x.stackBb) }))}
          onChange={onTable}
        />
      </div>
    </div>
  );
}

interface PreflopCardsProps {
  state: PreflopState | null;
  onLine: (line: string) => void;
  /** The line of the past decision the grid shows instead of the one to make (null: the one to make). */
  viewing?: string | null;
  onView?: (line: string | null) => void;
  /** Fold the preflop into one summary card (the line has reached a solved flop); a click opens it. */
  folded?: boolean;
  onUnfold?: () => void;
}

export function PreflopCards({ state, onLine, viewing = null, onView, folded = false, onUnfold }: PreflopCardsProps) {
  const t = useSolverDict();
  if (!state) return null;
  if (folded) {
    const acts = state.cards.filter((card) => card.kind === "past" && card.chosen !== "f");
    const folds = state.seats.filter((seat) => seat.folded).map((seat) => seat.position);
    return (
      <button type="button" className={`${styles.pcard} ${styles.pcardSummary}`} title={t.preflop.expand} onClick={onUnfold}>
        <span className={styles.pcardHead}>
          {t.preflop.name}
          <span className={styles.pcardPot}>{t.preflop.stack(state.potBb)}</span>
        </span>
        {acts.map((card) => {
          const option = card.node.options.find((o) => o.code === card.chosen)!;
          return (
            <span key={card.line} className={styles.pcardLine}>
              <b>{card.node.actor}</b>
              {t.preflop.action(option.action, option.toBb)}
            </span>
          );
        })}
        {folds.length ? <span className={`${styles.pcardLine} ${styles.pcardQuiet}`}>{t.preflop.folds(folds.join(", "))}</span> : null}
      </button>
    );
  }
  return (
    <>
      {state.cards.map((card) => {
        const played = playedOptions(card.node);
        const totals = actionTotals(card.node);
        const colours = actionColours(card.node.options.map((o) => ({ kind: o.action, amount: o.toBb })));
        // The card whose decision the grid shows: the one being looked back at, else the one to act.
        const shown = viewing !== null ? card.kind === "past" && card.line === viewing : card.kind === "current";
        const look = () => {
          if (card.kind === "past") onView?.(card.line);
          else if (card.kind === "current") onView?.(null);
          else onLine(card.line);
        };
        return (
          <div
            key={`${card.kind}:${card.line}`}
            data-current={card.kind === "current" || undefined}
            className={`${styles.pcard} ${shown ? styles.pcardActing : ""} ${card.kind === "ahead" ? styles.pcardLater : ""}`}
          >
            <button
              type="button"
              className={styles.pcardHead}
              aria-pressed={shown}
              title={card.kind === "ahead" ? t.preflop.foldTo(card.node.actor) : t.preflop.show(card.node.actor)}
              onClick={look}
            >
              {card.node.actor}
              <span className={styles.pcardPot}>{t.preflop.stack(card.node.potBb)}</span>
            </button>
            {card.node.options.map((option, a) => {
              const taken = card.chosen === option.code;
              // An option no hand takes is not one to offer - unless the line took it.
              if (!taken && !played[a]) return null;
              const other = card.kind === "ahead" || (card.kind === "past" && !taken);
              return (
                <button
                  key={option.code}
                  type="button"
                  className={`${styles.opt} ${taken ? styles.optTaken : ""} ${other ? styles.optOther : ""}`}
                  aria-pressed={card.kind === "past" ? taken : undefined}
                  title={card.kind === "past" && !taken ? t.preflop.rewind(card.node.actor) : undefined}
                  onClick={() => onLine(card.line + option.code)}
                >
                  <span className={`${styles.optDot} ${colours[a]}`} aria-hidden="true" />
                  <span className={styles.optLabel}>{t.preflop.action(option.action, option.toBb)}</span>
                  <span className={styles.optShare}>{t.shareOnly(totals[a].share)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
