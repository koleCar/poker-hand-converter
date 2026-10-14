/**
 * Saved filters (guideline §6): the row's first chip lists them - one click
 * applies a filter, × deletes it - and saves the filter in force under a
 * name (the same name replaces it). Kept in the local store
 * (`saved_filters`); a date preset stays relative ("last 7 days").
 */
import { useEffect, useRef, useState } from "react";
import { Chip } from "@rail/ui/chips/Chip";

import { useT } from "../../i18n";
import { errorText, inApp, ipc, type SavedFilter } from "../../lib/ipc";
import { activeGroups, fromSaved, toSaved, type FilterState } from "./filter";
import styles from "./FilterBar.module.css";
import { Popover } from "./Popover";

export function SavedFilters({
  filter,
  onApply,
}: {
  filter: FilterState;
  onApply: (filter: FilterState) => void;
}) {
  const t = useT().hands.saved;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) return;
    ipc
      .savedFilters()
      .then(setSaved)
      .catch(() => undefined);
  }, []);

  const save = () => {
    if (!name.trim()) return;
    ipc
      .saveFilter(name.trim(), toSaved(filter))
      .then((list) => {
        setSaved(list);
        setName("");
        setError(null);
      })
      .catch((reason: unknown) => setError(t.saveFailed(errorText(reason))));
  };

  return (
    <span ref={anchor} className={styles.anchor}>
      <Chip
        className={styles.group}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((was) => !was)}
      >
        {t.button}
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </Chip>
      {open ? (
        <Popover anchor={anchor} label={t.title} onClose={() => setOpen(false)}>
          {saved.length === 0 ? <p className={styles.hint}>{t.none}</p> : null}
          <ul className={styles.savedList}>
            {saved.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.savedApply}
                  aria-label={t.apply(item.name)}
                  onClick={() => {
                    const value = fromSaved(item.filter);
                    if (value) {
                      onApply(value);
                      setOpen(false);
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
                  onClick={() => {
                    ipc
                      .deleteSavedFilter(item.id)
                      .then(setSaved)
                      .catch(() => undefined);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {activeGroups(filter) > 0 ? (
            <form
              className={styles.saveForm}
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <label>
                {t.name}
                <input
                  value={name}
                  placeholder={t.namePlaceholder}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim()}>
                {t.save}
              </button>
            </form>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </Popover>
      ) : null}
    </span>
  );
}
