/**
 * Several hands chosen in any table of hands, not only the Hands list
 * (2026-11-16, the owner: "every table in the app" chooses several hands,
 * replays and tags them). A table is wrapped in {@link HandTable}; each of
 * its hand links takes {@link useChosenRow}'s props. Choosing is the Hands
 * list's (`@rail/ui/hands/useHandSelection`): Cmd/Ctrl + click adds or takes
 * out a hand, Shift + click takes every hand from the last one clicked,
 * Cmd/Ctrl + A takes them all, Escape lets them go; a plain click opens the
 * hand as before. A right click opens the hand menu (`HandActions`) for the
 * chosen hands, or for this one; with two or more chosen their bar shows.
 *
 * The table's order is its links' order on screen (`data-hand-key`), so a
 * table drawn by the shared package (the session review) needs no list of
 * its hands; a hand linked twice counts once.
 */
import {
  chooseAll,
  chooseOnly,
  chooseRun,
  chooseToggle,
  menuHands,
  NO_HANDS,
  type ChosenHands,
} from "@rail/ui/hands/useHandSelection";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { useHandActions } from "./HandActions";
import styles from "./HandTable.module.css";

interface Chooser {
  chosen: ReadonlySet<string>;
  /** A click on a hand, by its modifier keys; whether it only chose (no plain click). */
  click: (handKey: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => boolean;
  /** A right click on a hand. */
  menu: (handKey: string, at: { x: number; y: number }) => void;
}

const ChooserContext = createContext<Chooser | null>(null);

/** `state`'s hands in `order`'s order, none that is not in it. */
function inOrder(state: ChosenHands, order: readonly string[]): ChosenHands {
  return { checked: new Set(order.filter((key) => state.checked.has(key))), anchor: state.anchor };
}

export function HandTable({
  children,
  className,
  resetKey,
}: {
  children: ReactNode;
  className?: string;
  /** A new value (another session, another period) lets the chosen hands go. */
  resetKey?: unknown;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ChosenHands>(NO_HANDS);
  const [shownFor, setShownFor] = useState(resetKey);
  if (shownFor !== resetKey) {
    setShownFor(resetKey);
    setState(NO_HANDS);
  }
  const actions = useHandActions();
  const { openMenu } = actions;

  /** The table's hands as they are on screen. */
  const order = useCallback(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const link of box.current?.querySelectorAll<HTMLElement>("[data-hand-key]") ?? []) {
      const key = link.dataset.handKey;
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    return keys;
  }, []);

  const click = useCallback<Chooser["click"]>(
    (handKey, event) => {
      const keys = order();
      if (event.shiftKey) {
        setState((was) => inOrder(chooseRun(was, keys, handKey, event.metaKey || event.ctrlKey), keys));
        return true;
      }
      if (event.metaKey || event.ctrlKey) {
        setState((was) => inOrder(chooseToggle(was, handKey), keys));
        return true;
      }
      // A plain click opens the hand and lets the others go; Shift + click ranges from it.
      setState({ checked: new Set(), anchor: handKey });
      return false;
    },
    [order],
  );

  const menu = useCallback<Chooser["menu"]>(
    (handKey, at) => {
      const chosen = menuHands(state, order(), handKey);
      if (chosen !== null) {
        openMenu(chosen, at);
        return;
      }
      setState(chooseOnly(handKey));
      openMenu([handKey], at);
    },
    [state, order, openMenu],
  );

  const clear = useCallback(() => setState(NO_HANDS), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const keys = order();
      setState((was) => chooseAll(was, keys));
    } else if (event.key === "Escape" && state.checked.size > 0) {
      event.preventDefault();
      clear();
    }
  };

  const chooser = useMemo<Chooser>(() => ({ chosen: state.checked, click, menu }), [state.checked, click, menu]);

  return (
    <ChooserContext.Provider value={chooser}>
      <div ref={box} className={className} data-choosing={state.checked.size > 0 || undefined} onKeyDown={onKeyDown}>
        {children}
      </div>
      {actions.bar([...state.checked], clear)}
      {actions.element}
    </ChooserContext.Provider>
  );
}

/**
 * A hand link's props in a {@link HandTable}: the hand's key for the
 * table's order, its chosen mark, the click that chooses or opens (`open`),
 * the right click's menu. Outside a table the click only opens.
 */
export function useChosenRow(handKey: string, open: () => void, className?: string) {
  const table = useContext(ChooserContext);
  const chosen = table?.chosen.has(handKey) ?? false;
  return {
    "data-hand-key": handKey,
    className: chosen ? `${className ?? ""} ${styles.chosen}`.trim() : className,
    onMouseDown: (event: MouseEvent) => {
      // Shift + click chooses hands, it does not select the table's text.
      if (event.shiftKey) event.preventDefault();
    },
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      if (table?.click(handKey, event)) return;
      open();
    },
    onContextMenu: (event: MouseEvent) => {
      if (!table) return;
      event.preventDefault();
      table.menu(handKey, { x: event.clientX, y: event.clientY });
    },
  };
}

/** A hand's link in a {@link HandTable}: an `<a>` with {@link useChosenRow}'s props. */
export function ChosenLink({
  handKey,
  href,
  open,
  className,
  label,
  children,
}: {
  handKey: string;
  href: string;
  open: () => void;
  className?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
}) {
  const row = useChosenRow(handKey, open, className);
  return (
    <a href={href} aria-label={label} {...row}>
      {children}
    </a>
  );
}
