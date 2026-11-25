/**
 * The filter row of every screen that filters hands - Hands, Reports, ...
 * (redesigned 2026-11, after the owner's
 * brief: modern, intuitive, no hand counts on every value; the owner's
 * variant A of 2026-11-05). Two lines. The first holds what is set:
 *
 * - one chip per group that is set - "Position BTN, CO" - which opens that
 *   group's editor, and its × takes it off; groups that are not set are not
 *   in the row at all;
 * - "+ Add filter", a searchable menu of every group and value, which a
 *   click anywhere on the row's empty space opens too, as on a search bar
 *   (#418);
 * - "Clear all" and "All filters", the builder with every group in panes.
 *
 * The second is always in view: the quick filters (one-click spots over the
 * same groups) and the saved filters (`SavedRow`: apply, edit, delete, save
 * the filters in force). The order is the list's column headers. On a
 * phone both lines are one row that scrolls sideways, "Filters (n)" first
 * (it opens the builder, full screen there), and the chips' panels are
 * bottom sheets (`Popover`). The
 * row's groups are `filterGroups` of the surface's features (`groups.ts`),
 * the same on every screen: a screen cannot pick its own, so a change to
 * the filters is a change everywhere (2026-11-16, the owner).
 */
import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";

import { useUiStrings } from "../i18n";
import type { FilterState } from "./filter";
import { AddFilter } from "./AddFilter";
import styles from "./FilterBar.module.css";
import { FilterBuilder } from "./FilterBuilder";
import { GroupEditor, Pills } from "./GroupEditor";
import { clearAll, clearGroup, paneOf, filterGroups, quickFor, shownSet, useGroupWords, type GroupId, type PaneId } from "./groups";
import type { FilterScreen, HandFacets, HandFilter, HandSort, HandsFeatures, SavedFiltersSource } from "./model";
import { Popover } from "./Popover";
import { SavedRow, useSavedFilters } from "./SavedFilters";

export { HAND_GROUPS, ROLLUP_GROUPS, filterGroups, type GroupId } from "./groups";

interface FilterBarProps {
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
  /** What the surface can filter by: the row's groups are `filterGroups` of it. */
  features: HandsFeatures;
  /** Groups left out of the row and the builder (`groupsHiddenFor`: the tournament ones while the desktop shows cash). */
  hideGroups?: readonly GroupId[];
  /** Whose saved filters the row lists. */
  screen?: FilterScreen;
  /** Where saved filters are kept; none, no saved filters. */
  saved?: SavedFiltersSource | undefined;
  /** The orders the `sort` group offers besides newest first. */
  /** Unused since the order moved to the list's column headers (kept for the callers). */
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
  features,
  hideGroups,
  screen = "hands",
  saved,
  loadFacets,
}: FilterBarProps) {
  const words = useUiStrings();
  const t = words.hands.filters;
  const savedState = useSavedFilters(saved, screen);
  const [builder, setBuilder] = useState<{ pane: PaneId | undefined } | null>(null);
  const groups = useMemo(
    () => filterGroups(features).filter((group) => !hideGroups?.includes(group)),
    [features, hideGroups],
  );
  const rowGroups = useMemo(() => groups.filter((group) => group !== "sort"), [groups]);
  const quick = useMemo(() => quickFor(rowGroups), [rowGroups]);
  const set = shownSet(rowGroups, filter, facets);
  // "Hands with this player" (from Players) narrows every screen that has it.
  const player = filter.player ?? null;
  const active = set.length + (player !== null ? 1 : 0);
  const openBuilder = useCallback((pane?: PaneId) => setBuilder({ pane }), []);
  const [adding, setAdding] = useState(false);
  // A press on the row while a panel is open only closes that panel (the
  // panel's own outside-press); the click after it does not open the menu.
  const addOnClick = useRef(false);

  // The row's empty space opens "+ Add filter", like a click into a search
  // bar; its chips, buttons and open panels keep their own clicks. The
  // keyboard has the "+ Add filter" button itself.
  const onBarPointerDown = (event: MouseEvent<HTMLDivElement>) => {
    addOnClick.current = event.currentTarget.querySelector('[role="dialog"]') === null;
  };
  const onBarClick = (event: MouseEvent<HTMLDivElement>) => {
    for (let at = event.target as Element | null; at && at !== event.currentTarget; at = at.parentElement) {
      if (at.matches('button, a, input, select, textarea, label, [role="dialog"]') || at.classList.contains(styles.chip ?? "")) return;
    }
    if (addOnClick.current) setAdding(true);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar} role="toolbar" aria-label={t.label} onPointerDown={onBarPointerDown} onClick={onBarClick}>
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
          <AddFilter
            groups={rowGroups}
            filter={filter}
            facets={facets}
            onChange={onChange}
            onBrowse={openBuilder}
            open={adding}
            onOpenChange={setAdding}
          />
        </div>
        <div className={styles.tools}>
          {active > 0 ? (
            <button type="button" className={styles.textButton} onClick={() => onChange(clearAll(filter, facets))}>
              {t.clearAll}
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.tool} ${styles.allFilters}`}
            aria-label={active > 0 ? `${t.allFilters} (${active})` : undefined}
            onClick={() => openBuilder()}
          >
            <SlidersIcon />
            <span className={styles.toolText}>{t.allFilters}</span>
            {/* A phone's row says "Filters" and how many are set. */}
            <span className={styles.toolShort} aria-hidden="true">
              {t.label}
            </span>
            {active > 0 ? (
              <span className={styles.toolCount} aria-hidden="true">
                {active}
              </span>
            ) : null}
          </button>
        </div>
      </div>
      {quick.length > 0 || saved ? (
        <div className={styles.quick}>
          {quick.length > 0 ? (
            <>
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
            </>
          ) : null}
          {saved ? (
            <>
              {quick.length > 0 ? <span className={styles.divider} aria-hidden="true" /> : null}
              <span className={styles.quickLabel} aria-hidden="true">
                {words.hands.saved.label}
              </span>
              <SavedRow state={savedState} filter={filter} active={active} onApply={onChange} />
            </>
          ) : null}
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

