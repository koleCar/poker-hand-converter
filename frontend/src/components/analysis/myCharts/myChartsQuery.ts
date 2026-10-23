/**
 * The address of `/analysis/my-charts` (R5.3): the open chart set (`set`, its
 * id or `new`) and the situation the editor opens at (`at`, a key like
 * `vs-open:BB:BTN`). A whitelist: anything else is dropped.
 */
import { NEW_SET } from "@rail/ui/charts/ChartsScreen";
import { parseNodeKey } from "@rail/ui/charts/model";

export interface MyChartsQuery {
  selected: string | null;
  situation: string | null;
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
  return {
    selected,
    situation: selected !== null && at && at.length <= 40 && parseNodeKey(at) ? at : null,
  };
}

/** The query string (no `?`), defaults left out. */
export function myChartsQueryString(query: MyChartsQuery): string {
  const params = new URLSearchParams();
  if (query.selected) params.set("set", query.selected);
  if (query.selected && query.situation) params.set("at", query.situation);
  return params.toString();
}
