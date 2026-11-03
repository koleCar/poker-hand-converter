/**
 * Both ranges at the decision on screen, for the Ranges tab and the hand
 * filters (`lib/solver/ranges.ts` does the arithmetic):
 *
 * ```
 * the solve + the node ─▶ nodeRanges, handFeatures (at once)
 *                       ─▶ equity (a moment later, off the click: ~0.2 s the first time on a flop)
 * the filter ─▶ which hands of each player pass it (filterMasks)
 * ```
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  classOfCombo,
  comboIds,
  comboText,
  equityTable,
  filterActive,
  handFeatures,
  nodeRanges,
  passes,
  rangeEquity,
  type FlopChunk,
  type HandFeature,
  type HandFilter,
  type NodeRanges,
  type PickedFlop,
} from "../../lib/solver";

type Pair<T> = [T, T];

export interface RangeData {
  key: string;
  ranges: NodeRanges;
  /** Per player and hand: the two cards in the picked flop's suits, e.g. `AhKd`. */
  cards: Pair<string[]>;
  features: Pair<HandFeature[]>;
  /** Per player and class (grid order): the hands of the class. */
  byClass: Pair<number[][]>;
  /** Null while it is being computed. */
  equity: Pair<Float64Array> | null;
  /** The actor's strategy at the node, `[action][hand]`, and how many actions. */
  strategy: Float32Array;
  actions: number;
}

/** The node's ranges, or null without a solve. */
export function useRangeData(chunk: FlopChunk | null, index: number, picked: PickedFlop | null): RangeData | null {
  const key = chunk ? `${chunk.header.line}|${chunk.header.flop}|${chunk.result.board.join("")}|${index}` : "";
  const base = useMemo(() => {
    if (!chunk || !picked || chunk.result.nodes[index]?.kind !== "action") return null;
    const ranges = nodeRanges(chunk, index);
    const cards = ranges.sides.map((side) =>
      Array.from(side.hands, (combo) => {
        const text = comboText(combo);
        return `${picked.toPicked(text.slice(0, 2))}${picked.toPicked(text.slice(2, 4))}`;
      }),
    ) as Pair<string[]>;
    const features = ranges.sides.map((side) => handFeatures(side.hands, ranges.board)) as Pair<HandFeature[]>;
    const byClass = ranges.sides.map((side) => {
      const out: number[][] = Array.from({ length: 169 }, () => []);
      side.hands.forEach((combo, i) => {
        if (side.reach[i] > 0) out[classOfCombo(combo)].push(i);
      });
      return out;
    }) as Pair<number[][]>;
    const node = chunk.result.nodes[index];
    return { ranges, cards, features, byClass, strategy: node.strategy, actions: node.actions.length };
  }, [chunk, index, picked]);

  const [equity, setEquity] = useState<{ key: string; value: Pair<Float64Array> } | null>(null);
  useEffect(() => {
    if (!chunk || !base) return;
    // Off the click: the board's table is built once (cached per chunk), then a sweep per node.
    const timer = setTimeout(() => {
      const table = equityTable(chunk, base.ranges.board);
      setEquity({ key, value: rangeEquity(table, [base.ranges.sides[0].reach, base.ranges.sides[1].reach]) });
    }, 0);
    return () => clearTimeout(timer);
  }, [chunk, base, key]);

  if (!base) return null;
  return { key, ...base, equity: equity?.key === key ? equity.value : null };
}

/** Which hands of each player pass the filter (1) or not (0); null with no filter. */
export function filterMasks(data: RangeData | null, filter: HandFilter): Pair<Uint8Array> | null {
  if (!data || !filterActive(filter)) return null;
  return data.ranges.sides.map((side, p) =>
    Uint8Array.from(side.hands, (_, i) =>
      passes(filter, comboIds(data.cards[p][i], data.features[p][i], data.equity ? data.equity[p][i] : Number.NaN)) ? 1 : 0,
    ),
  ) as Pair<Uint8Array>;
}
