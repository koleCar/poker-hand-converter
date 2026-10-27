import type { HandFilter } from "@rail/ui/hands/model";
import type { StatsFilters } from "../../lib/db";

/**
 * The opponents table's scope from the Reports filter (R4.5c): the table is
 * summed per room, game and stake (`stats_opponents` over `player_stats`), so
 * it follows those chips when one of each is chosen, and `partial` says when
 * the filter has others it does not follow (dates, positions, variants,
 * limits, table sizes, or two values of one chip).
 */
export function opponentsScope(query: HandFilter): { filters: StatsFilters; partial: boolean } {
  const filters: StatsFilters = {};
  let partial = false;
  const one = (values: string[] | undefined): string | null => {
    if (!values || values.length === 0) return null;
    if (values.length > 1) {
      partial = true;
      return null;
    }
    return values[0] ?? null;
  };
  const site = one(query.sites);
  if (site) filters.site = site;
  const format = one(query.formats);
  if (format) filters.gameFormat = format;
  const stake = one(query.stakes);
  if (stake && stake !== "chips") {
    const [currency, bigBlind] = stake.split(":");
    if (currency) filters.currency = currency;
    if (bigBlind !== undefined && bigBlind !== "") filters.bigBlind = Number(bigBlind);
  }
  for (const key of ["variants", "limits", "sizes", "positions"] as const) {
    if ((query[key]?.length ?? 0) > 0) partial = true;
  }
  if (query.from || query.to) partial = true;
  return { filters, partial };
}
