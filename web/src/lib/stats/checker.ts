/**
 * The Analytics stat checker (docs/ANALYTICS.md §3, Step 3): the grouped sums
 * of `analytics_checker` (web) or `rail_store::checker` (desktop), judged
 * against their targets. Pure: no framework, no I/O. `rail_stats::checker`
 * is the Rust twin; both give the same output, field for field, on the
 * shared fixture `core/rail-stats/tests/data/analytics/checker/`.
 *
 * **Per stat** (`CheckedStat`, catalogue order):
 *
 * - a **rate**: player % = Σtaken / Σn, target % = ΣrefShare / Σn, over the
 *   analysed decisions (`n`); coverage = Σn / Σopps;
 * - a **share** (the weak share of a rate's actions): from the parent rate's
 *   groups by hand class - player % = taken in `weak` classes / taken, target
 *   % = ΣrefShare over `weak` classes / ΣrefShare. Its sample (`n`) is the
 *   parent's analysed actions; `opps` / `oppsTaken` are the parent's actions
 *   with a stored row, all and weak;
 * - a **coded** stat (WTSD, W$SD, WWSF): the player's number only, from the
 *   caller's coded rollups (`coded`); no target, tone `none`.
 *
 * **Band** = target ± max(floor, 1.96·√(t(1−t)/n)) points, t the target as a
 * fraction (clamped to 0..1) and n the sample. **Tone**, from the unrounded
 * numbers: inside the band (|gap| ≤ half-width) `ok`; outside it with a
 * sample under `sample.min`, `few`; more than twice the half-width outside
 * the band (|gap| > 3 × half-width), `far`; else `off`. No target (no
 * analysed decision, or a reference that never takes the action): `none`.
 * So below `sample.min` no tone is stronger than `few`, and a player equal
 * to the reference is always `ok`.
 *
 * **Cost** (bb/100): too much = ΣevHigh × 100 / hands, too little = ΣevLow ×
 * 100 / hands, `hands` the scope's (`CheckerSums.hands`); a share counts its
 * weak classes' only. `cost` is the one in the gap's direction.
 *
 * **Breakdowns** per spot, size bucket and hand class: the same figures over
 * the groups of that key, plus `shareOfTaken` ("share of your folds": the
 * row's taken / the stat's) and `worth` ("a call is worth": ΣevHigh / taken,
 * the bb each taken decision gave up). Spots costliest first (in the stat's
 * direction), then by sample, then by key; sizes and classes in catalogue
 * order. A share's classes are its composition: each class's part of your
 * actions against the reference's (`weak` says which count).
 *
 * **Findings** (Overview): the stats `off` or `far`, merged by `family` and
 * `lean` (`tight`: too much folding or too little of any other action, or
 * too few weak hands in a share; `loose`: the reverse), ranked by summed
 * cost. A stat is listed but not summed when its decisions are already in
 * the sum: its `within` (a rate) or `of` (a share) is in the same finding
 * (the probe inside turn fold), or a costlier summed stat of the finding has
 * the same opportunities (`overlaps`).
 * Each finding carries the numbers its why-sentence reads (`CheckerWhy`):
 * the lead stat's costliest spot and its hand class with the most extra
 * (loose / too much) or missing (too little) actions against the reference.
 * The words are `packages/ui/analytics/findings.ts`'.
 *
 * **Arithmetic** is one IEEE double operation at a time, in the order
 * written here and in the Rust twin, summing the groups in their input order;
 * every number out is rounded half away from zero to 6 decimals
 * (`roundHalfAway`), every decision (tone, order) is made on the unrounded
 * values.
 */

import type { Catalogue, CatalogueStat } from "./analytics";
import { roundHalfAway } from "./analyticsRows";

/** One group of the checker's sums (`CheckerGroup` of `@rail/ui/analytics/model`). */
export interface CheckerGroupIn {
  stat: string;
  spot: string;
  size: string;
  handClass: string;
  opps: number;
  oppsTaken: number;
  n: number;
  taken: number;
  refShare: number;
  evHigh: number;
  evLow: number;
  hands: number;
}

/** What the checker reads of `CheckerSums`. */
export interface CheckerSumsIn {
  hands: number;
  pending: number;
  groups: readonly CheckerGroupIn[];
}

/** A coded stat's counts from the player's rollups (`made` of `opp`). */
export interface CodedIn {
  made: number;
  opp: number;
}

export type CheckerTone = "ok" | "off" | "far" | "few" | "none";
export type CheckerDirection = "high" | "low";
export type CheckerLean = "loose" | "tight";
export type CheckerAxis = "spot" | "size" | "class";

/** One judged set of decisions: a stat, or one of its breakdown rows. */
export interface CheckerFigures {
  /** Member decisions with a stored row (a share: the parent's actions). */
  opps: number;
  /** Of them, those that took the class (a share: with a weak hand). */
  oppsTaken: number;
  /** The analysed ones: the sample behind the player's number and the target. */
  n: number;
  taken: number;
  /** Percent; null with no sample. */
  player: number | null;
  /** Percent; null with no target. */
  target: number | null;
  /** The band's half-width, points; null with no target. */
  half: number | null;
  /** The band, percent, clamped to 0..100. */
  bandLow: number | null;
  bandHigh: number | null;
  /** player − target, points. */
  gap: number | null;
  /** The gap's sign: `high` = above the target. */
  direction: CheckerDirection | null;
  tone: CheckerTone;
  /** bb/100 lost by taking the class ("too much"), and by not taking it ("too little"). */
  costHigh: number;
  costLow: number;
  /** The cost in the gap's direction (0 with none). */
  cost: number;
  /** n / opps; null with no opportunity. */
  coverage: number | null;
}

/** One breakdown row: a spot key, a size bucket id or a hand class id. */
export interface CheckerRow extends CheckerFigures {
  key: string;
  /** This row's taken / the stat's ("share of your folds"); null when the stat took none. */
  shareOfTaken: number | null;
  /** ΣevHigh / taken: bb each taken decision gave up ("a call is worth"); null with none taken. */
  worth: number | null;
  /** A share's class rows: whether the class counts as weak. */
  weak?: boolean;
}

export interface CheckedStat extends CheckerFigures {
  id: string;
  kind: CatalogueStat["kind"];
  /** Where the target comes from: preflop charts, the solver after the flop; null for coded stats. */
  source: "charts" | "solver" | null;
  spots: CheckerRow[];
  sizes: CheckerRow[];
  classes: CheckerRow[];
}

/** The numbers a finding's why-sentence reads. */
export interface CheckerWhy {
  stat: string;
  source: "charts" | "solver";
  /** The lead stat's costliest spot in its direction (with more or fewer actions than the reference). */
  spot: string | null;
  spotPlayer: number | null;
  spotTarget: number | null;
  /** The hand class with the most extra (`high`) or missing (`low`) actions; null preflop or with none. */
  handClass: string | null;
  classPlayer: number | null;
  classTarget: number | null;
  /** The class's share of the stat's taken decisions. */
  classShare: number | null;
  /** bb a taken decision of the class gave up; only when the lead stat is too high. */
  classWorth: number | null;
}

export interface CheckerFinding {
  family: string;
  lean: CheckerLean;
  /** `far` when any of its stats is far. */
  tone: "off" | "far";
  /** bb/100, the counted stats' costs summed. */
  cost: number;
  /** Costliest first; `counted` is false for a stat inside another of the finding. */
  stats: { id: string; counted: boolean }[];
  /** The first stat: the headline's and the why-sentence's. */
  lead: string;
  direction: CheckerDirection;
  why: CheckerWhy;
}

export interface CheckerResult {
  hands: number;
  pending: number;
  stats: CheckedStat[];
  /** Costliest first. */
  findings: CheckerFinding[];
}

/* ----------------------------------------------------------- sums -- */

interface Acc {
  opps: number;
  oppsTaken: number;
  n: number;
  taken: number;
  ref: number;
  evHigh: number;
  evLow: number;
}

const emptyAcc = (): Acc => ({ opps: 0, oppsTaken: 0, n: 0, taken: 0, ref: 0, evHigh: 0, evLow: 0 });

function add(acc: Acc, group: CheckerGroupIn): void {
  acc.opps += group.opps;
  acc.oppsTaken += group.oppsTaken;
  acc.n += group.n;
  acc.taken += group.taken;
  acc.ref += group.refShare;
  acc.evHigh += group.evHigh;
  acc.evLow += group.evLow;
}

/** A judged set before rounding: the four terms of the two ratios, and the rest. */
interface Raw {
  opps: number;
  oppsTaken: number;
  num: number;
  den: number;
  refNum: number;
  refDen: number;
  evHigh: number;
  evLow: number;
}

function rateRaw(acc: Acc): Raw {
  return {
    opps: acc.opps,
    oppsTaken: acc.oppsTaken,
    num: acc.taken,
    den: acc.n,
    refNum: acc.ref,
    refDen: acc.n,
    evHigh: acc.evHigh,
    evLow: acc.evLow,
  };
}

/** A share: `part`'s actions (the weak ones, or one class) among `all`'s. */
function shareRaw(all: Acc, part: Acc): Raw {
  return {
    opps: all.oppsTaken,
    oppsTaken: part.oppsTaken,
    num: part.taken,
    den: all.taken,
    refNum: part.ref,
    refDen: all.ref,
    evHigh: part.evHigh,
    evLow: part.evLow,
  };
}

/** What the stat's figures depend on besides the sums. */
interface Judge {
  floor: number;
  sampleMin: number;
  hands: number;
}

interface Judged {
  figures: CheckerFigures;
  /** Unrounded, for the decisions made later. */
  costHigh: number;
  costLow: number;
  cost: number;
  raw: Raw;
}

const r6 = (x: number): number => roundHalfAway(x, 6);
const r6n = (x: number | null): number | null => (x === null ? null : r6(x));

function costOf(ev: number, hands: number): number {
  return hands > 0 ? (ev * 100) / hands : 0;
}

/**
 * The band's half-width in points around a target `t` (a fraction, clamped
 * to 0..1) over a sample of `n`: max(floor, 1.96·√(t(1−t)/n)). The Pool tab
 * (Step 10) judges the opponents' numbers with it too.
 */
export function bandHalf(t: number, n: number, floor: number): number {
  const c = Math.min(1, Math.max(0, t));
  return Math.max(floor, 1.96 * Math.sqrt((c * (1 - c)) / n) * 100);
}

/** The tone of a gap (points) against a band's half-width, over a sample of `n` (module docs). */
export function toneOf(gap: number, half: number, n: number, sampleMin: number): CheckerTone {
  const outside = Math.abs(gap) - half;
  if (outside <= 0) return "ok";
  if (n < sampleMin) return "few";
  if (outside > 2 * half) return "far";
  return "off";
}

function judge(raw: Raw, rules: Judge): Judged {
  const player = raw.den > 0 ? (raw.num * 100) / raw.den : null;
  const target = raw.den > 0 && raw.refDen > 0 ? (raw.refNum * 100) / raw.refDen : null;
  const costHigh = costOf(raw.evHigh, rules.hands);
  const costLow = costOf(raw.evLow, rules.hands);
  let half: number | null = null;
  let bandLow: number | null = null;
  let bandHigh: number | null = null;
  let gap: number | null = null;
  let direction: CheckerDirection | null = null;
  let tone: CheckerTone = "none";
  if (player !== null && target !== null) {
    half = bandHalf(raw.refNum / raw.refDen, raw.den, rules.floor);
    bandLow = Math.max(0, target - half);
    bandHigh = Math.min(100, target + half);
    gap = player - target;
    direction = gap > 0 ? "high" : gap < 0 ? "low" : null;
    tone = toneOf(gap, half, raw.den, rules.sampleMin);
  }
  const cost = direction === "high" ? costHigh : direction === "low" ? costLow : 0;
  return {
    figures: {
      opps: raw.opps,
      oppsTaken: raw.oppsTaken,
      n: raw.den,
      taken: raw.num,
      player: r6n(player),
      target: r6n(target),
      half: r6n(half),
      bandLow: r6n(bandLow),
      bandHigh: r6n(bandHigh),
      gap: r6n(gap),
      direction,
      tone,
      costHigh: r6(costHigh),
      costLow: r6(costLow),
      cost: r6(cost),
      coverage: raw.opps > 0 ? r6(raw.den / raw.opps) : null,
    },
    costHigh,
    costLow,
    cost,
    raw,
  };
}

/**
 * The actions above the reference's (`high`) or below them (`low`):
 * num − refNum / refDen × den. Null without a target.
 */
function excess(raw: Raw, direction: CheckerDirection): number | null {
  if (raw.den <= 0 || raw.refDen <= 0) return null;
  const expected = (raw.refNum / raw.refDen) * raw.den;
  return direction === "high" ? raw.num - expected : expected - raw.num;
}

/* ------------------------------------------------------ breakdowns -- */

interface RowJudged {
  row: CheckerRow;
  judged: Judged;
}

/** Keys in first-seen order, each with its groups' sums. */
function byKey(groups: readonly CheckerGroupIn[], key: (group: CheckerGroupIn) => string): Map<string, Acc> {
  const out = new Map<string, Acc>();
  for (const group of groups) {
    const k = key(group);
    let acc = out.get(k);
    if (!acc) {
      acc = emptyAcc();
      out.set(k, acc);
    }
    add(acc, group);
  }
  return out;
}

/** Catalogue ids first in their order, then any other key in byte order; '' dropped. */
function inOrder(keys: Iterable<string>, order: readonly string[]): string[] {
  const present = new Set(keys);
  present.delete("");
  const known = order.filter((id) => present.has(id));
  const other = [...present].filter((id) => !order.includes(id)).sort(byteOrder);
  return [...known, ...other];
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rowOf(key: string, judged: Judged, statTaken: number, weak?: boolean): RowJudged {
  const raw = judged.raw;
  const row: CheckerRow = {
    ...judged.figures,
    key,
    shareOfTaken: statTaken > 0 ? r6(raw.num / statTaken) : null,
    worth: raw.num > 0 ? r6(raw.evHigh / raw.num) : null,
  };
  if (weak !== undefined) row.weak = weak;
  return { row, judged };
}

/** The weight a spot is ordered by: its cost in the stat's direction (both without one). */
function spotWeight(judged: Judged, direction: CheckerDirection | null): number {
  if (direction === "high") return judged.costHigh;
  if (direction === "low") return judged.costLow;
  return judged.costHigh + judged.costLow;
}

function sortSpots(rows: RowJudged[], direction: CheckerDirection | null): RowJudged[] {
  return rows.sort((a, b) => {
    const wa = spotWeight(a.judged, direction);
    const wb = spotWeight(b.judged, direction);
    if (wa !== wb) return wb > wa ? 1 : -1;
    if (a.judged.raw.den !== b.judged.raw.den) return b.judged.raw.den - a.judged.raw.den;
    return byteOrder(a.row.key, b.row.key);
  });
}

/* ----------------------------------------------------------- check -- */

interface StatWork {
  stat: CatalogueStat;
  index: number;
  checked: CheckedStat;
  judged: Judged | null;
  spots: RowJudged[];
  classes: RowJudged[];
}

function sourceOf(stat: CatalogueStat): CheckedStat["source"] {
  if (stat.kind === "coded" || stat.street === "showdown") return null;
  return stat.street === "preflop" ? "charts" : "solver";
}

function noFigures(): CheckerFigures {
  return {
    opps: 0,
    oppsTaken: 0,
    n: 0,
    taken: 0,
    player: null,
    target: null,
    half: null,
    bandLow: null,
    bandHigh: null,
    gap: null,
    direction: null,
    tone: "none",
    costHigh: 0,
    costLow: 0,
    cost: 0,
    coverage: null,
  };
}

/** Whether taking more of the stat's action is looser play (folding more is tighter). */
function leanOf(stat: CatalogueStat, direction: CheckerDirection): CheckerLean {
  const tighterWhenHigh = stat.kind === "rate" && stat.class === "fold";
  return (direction === "high") !== tighterWhenHigh ? "loose" : "tight";
}

/** Judge the sums against the catalogue. `coded`: the player's coded stats, by catalogue id. */
export function checkStats(
  catalogue: Catalogue,
  sums: CheckerSumsIn,
  coded: Readonly<Record<string, CodedIn>> = {},
): CheckerResult {
  const hands = sums.hands;
  const byStat = new Map<string, CheckerGroupIn[]>();
  for (const group of sums.groups) {
    let list = byStat.get(group.stat);
    if (!list) {
      list = [];
      byStat.set(group.stat, list);
    }
    list.push(group);
  }
  const sizeOrder = catalogue.file.sizeBuckets.map((bucket) => bucket.id);
  const classOrder = catalogue.file.handClasses.map((cls) => cls.id);

  const work: StatWork[] = catalogue.stats.map((stat, index) => {
    const rules: Judge = { floor: stat.band.floor, sampleMin: stat.sample.min, hands };
    const base = { id: stat.id, kind: stat.kind, source: sourceOf(stat) };
    if (stat.kind === "coded") {
      const counts = coded[stat.id];
      const figures = noFigures();
      if (counts) {
        figures.opps = counts.opp;
        figures.oppsTaken = counts.made;
        figures.n = counts.opp;
        figures.taken = counts.made;
        figures.player = counts.opp > 0 ? r6((counts.made * 100) / counts.opp) : null;
      }
      return {
        stat,
        index,
        checked: { ...base, ...figures, spots: [], sizes: [], classes: [] },
        judged: null,
        spots: [],
        classes: [],
      };
    }
    const groups = byStat.get(stat.kind === "share" ? stat.of : stat.id) ?? [];
    let judged: Judged;
    let spots: RowJudged[];
    let sizes: RowJudged[];
    let classes: RowJudged[];
    if (stat.kind === "rate") {
      const all = emptyAcc();
      for (const group of groups) add(all, group);
      judged = judge(rateRaw(all), rules);
      const rows = (accs: Map<string, Acc>, keys: string[]) =>
        keys.map((key) => rowOf(key, judge(rateRaw(accs.get(key) as Acc), rules), all.taken));
      const spotAccs = byKey(groups, (g) => g.spot);
      spots = sortSpots(rows(spotAccs, [...spotAccs.keys()]), judged.figures.direction);
      const sizeAccs = byKey(groups, (g) => g.size);
      sizes = rows(sizeAccs, inOrder(sizeAccs.keys(), sizeOrder));
      const classAccs = byKey(groups, (g) => g.handClass);
      classes = rows(classAccs, inOrder(classAccs.keys(), classOrder));
    } else {
      const weak = new Set(stat.weak);
      const isWeak = (group: CheckerGroupIn) => weak.has(group.handClass);
      const all = emptyAcc();
      const weakAll = emptyAcc();
      for (const group of groups) {
        add(all, group);
        if (isWeak(group)) add(weakAll, group);
      }
      judged = judge(shareRaw(all, weakAll), rules);
      const split = (key: (group: CheckerGroupIn) => string, keys: (accs: Map<string, Acc>) => string[]) => {
        const alls = byKey(groups, key);
        const weaks = byKey(groups.filter(isWeak), key);
        return keys(alls).map((k) =>
          rowOf(k, judge(shareRaw(alls.get(k) as Acc, weaks.get(k) ?? emptyAcc()), rules), all.taken),
        );
      };
      spots = sortSpots(
        split(
          (g) => g.spot,
          (accs) => [...accs.keys()],
        ),
        judged.figures.direction,
      );
      sizes = split(
        (g) => g.size,
        (accs) => inOrder(accs.keys(), sizeOrder),
      );
      const classAccs = byKey(groups, (g) => g.handClass);
      classes = inOrder(classAccs.keys(), classOrder).map((key) =>
        rowOf(key, judge(shareRaw(all, classAccs.get(key) as Acc), rules), all.taken, weak.has(key)),
      );
    }
    return {
      stat,
      index,
      checked: {
        ...base,
        ...judged.figures,
        spots: spots.map((r) => r.row),
        sizes: sizes.map((r) => r.row),
        classes: classes.map((r) => r.row),
      },
      judged,
      spots,
      classes,
    };
  });

  return {
    hands,
    pending: sums.pending,
    stats: work.map((w) => w.checked),
    findings: findingsOf(catalogue, work),
  };
}

/* -------------------------------------------------------- findings -- */

/**
 * Whether two stats of a finding judge the same decisions, so that one
 * decision's EV loss would be summed twice: one Streets block (`group`: the
 * same opportunities, as fold to 3-bet and 4-bet), or both preflop (every
 * preflop rate reads the hero's first preflop decision: an open raise is
 * also a PFR and a VPIP).
 */
function overlaps(a: CatalogueStat, b: CatalogueStat): boolean {
  return a.group === b.group || (a.street === "preflop" && b.street === "preflop");
}

function findingsOf(catalogue: Catalogue, work: StatWork[]): CheckerFinding[] {
  const families = catalogue.file.families;
  const groups = new Map<string, { family: string; lean: CheckerLean; members: StatWork[] }>();
  for (const w of work) {
    const judged = w.judged;
    const direction = judged?.figures.direction;
    if (!judged || !direction || (judged.figures.tone !== "off" && judged.figures.tone !== "far")) continue;
    const lean = leanOf(w.stat, direction);
    const key = `${w.stat.family}|${lean}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { family: w.stat.family, lean, members: [] };
      groups.set(key, entry);
    }
    entry.members.push(w);
  }
  const out: { finding: CheckerFinding; cost: number; family: number }[] = [];
  for (const { family, lean, members } of groups.values()) {
    members.sort((a, b) => {
      const ca = (a.judged as Judged).cost;
      const cb = (b.judged as Judged).cost;
      if (ca !== cb) return cb > ca ? 1 : -1;
      return a.index - b.index;
    });
    const ids = new Set(members.map((m) => m.stat.id));
    let cost = 0;
    const summed: CatalogueStat[] = [];
    const stats = members.map((m) => {
      const container = m.stat.kind === "rate" ? m.stat.within : m.stat.kind === "share" ? m.stat.of : undefined;
      const counted =
        !(container !== undefined && ids.has(container)) && !summed.some((other) => overlaps(other, m.stat));
      if (counted) {
        cost += (m.judged as Judged).cost;
        summed.push(m.stat);
      }
      return { id: m.stat.id, counted };
    });
    const lead = members[0];
    const direction = (lead.judged as Judged).figures.direction as CheckerDirection;
    out.push({
      finding: {
        family,
        lean,
        tone: members.some((m) => m.checked.tone === "far") ? "far" : "off",
        cost: r6(cost),
        stats,
        lead: lead.stat.id,
        direction,
        why: whyOf(lead, direction),
      },
      cost,
      family: families.indexOf(family),
    });
  }
  out.sort((a, b) => {
    if (a.cost !== b.cost) return b.cost > a.cost ? 1 : -1;
    if (a.family !== b.family) return a.family - b.family;
    return byteOrder(a.finding.lean, b.finding.lean);
  });
  return out.map((entry) => entry.finding);
}

/** The row with the most cost in `direction`, then the most excess; null when none has either. */
function pick(rows: RowJudged[], direction: CheckerDirection, costFirst: boolean): RowJudged | null {
  let best: { row: RowJudged; cost: number; excess: number } | null = null;
  for (const row of rows) {
    const extra = excess(row.judged.raw, direction);
    if (extra === null) continue;
    const cost = direction === "high" ? row.judged.costHigh : row.judged.costLow;
    if (extra <= 0 && !(costFirst && cost > 0)) continue;
    if (best === null) {
      best = { row, cost, excess: extra };
      continue;
    }
    const better = costFirst
      ? cost > best.cost || (cost === best.cost && extra > best.excess)
      : extra > best.excess || (extra === best.excess && cost > best.cost);
    if (better) best = { row, cost, excess: extra };
  }
  return best?.row ?? null;
}

function whyOf(lead: StatWork, direction: CheckerDirection): CheckerWhy {
  const spot = pick(lead.spots, direction, true);
  const classRows =
    lead.stat.kind === "share"
      ? lead.classes.filter((r) => r.row.weak === true)
      : lead.classes;
  const cls = pick(classRows, direction, false);
  return {
    stat: lead.stat.id,
    source: lead.checked.source ?? "solver",
    spot: spot?.row.key ?? null,
    spotPlayer: spot?.row.player ?? null,
    spotTarget: spot?.row.target ?? null,
    handClass: cls?.row.key ?? null,
    classPlayer: cls?.row.player ?? null,
    classTarget: cls?.row.target ?? null,
    classShare: cls?.row.shareOfTaken ?? null,
    classWorth: cls && direction === "high" ? cls.row.worth : null,
  };
}
