/**
 * The RNG box (`src-tauri/src/rng_box.rs`, the owner's brief of
 * 2026-11-16): the app's own small window while a session is live, showing
 * one number from 1 to 100. A click shows a new one; the "Roll the RNG"
 * hotkey does too (the Rust side rolls and tells the window).
 *
 * Its look and place are the user's (2026-11-17, `RngSettings`): size, the
 * number's size, background and number colours from Settings. Unlocked,
 * the box is dragged anywhere on the screen and resized from its
 * bottom-right corner: a press that moves a few pixels is a drag (the
 * window follows through `rng_box_place`, and where it ended is saved,
 * `rng_box_save_frame`), a press that does not is a click (a new number).
 * Locked, a press is always a click.
 */
import { type CSSProperties, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import { inApp, ipc, onRngBoxRolled, onRngBoxStyle, type RngFrame, type RngSettings } from "../lib/ipc";
import styles from "./RngBox.module.css";

/** How far a press moves before it is a drag, not a click (CSS pixels). */
const DRAG_PX = 4;

/** One press on the box: a drag (`move`) or a resize from the corner. */
interface Gesture {
  kind: "move" | "resize";
  pointer: number;
  /** Where the press began, screen points. */
  sx: number;
  sy: number;
  /** The box's frame when it began (asked of the Rust side). */
  start: RngFrame | null;
  moved: boolean;
  /** The frame to send next; one `rng_box_place` in flight at a time. */
  latest: RngFrame | null;
  queued: boolean;
  chain: Promise<unknown>;
}

export function RngBoxWindow() {
  const t = useT().rngBox;
  const [number, setNumber] = useState<number | null>(null);
  const [look, setLook] = useState<RngSettings | null>(null);
  const gesture = useRef<Gesture | null>(null);
  /** The click that ends a drag rolls nothing. */
  const dragged = useRef(false);

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    ipc
      .rngBoxNumber()
      .then((n) => live && setNumber(n))
      .catch(() => undefined);
    ipc
      .getRngSettings()
      .then((s) => live && setLook(s))
      .catch(() => undefined);
    const stopRoll = onRngBoxRolled(setNumber);
    const stopStyle = onRngBoxStyle(setLook);
    return () => {
      live = false;
      stopRoll();
      stopStyle();
    };
  }, []);

  const roll = useCallback(() => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    ipc
      .rngBoxRoll()
      .then(setNumber)
      .catch(() => undefined);
  }, []);

  const locked = look?.locked ?? true;

  const send = (g: Gesture, frame: RngFrame) => {
    g.latest = frame;
    if (g.queued) return;
    g.queued = true;
    g.chain = g.chain
      .then(() => {
        g.queued = false;
        return g.latest ? ipc.rngBoxPlace(g.latest) : null;
      })
      .catch(() => undefined);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (locked || e.button !== 0 || gesture.current) return;
    const resize = (e.target as Element).closest("[data-grip]") !== null;
    const g: Gesture = {
      kind: resize ? "resize" : "move",
      pointer: e.pointerId,
      sx: e.screenX,
      sy: e.screenY,
      start: null,
      moved: false,
      latest: null,
      queued: false,
      chain: Promise.resolve(),
    };
    gesture.current = g;
    e.currentTarget.setPointerCapture(e.pointerId);
    ipc
      .rngBoxFrame()
      .then((frame) => {
        g.start = frame;
      })
      .catch(() => {
        if (gesture.current === g) gesture.current = null;
      });
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointer) return;
    const dx = e.screenX - g.sx;
    const dy = e.screenY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    g.moved = true;
    if (!g.start) return;
    const s = g.start;
    send(
      g,
      g.kind === "move"
        ? { ...s, x: Math.round(s.x + dx), y: Math.round(s.y + dy) }
        : { ...s, width: Math.round(s.width + dx), height: Math.round(s.height + dy) },
    );
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointer) return;
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g.moved) return;
    // A drag: its click rolls nothing; where the box ended is saved once the last move landed.
    dragged.current = e.type === "pointerup";
    void g.chain.then(() => ipc.rngBoxSaveFrame()).catch(() => undefined);
  };

  const style: CSSProperties = {};
  if (look) {
    style.fontSize = `${look.numberSize}px`;
    if (look.background) style.background = look.background;
    if (look.color) style.color = look.color;
  }

  return (
    <button
      type="button"
      className={`${styles.box} ${locked ? "" : styles.unlocked}`}
      style={style}
      title={locked ? t.hint : t.hintUnlocked}
      aria-label={t.label(number)}
      onClick={roll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <span aria-live="polite">{number ?? "…"}</span>
      {!locked && <span className={styles.grip} data-grip aria-hidden="true" />}
    </button>
  );
}
