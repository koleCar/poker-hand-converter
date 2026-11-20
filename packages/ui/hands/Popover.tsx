import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import styles from "./FilterBar.module.css";

/** Where a popover becomes a bottom sheet: the web's phone layout (the desktop app is never this narrow). */
const SHEET_QUERY = "(max-width: 899px)";

/**
 * A small panel under the button that opened it: placed by the button's box
 * (fixed, so the filter row's sideways scroll does not clip it), closed by
 * Escape (focus goes back to the button) or a click outside. On a phone it is
 * a bottom sheet over a dimmed page instead (the same panel, full width).
 */
export function Popover({
  anchor,
  label,
  onClose,
  align = "start",
  className,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  /** Which edge of the button the panel lines up with. */
  align?: "start" | "end" | undefined;
  /** A wider or roomier panel (the "+ Add filter" menu). */
  className?: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The sheet's scrim closes it on its click, not on the press: a press that
  // took the scrim away would land its click on the row under it.
  const scrimRef = useRef<HTMLDivElement>(null);
  // A sheet on a phone, decided when the panel opens.
  const [sheet] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches,
  );
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (sheet) return;
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const width = ref.current?.offsetWidth ?? 320;
    const left = align === "end" ? box.right - width : box.left;
    setPlace({ top: box.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [anchor, align, sheet]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (target === scrimRef.current) return;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        (anchor.current?.querySelector<HTMLElement>("button") ?? anchor.current)?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  // Focus moves into the panel, to its first control, once it is placed
  // (a hidden element cannot take focus).
  const placed = sheet || place !== null;
  useEffect(() => {
    if (placed) {
      ref.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
    }
  }, [placed]);

  const classes = [styles.popover, className, sheet ? styles.sheet : null].filter(Boolean).join(" ");
  return (
    <>
      {sheet ? <div ref={scrimRef} className={styles.sheetScrim} aria-hidden="true" onClick={onClose} /> : null}
      <div
        ref={ref}
        className={classes}
        role="dialog"
        aria-label={label}
        style={sheet ? undefined : place ? { top: place.top, left: place.left } : { visibility: "hidden" }}
      >
        {children}
      </div>
    </>
  );
}
