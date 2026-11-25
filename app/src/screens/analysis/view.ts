/**
 * The Analysis screen's views in the address (R5.4): `#/analysis/<view>`.
 *
 * - `session` (the default), with `?at=<instant>&gap=<minutes>` - read, and
 *   unused since the review is of every hand of its filter (#425);
 * - `leaks`, with `?period=all` (the last 30 days of play by default);
 * - `stats` (Analytics, docs/ANALYTICS.md), with `?view=streets|stats|pool`
 *   (Overview by default) or `?stat=<id>` (a stat's drill-down, Step 8);
 * - `hand`, with `?key=<hand key>&a=<action index>&back=<the view it came from>`.
 *
 * Pure: the tests run it.
 */
import { isAnalyticsView, type AnalyticsView } from "@rail/ui/analytics/view";

export type AnalysisTab = "session" | "leaks" | "stats" | "multiway" | "bomb";

/** analysis/45: Session and Leaks read heads-up pots only; multiway and bomb pots have their own tabs. */
export const ANALYSIS_TABS: readonly AnalysisTab[] = ["session", "leaks", "stats", "multiway", "bomb"];


export type AnalysisView =
  | { kind: "session"; at: string | null; gap: number }
  | { kind: "leaks"; period: "30d" | "all" }
  | { kind: "stats"; view: AnalyticsView; stat: string | null }
  | { kind: "multiway" }
  | { kind: "bomb" }
  | { kind: "hand"; key: string; actionIndex: number | null; back: string | null };

/** The session review's break: 30 minutes by default; the web's choices. */
export const GAPS = [15, 30, 60, 120] as const;
const DEFAULT_GAP = 30;

function split(param: string | null): [string, URLSearchParams] {
  if (!param) return ["", new URLSearchParams()];
  const at = param.indexOf("?");
  return at < 0 ? [param, new URLSearchParams()] : [param.slice(0, at), new URLSearchParams(param.slice(at + 1))];
}

export function parseView(param: string | null): AnalysisView {
  const [name, q] = split(param);
  if (name === "leaks") return { kind: "leaks", period: q.get("period") === "all" ? "all" : "30d" };
  if (name === "stats") {
    const view = q.get("view");
    return { kind: "stats", view: isAnalyticsView(view) ? view : "overview", stat: q.get("stat") || null };
  }
  if (name === "multiway") return { kind: "multiway" };
  if (name === "bomb") return { kind: "bomb" };
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
  if (view.kind === "stats") {
    if (view.view !== "overview") q.set("view", view.view);
    if (view.stat) q.set("stat", view.stat);
    return q.toString() ? `stats?${q}` : "stats";
  }
  if (view.kind === "multiway" || view.kind === "bomb") return view.kind;
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
