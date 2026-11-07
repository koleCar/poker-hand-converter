/**
 * A right-click menu at the pointer: a short list of actions, placed inside
 * the window, keyboard-driven like a system menu (Up / Down / Home / End move,
 * Enter chooses, Escape or a click outside closes) and closed when the
 * window scrolls, resizes or loses focus.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import styles from "./ContextMenu.module.css";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** Where the menu opens: the pointer, in the window's pixels. */
export interface MenuPoint {
  x: number;
  y: number;
}

export function ContextMenu({
  at,
  label,
  items,
  onClose,
}: {
  at: MenuPoint;
  /** The menu's accessible name ("3 hands"). */
  label: string;
  items: readonly MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { offsetWidth: width, offsetHeight: height } = node;
    const left = at.x + width + 8 > window.innerWidth ? Math.max(8, at.x - width) : at.x;
    const top = at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height) : at.y;
    setPlace({ top, left });
  }, [at]);

  // Focus the first item once placed, so the keys work at once.
  const placed = place !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  }, [placed]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focus(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focus(at - 1);
        break;
      case "Home":
        event.preventDefault();
        focus(0);
        break;
      case "End":
        event.preventDefault();
        focus(buttons.length - 1);
        break;
      case "Escape":
      case "Tab":
        event.preventDefault();
        onClose();
        break;
      default:
    }
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      aria-label={label}
      style={place ? { top: place.top, left: place.left } : { top: at.y, left: at.x, visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={styles.item}
          disabled={item.disabled}
          tabIndex={-1}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
