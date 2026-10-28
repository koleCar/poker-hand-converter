/**
 * The Solver library (`/solver`): Rail's own solves, browsed the way a
 * solver's viewer shows them.
 *
 * ```
 * a table (players × stack depth the library holds)
 *   ─▶ the preflop line, seat by seat (PreflopBar): each decision is the chart node's grid (lib/charts)
 *   ─▶ the line ends heads-up on a library line ─▶ a flop (FlopPicker; any suits, the library files canonical flops)
 *   ─▶ the chunk (`FlopLibraryLoader.load`, the analysis' own reader) ─▶ a flop decision (`exploreNode`)
 *   ─▶ an action ─▶ the next flop decision, until the flop's betting is over
 * ```
 *
 * Public, like the preflop chart browser: nothing here reads an account. The
 * chunks are the public bucket's, the same files the analysis grades with.
 * The table, the preflop line, the flop and the flop decision live in the
 * address bar (`?set=…&line=…&flop=…&node=…`), so a link lands on the same
 * view.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { flopLibraryBase, flopLinesFor, FlopLibraryLoader } from "../../lib/analysis/flopLibrary";
import { preflopChartSet } from "../../lib/chartSet";
import { CHART_SETS, type ChartNode, type ChartSet } from "../../lib/charts";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import {
  classCombos,
  exploreHistory,
  exploreNode,
  flopCards,
  flopFeatures,
  pickedFlop,
  type FlopChunk,
  type PickedFlop,
} from "../../lib/solver";
import { SUPABASE_URL } from "../../lib/supabase/config";
import { actionTotals, GRID_CELLS, OFF_RANGE_WEIGHT } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import { FlopPicker } from "./FlopPicker";
import { PreflopBar, type TableOption } from "./PreflopBar";
import { preflopState, type PreflopState } from "./preflop";
import { actionColours, StrategyView, type StrategyModel } from "./StrategyView";
import styles from "./solver.module.css";

type Dict = ReturnType<typeof useDict>["solver"];

/** The chart sets the flop library is solved for, in the order offered. A set without a manifest yet says so. */
export const SOLVER_SETS = [
  "nlhe-cash-6max-100bb",
  "nlhe-cash-6max-150bb",
  "nlhe-cash-9max-100bb",
  "nlhe-cash-hu-100bb",
  "nlhe-cash-hu-150bb",
] as const;

const TABLES: readonly TableOption[] = SOLVER_SETS.map((id) => {
  const spec = CHART_SETS.find((s) => s.id === id)!;
  return { id, players: spec.players, stackBb: spec.stackBb };
});

/** High card first, then the next: how a player scans a list of flops. */
function byRanks(a: string, b: string): number {
  const ra = flopFeatures(flopCards(a)).ranks;
  const rb = flopFeatures(flopCards(b)).ranks;
  return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2] || a.localeCompare(b);
}

let loader: FlopLibraryLoader | null | undefined;
function libraryLoader(): FlopLibraryLoader | null {
  if (loader === undefined) {
    const base = flopLibraryBase(SUPABASE_URL);
    loader = base ? new FlopLibraryLoader(base, (url) => fetch(url)) : null;
  }
  return loader;
}

type Loaded<T> = { key: string; status: "loading" } | { key: string; status: "ready"; value: T } | { key: string; status: "error" };

interface SolverLibraryProps {
  initialSet: string | null;
  initialLine: string | null;
  /** The picked flop, six characters (`Ks7h2d`), any suits. */
  initialFlop: string | null;
  initialNode: number | null;
}

export function SolverLibrary(props: SolverLibraryProps) {
  const t = useDict().solver;
  if (!libraryLoader()) return <p className={analysis.muted}>{t.unavailable}</p>;
  return <Browser {...props} />;
}

function Browser({ initialSet, initialLine, initialFlop, initialNode }: SolverLibraryProps) {
  const t = useDict().solver;
  const router = useRouter();
  const [setId, setSetId] = useState<string>(
    initialSet && (SOLVER_SETS as readonly string[]).includes(initialSet) ? initialSet : SOLVER_SETS[0],
  );
  const [line, setLine] = useState(initialLine ?? "");
  const [flop, setFlop] = useState<string[] | null>(initialFlop ? flopCards(initialFlop) : null);
  const [node, setNode] = useState(initialNode ?? 0);
  const [picker, setPicker] = useState(false);
  /** The line whose automatic flop prompt was closed: it does not come back for that line. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [charts, setCharts] = useState<Loaded<ChartSet>>({ key: "", status: "loading" });
  const [entries, setEntries] = useState<Loaded<Map<string, string[]>>>({ key: "", status: "loading" });
  const [chunk, setChunk] = useState<Loaded<FlopChunk>>({ key: "", status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const table = TABLES.find((x) => x.id === setId)!;
  const lines = flopLinesFor(table.players);

  // The table's preflop charts and its flop manifest.
  useEffect(() => {
    let live = true;
    void preflopChartSet(setId)
      .then((value) => {
        if (live) setCharts(value ? { key: setId, status: "ready", value } : { key: setId, status: "error" });
      })
      .catch(() => {
        if (live) setCharts({ key: setId, status: "error" });
      });
    void libraryLoader()!
      .listed(setId)
      .then((listed) => {
        if (!live) return;
        const byLine = new Map<string, string[]>();
        for (const entry of listed) byLine.set(entry.line, [...(byLine.get(entry.line) ?? []), entry.flop]);
        for (const keys of byLine.values()) keys.sort(byRanks);
        setEntries({ key: setId, status: "ready", value: byLine });
      });
    return () => {
      live = false;
    };
  }, [setId]);

  const chartSet = charts.key === setId && charts.status === "ready" ? charts.value : null;
  const manifest = entries.key === setId && entries.status === "ready" ? entries.value : null;
  const state = useMemo(() => (chartSet ? preflopState(chartSet, line, lines) : null), [chartSet, line, lines]);
  const end = state?.end ?? null;
  const libraryLine = end?.kind === "flop" ? end.line : null;
  const solved = useMemo(() => (libraryLine && manifest?.get(libraryLine.id)) || [], [libraryLine, manifest]);
  const picked: PickedFlop | null = useMemo(() => (flop ? pickedFlop(flop) : null), [flop]);
  const flopKey = picked && solved.includes(picked.key) ? picked.key : null;
  const chunkKey = libraryLine && flopKey ? `${setId}/${libraryLine.id}/${flopKey}` : "";

  // The chunk of the line and the flop.
  useEffect(() => {
    if (!chunkKey || !libraryLine || !flopKey) return;
    let live = true;
    void libraryLoader()!
      .load(setId, libraryLine.id, flopKey)
      .then((value) => {
        if (live) setChunk(value ? { key: chunkKey, status: "ready", value } : { key: chunkKey, status: "error" });
      });
    return () => {
      live = false;
    };
  }, [chunkKey, setId, libraryLine, flopKey, attempt]);

  const solve = chunk.key === chunkKey && chunk.status === "ready" ? chunk.value : null;
  const nodeIndex = solve && solve.result.nodes[node]?.kind === "action" ? node : 0;

  // The view in the address bar, so a link lands here.
  useEffect(() => {
    if (!state) return;
    router.replace(
      paths.solver({ set: setId, line: state.line, flop: flopKey && flop ? flop.join("") : undefined, node: flopKey ? nodeIndex : 0 }),
      { scroll: false },
    );
  }, [router, setId, state, flop, flopKey, nodeIndex]);

  // A line that ends on a solved flop line with no flop yet asks for one, once.
  const lineKey = `${setId}|${line}`;
  const pickerOpen = solved.length > 0 && (picker || (!flopKey && dismissed !== lineKey));
  const closePicker = () => {
    setPicker(false);
    setDismissed(lineKey);
  };

  const goLine = (next: string) => {
    setLine(next);
    setFlop(null);
    setNode(0);
  };

  let body: ReactNode;
  if (!state || !manifest) {
    body = <p className={analysis.muted}>{t.loading}</p>;
  } else if (state.node) {
    const model = preflopModel(state.node, state, goLine, t);
    body = <StrategyView model={model} overview={<PreflopOverview node={state.node} t={t} />} />;
  } else if (end?.kind === "folded") {
    body = <p className={styles.message}>{t.preflop.folded(end.winner)}</p>;
  } else if (end?.kind === "allin") {
    body = <p className={styles.message}>{t.preflop.allin}</p>;
  } else if (end?.kind === "multiway") {
    body = <p className={styles.message}>{t.preflop.multiway(end.players.join(", "))}</p>;
  } else if (end?.kind === "flop" && solved.length === 0) {
    body = (
      <p className={styles.message}>
        {manifest.size === 0 ? t.preflop.setEmpty : t.preflop.notSolved(end.players[0], end.players[1])}
      </p>
    );
  } else if (!flopKey) {
    body = (
      <div className={styles.message}>
        <button type="button" className="btn btn--primary" onClick={() => setPicker(true)}>
          {t.flop.pick}
        </button>
      </div>
    );
  } else if (chunk.key === chunkKey && chunk.status === "error") {
    body = (
      <div className={styles.message}>
        <p>{t.loadError}</p>
        <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
          {t.retry}
        </button>
      </div>
    );
  } else if (solve && picked && flop) {
    body = (
      <StrategyView
        model={flopModel(solve, nodeIndex, picked, setNode, t)}
        overview={<FlopOverview chunk={solve} index={nodeIndex} board={flop} onGo={setNode} onChange={() => setPicker(true)} t={t} />}
      />
    );
  } else {
    body = <p className={analysis.muted}>{t.loading}</p>;
  }

  return (
    <div className={styles.solver}>
      <PreflopBar
        tables={TABLES}
        table={table}
        onTable={(id) => {
          setSetId(id);
          goLine("");
        }}
        state={state}
        onLine={goLine}
      />
      {body}
      {pickerOpen ? (
        <FlopPicker
          open
          onClose={closePicker}
          solved={solved}
          current={flopKey ? flop : null}
          onPick={(cards) => {
            setFlop(cards);
            setNode(0);
            closePicker();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ the models - */

function preflopModel(node: ChartNode, state: PreflopState, goLine: (line: string) => void, t: Dict): StrategyModel {
  const classes = node.range.length;
  const totals = actionTotals(node);
  const colours = actionColours(node.options.map((o) => ({ kind: o.action, amount: o.toBb })));
  return {
    id: `pre|${state.line}`,
    actor: node.actor,
    actions: node.options.map((option, a) => ({
      key: option.code,
      label: t.preflop.action(option.action, option.toBb),
      colour: colours[a],
      share: totals[a].share,
      combos: totals[a].combos,
      ends: null,
      onPick: () => goLine(state.line + option.code),
    })),
    classes: GRID_CELLS.map((cell) => {
      const k = cell.index;
      const freq = node.options.map((_, a) => node.freq[a * classes + k]);
      const ev = node.options.map((_, a) => node.ev[a * classes + k]);
      const range = node.range[k];
      return {
        state: range < OFF_RANGE_WEIGHT ? "faint" : "in",
        fill: Math.min(1, range),
        freq,
        ev,
        value: freq.reduce((sum, f, a) => sum + f * ev[a], 0),
        reach: t.reachesShare(range),
      };
    }),
    note: t.chartNote,
  };
}

function flopModel(chunk: FlopChunk, index: number, picked: PickedFlop, onGo: (node: number) => void, t: Dict): StrategyModel {
  const view = exploreNode(chunk, index);
  const colours = actionColours(view.actions);
  return {
    id: `flop|${chunk.header.line}|${chunk.header.flop}|${index}`,
    actor: view.position,
    actions: view.actions.map((action, a) => ({
      key: action.label,
      label: t.action(action.kind, action.sizePot, action.amount),
      colour: colours[a],
      share: view.totals[a].share,
      combos: view.totals[a].combos,
      ends: action.ends ? t.panel.ends[action.ends] : null,
      onPick: () => {
        if (action.child >= 0) onGo(action.child);
      },
    })),
    classes: GRID_CELLS.map((cell) => {
      const c = view.classes[cell.index];
      return {
        state: c.combos === 0 ? "absent" : c.weight === 0 ? "faint" : "in",
        fill: c.combos > 0 ? Math.min(1, c.weight / c.combos) : 0,
        freq: c.freq,
        ev: c.ev,
        value: c.value,
        reach: t.reaches(c.weight, c.combos),
      };
    }),
    combos: (k) =>
      classCombos(chunk, index, k).map((combo) => ({
        ...combo,
        cards: `${picked.toPicked(combo.cards.slice(0, 2))}${picked.toPicked(combo.cards.slice(2, 4))}`,
      })),
    note: `${t.rangeValue(view.reach, view.value)} · ${t.solvedTo(chunk.result.exploitabilityPct, chunk.result.iterations)} ${t.flopNote}`,
  };
}

/* --------------------------------------------------------- the overviews - */

function PreflopOverview({ node, t }: { node: ChartNode; t: Dict }) {
  return (
    <div className={styles.overview}>
      <p className={styles.overviewTitle}>
        <strong>{t.panel.toAct(node.actor)}</strong>{" "}
        <span className={analysis.muted}>{t.panel.pot(node.potBb, Math.max(0, node.toMatchBb - node.inBb))}</span>
      </p>
      <p className={analysis.muted}>{t.preflop.label}</p>
    </div>
  );
}

function FlopOverview({
  chunk,
  index,
  board,
  onGo,
  onChange,
  t,
}: {
  chunk: FlopChunk;
  index: number;
  board: readonly string[];
  onGo: (node: number) => void;
  onChange: () => void;
  t: Dict;
}) {
  const view = exploreNode(chunk, index);
  const history = exploreHistory(chunk, index);
  return (
    <div className={styles.overview}>
      <div className={styles.boardRow}>
        <CardRow cards={[...board]} size="sm" />
        <button type="button" className="btn btn--sm" onClick={onChange}>
          {t.flop.change}
        </button>
      </div>
      <p className={styles.overviewTitle}>
        <strong>{t.panel.toAct(view.position)}</strong> <span className={analysis.muted}>{t.panel.pot(view.pot, view.toCall)}</span>
      </p>
      <nav className={styles.history} aria-label={t.panel.history}>
        <button type="button" className={styles.step} disabled={index === 0} onClick={() => onGo(0)}>
          {t.panel.start}
        </button>
        {history.map((step) => (
          <span key={step.node} className={styles.stepWrap}>
            <span aria-hidden="true">›</span>
            <button type="button" className={styles.step} onClick={() => onGo(step.node)}>
              {t.panel.step(step.position, t.action(step.action.kind, step.action.sizePot, step.action.amount))}
            </button>
          </span>
        ))}
      </nav>
    </div>
  );
}
