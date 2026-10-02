/**
 * The action log — Tier 2.
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
 * `scrollIntoView({ block: "nearest" })` on the active row, safe because the
 * overlay body is its own scroll container.
 *
 * It is a modal `<dialog>` now rather than a floating `<aside>`, so it traps
 * focus, makes the background inert and answers Escape without any of that
 * being written here.
 */

import { useEffect, useRef } from "react";
import { useDict } from "../../lib/i18n/client";
import type { ReplayFrame } from "../../lib/replay";
import { Overlay } from "../ui/Overlay";
import type { NameMask } from "./replaySettings";

interface ActionLogSheetProps {
  frames: ReplayFrame[];
  /** Frame index of the line to highlight, or -1 before the first action. */
  activeIndex: number;
  mask: NameMask;
  onSeek: (index: number) => void;
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
}

export function ActionLogSheet({
  frames,
  activeIndex,
  mask,
  onSeek,
  open,
  onClose,
  anchor,
}: ActionLogSheetProps) {
  const en = useDict();
  return (
    <Overlay
      // A transcript, not a dialog: you read it while stepping.
      modal={false}
      open={open}
      onClose={onClose}
      title={en.replayer.log.title}
      anchor={anchor}
      className="rp-ov rp-ov--log"
    >
      <LogList frames={frames} activeIndex={activeIndex} mask={mask} onSeek={onSeek} />
    </Overlay>
  );
}

/**
 * Split out so the scroll effect only exists while the list is on screen. A
 * closed `<dialog>` is `display: none`, and `scrollIntoView` against a
 * zero-height box does nothing useful.
 */
function LogList({
  frames,
  activeIndex,
  mask,
  onSeek,
}: Pick<ActionLogSheetProps, "frames" | "activeIndex" | "mask" | "onSeek">) {
  const current = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
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
  );
}
