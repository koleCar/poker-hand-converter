/**
 * A locked decision's lock icon and its popover (`docs/NODELOCK.md` §7.3).
 * The icon sits after a locked action's label (on the action strip and in
 * the strategy panel) and on the decision card's corner. Hovering it shows
 * how the decision is locked; a click pins the popover, Esc or a click
 * outside closes it. One popover is open at a time.
 *
 * The icon after an action's label lives inside that action's button, so it
 * is a pointer target only (a click on it does not take the action); the
 * corner's is a real button, the keyboard's way in.
 *
 * In the library's look ("Studio", SV-A): its lock glyph, the popover as its
 * panels (a bar per action with GTO's tick, `GTO x → y`), its buttons. The
 * popover is the window's (a portal), not the library's `Popover`: the strip
 * it opens from scrolls sideways and would clip it.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../i18n";
import { IconButton, LockGlyph, ToolButton } from "../door";
import type { NodeMark } from "./marks";
import styles from "./nodelock.module.css";

/** What the popover says about one locked decision; built only when it opens. */
export interface LockPopoverData {
  /** `BB · Flop · Q♠6♥3♦ · after BTN bet 33 %`. */
  title: string;
  actions: Array<{ label: string; name: string; colour: string }>;
  mark: NodeMark;
  /** GTO's shares when the chunk at hand has none (the row's summary), or null. */
  gto: number[] | null;
  /** The preset's name, or null: then the mark's origin says Range or Hands painted. */
  preset: string | null;
  /** The lock it was inherited from, or null (the open lock's own). */
  from: { id: string; name: string } | null;
  /** The open lock locks only this decision: Remove this lock is off. */
  only: boolean;
}

export interface LockMarkProps {
  /** The decision's lock (the open lock and its path). */
  id: string;
  /** The action whose label the icon follows, or null on the card's corner. */
  action: string | null;
  data: () => LockPopoverData | null;
  onEdit: () => void;
  onRemove: () => void;
  onOpenFrom: (id: string) => void;
}

/* ------------------------------------------------- the one open popover - */

interface Open {
  id: string;
  /** Which icon opened it, to anchor it there (the strip and the panel both mark an action). */
  anchor: string;
  pinned: boolean;
}

let open: Open | null = null;
const listeners = new Set<() => void>();
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function setOpen(next: Open | null) {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  open = next;
  for (const listener of listeners) listener();
}

/** Closes a hover popover a moment after the pointer leaves, so it can reach the popover. */
function closeSoon() {
  if (!open || open.pinned) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => setOpen(null), 160);
}

function useOpen(): Open | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}

/** Closes any lock popover (the view moved). */
export function closeLockPopover(): void {
  setOpen(null);
}

/* ------------------------------------------------------------- the icon - */

export function LockMark({ id, action, data, onEdit, onRemove, onOpenFrom }: LockMarkProps) {
  const t = useT().nodelock;
  const current = useOpen();
  const anchor = useId();
  const ref = useRef<HTMLElement | null>(null);
  const shown = current?.anchor === anchor ? current : null;

  const enter = () => {
    if (open?.pinned) return;
    setOpen({ id, anchor, pinned: false });
  };
  const toggle = () => {
    setOpen(shown?.pinned ? null : { id, anchor, pinned: true });
  };
  const popover = shown ? (
    <Popover
      anchor={ref}
      pinned={shown.pinned}
      data={data}
      onEdit={() => {
        setOpen(null);
        onEdit();
      }}
      onRemove={() => {
        setOpen(null);
        onRemove();
      }}
      onOpenFrom={(from) => {
        setOpen(null);
        onOpenFrom(from);
      }}
    />
  ) : null;

  if (action === null) {
    return (
      <>
        <button
          ref={(element) => {
            ref.current = element;
          }}
          type="button"
          className={`${styles.markCorner} ${shown ? styles.markOn : ""}`}
          aria-label={t.markLabel}
          aria-expanded={Boolean(shown)}
          onPointerEnter={enter}
          onPointerLeave={closeSoon}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <LockGlyph />
        </button>
        {popover}
      </>
    );
  }
  return (
    <>
      <span
        ref={(element) => {
          ref.current = element;
        }}
        className={`${styles.mark} ${shown ? styles.markOn : ""}`}
        role="img"
        aria-label={t.markLabel}
        onPointerEnter={enter}
        onPointerLeave={closeSoon}
        onClick={(event) => {
          // The icon is inside the action's button: it pins the popover, it does not take the action.
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }}
      >
        <LockGlyph />
      </span>
      {popover}
    </>
  );
}

/* ---------------------------------------------------------- the popover - */

const POPOVER_WIDTH = 320;

function pct(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)} %`;
}

function Popover({
  anchor,
  pinned,
  data,
  onEdit,
  onRemove,
  onOpenFrom,
}: {
  anchor: { current: HTMLElement | null };
  pinned: boolean;
  data: () => LockPopoverData | null;
  onEdit: () => void;
  onRemove: () => void;
  onOpenFrom: (id: string) => void;
}) {
  const t = useT().nodelock;
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Read once per opening: the numbers walk the decision's hands.
  const [info] = useState(data);

  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const height = box.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(window.innerWidth - POPOVER_WIDTH - 8, rect.left + rect.width / 2 - POPOVER_WIDTH / 2));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 && rect.top - 6 - height > 8 ? rect.top - 6 - height : below;
    setPlace({ left, top });
  }, [anchor]);

  useEffect(() => {
    if (!pinned) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || anchor.current?.contains(target)) return;
      setOpen(null);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [pinned, anchor]);
  useEffect(() => {
    if (pinned) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pinned]);

  if (!info) return null;
  const { mark } = info;
  const gto = mark.gto ?? info.gto;
  const origin = info.preset ?? (mark.origin === "range" ? t.markRange : t.markPainted);
  const fixed = mark.fixed >= mark.reaching ? t.markAllFixed : t.markFixed(mark.fixed, mark.reaching);
  return createPortal(
    <div
      ref={box}
      className={styles.popover}
      role="dialog"
      aria-label={info.title}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, inlineSize: POPOVER_WIDTH }}
      onPointerEnter={() => {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
      }}
      onPointerLeave={closeSoon}
    >
      <div className={styles.popHead}>
        <span className={styles.popLock}>
          <LockGlyph />
        </span>
        <strong className={styles.popTitle}>{info.title}</strong>
        <IconButton size="sm" label={t.close} onClick={() => setOpen(null)}>
          <Icon name="close" />
        </IconButton>
      </div>
      {info.from ? (
        <p className={styles.popFrom}>
          {t.markFrom}{" "}
          <button type="button" className={styles.popLink} onClick={() => onOpenFrom(info.from!.id)}>
            {info.from.name}
          </button>
        </p>
      ) : null}
      <ul className={styles.popActions}>
        {info.actions.map((action, a) => (
          <li key={action.label} className={mark.locked[a] ? "" : styles.popFree}>
            <span className={styles.popName}>
              <span className={`${styles.popDot} ${action.colour}`} aria-hidden="true" />
              <span className={styles.popLabel}>{action.name}</span>
              {mark.locked[a] ? (
                <span className={styles.popLocked}>
                  <LockGlyph />
                </span>
              ) : null}
            </span>
            <span className={styles.popBar} aria-hidden="true">
              <span className={action.colour} style={{ inlineSize: `${mark.shares[a] * 100}%` }} />
              {gto ? <span className={styles.popTick} style={{ insetInlineStart: `${(gto[a] ?? 0) * 100}%` }} /> : null}
            </span>
            <span className={styles.popNums}>
              {gto ? (
                <>
                  {t.gto} {pct(gto[a] ?? 0)} → <strong>{pct(mark.shares[a])}</strong>
                </>
              ) : (
                <strong>{pct(mark.shares[a])}</strong>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.popMore}>
        <MiniGrid mark={mark} colours={info.actions.map((a) => a.colour)} />
        <p className={styles.popMuted}>
          {fixed}
          <br />
          {origin}
        </p>
      </div>
      <div className={styles.popTools}>
        <ToolButton size="sm" tone="lock" onClick={onEdit}>
          {t.editLock}
        </ToolButton>
        <ToolButton size="sm" disabled={info.only} title={info.only ? t.markOnlyNode : undefined} onClick={onRemove}>
          {t.removeLock}
        </ToolButton>
      </div>
    </div>,
    document.body,
  );
}

/** The locked strategy over the 13×13 grid: fixed cells full, free ones dimmed. */
function MiniGrid({ mark, colours }: { mark: NodeMark; colours: string[] }): ReactNode {
  return (
    <div className={styles.miniGrid} aria-hidden="true">
      {mark.cells.map((cell, k) => (
        <span key={k} className={styles.miniCell} style={{ opacity: cell ? (cell.fixed > 0 ? 1 : 0.28) : 0.08 }}>
          {cell
            ? cell.mix.map((x, a) => (x > 0.0005 ? <span key={a} className={colours[a]} style={{ inlineSize: `${x * 100}%` }} /> : null))
            : null}
        </span>
      ))}
    </div>
  );
}
