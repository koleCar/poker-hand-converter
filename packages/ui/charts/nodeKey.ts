/**
 * A shipped chart line as the user's situation (R5.3): which key of
 * `model.ts`' vocabulary a node of the shipped tree is, so a played decision
 * the analysis located on that tree can be compared with the user's chart,
 * and a shipped node can be copied into one.
 *
 * The same rule runs in the database (`preflop_chart_node_key`,
 * `20270811100000_preflop_charts_compare.sql`) to file each stored decision;
 * pgTAP (`preflop_charts_compare`) holds it to this one's answers for 966
 * shipped lines - every node of the 6-max 100bb and heads-up 100bb sets, the
 * 200 most reached of the 9-max 100bb set - which
 * `tests/test/preflopCharts.test.ts` checks are this module's.
 *
 * A line is one letter per action in turn order, folds included (`f` fold,
 * `k` check, `c` call or limp, `r` raise, `a` all-in; docs/CHARTS.md §6.1).
 * The decision at the end of it is the next seat still in and not all in.
 *
 * | Raises | What the actor faces | Key |
 * |---|---|---|
 * | 0 | nothing (unopened) | `rfi:hero` |
 * | 0 | limpers | `vs-limp:hero:first limper` |
 * | 1 | an open, no callers | `vs-open:hero:opener` |
 * | 1 | an open and callers | `squeeze:hero:opener` |
 * | 1 | an iso-raise over the actor's own limp | `vs-iso:hero:raiser` |
 * | 2, 3, 4+ | a 3-bet, a 4-bet, a 5-bet or more, in a pot only the actor and the raiser have raised and nobody called or limped | `vs-3bet`, `vs-4bet`, `vs-allin` `:hero:raiser` |
 *
 * Anything else has no key: a raise over limpers faced by a non-limper, a
 * cold 3-bet or 4-bet, a 3-bet pot with a caller, a straddled pot (the
 * straddle set's seats are not the vocabulary's).
 */
import { formatNodeKey, TABLE_POSITIONS, type NodeKey, type Position, type TableSize } from "./model";

/**
 * The seats of a shipped set (`nlhe-cash-6max-100bb`, …) in preflop order;
 * null for the straddle set and anything unknown. The push/fold game's
 * tables (R5.5: `icm-pushfold-hu`, `-6max`, `-9max` - a tournament
 * decision read on 2, 6 or 9 seats, earliest seats folded) read the same.
 */
export function seatsOfShippedSet(setId: string): { tableSize: TableSize; seats: readonly Position[] } | null {
  if (/-straddle$/.test(setId)) return null;
  if (/^nlhe-cash-6max-\d+bb$/.test(setId) || setId === "icm-pushfold-6max") return { tableSize: 6, seats: TABLE_POSITIONS[6] };
  if (/^nlhe-cash-9max-\d+bb$/.test(setId) || setId === "icm-pushfold-9max") return { tableSize: 9, seats: TABLE_POSITIONS[9] };
  if (/^nlhe-cash-hu-\d+bb$/.test(setId) || setId === "icm-pushfold-hu") return { tableSize: 2, seats: TABLE_POSITIONS[2] };
  return null;
}

/** The situation a line ends at, or null when the vocabulary does not name it. */
export function nodeKeyOfLine(line: string, seats: readonly Position[]): NodeKey | null {
  if (!/^[fkcra]{0,24}$/.test(line)) return null;
  const n = seats.length;
  const folded = new Array<boolean>(n).fill(false);
  const allIn = new Array<boolean>(n).fill(false);
  const limpers: number[] = [];
  const raisers: number[] = [];
  let callers = 0;
  let facingAllIn = false;
  let seat = -1;
  const next = (): number => {
    for (let tries = 0; tries < n; tries += 1) {
      seat = (seat + 1) % n;
      if (!folded[seat] && !allIn[seat]) return seat;
    }
    return -1;
  };
  for (const code of line) {
    const s = next();
    if (s < 0) return null;
    if (code === "f") folded[s] = true;
    else if (code === "c") {
      if (raisers.length === 0) limpers.push(s);
      else callers += 1;
      if (facingAllIn) allIn[s] = true;
    } else if (code === "r" || code === "a") {
      raisers.push(s);
      if (code === "a") {
        allIn[s] = true;
        facingAllIn = true;
      }
    }
  }
  const actor = next();
  if (actor < 0) return null;
  const hero = seats[actor];
  const raises = raisers.length;
  if (raises === 0) {
    if (limpers.length === 0) return hero === "BB" ? null : { scenario: "rfi", hero, vs: null };
    if (limpers.includes(actor)) return null;
    return { scenario: "vs-limp", hero, vs: seats[limpers[0]] };
  }
  const raiser = raisers[raises - 1];
  if (raiser === actor) return null;
  if (raises === 1) {
    if (limpers.length > 0) return limpers.includes(actor) ? { scenario: "vs-iso", hero, vs: seats[raiser] } : null;
    return { scenario: callers > 0 ? "squeeze" : "vs-open", hero, vs: seats[raiser] };
  }
  if (limpers.length > 0 || callers > 0) return null;
  // A raising war between the actor and the last raiser alone, the actor having raised first or second.
  if (!raisers.every((r) => r === actor || r === raiser)) return null;
  if (!raisers.includes(actor)) return null;
  const scenario = raises === 2 ? "vs-3bet" : raises === 3 ? "vs-4bet" : "vs-allin";
  return { scenario, hero, vs: seats[raiser] };
}

/** `nodeKeyOfLine` for a shipped set by id, formatted; null when it has no key. */
export function shippedNodeKey(setId: string, line: string): string | null {
  const table = seatsOfShippedSet(setId);
  if (!table) return null;
  const key = nodeKeyOfLine(line, table.seats);
  return key ? formatNodeKey(key) : null;
}
