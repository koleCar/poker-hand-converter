/**
 * "+ Add filter": a menu that searches every value of every group the row
 * has ("3bet" finds the 3-bet pots, "btn" the button) and adds the one
 * picked; with nothing typed it lists the groups, and a group opens its
 * editor in place. The arrow keys move, Enter adds, Escape closes;
 * "Browse all filters" opens the builder.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useUiStrings } from "../i18n";
import { DATE_PRESETS, type FilterState } from "./filter";
import styles from "./FilterBar.module.css";
import { GroupEditor } from "./GroupEditor";
import { FLAG_GROUPS, LIST_GROUPS, PANES, isSet, quickFor, useGroupWords, type GroupId, type PaneId } from "./groups";
import type { HandFacets } from "./model";
import { Popover } from "./Popover";

export interface SearchHit {
  key: string;
  label: string;
  /** Where it lives ("Position", "Quick"). */
  where: string;
  on: boolean;
  /** Adds (or, when on, removes) it. */
  apply: (filter: FilterState) => FilterState;
}

/** Lower case, letters, digits and plus only: "3-Bet" and "3bet" meet. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}+]/gu, "");
}

/** Every value of these groups (and the quick filters) that matches what was typed. */
export function useSearchHits(groups: readonly GroupId[], filter: FilterState, facets: HandFacets | null, query: string) {
  const t = useUiStrings().hands.filters;
  const words = useGroupWords();
  return useMemo(() => {
    const needle = normalise(query);
    if (!needle) return [];
    const hits: SearchHit[] = [];
    const matches = (label: string, group: string) => normalise(label).includes(needle) || normalise(group + label).includes(needle);
    for (const quick of quickFor(groups)) {
      const label = t.quick[quick.id];
      if (matches(label, "")) {
        hits.push({ key: `quick:${quick.id}`, label, where: t.quick.label, on: quick.on(filter), apply: quick.toggle });
      }
    }
    for (const group of groups) {
      const name = words.name(group);
      const list = LIST_GROUPS[group];
      if (list) {
        for (const option of words.options(group, filter, facets)) {
          if (!matches(option.label, name)) continue;
          const on = filter[list].includes(option.value);
          hits.push({
            key: `${group}:${option.value}`,
            label: option.label,
            where: name,
            on,
            apply: (f) => ({ ...f, [list]: on ? f[list].filter((v) => v !== option.value) : [...f[list], option.value] }),
          });
        }
      }
      const flag = FLAG_GROUPS[group];
      if (flag) {
        const pairs = group === "allIn" ? t.allIn : group === "notes" ? t.notes : t.showdownValues;
        for (const answer of ["yes", "no"] as const) {
          if (!matches(pairs[answer], name)) continue;
          const value = answer === "yes";
          const on = filter[flag] === value;
          hits.push({ key: `${group}:${answer}`, label: pairs[answer], where: name, on, apply: (f) => ({ ...f, [flag]: on ? null : value }) });
        }
      }
      if (group === "date") {
        for (const preset of DATE_PRESETS) {
          if (preset === "custom" || !matches(t.dates[preset], name)) continue;
          const on = filter.date === preset;
          hits.push({
            key: `date:${preset}`,
            label: t.dates[preset],
            where: name,
            on,
            apply: (f) => ({ ...f, date: on ? null : preset, dateFrom: "", dateTo: "" }),
          });
        }
      }
    }
    return hits;
  }, [groups, filter, facets, query, t, words]);
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function AddFilter({
  groups,
  filter,
  facets,
  onChange,
  onBrowse,
}: {
  groups: readonly GroupId[];
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
  /** Opens the builder, on a pane when one is named. */
  onBrowse: (pane?: PaneId) => void;
}) {
  const t = useUiStrings().hands.filters;
  const words = useGroupWords();
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [drill, setDrill] = useState<GroupId | null>(null);
  const [active, setActive] = useState(0);
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setDrill(null);
    setActive(0);
  }, []);

  const hits = useSearchHits(groups, filter, facets, query);
  // With nothing typed: the groups, in the builder's order.
  const listed = useMemo(
    () => PANES.flatMap((section) => section.panes.flatMap((pane) => pane.groups)).filter((group) => groups.includes(group)),
    [groups],
  );
  const rows = query.trim() ? hits.length : listed.length;

  const run = (index: number) => {
    if (query.trim()) {
      const hit = hits[index];
      if (hit) {
        onChange(hit.apply(filter));
        close();
      }
    } else {
      const group = listed[index];
      if (group) setDrill(group);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows === 0) return;
      setActive((was) => (was + (event.key === "ArrowDown" ? 1 : rows - 1)) % rows);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(active);
    }
  };

  return (
    <span ref={anchor} className={styles.anchor}>
      <button type="button" className={styles.add} aria-expanded={open} aria-haspopup="dialog" onClick={() => (open ? close() : setOpen(true))}>
        <PlusIcon />
        {t.addFilter}
      </button>
      {open ? (
        <Popover anchor={anchor} label={t.menu.label} onClose={close} className={styles.menu}>
          {drill === null ? (
            <>
              <label className={styles.menuSearch}>
                <SearchIcon />
                <span className={styles.visuallyHidden}>{t.menu.search}</span>
                <input
                  type="search"
                  value={query}
                  placeholder={t.menu.placeholder}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKey}
                  aria-controls="rail-add-filter-results"
                />
              </label>
              <ul id="rail-add-filter-results" className={styles.menuList}>
                {query.trim()
                  ? hits.map((hit, index) => (
                      <li key={hit.key}>
                        <button
                          type="button"
                          className={styles.menuRow}
                          data-active={index === active || undefined}
                          aria-pressed={hit.on}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => run(index)}
                        >
                          <span className={styles.menuLabel}>{hit.label}</span>
                          <span className={styles.menuWhere}>{hit.where}</span>
                        </button>
                      </li>
                    ))
                  : listed.map((group, index) => (
                      <li key={group}>
                        <button
                          type="button"
                          className={styles.menuRow}
                          data-active={index === active || undefined}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => run(index)}
                        >
                          <span className={styles.menuLabel}>{words.name(group)}</span>
                          <span className={styles.menuWhere}>{isSet(group, filter) ? words.summary(group, filter, facets) : null}</span>
                          <span className={styles.caretRight} aria-hidden="true">
                            ›
                          </span>
                        </button>
                      </li>
                    ))}
              </ul>
              {query.trim() && hits.length === 0 ? <p className={styles.hint}>{t.menu.none(query.trim())}</p> : null}
              <div className={styles.menuFoot}>
                <span>{t.menu.keys}</span>
                <button
                  type="button"
                  className={styles.textLink}
                  onClick={() => {
                    close();
                    onBrowse();
                  }}
                >
                  {t.menu.browse} →
                </button>
              </div>
            </>
          ) : (
            <div className={styles.editorStack}>
              <div className={styles.menuDrillHead}>
                <button type="button" className={styles.textButton} onClick={() => setDrill(null)}>
                  ‹ {t.menu.back}
                </button>
                <strong>{words.name(drill)}</strong>
              </div>
              <GroupEditor group={drill} filter={filter} facets={facets} onChange={onChange} variant="popover" />
              <div className={styles.popoverFoot}>
                <button
                  type="button"
                  className={styles.textLink}
                  onClick={() => {
                    const group = drill;
                    close();
                    onBrowse(PANES.flatMap((s) => s.panes).find((pane) => pane.groups.includes(group))?.id);
                  }}
                >
                  {t.moreOptions} →
                </button>
                <button type="button" className="btn btn--primary btn--sm" onClick={close}>
                  {t.done}
                </button>
              </div>
            </div>
          )}
        </Popover>
      ) : null}
    </span>
  );
}
