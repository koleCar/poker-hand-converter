/**
 * One page of hands through the web's analysis, the way the web's worker
 * runs it (`frontend/src/workers/analysis.worker.ts`), with the app's rows
 * out (docs/RAIL-PLAN.md R5.4).
 *
 * The same steps in the same order: the chart sets the page needs
 * (`requiredChartSets`, then `rareLineChartSets`), the flop library's
 * chunks each hand would read (`FlopLibraryLoader.prefetch`), then
 * `analyseStoredHands` - the web's own function - and its rows. What is the
 * app's: the hands come from the store (their PHF trimmed as the web's
 * reader trims it, {@link trimPhf}), the flop library's files come through
 * the loader the caller hands in (the worker's: Rust, the disk, the
 * bucket), and each row says whether the flop library was at hand for its
 * hand - a hand whose chunk could not be fetched is graded without it,
 * exactly as the web grades it then, and analysed again later.
 *
 * Pure apart from the loader: the worker runs it, and so does the parity
 * test in Node.
 */
import {
  analyseStoredHands,
  ensureChartSets,
  FLOP_LIBRARY_ENABLED,
  rareLineChartSets,
  requiredChartSets,
  type ChartLibrary,
  type FlopLibraryLoader,
  type PhfHand,
  type VillainStatsMap,
} from "./library";
import { heroPositionOf, storeRow, trimPhf, type StoreHandRow } from "./rows";

/** A hand of a page: its store key and its PHF as stored. */
export interface PageHand {
  handKey: string;
  phf: PhfHand;
}

/** The flop library as a page reads it: the loader, and a count of the fetches that failed (offline, 429, 5xx). */
export interface PageLibrary {
  loader: FlopLibraryLoader;
  failures(): number;
}

export interface PageResult {
  rows: StoreHandRow[];
  /** Hand keys the engine threw on (a converter bug): left unanalysed. */
  failed: string[];
}

/** A page made ready: its hands trimmed, their chart sets loaded and their flop chunks fetched. */
export interface PreparedPage {
  hands: PageHand[];
  /** The flop library to hand the analysis; null without one. */
  loader: FlopLibraryLoader | null;
  /** Per hand key: every chunk it reads was fetched without a failure. */
  complete: Map<string, boolean>;
}

/** The web worker's steps before `analyzeHand`: chart sets, then the flop library's chunks. */
export async function preparePage(page: readonly PageHand[], charts: ChartLibrary, library: PageLibrary | null): Promise<PreparedPage> {
  const hands = page.map((item) => ({ handKey: item.handKey, phf: trimPhf(item.phf) }));
  const phfs = hands.map((item) => item.phf);
  await ensureChartSets(charts, phfs.flatMap((hand) => requiredChartSets(hand, charts.specs)));
  // A rare line is read on a neighbouring depth when graded (analysis/13); known once the sets above are in.
  await ensureChartSets(charts, phfs.flatMap((hand) => rareLineChartSets(hand, charts)));

  const loader = FLOP_LIBRARY_ENABLED && library ? library.loader : null;
  const complete = new Map<string, boolean>();
  for (const { handKey, phf } of hands) {
    if (!loader || !library) {
      complete.set(handKey, false);
      continue;
    }
    const before = library.failures();
    await loader.prefetch(phf, charts);
    complete.set(handKey, library.failures() === before);
  }
  return { hands, loader, complete };
}

/**
 * Analyses a page. `library` null: without the flop library (offline, or
 * the flag off) - every row says so.
 */
export async function analysePage(
  page: readonly PageHand[],
  charts: ChartLibrary,
  library: PageLibrary | null,
  villains: VillainStatsMap | null,
  onHand?: (done: number) => void,
): Promise<PageResult> {
  const { hands, loader, complete } = await preparePage(page, charts, library);
  const batch = analyseStoredHands(
    hands.map((item) => ({ id: item.handKey, phf: item.phf })),
    charts,
    onHand,
    loader,
    villains,
  );
  const byKey = new Map(hands.map((item) => [item.handKey, item.phf]));
  return {
    rows: batch.rows.map((row) => {
      const phf = byKey.get(row.hand_id);
      return storeRow(row, row.hand_id, phf ? heroPositionOf(phf) : null, complete.get(row.hand_id) ?? false);
    }),
    failed: batch.failed,
  };
}
