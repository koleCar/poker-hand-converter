/**
 * My nodelocks as two columns (§7.1): the tree on the left (resizable,
 * hidden to a thin strip like the app's sidebar) and the open lock's solve on
 * the right, so going back to an older lock is one click. The width and
 * hidden state are remembered.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { useT } from "../../../i18n";
import { NodelockTree } from "./NodelockTree";
import { clampWidth, readHidden, readWidth, TREE_WIDTH, writeHidden, writeWidth } from "./persist";
import styles from "./tree.module.css";

export function NodelockSplit({ openId, children }: { openId: string | null; children: ReactNode }) {
  const tt = useT().nodelock.tree;
  const [width, setWidth] = useState(readWidth);
  const [hidden, setHidden] = useState(readHidden);
  const resize = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => writeHidden(hidden), [hidden]);

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { x: event.clientX, width };
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = resize.current;
    if (at) setWidth(clampWidth(at.width + event.clientX - at.x));
  };
  const onUp = () => {
    if (!resize.current) return;
    resize.current = null;
    writeWidth(width);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = clampWidth(width + (event.key === "ArrowRight" ? step : -step));
    setWidth(next);
    writeWidth(next);
  };

  return (
    <div className={styles.split} style={{ gridTemplateColumns: hidden ? "auto minmax(0, 1fr)" : `${width}px minmax(0, 1fr)` }}>
      {hidden ? (
        <div className={styles.strip}>
          <button type="button" className={styles.tool} title={tt.show} aria-label={tt.show} onClick={() => setHidden(false)}>
            <Icon name="sidebar" />
          </button>
        </div>
      ) : (
        <aside className={styles.side}>
          <NodelockTree openId={openId} onHide={() => setHidden(true)} />
          <div
            className={styles.handle}
            role="separator"
            aria-orientation="vertical"
            aria-label={tt.resize}
            aria-valuemin={TREE_WIDTH.min}
            aria-valuemax={TREE_WIDTH.max}
            aria-valuenow={width}
            title={tt.resize}
            tabIndex={0}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey}
          />
        </aside>
      )}
      <div className={styles.solve}>{children}</div>
    </div>
  );
}
