import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import styles from "./FilterBar.module.css";

/**
 * A small panel under the button that opened it: placed by the button's box
 * (fixed, so the filter row's sideways scroll does not clip it), closed by
 * Escape (focus goes back to the button) or a click outside.
 */
export function Popover({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const width = ref.current?.offsetWidth ?? 320;
    setPlace({ top: box.bottom + 6, left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
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
  const placed = place !== null;
  useEffect(() => {
    if (placed) {
      ref.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
    }
  }, [placed]);

  return (
    <div
      ref={ref}
      className={styles.popover}
      role="dialog"
      aria-label={label}
      style={place ? { top: place.top, left: place.left } : { visibility: "hidden" }}
    >
      {children}
    </div>
  );
}
