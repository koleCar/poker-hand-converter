/**
 * The shape of the library filter form, and how it becomes a database query.
 *
 * Separate from `HandFiltersBar.tsx` so that file exports nothing but its
 * component (react-refresh needs that to hot-reload it), and because
 * `ReplayerTab` holds the form state and needs the type without importing the
 * bar's rendering.
 *
 * `HandFilterForm` in the data layer covers the text fields only. Positions,
 * game format and anonymization exist on `HandFilters` but have no form
 * representation, so they are added here and merged in {@link toHandFilters}.
 */

import {
  EMPTY_HAND_FILTER_FORM,
  handFiltersFromForm,
  type GameFormat,
  type HandFilterForm,
  type HandFilters,
  type PositionLabel,
  type SiteAnonymization,
} from "../lib/db";

export interface ReplayerFilterForm extends HandFilterForm {
  gameFormat: "" | GameFormat;
  heroPositions: PositionLabel[];
  winnerPositions: PositionLabel[];
  anonymization: "" | SiteAnonymization;
}

export const EMPTY_REPLAYER_FILTERS: ReplayerFilterForm = {
  ...EMPTY_HAND_FILTER_FORM,
  gameFormat: "",
  heroPositions: [],
  winnerPositions: [],
  anonymization: "",
};

/** Seats in table order, so the chips read the way a poker player thinks. */
export const POSITIONS: PositionLabel[] = [
  "UTG",
  "UTG+1",
  "UTG+2",
  "MP",
  "LJ",
  "HJ",
  "CO",
  "BTN",
  "SB",
  "BB",
];

/**
 * Turns the form into a database filter.
 *
 * Chip tournaments store whole chips (`minorUnits` 1) and cash tables store
 * cents (`minorUnits` 100), so the min-pot scale has to follow the game the
 * user asked for — the data layer's default of 100 silently meant "2 500
 * chips" when a tournament player typed 25. With no game filter the library is
 * mostly cash, so cents stays the default and the field's hint says so.
 */
export function toHandFilters(form: ReplayerFilterForm): HandFilters {
  const filters = handFiltersFromForm(form, {
    minorUnits: form.gameFormat === "tournament" ? 1 : 100,
  });
  if (form.gameFormat) {
    filters.gameFormat = form.gameFormat;
  }
  if (form.heroPositions.length) {
    filters.heroPositions = form.heroPositions;
  }
  if (form.winnerPositions.length) {
    filters.winnerPositions = form.winnerPositions;
  }
  if (form.anonymization) {
    filters.anonymization = form.anonymization;
  }
  return filters;
}
