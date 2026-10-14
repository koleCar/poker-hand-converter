/**
 * The Hands screen's filters (guideline §6: "filters as chips in one row ...
 * instead of long dialogs, with saved filters"): one row of group chips -
 * room, date, stakes, position, ... - each showing what it is set to and
 * opening its values as toggle chips (`FilterChips` of the shared package)
 * with how many hands each would match; then the saved filters and "clear
 * all". Reports (R2.7b) shows the same row with the groups a report sums by
 * (`REPORT_GROUPS`) and its own saved filters.
 */
import { useRef, useState } from "react";
import { Chip } from "@rail/ui/chips/Chip";
import { FilterChips, type FilterChipOption } from "@rail/ui/chips/FilterChips";
import { useUiStrings } from "@rail/ui/i18n";

import { useT } from "../../i18n";
import type { FacetCount, FilterScreen, HandFacets } from "../../lib/ipc";
import {
  DATE_PRESETS,
  EMPTY_FILTER,
  FORMAT_ORDER,
  LIMIT_ORDER,
  POSITION_ORDER,
  POT_TYPE_ORDER,
  RESULT_ORDER,
  SIZE_ORDER,
  STACK_ORDER,
  activeGroups,
  ordered,
  type DatePreset,
  type FilterState,
  type ListGroup,
} from "./filter";
import { count, stakeLabel } from "./format";
import styles from "./FilterBar.module.css";
import { Popover } from "./Popover";
import { SavedFilters } from "./SavedFilters";

export type GroupId =
  | "date"
  | "site"
  | "format"
  | "variant"
  | "limit"
  | "size"
  | "stakes"
  | "position"
  | "potType"
  | "result"
  | "stack"
  | "allIn"
  | "notes"
  | "tags";

const LIST_GROUPS: Partial<Record<GroupId, ListGroup>> = {
  site: "sites",
  format: "formats",
  variant: "variants",
  limit: "limits",
  size: "sizes",
  stakes: "stakes",
  position: "positions",
  potType: "potTypes",
  result: "results",
  stack: "stacks",
  tags: "tags",
};

/** The row's order: what a player narrows by first. */
export const HAND_GROUPS: GroupId[] = [
  "date",
  "site",
  "stakes",
  "position",
  "potType",
  "result",
  "stack",
  "allIn",
  "format",
  "variant",
  "limit",
  "size",
  "tags",
  "notes",
];

/**
 * Reports' groups (R2.7b): what `hero_totals` sums by - the dates, the
 * segment's dimensions and the hero's position. A pot type or a stack depth
 * is a breakdown there, not a filter.
 */
export const REPORT_GROUPS: GroupId[] = ["date", "site", "stakes", "position", "format", "variant", "limit", "size"];

interface FilterBarProps {
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
  /** The chips in the row, in order (the Hands screen's by default). */
  groups?: GroupId[];
  /** Whose saved filters the row lists. */
  screen?: FilterScreen;
}

/** The labelled options of a list group, with counts. */
function useOptions(group: GroupId, filter: FilterState, facets: HandFacets | null): FilterChipOption<string>[] {
  const t = useT().hands.filters;
  const variants = useUiStrings().replayer.facts.variants as Record<string, string>;
  const list = LIST_GROUPS[group];
  if (!list) return [];
  let counts: (FacetCount & { label?: string })[] = [];
  if (facets) {
    switch (group) {
      case "site":
        counts = facets.sites.map((f) => ({ ...f, label: f.name }));
        break;
      case "stakes":
        counts = facets.stakes.map((f) => ({ ...f, label: stakeLabel(f) ?? t.chips }));
        break;
      case "tags":
        counts = facets.tags;
        break;
      default:
        counts = facets[list as Exclude<ListGroup, "sites" | "stakes" | "tags">].filter((f) => f.value !== "");
    }
  }
  // The values chosen stay listed even when nothing has them now.
  for (const value of filter[list]) {
    if (!counts.some((c) => c.value === value)) {
      counts = counts.concat({ value, count: 0 });
    }
  }
  const labelOf = (value: string, fallback?: string): string => {
    const maps: Partial<Record<GroupId, Record<string, string>>> = {
      format: t.formats,
      limit: t.limits,
      size: t.sizes,
      potType: t.potTypes,
      result: t.results,
      stack: t.stacks,
      variant: variants,
    };
    return maps[group]?.[value] ?? fallback ?? value;
  };
  const order: Partial<Record<GroupId, string[]>> = {
    position: POSITION_ORDER,
    potType: POT_TYPE_ORDER,
    result: RESULT_ORDER,
    stack: STACK_ORDER,
    format: FORMAT_ORDER,
    limit: LIMIT_ORDER,
    size: SIZE_ORDER,
  };
  const sorted = group === "stakes" ? counts : ordered(counts, order[group] ?? []);
  return sorted.map((c) => ({
    value: c.value,
    label: labelOf(c.value, c.label),
    // Tags count every hand that carries them; the other groups, the hands
    // the rest of the filter leaves.
    detail: facets ? count(c.count) : undefined,
  }));
}

export function FilterBar({ filter, facets, onChange, groups = HAND_GROUPS, screen = "hands" }: FilterBarProps) {
  const t = useT().hands;
  const active = activeGroups(filter);
  return (
    <div className={styles.bar} role="toolbar" aria-label={t.filters.label}>
      <SavedFilters filter={filter} onApply={onChange} screen={screen} />
      <div className={styles.groups}>
        {groups.map((group) => (
          <GroupChip key={group} group={group} filter={filter} facets={facets} onChange={onChange} />
        ))}
      </div>
      {active > 0 ? (
        <button type="button" className={styles.clearAll} onClick={() => onChange(EMPTY_FILTER)}>
          {t.filters.clearAll}
        </button>
      ) : null}
    </div>
  );
}

function GroupChip({
  group,
  filter,
  facets,
  onChange,
}: {
  group: GroupId;
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
}) {
  const t = useT().hands.filters;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const options = useOptions(group, filter, facets);
  const name = t.groups[group];
  const list = LIST_GROUPS[group];

  // What the chip says when the group is set.
  let summary: string | null = null;
  if (list && filter[list].length > 0) {
    const labels = filter[list].map((value) => options.find((o) => o.value === value)?.label ?? value);
    summary = labels.length === 1 ? (labels[0] ?? "") : t.more(labels[0] ?? "", labels.length - 1);
  } else if (group === "date" && filter.date !== null) {
    summary =
      filter.date === "custom" ? `${filter.dateFrom || "…"} – ${filter.dateTo || "…"}` : t.dates[filter.date];
  } else if (group === "allIn" && filter.allIn !== null) {
    summary = filter.allIn ? t.allIn.yes : t.allIn.no;
  } else if (group === "notes" && filter.hasNote !== null) {
    summary = filter.hasNote ? t.notes.yes : t.notes.no;
  }

  const close = () => setOpen(false);
  const single = (current: string | null, next: string[]): string | null =>
    next.find((value) => value !== current) ?? null;

  let body = null;
  if (list) {
    body =
      options.length === 0 && group === "tags" ? (
        <p className={styles.hint}>{t.noTags}</p>
      ) : (
        <FilterChips
          label={name}
          options={options}
          selected={filter[list]}
          onChange={(next) => onChange({ ...filter, [list]: next })}
          clearLabel={t.clear}
        />
      );
  } else if (group === "date") {
    body = (
      <>
        <FilterChips
          label={name}
          options={DATE_PRESETS.map((value) => ({ value, label: t.dates[value] }))}
          selected={filter.date === null ? [] : [filter.date]}
          onChange={(next) => onChange({ ...filter, date: single(filter.date, next) as DatePreset | null })}
          clearLabel={t.clear}
        />
        {filter.date === "custom" ? (
          <div className={styles.range}>
            <label>
              {t.dates.from}
              <input
                type="date"
                value={filter.dateFrom}
                onChange={(event) => onChange({ ...filter, dateFrom: event.target.value })}
              />
            </label>
            <label>
              {t.dates.to}
              <input
                type="date"
                value={filter.dateTo}
                onChange={(event) => onChange({ ...filter, dateTo: event.target.value })}
              />
            </label>
          </div>
        ) : null}
      </>
    );
  } else if (group === "allIn" || group === "notes") {
    const key = group === "allIn" ? "allIn" : "hasNote";
    const words = group === "allIn" ? t.allIn : t.notes;
    const value = filter[key];
    const counts =
      group === "allIn" && facets
        ? Object.fromEntries(facets.allIn.map((f) => [f.value === "1" ? "yes" : "no", count(f.count)]))
        : group === "notes" && facets
          ? { yes: count(facets.noted) }
          : {};
    body = (
      <FilterChips
        label={name}
        options={(["yes", "no"] as const).map((v) => ({ value: v, label: words[v], detail: counts[v] }))}
        selected={value === null ? [] : [value ? "yes" : "no"]}
        onChange={(next) => {
          const chosen = single(value === null ? null : value ? "yes" : "no", next);
          onChange({ ...filter, [key]: chosen === null ? null : chosen === "yes" });
        }}
        clearLabel={t.clear}
      />
    );
  }

  return (
    <span ref={anchor} className={styles.anchor}>
      <Chip
        pressed={summary !== null}
        className={styles.group}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={summary === null ? t.groupLabel(name) : t.summary(name, summary)}
        onClick={() => setOpen((was) => !was)}
      >
        {summary === null ? name : t.summary(name, summary)}
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </Chip>
      {open ? (
        <Popover anchor={anchor} label={name} onClose={close}>
          {body}
        </Popover>
      ) : null}
    </span>
  );
}
