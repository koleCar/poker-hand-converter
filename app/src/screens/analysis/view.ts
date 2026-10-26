/**
 * The Analysis screen's views in the address (R5.4): `#/analysis/<view>`.
 *
 * - `session` (the default), with `?at=<instant>&gap=<minutes>`;
 * - `leaks`, with `?period=all` (the last 30 days of play by default);
 * - `charts`, with `?set=<id>&view=edit|compare&at=<situation>&period=…`;
 * - `hand`, with `?key=<hand key>&a=<action index>&back=<the view it came from>`.
 *
 * Pure: the tests run it.
 */
export type AnalysisTab = "session" | "leaks" | "charts";

export const ANALYSIS_TABS: readonly AnalysisTab[] = ["session", "leaks", "charts"];

export type ComparePeriod = "30d" | "90d" | "365d" | "all";

export type AnalysisView =
  | { kind: "session"; at: string | null; gap: number }
  | { kind: "leaks"; period: "30d" | "all" }
  | { kind: "charts"; set: string | null; view: "edit" | "compare"; situation: string | null; period: ComparePeriod | null }
  | { kind: "hand"; key: string; actionIndex: number | null; back: string | null };

/** The session review's break: 30 minutes by default; the web's choices. */
export const GAPS = [15, 30, 60, 120] as const;
const DEFAULT_GAP = 30;
const PERIODS: readonly ComparePeriod[] = ["30d", "90d", "365d", "all"];

function split(param: string | null): [string, URLSearchParams] {
  if (!param) return ["", new URLSearchParams()];
  const at = param.indexOf("?");
  return at < 0 ? [param, new URLSearchParams()] : [param.slice(0, at), new URLSearchParams(param.slice(at + 1))];
}

export function parseView(param: string | null): AnalysisView {
  const [name, q] = split(param);
  if (name === "leaks") return { kind: "leaks", period: q.get("period") === "all" ? "all" : "30d" };
  if (name === "charts") {
    const period = q.get("period") as ComparePeriod | null;
    return {
      kind: "charts",
      set: q.get("set") || null,
      view: q.get("view") === "compare" ? "compare" : "edit",
      situation: q.get("at") || null,
      period: period && PERIODS.includes(period) ? period : null,
    };
  }
  if (name === "hand") {
    const key = q.get("key");
    if (key) {
      const a = Number(q.get("a"));
      return { kind: "hand", key, actionIndex: q.has("a") && Number.isInteger(a) && a >= 0 ? a : null, back: q.get("back") };
    }
  }
  const gap = Number(q.get("gap"));
  return { kind: "session", at: q.get("at") || null, gap: (GAPS as readonly number[]).includes(gap) ? gap : DEFAULT_GAP };
}

export function viewParam(view: AnalysisView): string {
  const q = new URLSearchParams();
  if (view.kind === "leaks") return view.period === "all" ? "leaks?period=all" : "leaks";
  if (view.kind === "charts") {
    if (view.set) q.set("set", view.set);
    if (view.view === "compare") q.set("view", "compare");
    if (view.situation) q.set("at", view.situation);
    if (view.period) q.set("period", view.period);
    return q.toString() ? `charts?${q}` : "charts";
  }
  if (view.kind === "hand") {
    q.set("key", view.key);
    if (view.actionIndex !== null) q.set("a", String(view.actionIndex));
    if (view.back) q.set("back", view.back);
    return `hand?${q}`;
  }
  if (view.at) q.set("at", view.at);
  if (view.gap !== DEFAULT_GAP) q.set("gap", String(view.gap));
  return q.toString() ? `session?${q}` : "session";
}

/** The tab a view belongs to (a hand: the one it came from). */
export function tabOf(view: AnalysisView): AnalysisTab {
  if (view.kind === "hand") {
    const back = view.back ? parseView(view.back) : null;
    return back && back.kind !== "hand" ? back.kind : "session";
  }
  return view.kind;
}
