/**
 * The filter row of Hands and Reports (redesigned 2026-11, after the owner's
 * brief: modern, intuitive, no hand counts on every value). One line:
 *
 * - the saved filters (the one in force by name);
 * - one chip per group that is set - "Position BTN, CO" - which opens that
 *   group's editor, and its × takes it off; groups that are not set are not
 *   in the row at all;
 * - "+ Add filter", a searchable menu of every group and value;
 * - the order (where the source sorts), "Save as…", "Clear all" and "All
 *   filters", the builder with every group in panes.
 *
 * Under it, the quick filters: one-click spots over the same groups. The
 * row's groups are the source's (`handGroups`, `REPORT_GROUPS` in
 * `groups.ts`); a group the source cannot filter by is never offered.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import { useUiStrings } from "../i18n";
import type { FilterState } from "./filter";
import { AddFilter } from "./AddFilter";
import styles from "./FilterBar.module.css";
import { FilterBuilder } from "./FilterBuilder";
import { GroupEditor, Pills } from "./GroupEditor";
import { HAND_GROUPS, clearAll, clearGroup, paneOf, quickFor, shownSet, useGroupWords, type GroupId, type PaneId } from "./groups";
import type { FilterScreen, HandFacets, HandFilter, HandSort, SavedFiltersSource } from "./model";
import { Popover } from "./Popover";
import { SaveAs, SavedMenu, useSavedFilters } from "./SavedFilters";

export { HAND_GROUPS, REPORT_GROUPS, handGroups, type GroupId } from "./groups";

interface FilterBarProps {
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
  /** The groups the row offers, in order (the Hands screen's by default). */
  groups?: GroupId[];
  /** Whose saved filters the row lists. */
  screen?: FilterScreen;
  /** Where saved filters are kept; none, no saved filters. */
  saved?: SavedFiltersSource | undefined;
  /** The orders the `sort` group offers besides newest first. */
  sorts?: HandSort[];
  /** Counts a filter for the builder's "Show N hands" (and lists its values). */
  loadFacets?: ((query: HandFilter) => Promise<HandFacets>) | undefined;
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

export function FilterBar({
  filter,
  facets,
  onChange,
  groups = HAND_GROUPS,
  screen = "hands",
  saved,
  sorts = [],
  loadFacets,
}: FilterBarProps) {
  const t = useUiStrings().hands.filters;
  const savedState = useSavedFilters(saved, screen);
  const [builder, setBuilder] = useState<{ pane: PaneId | undefined } | null>(null);
  const filterGroups = useMemo(() => groups.filter((group) => group !== "sort"), [groups]);
  const quick = useMemo(() => quickFor(filterGroups), [filterGroups]);
  const set = shownSet(filterGroups, filter, facets);
  const player = screen === "hands" ? filter.player : null;
  const active = set.length + (player !== null ? 1 : 0);
  const openBuilder = useCallback((pane?: PaneId) => setBuilder({ pane }), []);

  return (
    <div className={styles.wrap}>
      <div className={styles.bar} role="toolbar" aria-label={t.label}>
        {saved ? (
          <>
            <SavedMenu state={savedState} filter={filter} onApply={onChange} />
            <span className={styles.divider} aria-hidden="true" />
          </>
        ) : null}
        <div className={styles.chips}>
          {player !== null ? (
            // Set from the Players screen ("hands with this player"): it is taken off, not edited.
            <span className={styles.chip}>
              <span className={styles.chipOpen}>
                <span className={styles.chipKey}>{t.groups.player}</span>
                <span className={styles.chipValue}>{player.player}</span>
              </span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={t.removePlayer(player.player)}
                title={t.removePlayer(player.player)}
                onClick={() => onChange({ ...filter, player: null })}
              >
                <CloseIcon />
              </button>
            </span>
          ) : null}
          {set.map((group) => (
            <ActiveChip key={group} group={group} filter={filter} facets={facets} onChange={onChange} onMore={openBuilder} />
          ))}
          <AddFilter groups={filterGroups} filter={filter} facets={facets} onChange={onChange} onBrowse={openBuilder} />
        </div>
        <div className={styles.tools}>
          {sorts.length > 0 && groups.includes("sort") ? <SortMenu filter={filter} sorts={sorts} onChange={onChange} /> : null}
          {saved && active > 0 ? <SaveAs state={savedState} filter={filter} /> : null}
          {active > 0 ? (
            <button type="button" className={styles.textButton} onClick={() => onChange(clearAll(filter, facets))}>
              {t.clearAll}
            </button>
          ) : null}
          <button type="button" className={styles.tool} onClick={() => openBuilder()}>
            <SlidersIcon />
            <span className={styles.toolText}>{t.allFilters}</span>
          </button>
        </div>
      </div>
      {quick.length > 0 ? (
        <div className={styles.quick}>
          <span className={styles.quickLabel} aria-hidden="true">
            {t.quick.label}
          </span>
          <Pills
            label={t.quick.label}
            options={quick.map((q) => ({ value: q.id, label: t.quick[q.id] }))}
            selected={quick.filter((q) => q.on(filter)).map((q) => q.id)}
            onChange={(next) => {
              let value = filter;
              for (const q of quick) {
                if (q.on(value) !== next.includes(q.id)) value = q.toggle(value);
              }
              onChange(value);
            }}
          />
        </div>
      ) : null}
      {builder ? (
        <FilterBuilder
          groups={groups}
          filter={filter}
          facets={facets}
          loadFacets={loadFacets}
          saved={saved ? savedState : undefined}
          startPane={builder.pane}
          onApply={onChange}
          onClose={() => setBuilder(null)}
        />
      ) : null}
    </div>
  );
}

/** A set group: its name and values; a click edits it, × takes it off. */
function ActiveChip({
  group,
  filter,
  facets,
  onChange,
  onMore,
}: {
  group: GroupId;
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
  onMore: (pane?: PaneId) => void;
}) {
  const t = useUiStrings().hands.filters;
  const words = useGroupWords();
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const name = words.name(group);
  const value = words.summary(group, filter, facets) ?? "";

  return (
    <span ref={anchor} className={styles.chip} data-open={open || undefined}>
      <button
        type="button"
        className={styles.chipOpen}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t.edit(name, value)}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.chipKey}>{name}</span>
        <span className={styles.chipValue}>{value}</span>
      </button>
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={t.remove(name)}
        title={t.remove(name)}
        onClick={() => {
          close();
          onChange(clearGroup(group, filter, facets));
        }}
      >
        <CloseIcon />
      </button>
      {open ? (
        <Popover anchor={anchor} label={name} onClose={close}>
          <GroupEditor group={group} filter={filter} facets={facets} onChange={onChange} variant="popover" />
          <div className={styles.popoverFoot}>
            <button
              type="button"
              className={styles.textLink}
              onClick={() => {
                close();
                onMore(paneOf(group));
              }}
            >
              {t.moreOptions} →
            </button>
            <button type="button" className="btn btn--primary btn--sm" onClick={close}>
              {t.done}
            </button>
          </div>
        </Popover>
      ) : null}
    </span>
  );
}

/** The order of the list (not a filter: "Clear all" leaves it). */
function SortMenu({ filter, sorts, onChange }: { filter: FilterState; sorts: HandSort[]; onChange: (filter: FilterState) => void }) {
  const t = useUiStrings().hands.filters;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const choices: HandSort[] = ["newest", ...sorts.filter((sort) => sort !== "newest")];
  return (
    <span ref={anchor} className={styles.anchor}>
      <button
        type="button"
        className={styles.tool}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t.summary(t.groups.sort, t.sorts[filter.sort])}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.toolText}>{t.sorts[filter.sort]}</span>
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <Popover anchor={anchor} label={t.groups.sort} onClose={close} align="end">
          <Pills
            label={t.groups.sort}
            single
            options={choices.map((value) => ({ value, label: t.sorts[value] }))}
            selected={[filter.sort]}
            onChange={(next) => {
              onChange({ ...filter, sort: (next[0] ?? "newest") as HandSort });
              close();
            }}
          />
        </Popover>
      ) : null}
    </span>
  );
}
