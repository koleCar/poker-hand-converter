/**
 * A lock row's full summary on hover (§7.1): the spot, the line, the locked
 * nodes with GTO → locked shifts, accuracy, time, engine and date. The locked
 * node is a link to the locked spot (§7.2). Placed beside the row, inside the
 * window.
 */
import { useLayoutEffect, useRef, useState } from "react";

import { useLocale, useT } from "../../../i18n";
import { liveDateFormat } from "../../../i18n/format";
import { nodelockSuggestEn, nodelockSuggestHr, type Archetype } from "../../door";
import type { NodeLockRow } from "../data";
import { boardText, parseRow } from "../session";
import { rangesLineage } from "../editor/ranges";
import { boardCards } from "./model";
import styles from "./tree.module.css";

const DATE = liveDateFormat({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const EDGE = 8;

export function HoverCard({
  row,
  progress = null,
  anchor,
  onGo,
  onEnter,
  onLeave,
}: {
  row: NodeLockRow;
  /** The solve running on this row, in words (`progressLine`), or null. */
  progress?: string | null;
  /** The row's box, in the window's pixels. */
  anchor: DOMRect;
  /** Opens the lock on its locked spot. */
  onGo: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const t = useT().nodelock;
  const locale = useLocale();
  const names = (locale === "hr" ? nodelockSuggestHr : nodelockSuggestEn).names;
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { offsetWidth: width, offsetHeight: height } = node;
    const right = anchor.right + EDGE;
    const left = right + width + EDGE > window.innerWidth ? Math.max(EDGE, anchor.left - width - EDGE) : right;
    const top = Math.max(EDGE, Math.min(anchor.top - 6, window.innerHeight - height - EDGE));
    setPlace({ top, left });
  }, [anchor]);

  const parsed = parseRow(row);
  const summary = parsed?.summary ?? null;
  const nodes = parsed?.lockSet.nodes.length ?? 0;
  const street = t.streets[row.street] ?? row.street;
  const steps = summary?.steps?.join(" · ") ?? "";
  const solved = row.status === "solved";

  return (
    <div
      ref={ref}
      className={styles.card}
      role="tooltip"
      style={place ? { top: place.top, left: place.left } : { top: anchor.top, left: anchor.right + EDGE, visibility: "hidden" }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className={styles.cardName}>{row.name}</div>
      <div className={styles.cardLine}>
        <span className={styles.cardBoard}>{boardText(boardCards(row))}</span>
        {summary ? (
          <span>
            {summary.players[0]} – {summary.players[1]}
          </span>
        ) : null}
        <span className={styles.cardMuted}>{row.line}</span>
      </div>
      {/* The ranges first: the lineage's first step (§9.3). */}
      {summary?.ranges?.length ? <div className={styles.cardMuted}>{rangesLineage(summary.ranges, t.ranges)}</div> : null}
      {summary && nodes > 0 ? (
        <button type="button" className={styles.cardNode} disabled={!solved} onClick={onGo} title={solved ? t.tree.toLockedSpot : undefined}>
          {t.nodeAt(summary.position, street, steps)}
        </button>
      ) : null}
      {summary?.shifts.length ? (
        <ul className={styles.cardShifts}>
          {summary.shifts.map((shift) => (
            <li key={shift.label}>{t.shift(shift.label, shift.gto, shift.locked)}</li>
          ))}
        </ul>
      ) : null}
      <div className={styles.cardMuted}>
        {[
          nodes > 1 ? t.tree.lockedNodes(nodes) : "",
          row.preset ? (names[row.preset as Archetype] ?? row.preset) : t.custom,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {solved && row.exploitability_pct !== null && row.seconds !== null ? (
        <div className={styles.cardMuted}>
          {t.solvedTo(row.exploitability_pct, row.seconds, row.engine ? (t.engines[row.engine] ?? row.engine) : "")}
        </div>
      ) : (
        <div className={progress ? styles.cardProgress : styles.cardMuted}>{progress ?? t.status[row.status] ?? row.status}</div>
      )}
      <div className={styles.cardMuted}>{DATE.format(row.created_at)}</div>
    </div>
  );
}
