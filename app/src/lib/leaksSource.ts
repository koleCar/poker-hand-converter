/**
 * The leak finder's top three in the app (R5.2 in the desktop app, R5.4):
 * the store's sums (`top_leaks`, `leak_examples`: the web's
 * `analysis_top_leaks` / `analysis_leak_examples` over `analysis_leak_rows`)
 * in the shape the web's pure modules read - a finest spot's fields from its
 * key, the sums rounded as the web's `numeric` sums are - and the top three
 * worked out by them (`groupLeaks`, `rankTopLeaks`, `leakTrend`), unchanged.
 */
import { stakes } from "@rail/ui/hands/format";

import { ANALYSIS_VERSION } from "../analysis/library";
import { groupLeaks, leakTrend, rankTopLeaks, type LeakTrend, type RankedLeak, type SpotRow, type TopPeriod } from "../analysis/leakWords";
import { roundNumeric } from "../analysis/rows";
import { ipc, type LeakFiltersDto, type SpotSumsDto } from "./ipc";

export interface LeakSample {
  hands: number;
  graded: number;
  rows: SpotRow[];
}

/** The web's `TopLeaksReport`. */
export interface TopLeaksReport {
  period: TopPeriod;
  last: string | null;
  current: { from: string; to: string } | null;
  prior: { from: string; to: string } | null;
  sample: LeakSample;
  now: LeakSample;
  was: LeakSample;
}

export interface TopLeakView extends RankedLeak {
  trend: LeakTrend;
}

/** The web's `LeakExampleRow`. */
export interface LeakExampleRow {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  site: string;
  stakesLabel: string | null;
  position: string | null;
  heroCards: string[];
  handClass: string | null;
  street: string;
  scenario: string;
  line: string;
  taken: string;
  best: string;
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
}

/** A spot's sums as the web's `analysis_leak_sample` returns its row. */
export function spotRow(sums: SpotSumsDto): SpotRow {
  const [street = "", scenario = "", line = "", position = "", taken = "", best = ""] = sums.key.split("|");
  return {
    key: sums.key,
    set: sums.set,
    street,
    scenario,
    line,
    position,
    taken,
    best,
    decisions: sums.decisions,
    hands: sums.decisions,
    nonPerfect: sums.nonPerfect,
    mistakes: sums.mistakes,
    evLossBb: roundNumeric(sums.evLossBb, 3) ?? 0,
    evLossPot: roundNumeric(sums.evLossPot, 4) ?? 0,
    scoreSum: roundNumeric(sums.scoreSum, 2) ?? 0,
    scoreSq: roundNumeric(sums.scoreSq, 2) ?? 0,
  };
}

const sampleOf = (s: { hands: number; graded: number; rows: SpotSumsDto[] }): LeakSample => ({
  hands: s.hands,
  graded: s.graded,
  rows: s.rows.map(spotRow),
});

/** The top three of a report: grouped, ranked, each with its was / now (the web's `topOf`). */
export function topOf(report: TopLeaksReport): TopLeakView[] {
  const leaks = groupLeaks(report.sample.rows, { hands: report.sample.hands });
  return rankTopLeaks(leaks).map((entry) => ({ ...entry, trend: leakTrend(entry.leak, report.now.rows, report.was.rows) }));
}

export async function fetchTopLeaks(filters: LeakFiltersDto, period: TopPeriod): Promise<TopLeaksReport> {
  const top = await ipc.topLeaks(ANALYSIS_VERSION, filters, period);
  return {
    period,
    last: top.last,
    current: top.current,
    prior: top.prior,
    sample: sampleOf(top.sample),
    now: sampleOf(top.now),
    was: sampleOf(top.was),
  };
}

/** Each leak's costliest decisions (at most `limit`), in the window given (all time without one). */
export async function fetchLeakExamples(
  filters: LeakFiltersDto,
  leaks: ReadonlyArray<{ id: string; keys: string[] }>,
  window: { from: string; to: string } | null,
  limit: number,
): Promise<Map<string, LeakExampleRow[]>> {
  const out = new Map<string, LeakExampleRow[]>();
  for (const leak of leaks.slice(0, 10)) {
    if (leak.keys.length === 0) continue;
    const rows = await ipc.leakExamples(ANALYSIS_VERSION, filters, window, leak.keys.slice(0, 200), limit);
    out.set(
      leak.id,
      rows.map((row) => {
        const [street = "", scenario = "", line = "", position = "", taken = "", best = ""] = row.spotKey.split("|");
        return {
          handId: row.handId,
          ord: row.ord,
          actionIndex: row.actionIndex,
          playedAt: row.playedAt,
          site: row.site,
          stakesLabel: stakes(row),
          position: position || null,
          heroCards: row.heroCards,
          handClass: row.handClass,
          street,
          scenario,
          line,
          taken,
          best,
          grade: row.grade,
          evLossBb: row.evLossBb,
          evLossPot: row.evLossPot,
        };
      }),
    );
  }
  return out;
}
