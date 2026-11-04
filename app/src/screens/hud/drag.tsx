/**
 * The HUD editor's drag and drop: pointer events, not HTML5 drag and drop
 * (which Tauri's own file drop takes over in the Windows webview, and which
 * cannot style what is dragged).
 *
 * A source calls `begin` on pointer down with what it carries; the drag
 * starts once the pointer has moved a few pixels (a press without moving
 * stays a click). While it moves, the spot under the pointer is found from
 * the page: the nearest `[data-zone]` element is a drop zone and its
 * `[data-slot]` children are the places in it - over the right half of a
 * slot the item goes after it. A zone registers what it accepts and what a
 * drop does (`useDropZone`). The keyboard has its own ways (Add buttons,
 * Alt+arrows), so nothing here is the only way to do anything.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import styles from "./HudEditor.module.css";

/** What is dragged: a statistic from the library, a panel cell, a popup statistic. */
export type DragItem =
  | { kind: "stat"; id: string; label: string }
  | { kind: "cell"; index: number; id: string; label: string }
  | { kind: "popup"; id: string; label: string; section: number; index: number };

/** Where it would land: a zone and the index in it. */
export interface DropSpot {
  zone: string;
  index: number;
}

interface Zone {
  accepts: (item: DragItem) => boolean;
  drop: (item: DragItem, spot: DropSpot) => void;
}

interface DragState {
  item: DragItem;
  x: number;
  y: number;
}

interface Ctx {
  dragging: DragItem | null;
  spot: DropSpot | null;
  begin: (event: ReactPointerEvent, item: DragItem) => void;
  register: (zone: string, value: Zone) => () => void;
}

const DragContext = createContext<Ctx | null>(null);

/** How far the pointer moves before a press becomes a drag. */
const THRESHOLD_PX = 4;
/** Near this close to the top or bottom of what scrolls, a drag scrolls it. */
const EDGE_PX = 56;
/** The fastest it scrolls, pixels a frame. */
const SCROLL_MAX_PX = 18;

/** The element that scrolls the page under (x, y): the nearest tall scrolling ancestor. */
function scrollerAt(x: number, y: number): HTMLElement | null {
  let el: HTMLElement | null = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight && el.clientHeight > 320) {
      return el;
    }
    el = el.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function spotAt(x: number, y: number, zones: Map<string, Zone>, item: DragItem): DropSpot | null {
  const hit = document.elementFromPoint(x, y);
  const zoneEl = hit?.closest<HTMLElement>("[data-zone]");
  const zone = zoneEl?.dataset.zone;
  if (!zoneEl || !zone) return null;
  const entry = zones.get(zone);
  if (!entry || !entry.accepts(item)) return null;
  const slotEl = hit?.closest<HTMLElement>("[data-slot]");
  if (slotEl && zoneEl.contains(slotEl)) {
    const slot = Number(slotEl.dataset.slot);
    const rect = slotEl.getBoundingClientRect();
    return { zone, index: x > rect.left + rect.width / 2 ? slot + 1 : slot };
  }
  return { zone, index: Number(zoneEl.dataset.end ?? 0) };
}

export function DragProvider({ children }: { children: ReactNode }) {
  const zones = useRef(new Map<string, Zone>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [spot, setSpot] = useState<DropSpot | null>(null);
  const pending = useRef<{ item: DragItem; x: number; y: number; id: number } | null>(null);
  const active = useRef<DragItem | null>(null);
  const spotRef = useRef<DropSpot | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  const register = useCallback((zone: string, value: Zone) => {
    zones.current.set(zone, value);
    return () => {
      if (zones.current.get(zone) === value) zones.current.delete(zone);
    };
  }, []);

  const begin = useCallback((event: ReactPointerEvent, item: DragItem) => {
    if (event.button !== 0) return;
    pending.current = { item, x: event.clientX, y: event.clientY, id: event.pointerId };
  }, []);

  useEffect(() => {
    const locate = (x: number, y: number) => {
      const item = active.current;
      if (!item) return;
      const next = spotAt(x, y, zones.current, item);
      spotRef.current = next;
      setSpot((old) => (old?.zone === next?.zone && old?.index === next?.index ? old : next));
    };
    // While a drag is held near the top or bottom of what scrolls, scroll it.
    const scroll = () => {
      frame.current = null;
      const at = pointer.current;
      if (!active.current || !at) return;
      const scroller = scrollerAt(at.x, at.y);
      if (scroller) {
        const rect = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
        const top = Math.max(rect.top, 0);
        const bottom = Math.min(rect.bottom, window.innerHeight);
        const speed = (into: number) => Math.ceil(SCROLL_MAX_PX * Math.min(1, (EDGE_PX - into) / EDGE_PX));
        let by = 0;
        if (at.y < top + EDGE_PX) by = -speed(at.y - top);
        else if (at.y > bottom - EDGE_PX) by = speed(bottom - at.y);
        if (by !== 0) {
          const before = scroller.scrollTop;
          scroller.scrollTop += by;
          if (scroller.scrollTop !== before) locate(at.x, at.y);
        }
      }
      frame.current = window.requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      const start = pending.current;
      if (!start || start.id !== event.pointerId) return;
      if (!active.current) {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < THRESHOLD_PX) return;
        active.current = start.item;
        document.body.dataset.hudDragging = "true";
        frame.current ??= window.requestAnimationFrame(scroll);
      }
      event.preventDefault();
      pointer.current = { x: event.clientX, y: event.clientY };
      setDrag({ item: active.current, x: event.clientX, y: event.clientY });
      locate(event.clientX, event.clientY);
    };
    const stopScrolling = () => {
      pointer.current = null;
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    const end = (event: PointerEvent) => {
      const start = pending.current;
      if (!start || start.id !== event.pointerId) return;
      pending.current = null;
      const item = active.current;
      active.current = null;
      stopScrolling();
      if (!item) return;
      delete document.body.dataset.hudDragging;
      // The press ends in a click on what was under it: not this time.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const where = event.type === "pointerup" ? spotRef.current : null;
      spotRef.current = null;
      setDrag(null);
      setSpot(null);
      if (where) zones.current.get(where.zone)?.drop(item, where);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !active.current) return;
      pending.current = null;
      active.current = null;
      spotRef.current = null;
      stopScrolling();
      delete document.body.dataset.hudDragging;
      setDrag(null);
      setSpot(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", escape);
      stopScrolling();
      delete document.body.dataset.hudDragging;
    };
  }, []);

  const value = useMemo<Ctx>(
    () => ({ dragging: drag?.item ?? null, spot, begin, register }),
    [drag?.item, spot, begin, register],
  );

  return (
    <DragContext.Provider value={value}>
      {children}
      {drag ? (
        <div
          className={spot ? `${styles.ghost} ${styles.ghostOk}` : styles.ghost}
          style={{ transform: `translate(${drag.x + 12}px, ${drag.y + 10}px)` }}
          aria-hidden="true"
        >
          {drag.item.label}
        </div>
      ) : null}
    </DragContext.Provider>
  );
}

export function useDrag(): Ctx {
  const ctx = useContext(DragContext);
  if (!ctx) throw new Error("useDrag outside DragProvider");
  return ctx;
}

/** Register a drop zone (`data-zone={zone}` on its element). */
export function useDropZone(
  zone: string,
  accepts: (item: DragItem) => boolean,
  drop: (item: DragItem, spot: DropSpot) => void,
): void {
  const { register } = useDrag();
  const latest = useRef({ accepts, drop });
  useEffect(() => {
    latest.current = { accepts, drop };
  });
  useEffect(
    () =>
      register(zone, {
        accepts: (item) => latest.current.accepts(item),
        drop: (item, spot) => latest.current.drop(item, spot),
      }),
    [register, zone],
  );
}
