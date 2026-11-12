/**
 * A right-click menu at the pointer: a short list of actions, placed inside
 * the window, keyboard-driven like a system menu (Up / Down / Home / End move,
 * Enter chooses, Escape or a click outside closes) and closed when the
 * window scrolls, resizes or loses focus.
 *
 * An item can open a panel beside the menu instead (`submenu`: the hand
 * lists' "Mark"): on a click, Enter or Right, or when the pointer rests on
 * it. Up / Down move inside the panel, Left or Escape go back to the menu;
 * the panel stays open while it is used and closes the menu itself when it
 * is done (its `close`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import styles from "./ContextMenu.module.css";

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** A panel beside the menu instead of an action; `close` closes the whole menu. */
  submenu?: (close: () => void) => ReactNode;
}

/** Where the menu opens: the pointer, in the window's pixels. */
export interface MenuPoint {
  x: number;
  y: number;
}

/** What a panel's Up / Down move between. */
const PANEL_FOCUSABLE = "[role^=menuitem]:not([disabled]), input:not([disabled])";
/** Room kept between the menu and the window's edge. */
const EDGE = 8;

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
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  // The open submenu: its item's index, and whether its first control takes the focus.
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  // Where the open panel sits (for the item it belongs to).
  const [placedPanel, setPlacedPanel] = useState<{ index: number; top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { offsetWidth: width, offsetHeight: height } = node;
    const left = at.x + width + EDGE > window.innerWidth ? Math.max(EDGE, at.x - width) : at.x;
    const top = at.y + height + EDGE > window.innerHeight ? Math.max(EDGE, at.y - height) : at.y;
    setPlace({ top, left });
  }, [at]);

  // Focus the first item once placed, so the keys work at once.
  const placed = place !== null;
  useEffect(() => {
    if (placed) topItems(ref.current)[0]?.focus();
  }, [placed]);

  // The panel beside its item: on the right, else on the left; inside the
  // window's height. Placed again as its content grows (a list that loads).
  const subIndex = sub?.index ?? null;
  const placePanel = useCallback(() => {
    const menu = ref.current;
    const node = panel.current;
    if (!menu || !node || subIndex === null) return;
    const item = menu.querySelector<HTMLElement>(`[data-index="${subIndex}"]`);
    if (!item) return;
    const box = menu.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = node;
    const right = box.right + 4;
    const left = right + width + EDGE > window.innerWidth ? Math.max(EDGE, box.left - width - 4) : right;
    const top = Math.max(EDGE, Math.min(row.top - EDGE, window.innerHeight - height - EDGE));
    setPlacedPanel((was) =>
      was && was.index === subIndex && was.top === top && was.left === left ? was : { index: subIndex, top, left },
    );
  }, [subIndex]);

  useLayoutEffect(() => {
    if (subIndex === null) return;
    placePanel();
    const node = panel.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(placePanel);
    observer.observe(node);
    return () => observer.disconnect();
  }, [subIndex, placePanel]);

  const panelPlace = placedPanel !== null && placedPanel.index === subIndex ? placedPanel : null;
  // Opened by a click or a key: the panel's first control takes the focus once placed.
  const panelPlaced = panelPlace !== null;
  const focusPanel = sub?.focus ?? false;
  useEffect(() => {
    if (!panelPlaced || !focusPanel) return;
    const node = panel.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(PANEL_FOCUSABLE))?.focus();
  }, [panelPlaced, focusPanel]);

  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && ref.current?.contains(target) === true;
    const onDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose();
    };
    // A list scrolling inside the panel is not the window scrolling.
    const onScroll = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const back = () => {
    const index = sub?.index;
    setSub(null);
    if (index !== undefined) ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = topItems(ref.current);
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
      case "ArrowRight": {
        const index = Number((document.activeElement as HTMLElement | null)?.dataset.index);
        if (Number.isInteger(index) && items[index]?.submenu) {
          event.preventDefault();
          setSub({ index, focus: true });
        }
        break;
      }
      case "ArrowLeft":
        if (sub !== null) {
          event.preventDefault();
          back();
        }
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

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inInput = event.target instanceof HTMLInputElement;
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE) ?? [])];
    const at = controls.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => controls[(index + controls.length) % controls.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focus(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focus(at - 1);
        break;
      case "ArrowLeft":
        if (!inInput) {
          event.preventDefault();
          back();
        }
        break;
      case "Escape":
        event.preventDefault();
        back();
        break;
      case "Tab":
        event.preventDefault();
        onClose();
        break;
      default:
    }
    event.stopPropagation();
  };

  const open = sub !== null ? items[sub.index] : undefined;

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
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          data-index={index}
          className={`${styles.item} ${sub?.index === index ? styles.open : ""}`.trim()}
          disabled={item.disabled}
          tabIndex={-1}
          aria-haspopup={item.submenu ? "menu" : undefined}
          aria-expanded={item.submenu ? sub?.index === index : undefined}
          onPointerEnter={() => {
            if (item.submenu && !item.disabled) setSub((was) => (was?.index === index ? was : { index, focus: false }));
            else if (sub !== null) setSub(null);
          }}
          onClick={() => {
            if (item.submenu) {
              setSub({ index, focus: true });
              return;
            }
            onClose();
            item.onSelect?.();
          }}
        >
          <span className={styles.label}>{item.label}</span>
          {item.submenu ? (
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          ) : null}
        </button>
      ))}
      {open?.submenu ? (
        <div
          ref={panel}
          className={`${styles.menu} ${styles.panel}`}
          role="menu"
          aria-label={open.label}
          style={panelPlace ? { top: panelPlace.top, left: panelPlace.left } : { top: 0, left: 0, visibility: "hidden" }}
          onKeyDown={onPanelKeyDown}
        >
          {open.submenu(onClose)}
        </div>
      ) : null}
    </div>
  );
}

/** The menu's own items (not a panel's). */
function topItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>(":scope > [role=menuitem]:not([disabled])") ?? [])];
}
