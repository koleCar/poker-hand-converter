/**
 * The bar above the Solver library's grid, as a solver's viewer has it: the
 * table card (players and stack depth, changed in a dialog) and one card per
 * seat in preflop order. A seat that has acted shows every option it had,
 * the one it took highlighted - clicking that goes back to the decision,
 * clicking another takes it instead; the seat to act lists its options to pick;
 * the seats after it wait.
 */

"use client";

import { Overlay } from "@rail/ui/overlay/Overlay";
import { useState } from "react";
import type { ChartNode } from "../../lib/charts";
import { useSolverDict } from "./host";
import type { PreflopState } from "./preflop";
import styles from "./solver.module.css";

export interface TableOption {
  id: string;
  players: number;
  stackBb: number;
}

interface PreflopBarProps {
  tables: readonly TableOption[];
  table: TableOption;
  onTable: (id: string) => void;
  state: PreflopState | null;
  onLine: (line: string) => void;
}

export function PreflopBar({ tables, table, onTable, state, onLine }: PreflopBarProps) {
  const t = useSolverDict();
  const [settings, setSettings] = useState(false);
  const node: ChartNode | null = state?.node ?? null;

  return (
    <div className={styles.bar}>
      <div className={styles.tableCard}>
        <span className={styles.tableKind}>{t.settings.cash}</span>
        <strong>{t.settings.summary(table.players, table.stackBb)}</strong>
        <button type="button" className="btn btn--sm" onClick={() => setSettings(true)}>
          {t.settings.change}
        </button>
      </div>

      <div className={styles.seats} role="group" aria-label={t.preflop.label}>
        {(state?.seats ?? []).map((seat) => {
          const acting = node?.actor === seat.position;
          return (
            <div
              key={seat.position}
              className={`${styles.seat} ${acting ? styles.seatActing : ""} ${seat.folded ? styles.seatFolded : ""}`}
            >
              <div className={styles.seatHead}>
                <strong>{seat.position}</strong>
                <span>{t.preflop.stack(seat.stackBb)}</span>
              </div>
              {seat.acts.length > 0 || (acting && node) ? (
                <div className={styles.seatOptions}>
                  {seat.acts.map((act, n) => (
                    <div key={act.index} className={`${styles.seatGroup} ${n > 0 ? styles.seatDecision : ""}`}>
                      {act.node.options.map((option) => {
                        const taken = option.code === act.code;
                        return (
                          <button
                            key={option.code}
                            type="button"
                            className={`${styles.seatOption} ${taken ? styles.seatTaken : ""}`}
                            aria-pressed={taken}
                            title={taken ? t.preflop.rewind(seat.position) : undefined}
                            onClick={() => onLine(state!.line.slice(0, act.index) + (taken ? "" : option.code))}
                          >
                            {t.preflop.action(option.action, option.toBb)}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {acting && node ? (
                    <div className={`${styles.seatGroup} ${seat.acts.length > 0 ? styles.seatDecision : ""}`}>
                      {node.options.map((option) => (
                        <button
                          key={option.code}
                          type="button"
                          className={styles.seatOption}
                          onClick={() => onLine(state!.line + option.code)}
                        >
                          {t.preflop.action(option.action, option.toBb)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : seat.ahead ? (
                <div className={styles.seatOptions}>
                  {seat.ahead.node.options.map((option) => (
                    <button
                      key={option.code}
                      type="button"
                      className={`${styles.seatOption} ${styles.seatAhead}`}
                      title={t.preflop.foldTo(seat.position)}
                      onClick={() => onLine(seat.ahead!.line + option.code)}
                    >
                      {t.preflop.action(option.action, option.toBb)}
                    </button>
                  ))}
                </div>
              ) : (
                <div className={styles.seatOptions}>
                  <span className={styles.seatWaiting} aria-hidden="true">
                    —
                  </span>
                </div>
              )}
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
  const counts = [...new Set(tables.map((x) => x.players))].sort((a, b) => a - b);
  const depths = tables.filter((x) => x.players === table.players);
  return (
    <div className={styles.settings}>
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
                const same = tables.find((x) => x.players === players && x.stackBb === table.stackBb);
                onTable((same ?? tables.find((x) => x.players === players)!).id);
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
