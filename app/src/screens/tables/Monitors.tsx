/**
 * (T5) The displays, each to one scale side by side (`previewLayout`), with
 * the tables tiling manages as felt boxes named by room and table; a stack
 * as one box with its count; a table moved by hand dashed. Under each, its
 * number, resolution and how many tables it holds. Nothing until the HUD
 * has said which displays there are.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

import { useT } from "../../i18n";
import type { HudPolicy, HudStatus, TilingStatus } from "../../lib/ipc";
import { displayCounts, previewLayout, previewTables } from "./model";
import styles from "./Tables.module.css";

/** The tallest a display is drawn, and the gap between two. */
const MAX_HEIGHT = 240;
const GAP = 24;
/** Tables laid edge to edge are drawn this far apart, so each reads as one. */
const INSET = 1;
/** The preview's own padding, both sides. */
const PADDING = 44;

/** The width of `ref`'s element, followed. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function Monitors({ status, policy }: { status: HudStatus | null; policy: HudPolicy }) {
  const report = status?.tiling ?? null;
  if (report === null || report.monitors.length === 0) return null;
  return <Preview report={report} policy={policy} />;
}

function Preview({ report, policy }: { report: TilingStatus; policy: HudPolicy }) {
  const s = useT().tables;
  const ref = useRef<HTMLElement>(null);
  const width = useWidth(ref);
  const { monitors } = report;
  const names = new Map(policy.rooms.map((room) => [room.id, room.name]));
  const layout = previewLayout(monitors, Math.max(0, width - PADDING), MAX_HEIGHT, GAP);
  const windows = report.enabled ? report.windows : [];
  return (
    <section ref={ref} className={styles.monitors} aria-label={s.displays} data-off={!report.enabled}>
      {layout.displays.map((display) => {
        const boxes = previewTables(display, windows, layout.scale);
        const counts = displayCounts(boxes);
        const { bounds } = display.monitor;
        const caption = s.display(display.monitor.index + 1, bounds.width, bounds.height);
        return (
          <figure key={display.monitor.index} className={styles.monitor}>
            <div className={styles.screen} style={{ width: display.width, height: display.height }}>
              <span
                className={styles.work}
                style={{ left: display.work.left, top: display.work.top, width: display.work.width, height: display.work.height }}
              />
              {boxes.map((box, i) => {
                const room = names.get(box.table.site) ?? box.table.site;
                const name = box.table.table ?? s.untitled;
                const hint = [`${room} · ${name}`, ...(box.count > 1 ? [s.stacked(box.count)] : []), ...(box.table.pinned ? [s.pinned] : [])].join("\n");
                return (
                  <span
                    key={`${box.table.site}:${i}`}
                    className={styles.table}
                    data-stacked={box.count > 1}
                    data-pinned={box.table.pinned === true}
                    title={hint}
                    style={{ left: box.left + INSET, top: box.top + INSET, width: Math.max(0, box.width - 2 * INSET), height: Math.max(0, box.height - 2 * INSET) }}
                  >
                    <span className={styles.tableTop}>
                      <span className={styles.tableRoom}>{room}</span>
                      {box.count > 1 ? <span className={styles.stackCount}>{`×${box.count}`}</span> : null}
                    </span>
                    <span className={styles.tableName}>{name}</span>
                  </span>
                );
              })}
            </div>
            <figcaption className={styles.caption}>
              {counts.shown > 0 ? `${caption} · ${s.displayTables(counts.shown, counts.stacked)}` : caption}
            </figcaption>
          </figure>
        );
      })}
    </section>
  );
}
