/**
 * Several hands chosen in a list, the way a file list chooses: a click
 * chooses one hand, Cmd/Ctrl + click adds or removes one, Shift + click (or
 * Shift + an arrow key) takes every hand from the last one clicked to this
 * one, Cmd/Ctrl + A takes every loaded hand. A right click on a chosen hand
 * acts on all of them; on another hand, on that one alone (`forMenu`).
 *
 * The chosen hands are kept by key in the list's order, so the list's
 * next pages arriving keeps them; a hand no longer in the list (another
 * filter) is let go.
 */
import { useCallback, useMemo, useState } from "react";

export interface HandSelection {
  /** The chosen hands' keys. */
  readonly checked: ReadonlySet<string>;
  /** How many are chosen. */
  readonly size: number;
  /** Choose this hand alone. */
  only: (handKey: string) => void;
  /** Add this hand, or take it out. */
  toggle: (handKey: string) => void;
  /** Every hand from the last one chosen to this one (`add`: keep the others too). */
  extendTo: (handKey: string, add?: boolean) => void;
  /** Every loaded hand. */
  all: () => void;
  /** Nothing chosen. */
  clear: () => void;
  /** A click on a row, by its modifier keys; whether it only chose (no plain click). */
  click: (handKey: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => boolean;
  /**
   * A right click on a row: the hands to act on, in the list's order - every
   * chosen one when this is one of them, else this one (now chosen alone).
   */
  forMenu: (handKey: string) => string[];
}

/** The chosen hands and where Shift + click ranges from. */
export interface ChosenHands {
  checked: ReadonlySet<string>;
  anchor: string | null;
}

export const NO_HANDS: ChosenHands = { checked: new Set(), anchor: null };

/** This hand alone. */
export function chooseOnly(handKey: string): ChosenHands {
  return { checked: new Set([handKey]), anchor: handKey };
}

/** This hand added, or taken out. */
export function chooseToggle(was: ChosenHands, handKey: string): ChosenHands {
  const checked = new Set(was.checked);
  if (checked.has(handKey)) checked.delete(handKey);
  else checked.add(handKey);
  return { checked, anchor: handKey };
}

/**
 * Every hand of `order` from the anchor to this one (`add`: the others
 * stay). The anchor stays, so Shift + click again ranges from it.
 */
export function chooseRun(was: ChosenHands, order: readonly string[], handKey: string, add: boolean): ChosenHands {
  const to = order.indexOf(handKey);
  const from = was.anchor === null ? -1 : order.indexOf(was.anchor);
  if (to < 0) return was;
  if (from < 0) return chooseOnly(handKey);
  const [low, high] = from <= to ? [from, to] : [to, from];
  const checked = new Set(add ? was.checked : []);
  for (let index = low; index <= high; index += 1) checked.add(order[index] as string);
  return { checked, anchor: was.anchor };
}

/** Every hand of `order`. */
export function chooseAll(was: ChosenHands, order: readonly string[]): ChosenHands {
  return { checked: new Set(order), anchor: was.anchor ?? order[0] ?? null };
}

/** Only the chosen hands still in `order` (another filter lets the rest go). */
export function chosenIn(was: ChosenHands, order: readonly string[]): ChosenHands {
  if (was.checked.size === 0) return was;
  const present = new Set(order);
  const kept = [...was.checked].filter((key) => present.has(key));
  if (kept.length === was.checked.size) return was;
  return { checked: new Set(kept), anchor: was.anchor !== null && present.has(was.anchor) ? was.anchor : null };
}

/** A right click on this hand: the chosen hands in `order`'s order, or `null` when it is not one of them. */
export function menuHands(state: ChosenHands, order: readonly string[], handKey: string): string[] | null {
  return state.checked.has(handKey) ? order.filter((key) => state.checked.has(key)) : null;
}

export function useHandSelection(rows: readonly { handKey: string }[]): HandSelection {
  const [raw, setState] = useState<ChosenHands>(NO_HANDS);
  const order = useMemo(() => rows.map((row) => row.handKey), [rows]);
  const state = useMemo(() => chosenIn(raw, order), [raw, order]);

  const only = useCallback((handKey: string) => setState(chooseOnly(handKey)), []);
  const toggle = useCallback((handKey: string) => setState((was) => chooseToggle(was, handKey)), []);
  const extendTo = useCallback(
    (handKey: string, add = false) => setState((was) => chooseRun(was, order, handKey, add)),
    [order],
  );
  const all = useCallback(() => setState((was) => chooseAll(was, order)), [order]);
  const clear = useCallback(() => setState(NO_HANDS), []);

  const click = useCallback(
    (handKey: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      if (event.shiftKey) {
        extendTo(handKey, event.metaKey || event.ctrlKey);
        return true;
      }
      if (event.metaKey || event.ctrlKey) {
        toggle(handKey);
        return true;
      }
      only(handKey);
      return false;
    },
    [extendTo, toggle, only],
  );

  const forMenu = useCallback(
    (handKey: string) => {
      const chosen = menuHands(state, order, handKey);
      if (chosen !== null) return chosen;
      only(handKey);
      return [handKey];
    },
    [state, order, only],
  );

  return useMemo(
    () => ({ checked: state.checked, size: state.checked.size, only, toggle, extendTo, all, clear, click, forMenu }),
    [state.checked, only, toggle, extendTo, all, clear, click, forMenu],
  );
}
