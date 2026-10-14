import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import styles from "./CommandPalette.module.css";
import { fuzzyMatch } from "./fuzzy";

export interface PaletteItem {
  /** Unique among the items shown. */
  id: string;
  label: string;
  /** A second, quieter line: the hand's stakes and date, a player's room. */
  detail?: string;
  /** Items with the same group are listed under one heading, in the order given. */
  group?: string;
  /** Other words the item answers to (`rankItems`); not shown. */
  keywords?: readonly string[];
  /** The item's own key combination, one key cap per string (`["⌘", "1"]`); shown at the right. */
  shortcut?: readonly string[];
}

/** A line of the footer: what a key does here (`↑ ↓` "to move"). */
export interface PaletteKeyHint {
  keys: readonly string[];
  label: string;
}

export interface CommandPaletteProps {
  /** Mount it to open it; `onClose` asks the surface to unmount it (Escape, a backdrop click). */
  onClose: () => void;
  /** The dialog's accessible name ("Go to"). */
  label: string;
  /** The search field's placeholder ("Hand, player or report"). */
  placeholder: string;
  /** Shown when nothing matches the query. */
  emptyText: string;
  /** What the surface found for `query`, best first. The palette filters nothing itself. */
  items: readonly PaletteItem[];
  query: string;
  onQueryChange: (query: string) => void;
  /** Enter or a click on an item. The surface navigates, then unmounts the palette. */
  onSelect: (item: PaletteItem) => void;
  /** The surface is still asking for more (a store search): `busyText` shows under the items. */
  busy?: boolean;
  busyText?: string;
  /** Read out when the list changes ("5 results"); a polite live region. */
  resultsText?: (count: number) => string;
  /** The footer's key hints. */
  keyHints?: readonly PaletteKeyHint[];
}

/** The label with the query's matched characters marked. */
function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const match = query.trim() === "" ? null : fuzzyMatch(query, text);
  if (match === null || match.indexes.length === 0) return text;
  const marked = new Set(match.indexes);
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (run === "") return;
    parts.push(runMarked ? <mark key={key} className={styles.mark}>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += text[i];
  }
  flush(text.length);
  return parts;
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className={styles.keys}>
      {keys.map((key, index) => (
        <kbd key={index} className={styles.kbd}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The command palette's shell (guideline §6: Cmd/Ctrl + K to jump to a hand, a
 * player or a report; R2.8: and to run a command). UI only: a search field
 * and a list on the platform's modal `<dialog>` (inert page, Escape), with the
 * arrow keys - and Tab / Shift + Tab, which never leave the field - moving
 * through the list, Page Up / Page Down by five, and Enter choosing. The
 * active item scrolls into view; the query's matched letters are marked
 * (`fuzzy.ts`, the same match `rankItems` ranks by); an item may show its own
 * shortcut, and the footer the palette's keys. What the query finds, where a
 * choice goes and which key opens the palette are the surface's: the web
 * searches Supabase, the desktop app its local store and its commands.
 *
 * The list is an ARIA listbox (options in labelled groups) driven from the
 * field (`aria-activedescendant`), so focus never leaves the text the user is
 * typing.
 */
export function CommandPalette({
  onClose,
  label,
  placeholder,
  emptyText,
  items,
  query,
  onQueryChange,
  onSelect,
  busy = false,
  busyText,
  resultsText,
  keyHints,
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = useId();
  const [active, setActive] = useState(0);
  // A new result list starts at its first item.
  const [shownItems, setShownItems] = useState(items);
  if (shownItems !== items) {
    setShownItems(items);
    setActive(0);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => dialog?.close();
  }, []);

  // Keep the active option in view as the keys move it.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${optionId}-${active}`)}`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active, optionId, items]);

  const move = (step: number, wrap: boolean) => {
    if (items.length === 0) return;
    setActive((current) => {
      const next = current + step;
      if (wrap) return (next + items.length) % items.length;
      return Math.max(0, Math.min(items.length - 1, next));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1, true);
        break;
      case "Tab":
        // The field is the dialog's only stop: Tab moves through the list
        // instead of out of it.
        event.preventDefault();
        move(event.shiftKey ? -1 : 1, true);
        break;
      case "PageDown":
      case "PageUp":
        event.preventDefault();
        move(event.key === "PageDown" ? 5 : -5, false);
        break;
      case "Escape":
        // A search field would only clear its text: Escape closes, typed or not.
        event.preventDefault();
        onClose();
        break;
      case "Enter": {
        const item = items[active];
        if (item) {
          event.preventDefault();
          onSelect(item);
        }
        break;
      }
      default:
    }
  };

  // Consecutive items with one group, in the order given.
  const groups: { name: string | undefined; start: number; items: PaletteItem[] }[] = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, start: index, items: [item] });
  });

  return (
    <dialog
      ref={dialogRef}
      className={styles.palette}
      aria-label={label}
      onCancel={(event) => {
        // Escape: the surface decides (it unmounts the palette).
        event.preventDefault();
        onClose();
      }}
      // The browser may close a modal dialog itself without a cancel event
      // (a second Escape with no user activation in between): the surface
      // still has to hear of it, or it would keep an invisible palette open.
      // A close event that finds the dialog open again is the effect's own
      // cleanup re-run (React's development double mount): not a close.
      onClose={() => {
        if (!dialogRef.current?.open) onClose();
      }}
      onClick={(event) => {
        // A click on the dialog element itself is a click on the backdrop.
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <input
        className={styles.input}
        type="search"
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={items[active] ? `${optionId}-${active}` : undefined}
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {items.length === 0 ? (
        <p className={styles.empty}>{busy && busyText ? busyText : emptyText}</p>
      ) : (
        <div ref={listRef} id={listId} role="listbox" aria-label={label} className={styles.list}>
          {groups.map((group) => {
            const headingId = `${optionId}-g${group.start}`;
            return (
              <div
                key={headingId}
                role="group"
                aria-labelledby={group.name === undefined ? undefined : headingId}
                className={styles.groupBlock}
              >
                {group.name === undefined ? null : (
                  <div id={headingId} role="presentation" className={styles.group}>
                    {group.name}
                  </div>
                )}
                {group.items.map((item, offset) => {
                  const index = group.start + offset;
                  return (
                    <div
                      key={item.id}
                      id={`${optionId}-${index}`}
                      role="option"
                      aria-selected={index === active}
                      className={index === active ? `${styles.item} ${styles.active}` : styles.item}
                      onMouseMove={() => setActive(index)}
                      onClick={() => onSelect(item)}
                    >
                      <span className={styles.label}>
                        <Highlighted text={item.label} query={query} />
                      </span>
                      {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
                      {item.shortcut && item.shortcut.length > 0 ? <Keys keys={item.shortcut} /> : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {busy && busyText ? <p className={styles.busy}>{busyText}</p> : null}
        </div>
      )}
      {resultsText ? (
        <p className={styles.hidden} aria-live="polite">
          {resultsText(items.length)}
        </p>
      ) : null}
      {keyHints && keyHints.length > 0 ? (
        <div className={styles.footer} aria-hidden="true">
          {keyHints.map((hint) => (
            <span key={hint.label} className={styles.hint}>
              <Keys keys={hint.keys} />
              {hint.label}
            </span>
          ))}
        </div>
      ) : null}
    </dialog>
  );
}
