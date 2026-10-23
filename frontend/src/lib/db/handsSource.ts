/**
 * The shared Hands screen's `HandsSource` (`@rail/ui/hands/model`, R4.5b)
 * over Supabase: `library_page` (keyset, the app's filter groups plus the
 * library's searches and orders) and `library_facets` (the counts beside
 * the chips), as the reader under RLS
 * (`20270630090000_library_list.sql`). The desktop app implements the same
 * interface over its local store.
 *
 * The web keeps no tags, notes or saved filters (yet): the screen leaves
 * those groups out. Live arrivals (R1.10, R4.3) reach the list through
 * `notifyHandsChanged`, which the library calls for each batch the shell
 * hands it.
 */
import type {
  FacetCount,
  HandFacets,
  HandFilter,
  HandPage,
  HandRow,
  HandsSource,
  SiteFacet,
  StakeFacet,
} from "@rail/ui/hands/model";
import { EV_VERSION } from "../equity";
import { getParser } from "../phf";
import { STATS_VERSION } from "../stats";
import { rpc } from "./client";

/** "PokerStars", not "pokerstars"; our own re-import format has no room. */
function siteName(id: string, standardFormat: string): string {
  if (id === "standard") return standardFormat;
  return getParser(id)?.name ?? id;
}

/** The screen's filter as `library_page` reads it. */
function wire(filter: HandFilter): Record<string, unknown> {
  // `player` is the app's opponent reference; here it is a name at the
  // table. Tags and notes are the app's.
  const out: Record<string, unknown> = {
    ...filter,
    player: filter.playerName ?? null,
    statsVersion: STATS_VERSION,
    evVersion: EV_VERSION,
  };
  delete out.playerName;
  delete out.tags;
  delete out.hasNote;
  return out;
}

type WireRow = Omit<HandRow, "siteName" | "positionalNames"> & { anonymization?: string };

const listeners = new Set<() => void>();

/** Hands arrived or were saved: the list reads its first page and counts again. */
export function notifyHandsChanged(): void {
  for (const listener of listeners) listener();
}

/** The library's source; `standardFormat` names hands in Rail's own text format. */
export function webHandsSource(standardFormat: string): HandsSource {
  return {
    async page(filter, after, limit): Promise<HandPage> {
      const page = await rpc<{ rows: WireRow[]; next: unknown }>("library_page", {
        p_filter: wire(filter),
        p_after: after ?? null,
        p_limit: limit,
      });
      return {
        rows: page.rows.map(({ anonymization, ...row }) => ({
          ...row,
          siteName: siteName(row.site, standardFormat),
          positionalNames: anonymization === "positional",
        })),
        next: page.next ?? null,
      };
    },
    async facets(filter): Promise<HandFacets> {
      const raw = await rpc<Record<string, unknown>>("library_facets", { p_filter: wire(filter) });
      const list = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as FacetCount[]) : []);
      return {
        total: Number(raw.total ?? 0),
        library: Number(raw.library ?? 0),
        sites: list("sites").map((f): SiteFacet => ({ ...f, name: siteName(f.value, standardFormat) })),
        formats: list("formats"),
        variants: list("variants"),
        limits: list("limits"),
        sizes: list("sizes"),
        stakes: list("stakes") as StakeFacet[],
        positions: list("positions"),
        potTypes: list("potTypes"),
        results: list("results"),
        stacks: list("stacks"),
        allIn: list("allIn"),
        anonymizations: list("anonymizations"),
        tags: [],
        noted: 0,
      };
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    features: {
      annotations: false,
      search: true,
      sorts: ["oldest", "pot", "won", "lost"],
      // Everything the library's old filter bar had (R4.5b restores it).
      more: ["tableName", "minPot", "showdownPositions", "winnerPositions", "anonymization"],
    },
  };
}
