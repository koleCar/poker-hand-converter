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

/**
 * The saved filter the row is showing now, if it is one. The order is the
 * list's column headers' (2026-11-05): sorting does not leave a saved filter.
 */
function current(list: SavedFilter[], filter: FilterState): SavedFilter | null {
  return (
    list.find((item) => {
      const value = fromSaved(item.filter);
      if (value === null) return false;
      // A saved filter without a kind takes the one the screen pins (Cash |
      // Tournaments): it is in force under either.
      const formats = value.formats.length === 0 ? [] : filter.formats;
      return toSaved({ ...value, sort: "newest" }) === toSaved({ ...filter, formats, sort: "newest" });
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

/**
 * The saved filters as the filter row's second line shows them (the
 * owner's variant A, 2026-11-05): one pill each, always in view - a click
 * applies it, the one in force is filled - with ✎ (rename it, or replace its
 * filters with the ones in force) and × at hand, and "+ Save current" when
 * any filter is set.
 */
export function SavedRow({
  state,
  filter,
  active,
  onApply,
}: {
  state: SavedFiltersState;
  filter: FilterState;
  /** How many filters are set: nothing to save without one. */
  active: number;
  onApply: (filter: FilterState) => void;
}) {
  const t = useUiStrings().hands.saved;
  const inForce = current(state.list, filter);
  return (
    <div className={styles.savedRow} role="group" aria-label={t.title}>
      {state.list.map((item) => (
        <SavedPill
          key={item.id}
          item={item}
          on={inForce?.id === item.id}
          state={state}
          filter={filter}
          onApply={onApply}
        />
      ))}
      {active > 0 && !inForce ? <SaveCurrent state={state} filter={filter} /> : null}
      {state.list.length === 0 && active === 0 ? <span className={styles.savedHint}>{t.none}</span> : null}
    </div>
  );
}

function SavedPill({
  item,
  on,
  state,
  filter,
  onApply,
}: {
  item: SavedFilter;
  on: boolean;
  state: SavedFiltersState;
  filter: FilterState;
  onApply: (filter: FilterState) => void;
}) {
  const t = useUiStrings().hands.saved;
  const anchor = useRef<HTMLSpanElement>(null);
  const [editing, setEditing] = useState(false);
  const close = useCallback(() => setEditing(false), []);
  return (
    <span ref={anchor} className={on ? `${styles.savedPill} ${styles.savedOn}` : styles.savedPill}>
      <button
        type="button"
        className={styles.savedName}
        aria-pressed={on}
        aria-label={t.apply(item.name)}
        onClick={() => {
          const value = fromSaved(item.filter);
          if (value) onApply(value);
        }}
      >
        <span className={styles.savedStar} aria-hidden="true">
          ★
        </span>
        {item.name}
      </button>
      <button
        type="button"
        className={styles.savedTool}
        aria-label={t.edit(item.name)}
        title={t.edit(item.name)}
        aria-expanded={editing}
        onClick={() => setEditing((was) => !was)}
      >
        ✎
      </button>
      <button
        type="button"
        className={styles.savedTool}
        aria-label={t.remove(item.name)}
        title={t.remove(item.name)}
        onClick={() => state.remove(item.id)}
      >
        ×
      </button>
      {editing ? (
        <Popover anchor={anchor} label={t.edit(item.name)} onClose={close}>
          <EditSaved item={item} state={state} filter={filter} onDone={close} />
        </Popover>
      ) : null}
    </span>
  );
}

/** Rename a saved filter, put the filters in force in its place, or delete it. */
function EditSaved({
  item,
  state,
  filter,
  onDone,
}: {
  item: SavedFilter;
  state: SavedFiltersState;
  filter: FilterState;
  onDone: () => void;
}) {
  const t = useUiStrings().hands.saved;
  const [name, setName] = useState(item.name);
  const kept = fromSaved(item.filter);
  const rename = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === item.name || !kept) {
      onDone();
      return;
    }
    // The same name replaces: save under the new one, then let the old go.
    void state.save(next, kept).then((saved) => {
      if (saved) {
        state.remove(item.id);
        onDone();
      }
    });
  };
  return (
    <form className={styles.saveForm} onSubmit={rename}>
      <label>
        {t.name}
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className={styles.savedActions}>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void state.save(item.name, filter).then((saved) => {
              if (saved) onDone();
            });
          }}
        >
          {t.replace}
        </button>
        <button
          type="button"
          className={`btn btn--sm btn--ghost ${styles.danger}`}
          onClick={() => {
            state.remove(item.id);
            onDone();
          }}
        >
          {t.delete}
        </button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim()}>
          {t.saveButton}
        </button>
      </div>
      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** "+ Save current": names the filters in force. */
function SaveCurrent({ state, filter }: { state: SavedFiltersState; filter: FilterState }) {
  const t = useUiStrings().hands.saved;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span ref={anchor} className={styles.anchor}>
      <button
        type="button"
        className={styles.savedAdd}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((was) => !was)}
      >
        {t.saveCurrent}
      </button>
      {open ? (
        <Popover anchor={anchor} label={t.saveTitle} onClose={close}>
          <SaveForm state={state} filter={filter} onDone={close} />
        </Popover>
      ) : null}
    </span>
  );
}
