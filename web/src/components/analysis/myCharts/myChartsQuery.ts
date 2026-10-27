/**
 * The address of `/analysis/my-charts` (R5.3): the open chart set (`set`, its
 * id or `new`), the view (`view=compare`; the editor otherwise), the
 * situation the editor opens at (`at`, a key like `vs-open:BB:BTN`) and the
 * comparison's period (`period`). A whitelist: anything else is dropped.
 */
import { COMPARE_PERIODS, type ComparePeriod } from "@rail/ui/charts/source";
import { NEW_SET, type ChartsView } from "@rail/ui/charts/ChartsScreen";
import { parseNodeKey } from "@rail/ui/charts/model";

export interface MyChartsQuery {
  selected: string | null;
  view: ChartsView;
  situation: string | null;
  period: ComparePeriod | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Source = URLSearchParams | Record<string, string | string[] | undefined>;

function getter(source: Source): (key: string) => string | null {
  return (key) => {
    if (source instanceof URLSearchParams) return source.get(key);
    const value = source[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
}

export function parseMyChartsQuery(source: Source): MyChartsQuery {
  const get = getter(source);
  const set = get("set");
  const selected = set === NEW_SET || (set !== null && UUID.test(set)) ? set : null;
  const at = get("at");
  const period = get("period") as ComparePeriod | null;
  return {
    selected,
    view: selected !== null && get("view") === "compare" ? "compare" : "edit",
    situation: at && at.length <= 40 && parseNodeKey(at) ? at : null,
    period: period && COMPARE_PERIODS.includes(period) ? period : undefined,
  };
}

/** The query string (no `?`), defaults left out. */
export function myChartsQueryString(query: MyChartsQuery): string {
  const params = new URLSearchParams();
  if (query.selected) params.set("set", query.selected);
  if (query.selected && query.view === "compare") params.set("view", "compare");
  if (query.selected && query.view === "edit" && query.situation) params.set("at", query.situation);
  if (query.selected && query.view === "compare" && query.period) params.set("period", query.period);
  return params.toString();
}
