/**
 * The bar above the Solver library's grid, as a solver's viewer has it: the
 * table card (format, players and stack depth, changed in a dialog) and one
 * card per decision in the order they are made (`SpotCard`): a seat that
 * acts twice has two. A past card shows every option the seat had, the one
 * it took highlighted - clicking its head shows that decision's range in the
 * grid, clicking another option takes it instead; the decision to make lists
 * its options to pick; after it, dashed, the decisions later seats would face
 * if everyone between folded.
 */

"use client";

import { Overlay } from "@rail/ui/overlay/Overlay";
import { useState } from "react";
import { useSolverDict } from "./host";
import type { PreflopState } from "./preflop";
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

interface PreflopBarProps {
  tables: readonly TableOption[];
  table: TableOption;
  onTable: (id: string) => void;
  state: PreflopState | null;
  onLine: (line: string) => void;
  /** The line of the past decision the grid shows instead of the one to make (null: the one to make). */
  viewing?: string | null;
  onView?: (line: string | null) => void;
}

export function PreflopBar({ tables, table, onTable, state, onLine, viewing = null, onView }: PreflopBarProps) {
  const t = useSolverDict();
  const [settings, setSettings] = useState(false);

  return (
    <div className={styles.bar}>
      <div className={styles.tableCard}>
        <span className={styles.tableKind}>{t.settings.cash}</span>
        <strong>
          {t.settings.summary(table.players, table.stackBb)}
          {table.format !== "classic" ? ` · ${t.settings[table.format]}` : ""}
        </strong>
        <button type="button" className="btn btn--sm" onClick={() => setSettings(true)}>
          {t.settings.change}
        </button>
      </div>

      <div className={styles.seats} role="group" aria-label={t.preflop.label}>
        {(state?.cards ?? []).map((card) => {
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
              className={`${styles.seat} ${shown ? styles.seatActing : ""} ${card.kind === "ahead" ? styles.seatLater : ""}`}
            >
              <button
                type="button"
                className={styles.seatHead}
                aria-pressed={shown}
                title={card.kind === "ahead" ? t.preflop.foldTo(card.node.actor) : t.preflop.show(card.node.actor)}
                onClick={look}
              >
                <strong>{card.node.actor}</strong>
                <span>{t.preflop.stack(card.stackBb)}</span>
              </button>
              <div className={styles.seatOptions}>
                {card.node.options.map((option) => {
                  const taken = card.chosen === option.code;
                  const other = card.kind === "ahead" || (card.kind === "past" && !taken);
                  return (
                    <button
                      key={option.code}
                      type="button"
                      className={`${styles.seatOption} ${taken ? styles.seatTaken : ""} ${other ? styles.seatAhead : ""}`}
                      aria-pressed={card.kind === "past" ? taken : undefined}
                      title={card.kind === "past" && !taken ? t.preflop.rewind(card.node.actor) : undefined}
                      onClick={() => onLine(card.line + option.code)}
                    >
                      {t.preflop.action(option.action, option.toBb)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {settings ? (
        <Overlay open onClose={() => setSettings(false)} title={t.settings.title}>
          <TableSettings
            tables={tables}
            table={table}
            onTable={(id) => {
              onTable(id);
            }}
          />
          <div className={styles.settingsFoot}>
            <button type="button" className="btn btn--primary" onClick={() => setSettings(false)}>
              {t.settings.done}
            </button>
          </div>
        </Overlay>
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
        <fieldset className={styles.segmentGroup}>
          <legend>{t.format}</legend>
          <div className={styles.segments}>
            {formats.map((format) => (
              <button
                key={format}
                type="button"
                className={`${styles.segment} ${format === table.format ? styles.segmentOn : ""}`}
                aria-pressed={format === table.format}
                onClick={() => {
                  const pool = tables.filter((x) => x.format === format);
                  const same = pool.find((x) => x.players === table.players && x.stackBb === table.stackBb);
                  onTable((same ?? pool.find((x) => x.players === table.players) ?? pool[0]).id);
                }}
              >
                {t[format]}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <fieldset className={styles.segmentGroup}>
        <legend>{t.players}</legend>
        <div className={styles.segments}>
          {counts.map((players) => (
            <button
              key={players}
              type="button"
              className={`${styles.segment} ${players === table.players ? styles.segmentOn : ""}`}
              aria-pressed={players === table.players}
              onClick={() => {
                const same = sameFormat.find((x) => x.players === players && x.stackBb === table.stackBb);
                onTable((same ?? sameFormat.find((x) => x.players === players)!).id);
              }}
            >
              {t.playersName(players)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.segmentGroup}>
        <legend>{t.depth}</legend>
        <div className={styles.segments}>
          {depths.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`${styles.segment} ${x.id === table.id ? styles.segmentOn : ""}`}
              aria-pressed={x.id === table.id}
              onClick={() => onTable(x.id)}
            >
              {t.depthName(x.stackBb)}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
