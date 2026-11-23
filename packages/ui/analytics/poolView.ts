/**
 * The Pool tab's view model (docs/ANALYTICS.md Step 10): pure functions from
 * the surface's `PoolSums`, the player's checker result and two reports
 * over the "vs type" filter to what the tab lays out.
 *
 * - **Figures.** Regs : fish by their hands with the hero; the regs' win
 *   rate (bb/100) with its standard error from the measured spread of their
 *   results (Σ result², sample variance); the player's win rate with a fish
 *   in the pot (the Hands filter `vsTypes: ["fish"]`) and with regs and no
 *   fish (`["reg", "fish"]` minus `["fish"]`: every hand with a reg or a
 *   fish, less those with a fish).
 * - **Rows**, one per catalogue rate: the player's number and target (the
 *   checker's - the pool's target is the player's own, approximate: the
 *   opponents' cards are mostly unknown, so no hand-adjusted target can be
 *   made for them, §3 and §6.4), and each type's rate judged against that
 *   target by the checker's own band and tones (`bandHalf`, `toneOf`) over
 *   the type's opportunities.
 * - **Exploits.** A type's gap is clear when its tone is `off` or `far`:
 *   outside the band on at least the stat's `sample.min` opportunities. A
 *   row has a sentence per clear direction - one for "regs and fish" when
 *   both are clear the same way. A small pool is `few` or `ok`: no sentence.
 *   Nor is there one while the target itself rests on fewer than
 *   `sample.min` of the player's analysed decisions (a target of 0% from
 *   three decisions would make every opponent "too much").
 */
import type { HandFilter } from "../hands/model";
import type { Report } from "../reports/model";
import {
  bandHalf,
  toneOf,
  type Catalogue,
  type CatalogueStat,
  type CheckerDirection,
  type CheckerResult,
  type CheckerTone,
} from "../model/checker";
import type { PoolFilters, PoolSums, PoolType, PoolTypeSums } from "./model";

export const POOL_TYPES: readonly PoolType[] = ["reg", "fish"];

/* ----------------------------------------------------------- filters -- */

/** The groups of the screen's filter the pool follows: the kind or one format, and the rooms. */
export function poolFiltersOf(query: HandFilter): PoolFilters {
  const filters: PoolFilters = {};
  const formats = query.formats ?? [];
  if (formats.length === 1) {
    filters.gameFormat = formats[0];
  } else if (formats.length > 1) {
    if (formats.every((format) => format === "cash")) filters.gameKind = "cash";
    else if (formats.every((format) => format !== "cash" && format !== "")) filters.gameKind = "tournament";
  }
  const sites = (query.sites ?? []).filter((site) => site !== "");
  if (sites.length > 0) filters.sites = sites;
  return filters;
}

/** The two reports' filters: hands with a fish in the pot, and with a reg or a fish. */
export function youQueries(query: HandFilter): { fish: HandFilter; regOrFish: HandFilter } {
  return { fish: { ...query, vsTypes: ["fish"] }, regOrFish: { ...query, vsTypes: ["reg", "fish"] } };
}

/* ----------------------------------------------------------- figures -- */

/** A win rate over a sample. */
export interface Rate {
  hands: number;
  /** bb/100; null without a hand. */
  bb100: number | null;
}

export interface PoolFigures {
  reg: { players: number; hands: number };
  fish: { players: number; hands: number };
  /** Reg hands per fish hand; null without fish hands. */
  ratio: number | null;
  /** The regs' bb/100 and its standard error; null under two hands. */
  regRate: number | null;
  regSe: number | null;
}

/** bb/100 and its standard error from Σx, Σx² over n hands (sample variance). */
export function rateOf(sums: PoolTypeSums): { bb100: number | null; se: number | null } {
  const n = sums.hands;
  if (!(n > 0)) return { bb100: null, se: null };
  const mean = sums.netBb / n;
  if (n < 2) return { bb100: mean * 100, se: null };
  const variance = Math.max(0, (sums.netBbSq - (sums.netBb * sums.netBb) / n) / (n - 1));
  return { bb100: mean * 100, se: Math.sqrt(variance / n) * 100 };
}

export function poolFigures(sums: PoolSums): PoolFigures {
  const reg = rateOf(sums.reg);
  return {
    reg: { players: sums.reg.players, hands: sums.reg.hands },
    fish: { players: sums.fish.players, hands: sums.fish.hands },
    ratio: sums.fish.hands > 0 ? sums.reg.hands / sums.fish.hands : null,
    regRate: reg.bb100,
    regSe: reg.se,
  };
}

/** A report's result in big blinds over its money hands. */
function resultOf(report: Pick<Report, "summary"> | null): { hands: number; moneyHands: number; netBb: number | null } | null {
  if (!report) return null;
  const { hands, moneyHands, netBbMilli } = report.summary;
  return { hands, moneyHands, netBb: netBbMilli === null ? null : netBbMilli / 1000 };
}

/**
 * The player's win rates: with a fish in the pot, and with regs and no fish
 * (the reg-or-fish report less the fish one). Null while a report is missing.
 */
export function youRates(
  withFish: Pick<Report, "summary"> | null,
  regOrFish: Pick<Report, "summary"> | null,
): { fish: Rate | null; regsOnly: Rate | null } {
  const fish = resultOf(withFish);
  const any = resultOf(regOrFish);
  const rate = (hands: number, money: number, net: number | null): Rate => ({
    hands,
    bb100: money > 0 && net !== null ? (net * 100) / money : null,
  });
  return {
    fish: fish ? rate(fish.hands, fish.moneyHands, fish.netBb) : null,
    regsOnly:
      fish && any
        ? rate(
            Math.max(0, any.hands - fish.hands),
            Math.max(0, any.moneyHands - fish.moneyHands),
            any.netBb === null || fish.netBb === null ? null : any.netBb - fish.netBb,
          )
        : null,
  };
}

/* -------------------------------------------------------------- rows -- */

/** One type's rate, judged against the player's target. */
export interface PoolCell {
  made: number;
  opp: number;
  /** Percent; null without an opportunity. */
  player: number | null;
  /** The band's half-width around the target over this sample, points; null without a target. */
  half: number | null;
  gap: number | null;
  direction: CheckerDirection | null;
  tone: CheckerTone;
}

/** A clear gap: one sentence, for one type or both. */
export interface PoolExploit {
  types: PoolType[];
  direction: CheckerDirection;
  tone: "off" | "far";
}

export interface PoolRow {
  stat: CatalogueStat;
  /** The player's number and target (the checker's); null without them. */
  you: number | null;
  youTone: CheckerTone;
  target: number | null;
  /** The target rests on at least `sample.min` of the player's analysed decisions. */
  targetSure: boolean;
  reg: PoolCell;
  fish: PoolCell;
  exploits: PoolExploit[];
}

/** One type's cell: its rate against `target` with the stat's band rules. */
export function poolCell(stat: CatalogueStat, made: number, opp: number, target: number | null): PoolCell {
  const player = opp > 0 ? (made * 100) / opp : null;
  if (player === null || target === null) {
    return { made, opp, player, half: null, gap: null, direction: null, tone: "none" };
  }
  const half = bandHalf(target / 100, opp, stat.band.floor);
  const gap = player - target;
  return {
    made,
    opp,
    player,
    half,
    gap,
    direction: gap > 0 ? "high" : gap < 0 ? "low" : null,
    tone: toneOf(gap, half, opp, stat.sample.min),
  };
}

const clear = (cell: PoolCell): cell is PoolCell & { direction: CheckerDirection; tone: "off" | "far" } =>
  (cell.tone === "off" || cell.tone === "far") && cell.direction !== null;

/** A row's sentences: both types in one when they are clear the same way. */
export function exploitsOf(reg: PoolCell, fish: PoolCell): PoolExploit[] {
  const out: PoolExploit[] = [];
  if (clear(reg) && clear(fish) && reg.direction === fish.direction) {
    out.push({ types: ["reg", "fish"], direction: reg.direction, tone: reg.tone === "far" || fish.tone === "far" ? "far" : "off" });
    return out;
  }
  if (clear(reg)) out.push({ types: ["reg"], direction: reg.direction, tone: reg.tone });
  if (clear(fish)) out.push({ types: ["fish"], direction: fish.direction, tone: fish.tone });
  return out;
}

/** The catalogue's rates in its order, each with the player's figures and the pool's. */
export function poolRows(catalogue: Catalogue, result: CheckerResult | null, sums: PoolSums | null): PoolRow[] {
  const counts = new Map<string, { made: number; opp: number }>();
  for (const row of sums?.stats ?? []) {
    const key = `${row.stat}|${row.type}`;
    const sum = counts.get(key) ?? { made: 0, opp: 0 };
    sum.made += row.made;
    sum.opp += row.opp;
    counts.set(key, sum);
  }
  const rows: PoolRow[] = [];
  for (const stat of catalogue.stats) {
    if (stat.kind !== "rate") continue;
    const checked = result?.stats.find((s) => s.id === stat.id) ?? null;
    const target = checked?.target ?? null;
    const targetSure = target !== null && (checked?.n ?? 0) >= stat.sample.min;
    const cell = (type: PoolType) => {
      const sum = counts.get(`${stat.id}|${type}`) ?? { made: 0, opp: 0 };
      return poolCell(stat, sum.made, sum.opp, target);
    };
    // A target not sure yet colours nothing beyond grey either.
    const unsure = (c: PoolCell): PoolCell => (targetSure || (c.tone !== "off" && c.tone !== "far") ? c : { ...c, tone: "few" });
    const reg = unsure(cell("reg"));
    const fish = unsure(cell("fish"));
    rows.push({
      stat,
      you: checked?.player ?? null,
      youTone: checked?.tone ?? "none",
      target,
      targetSure,
      reg,
      fish,
      exploits: exploitsOf(reg, fish),
    });
  }
  return rows;
}

/** The rows a show choice keeps: all, or those with a sentence. */
export function shownPoolRows(rows: readonly PoolRow[], show: PoolShow): PoolRow[] {
  return show === "all" ? [...rows] : rows.filter((row) => row.exploits.length > 0);
}

export type PoolShow = "all" | "exploits";

/** Whether the pool has anyone in it. */
export function poolEmpty(sums: PoolSums | null): boolean {
  return !sums || (sums.reg.players === 0 && sums.fish.players === 0);
}
