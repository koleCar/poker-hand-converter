/**
 * The one modal primitive.
 *
 * Built on `<dialog>` + `showModal()` rather than a hand-rolled popover,
 * because the platform already ships the three things a hand-rolled one always
 * gets wrong: the focus trap, an inert background, and Escape. What was here
 * before — a `mousedown` outside-click listener on `document` — had none of
 * them, and it leaked focus into a background that was still tabbable.
 *
 * Two things are added on top of the native element.
 *
 * **Focus return.** The element that opened the overlay is recorded on open and
 * refocused on close. Chrome's own dialog focus fix-up mostly does this, but it
 * is not portable and it does not survive the invoking control being
 * re-rendered, so it is done explicitly.
 *
 * **Anchoring.** A modal dialog lives in the top layer, which means its
 * containing block is the viewport: it escapes `overflow: clip`, `contain` and
 * every stacking context between it and the root. That is exactly what makes it
 * safe to open one over a size-contained stage — it cannot reflow anything —
 * but it also means it has no idea where that stage is. `anchor` closes the
 * gap: the anchor element's box is measured and published as `--ov-x/y/w/h`, so
 * the overlay covers precisely that box and nothing else on the page moves.
 * Without an anchor it centres on the viewport.
 */

import { useCallback, useEffect, useId, useRef } from "react";
import { useDict } from "../../lib/i18n/client";
import "../../styles/overlay.css";

export interface OverlayProps {
  open: boolean;
  /** Called on Escape, on the close button, and on a backdrop click. */
  onClose: () => void;
  /** Accessible name of the dialog, and the text in its head row. */
  title: string;
  /** Optional summary line in the head, between the title and the close button. */
  note?: React.ReactNode;
  /**
   * Element the overlay should cover. Measured live, so a resize or a scroll
   * keeps the two boxes together. Omit to centre on the viewport.
   */
  anchor?: React.RefObject<HTMLElement | null>;
  /**
   * Whether the overlay makes the rest of the page inert.
   *
   * True for anything you *configure* — settings, hand info, the shortcut
   * list — because there is nothing behind them worth reaching while they are
   * up, and modality buys the focus trap and Escape for free.
   *
   * **False for the action log**, and that exception is the whole reason this
   * prop exists. The log is a transcript, not a dialog: its entire value is
   * watching the highlight track the current action while you step, and
   * clicking a line to seek. A modal log cannot do either — it inerts the
   * transport, so the arrow keys and the buttons stop working and the panel
   * you opened to follow the hand is the thing preventing you from following
   * it. Verified before this prop existed: with the log open, ArrowRight left
   * the frame index unchanged and the transport buttons were click-blocked.
   *
   * A non-modal `<dialog>` keeps Escape and focus return (both handled here,
   * since only the modal path gets them from the platform) and gives up the
   * trap and the inert background, which is exactly the trade wanted.
   */
  modal?: boolean;
  /** Placement / skin hook for the surface embedding the overlay. */
  className?: string;
  children: React.ReactNode;
}

export function Overlay({
  open,
  onClose,
  title,
  note,
  anchor,
  modal = true,
  className = "",
  children,
}: OverlayProps) {
  const en = useDict();
  const ref = useRef<HTMLDialogElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || typeof dialog.showModal !== "function") {
      return;
    }
    if (open && !dialog.open) {
      restoreTo.current = document.activeElement as HTMLElement | null;
      if (modal) {
        dialog.showModal();
      } else {
        // `show()` keeps the dialog out of the top layer, so the page behind
        // it stays live. That is the point -- see `OverlayProps.modal`.
        dialog.show();
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, modal]);

  // Measured rather than positioned in CSS: nothing in the cascade can see
  // where a top-layer element's anchor ended up.
  useEffect(() => {
    const dialog = ref.current;
    const node = anchor?.current;
    if (!open || !dialog || !node) {
      return;
    }
    const place = () => {
      const box = node.getBoundingClientRect();
      dialog.style.setProperty("--ov-x", `${box.left}px`);
      dialog.style.setProperty("--ov-y", `${box.top}px`);
      dialog.style.setProperty("--ov-w", `${box.width}px`);
      dialog.style.setProperty("--ov-h", `${box.height}px`);
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(node);
    window.addEventListener("resize", place);
    // Capture phase: the anchor may sit inside a scroller that is not the page.
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor]);

  const close = useCallback(() => {
    const target = restoreTo.current;
    restoreTo.current = null;
    onClose();
    if (target && target.isConnected) {
      target.focus({ preventScroll: true });
    }
  }, [onClose]);

  // Fires for Escape and for the programmatic `close()` above, so focus return
  // happens on every exit path without each of them being wired up.
  const onNativeClose = useCallback(() => {
    close();
  }, [close]);

  // Escape is a behaviour of `showModal()`, not of `<dialog>`, so the non-modal
  // path has to provide it. Bound to the dialog rather than the document so it
  // cannot eat an Escape meant for something else on the page.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (!modal && event.key === "Escape") {
        event.preventDefault();
        close();
      }
    },
    [modal, close],
  );

  // A click that lands on the dialog element itself is a click on the backdrop:
  // the panel covers the whole box, so nothing else can be the target.
  const onSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === ref.current) {
        close();
      }
    },
    [close],
  );

  return (
    <dialog
      ref={ref}
      className={`ov ${className}`.trim()}
      data-anchored={anchor ? "true" : undefined}
      data-modal={modal ? "true" : "false"}
      // `aria-modal` is a claim about the background being unreachable, so it
      // may only be stated when it is true. Saying it on the non-modal log
      // would tell a screen-reader user the transport is gone when it is not.
      role="dialog"
      aria-modal={modal ? "true" : undefined}
      aria-labelledby={titleId}
      onClose={onNativeClose}
      onClick={onSurfaceClick}
      onKeyDown={onKeyDown}
    >
      <div className="ov__panel">
        <div className="ov__head">
          <h2 className="ov__title" id={titleId}>
            {title}
          </h2>
          {note ? <div className="ov__note">{note}</div> : null}
          <button
            type="button"
            className="btn btn--icon ov__close"
            onClick={close}
            aria-label={en.chrome.closeNamed(title)}
          >
            ✕
          </button>
        </div>
        {/* Mounted only while open: a closed `<dialog>` is `display: none`, so
            anything inside it would be measured at zero and would run its
            effects against a box that is not on screen. */}
        <div className="ov__body">{open ? children : null}</div>
      </div>
    </dialog>
  );
}
