/**
 * The action log.
 *
 * A sixty-action transcript genuinely cannot fit on a felt, and it is the one
 * honest exception to the no-scroll rule: the log is a *transcript*, not a
 * control, so it moved out of the layout and into an overlay whose list is the
 * only scrollable region the replayer has.
 *
 * That also deleted a bug. The old log was a fixed 240px box with absolutely
 * positioned contents and a `useEffect` doing `offsetTop` arithmetic to keep
 * the current line visible — all of it only there because the log had been
 * forced into the main flow beside the felt. In an overlay the browser does it:
 * `scrollIntoView({ block: "nearest" })` on the active row.
 */

import { useEffect, useRef } from "react";
import type { ReplayFrame } from "../../lib/replay";
import type { NameMask } from "./replaySettings";

interface ActionLogSheetProps {
  frames: ReplayFrame[];
  /** Frame index of the line to highlight, or -1 before the first action. */
  activeIndex: number;
  mask: NameMask;
  onSeek: (index: number) => void;
  onClose: () => void;
}

export function ActionLogSheet({
  frames,
  activeIndex,
  mask,
  onSeek,
  onClose,
}: ActionLogSheetProps) {
  const current = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <aside className="rp__sheet rp__sheet--log" id="replay-log" aria-label="Action log">
      <div className="rp__sheet-head">
        <span className="rp__sheet-title">Action log</span>
        <button
          type="button"
          className="btn btn--icon"
          onClick={onClose}
          aria-label="Close action log"
        >
          ✕
        </button>
      </div>
      <ol className="rp__sheet-list rp__log-list">
        {frames.map((entry) => (
          <li
            key={entry.index}
            ref={entry.index === activeIndex ? current : undefined}
            className={[
              "rp__log-item",
              `rp__log-item--${entry.kind}`,
              entry.index === activeIndex ? "is-current" : "",
              entry.index < activeIndex ? "is-past" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              aria-current={entry.index === activeIndex ? "step" : undefined}
              onClick={() => onSeek(entry.index)}
            >
              {mask.text(entry.description)}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
