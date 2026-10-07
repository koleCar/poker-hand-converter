"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReplayFrame } from "../../lib/replay";
import { ReplayTable, type TableHand } from "../replayer/ReplayTable";
import { DEFAULT_REPLAY_SETTINGS } from "../replayer/replaySettings";
import { shapeFor, type TableShape } from "../replayer/seatLayout";
import type { AmountFormatter } from "../replayer/tableMath";
import styles from "./manual.module.css";

interface ManualTableProps {
  hand: TableHand;
  frame: ReplayFrame;
  format: AmountFormatter;
  selectedSeat: number | null;
  onSeatClick: (seat: number) => void;
  onBoardClick: () => void;
}

const IDENTITY = { seat: (name: string) => name, text: (value: string) => value, tableName: null };

/**
 * The replayer's felt, live: the same `ReplayTable` inside the same `.rp` /
 * `.rp__stage` boxes the replayer uses, so the stylesheet treats it exactly
 * the same. The shape is measured off the stage the way `ReplayViewer` does.
 */
export function ManualTable({ hand, frame, format, selectedSeat, onSeatClick, onBoardClick }: ManualTableProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [shape, setShape] = useState<TableShape>("classic");

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      setShape(shapeFor(box.width, box.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Every card the editor knows is shown face up; the replayer's spoiler
  // settings do not apply to a hand you are typing in yourself.
  const settings = useMemo(() => ({ ...DEFAULT_REPLAY_SETTINGS, showHeroCards: true }), []);

  return (
    <div
      className={`rp ${styles.tableBox}`}
      data-shape={shape}
      data-motion="none"
      // The replayer's grid has a header and a transport row; this box has the
      // stage alone. Inline so it outranks `.rp`'s own `--rp-block` default
      // whatever order the stylesheets load in.
      style={{ gridTemplateRows: "minmax(0, 1fr)", "--rp-block": "clamp(20rem, 64svh, 40rem)" } as React.CSSProperties}
    >
      <div className="rp__stage" ref={stageRef}>
        <ReplayTable
          hand={hand}
          frame={frame}
          shape={shape}
          motion="none"
          settings={settings}
          mask={IDENTITY}
          format={format}
          focusSeat={selectedSeat}
          onSeatClick={onSeatClick}
          onBoardClick={onBoardClick}
        />
      </div>
    </div>
  );
}
