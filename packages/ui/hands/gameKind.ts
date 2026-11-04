/**
 * Cash or tournaments: the two kinds of game whose results never add up
 * (money against tournament chips). The Hands and Reports screens always show
 * one kind - the reader's, chosen with the Cash / Tournaments toggle
 * (`KindToggle.tsx`), else the one with more hands - so a library holding
 * both never lands on a report with no result and no graph.
 *
 * The kind is kept in the filter's `formats` group: Cash is `["cash"]`,
 * Tournaments is every chip format the library has (tournament, Sit & Go,
 * Spin), so the Game chip can still narrow within the kind.
 */
import type { FilterState } from "./filter";
import type { HandFacets } from "./model";

export type GameKind = "cash" | "tournament";

export const GAME_KINDS: GameKind[] = ["cash", "tournament"];

/** The chip formats, in the Game chip's order. */
export const CHIP_FORMATS = ["tournament", "sng", "spin"];

/** The kind a format belongs to; `null` for a hand with no format. */
export function kindOfFormat(format: string): GameKind | null {
  if (format === "") return null;
  return format === "cash" ? "cash" : "tournament";
}

/** The one kind every chosen format shares; `null` for none chosen or both kinds. */
export function kindOf(formats: readonly string[]): GameKind | null {
  const kinds = new Set(formats.map(kindOfFormat).filter((kind): kind is GameKind => kind !== null));
  return kinds.size === 1 ? [...kinds][0] : null;
}

/** Hands of each kind, as the Game chip counts them (its own choice left out). */
export function kindCounts(facets: HandFacets | null): Record<GameKind, number> {
  const counts: Record<GameKind, number> = { cash: 0, tournament: 0 };
  for (const facet of facets?.formats ?? []) {
    const kind = kindOfFormat(facet.value);
    if (kind !== null) counts[kind] += facet.count;
  }
  return counts;
}

/** Whether the hands hold both kinds, so the screen must show one. */
export function hasBothKinds(facets: HandFacets | null): boolean {
  const counts = kindCounts(facets);
  return counts.cash > 0 && counts.tournament > 0;
}

/** The filter showing `kind`: its formats (the ones the hands have, every one when unknown). */
export function withKind(filter: FilterState, kind: GameKind, facets: HandFacets | null): FilterState {
  if (kind === "cash") return { ...filter, formats: ["cash"] };
  const present = (facets?.formats ?? []).filter((f) => f.count > 0).map((f) => f.value);
  const formats = CHIP_FORMATS.filter((format) => present.includes(format));
  return { ...filter, formats: formats.length > 0 ? formats : CHIP_FORMATS };
}

/** Whether the formats chosen are the whole of one kind (the toggle's choice, not narrowed by the Game chip). */
export function isWholeKind(filter: FilterState, facets: HandFacets | null): boolean {
  const kind = kindOf(filter.formats);
  if (kind === null) return false;
  const whole = withKind(filter, kind, facets).formats;
  return whole.length === filter.formats.length && whole.every((format) => filter.formats.includes(format));
}

/**
 * The Game chip's change, kept to one kind: a format of the other kind
 * replaces the choice (the newest pick decides), and "Any" is the whole of
 * the kind shown - never both kinds.
 */
export function withFormats(filter: FilterState, next: readonly string[], facets: HandFacets | null): FilterState {
  if (next.length === 0) {
    const kind = kindOf(filter.formats);
    return kind === null ? { ...filter, formats: [] } : withKind(filter, kind, facets);
  }
  const added = next.find((format) => !filter.formats.includes(format)) ?? next[0] ?? "";
  const kind = kindOfFormat(added);
  return { ...filter, formats: next.filter((format) => kindOfFormat(format) === kind) };
}

/**
 * The filter the screen shows: as chosen when it holds one kind (or the hands
 * hold only one), else narrowed to the kind with more hands - among the
 * formats chosen, when some are. `defaulted` says the screen picked it.
 */
export function pinKind(
  filter: FilterState,
  facets: HandFacets | null,
): { filter: FilterState; defaulted: GameKind | null } {
  if (facets === null || kindOf(filter.formats) !== null || !hasBothKinds(facets)) {
    return { filter, defaulted: null };
  }
  const chosen = filter.formats;
  const counts: Record<GameKind, number> = { cash: 0, tournament: 0 };
  for (const facet of facets.formats) {
    const kind = kindOfFormat(facet.value);
    if (kind !== null && (chosen.length === 0 || chosen.includes(facet.value))) counts[kind] += facet.count;
  }
  const kind: GameKind = counts.cash >= counts.tournament ? "cash" : "tournament";
  if (chosen.length === 0) return { filter: withKind(filter, kind, facets), defaulted: kind };
  return { filter: { ...filter, formats: chosen.filter((format) => kindOfFormat(format) === kind) }, defaulted: kind };
}
