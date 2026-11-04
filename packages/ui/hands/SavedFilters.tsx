/**
 * Saved filters (guideline §6): the row's first button lists them - one
 * click applies one, × deletes it, the one in force is marked - and "Save
 * as…" keeps the filter in force under a name (the same name replaces it).
 * Kept where the surface keeps them (the desktop app's local store's
 * `saved_filters`, per screen); a date preset stays relative ("last 7
 * days"). The desktop app's (R2.7a), shared since R4.5b; split into the
 * list and the save form for the new row (2026-11), over one hook so a
 * filter saved in either shows in the list at once.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { useUiStrings } from "../i18n";
import { fromSaved, toSaved, type FilterState } from "./filter";
import styles from "./FilterBar.module.css";
import { errorText, type FilterScreen, type SavedFilter, type SavedFiltersSource } from "./model";
import { Popover } from "./Popover";

export interface SavedFiltersState {
  list: SavedFilter[];
  error: string | null;
  save: (name: string, filter: FilterState) => Promise<boolean>;
  remove: (id: SavedFilter["id"]) => void;
}

/** The screen's saved filters and what changes them. */
export function useSavedFilters(source: SavedFiltersSource | undefined, screen: FilterScreen): SavedFiltersState {
  const t = useUiStrings().hands.saved;
  const [list, setList] = useState<SavedFilter[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let live = true;
    source
      .list(screen)
      .then((items) => {
        if (live) setList(items);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [source, screen]);

  const save = useCallback(
    async (name: string, filter: FilterState) => {
      if (!source || !name.trim()) return false;
      try {
        setList(await source.save(name.trim(), toSaved(filter), screen));
        setError(null);
        return true;
      } catch (reason: unknown) {
        setError(t.saveFailed(errorText(reason)));
        return false;
      }
    },
    [source, screen, t],
  );

  const remove = useCallback(
    (id: SavedFilter["id"]) => {
      source
        ?.remove(id, screen)
        .then(setList)
        .catch(() => undefined);
    },
    [source, screen],
  );

  return { list, error, save, remove };
}

/** The saved filter the row is showing now, if it is one. */
function current(list: SavedFilter[], filter: FilterState): SavedFilter | null {
  const now = toSaved(filter);
  return (
    list.find((item) => {
      const value = fromSaved(item.filter);
      return value !== null && toSaved(value) === now;
    }) ?? null
  );
}

export function BookmarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  );
}

/** The list: the first button of the row. */
export function SavedMenu({
  state,
  filter,
  onApply,
}: {
  state: SavedFiltersState;
  filter: FilterState;
  onApply: (filter: FilterState) => void;
}) {
  const t = useUiStrings().hands.saved;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const inForce = current(state.list, filter);

  return (
    <span ref={anchor} className={styles.anchor}>
      <button
        type="button"
        className={styles.tool}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((was) => !was)}
      >
        <BookmarkIcon />
        <span className={styles.toolText}>{inForce ? inForce.name : t.button}</span>
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <Popover anchor={anchor} label={t.title} onClose={close}>
          {state.list.length === 0 ? <p className={styles.hint}>{t.none}</p> : null}
          <ul className={styles.savedList}>
            {state.list.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.savedApply}
                  aria-current={inForce?.id === item.id ? "true" : undefined}
                  aria-label={t.apply(item.name)}
                  onClick={() => {
                    const value = fromSaved(item.filter);
                    if (value) {
                      onApply(value);
                      close();
                    }
                  }}
                >
                  {item.name}
                </button>
                <button
                  type="button"
                  className={styles.savedDelete}
                  aria-label={t.remove(item.name)}
                  title={t.remove(item.name)}
                  onClick={() => state.remove(item.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </span>
  );
}

/** The form that names and saves the filter in force. */
export function SaveForm({
  state,
  filter,
  onDone,
}: {
  state: SavedFiltersState;
  filter: FilterState;
  onDone?: (() => void) | undefined;
}) {
  const t = useUiStrings().hands.saved;
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void state.save(name, filter).then((saved) => {
      if (saved) {
        setName("");
        onDone?.();
      }
    });
  };
  return (
    <form className={styles.saveForm} onSubmit={submit}>
      <label>
        {t.name}
        <input value={name} placeholder={t.namePlaceholder} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim()}>
        {t.saveButton}
      </button>
      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** "Save as…" in the row. */
export function SaveAs({ state, filter }: { state: SavedFiltersState; filter: FilterState }) {
  const t = useUiStrings().hands.saved;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span ref={anchor} className={styles.anchor}>
      <button
        type="button"
        className={styles.textButton}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((was) => !was)}
      >
        {t.saveAs}
      </button>
      {open ? (
        <Popover anchor={anchor} label={t.saveTitle} onClose={close} align="end">
          <SaveForm state={state} filter={filter} onDone={close} />
        </Popover>
      ) : null}
    </span>
  );
}
