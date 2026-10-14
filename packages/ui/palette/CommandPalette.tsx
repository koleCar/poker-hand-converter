import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import styles from "./CommandPalette.module.css";

export interface PaletteItem {
  /** Unique among the items shown. */
  id: string;
  label: string;
  /** A second, quieter line: the hand's stakes and date, a player's room. */
  detail?: string;
  /** Items with the same group are listed under one heading, in the order given. */
  group?: string;
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
}

/**
 * The command palette's shell (guideline §6: Cmd/Ctrl + K to jump to a hand, a
 * player or a report). UI only: a search field and a list on the platform's
 * modal `<dialog>` (focus trap, inert page, Escape), with the arrow keys
 * moving through the list and Enter choosing. What the query finds, where a
 * choice goes and which key opens the palette are the surface's: the web
 * searches Supabase, the desktop app its local store.
 *
 * The list is an ARIA listbox driven from the field (`aria-activedescendant`),
 * so focus never leaves the text the user is typing.
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
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
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

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => (current + step + items.length) % items.length);
      }
    } else if (event.key === "Enter") {
      const item = items[active];
      if (item) {
        event.preventDefault();
        onSelect(item);
      }
    }
  };

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
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <ul id={listId} role="listbox" aria-label={label} className={styles.list}>
          {items.flatMap((item, index) => {
            const heading = item.group !== undefined && item.group !== items[index - 1]?.group ? item.group : null;
            const option = (
              <li
                key={item.id}
                id={`${optionId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? `${styles.item} ${styles.active}` : styles.item}
                onMouseMove={() => setActive(index)}
                onClick={() => onSelect(item)}
              >
                <span className={styles.label}>{item.label}</span>
                {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
              </li>
            );
            return heading === null
              ? [option]
              : [
                  <li key={`group:${index}`} role="presentation" className={styles.group}>
                    {heading}
                  </li>,
                  option,
                ];
          })}
        </ul>
      )}
    </dialog>
  );
}
