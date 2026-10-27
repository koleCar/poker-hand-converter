"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import styles from "./manual.module.css";

interface ActionBubbleProps {
  /** The element the table is drawn in; the seat is looked up inside it. */
  tableRef: RefObject<HTMLElement | null>;
  seat: number;
  /** Changes whenever the table may have moved under the bubble. */
  layoutKey: string;
  children: ReactNode;
}

interface Placement {
  left: number;
  top: number;
  /** Bubble sits above the seat (tail pointing down) or below it. */
  above: boolean;
  /** Tail position along the bubble, px from its left edge. */
  tail: number;
}

const GAP = 10;
const MARGIN = 8;

/**
 * A speech bubble next to a seat on the felt, holding that player's options.
 *
 * Rendered into `document.body` with fixed coordinates measured off the seat
 * (`[data-seat-no]`, set by `ReplayTable`), because the felt clips its
 * overflow and a bubble near the rail would otherwise be cut in half. It goes
 * on the side of the seat facing the middle of the table: above the bottom
 * seats, below the top ones.
 */
export function ActionBubble({ tableRef, seat, layoutKey, children }: ActionBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const table = tableRef.current;
    const bubble = bubbleRef.current;
    if (!table || !bubble) return;
    const measure = () => {
      // The whole seat, cards included, so the bubble never covers the hand.
      const node = table.querySelector<HTMLElement>(`[data-seat-no="${seat}"]`);
      if (!node) return;
      const seatBox = node.getBoundingClientRect();
      const tableBox = table.getBoundingClientRect();
      const width = bubble.offsetWidth;
      const height = bubble.offsetHeight;
      const centre = seatBox.left + seatBox.width / 2;
      const left = Math.max(MARGIN, Math.min(window.innerWidth - width - MARGIN, centre - width / 2));
      const lowerHalf = seatBox.top + seatBox.height / 2 > tableBox.top + tableBox.height / 2;
      // Prefer the side facing the middle; fall back when the viewport has no room.
      const roomAbove = seatBox.top - GAP - height >= MARGIN;
      const roomBelow = seatBox.bottom + GAP + height <= window.innerHeight - MARGIN;
      const above = lowerHalf ? roomAbove || !roomBelow : !roomBelow && roomAbove;
      const top = above ? seatBox.top - GAP - height : seatBox.bottom + GAP;
      setPlace({ left, top, above, tail: Math.max(14, Math.min(width - 14, centre - left)) });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(table);
    observer?.observe(bubble);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [tableRef, seat, layoutKey]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={bubbleRef}
      className={`${styles.bubble} ${place?.above === false ? styles.bubbleBelow : ""}`}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? "visible" : "hidden",
        ["--tail" as string]: `${place?.tail ?? 0}px`,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
