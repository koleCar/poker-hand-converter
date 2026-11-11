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
 *   ─▶ a turn card ─▶ the turn's decisions ─▶ a river card ─▶ the river's
 * ```
 *
 * The turn comes from a full solve's turn file when one is served
 * (fullSolve.ts, local), and otherwise is solved here, in a worker, from the
 * chunk's ranges at the deal (liveTurn.ts): a few seconds, nothing stored.
 *
 * A flop decision has two tabs: the actor's strategy (StrategyView) and both
 * ranges side by side (RangesView). The hand filters (HandFilters) sit in the
 * panel beside either and stay set while the line is walked.
 *
 * Public, like the preflop chart browser: nothing here reads an account. The
 * chunks are the public bucket's, the same files the analysis grades with.
 * The table, the preflop line, the flop and the flop decision live in the
 * address bar (`?set=…&line=…&flop=…&node=…`), so a link lands on the same
 * view.
 */

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { flopLinesFor, FLOP_LIBRARY_SETS } from "../../lib/analysis/flopLibrary";
import { preflopChartSet } from "../../lib/chartSet";
import { CHART_SETS, type ChartNode, type ChartSet } from "../../lib/charts";
import {
  classCombos,
  dealtCards,
  exploreHistory,
  exploreNode,
  flopCards,
  EMPTY_FILTER,
  flopFeatures,
  pickedFlop,
  nodeAt,
  turnDeal,
  type FlopChunk,
  type HandFilter,
  type LiveTurnProgress,
  type PickedFlop,
} from "../../lib/solver";
import { actionTotals, GRID_CELLS, OFF_RANGE_WEIGHT } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import { FlopPicker } from "./FlopPicker";
import { loadFullSolve, type FullSolve } from "./fullSolve";
import { HandFilters } from "./HandFilters";
import { useSolverHost, type SolverDict } from "./host";
import { liveTurnId, parseLiveTurnId, solveTurnLive } from "./liveTurn";
import { PreflopBar, type TableOption } from "./PreflopBar";
import { preflopState, type PreflopState } from "./preflop";
import { filterMasks, useRangeData } from "./rangeData";
import { RangesView } from "./RangesView";
import { actionColours, StrategyView, type StrategyModel } from "./StrategyView";
import styles from "./solver.module.css";

type Dict = SolverDict;

/** The chart sets the flop library is solved for, in the order offered. A set without a manifest yet says so. */
export const SOLVER_SETS = FLOP_LIBRARY_SETS;

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

type Loaded<T> = { key: string; status: "loading" } | { key: string; status: "ready"; value: T } | { key: string; status: "error" };

interface SolverLibraryProps {
  initialSet: string | null;
  initialLine: string | null;
  /** The picked flop, six characters (`Ks7h2d`), any suits. */
  initialFlop: string | null;
  initialNode: number | null;
  /**
   * The turn being walked: a full solve's turn file stem (`X-X~Kd`), or a live
   * turn's deal node and card (`12~Kd`). `initialNode` is then a decision of that turn.
   */
  initialTurn?: string | null;
  /**
   * A flop decision by its path in the solve (`X-B1.82`), in place of
   * `initialNode`: what a hand's analysis records (`FlopFacts.path`).
   */
  initialPath?: string | null;
  /** Hears the view as it changes - the web keeps it in the address bar, the app in its route. */
  onView?: (view: SolverView) => void;
}

/** The view a link (or a route) names: the table, the preflop line, the flop as picked, the decision, the turn. */
export interface SolverView {
  set: string;
  line: string;
  flop?: string;
  node: number;
  turn?: string;
}

export function SolverLibrary(props: SolverLibraryProps) {
  const { t, loader } = useSolverHost();
  if (!loader) return <p className={analysis.muted}>{t.unavailable}</p>;
  return <Browser {...props} />;
}

function Browser({ initialSet, initialLine, initialFlop, initialNode, initialTurn, initialPath, onView }: SolverLibraryProps) {
  const { t, loader, fullSolveBase } = useSolverHost();
  const [setId, setSetId] = useState<string>(
    initialSet && (SOLVER_SETS as readonly string[]).includes(initialSet) ? initialSet : SOLVER_SETS[0],
  );
  const [line, setLine] = useState(initialLine ?? "");
  const [flop, setFlop] = useState<string[] | null>(initialFlop ? flopCards(initialFlop) : null);
  const [node, setNode] = useState(initialNode ?? 0);
  /** A flop decision named by its path, read once the flop's solve is in (`initialPath`). */
  const [path, setPath] = useState(initialPath ?? null);
  const [picker, setPicker] = useState(false);
  /** The line whose automatic flop prompt was closed: it does not come back for that line. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [charts, setCharts] = useState<Loaded<ChartSet>>({ key: "", status: "loading" });
  const [entries, setEntries] = useState<Loaded<Map<string, string[]>>>({ key: "", status: "loading" });
  const [chunk, setChunk] = useState<Loaded<FlopChunk>>({ key: "", status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [full, setFull] = useState<Loaded<FullSolve | null>>({ key: "", status: "loading" });
  /** The turn being walked - a full solve's file (`turn/X-X~Kd.bin`) or a live turn (`live:12~Kd`) - or null on the flop. */
  const [turn, setTurn] = useState<string | null>(
    initialTurn ? (parseLiveTurnId(initialTurn) ? `live:${initialTurn}` : `turn/${initialTurn}.bin`) : null,
  );
  const [turnChunk, setTurnChunk] = useState<Loaded<FlopChunk>>({ key: "", status: "loading" });
  const [progress, setProgress] = useState<(LiveTurnProgress & { key: string }) | null>(null);
  /** A street's betting is over and its card is being picked: the deal's node (flop chunk: the turn; turn file: the river). */
  const [deal, setDeal] = useState<number | null>(null);
  const [tab, setTab] = useState<"strategy" | "ranges">("strategy");
  /**
   * The decision the tab was last switched on: its view fades in (`.rail-fade`).
   * Walking to another decision does not replay it - that is a click through
   * a tree, and a fade on every step would read as lag.
   */
  const [swappedAt, setSwappedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<HandFilter>(EMPTY_FILTER);

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
    void loader!
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
  }, [setId, loader]);

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
    void loader!
      .load(setId, libraryLine.id, flopKey)
      .then((value) => {
        if (live) setChunk(value ? { key: chunkKey, status: "ready", value } : { key: chunkKey, status: "error" });
      });
    return () => {
      live = false;
    };
  }, [chunkKey, setId, libraryLine, flopKey, attempt, loader]);

  // A full solve of the flop, when one is served (local).
  useEffect(() => {
    if (!chunkKey || !libraryLine || !flopKey) return;
    let live = true;
    void loadFullSolve(fullSolveBase, setId, "flop-m1", libraryLine.id, flopKey).then((value) => {
      if (live) setFull({ key: chunkKey, status: "ready", value });
    });
    return () => {
      live = false;
    };
  }, [chunkKey, setId, libraryLine, flopKey, fullSolveBase]);
  const fullSolve = full.key === chunkKey && full.status === "ready" ? full.value : null;
  const librarySolve = chunk.key === chunkKey && chunk.status === "ready" ? chunk.value : null;
  /** Without a full solve, turns are solved live from the library's chunk. */
  const liveBase = full.key === chunkKey && full.status === "ready" && !fullSolve ? librarySolve : null;
  const live = useMemo(() => (turn?.startsWith("live:") ? parseLiveTurnId(turn.slice(5)) : null), [turn]);

  const turnKey = turn && (live ? liveBase : fullSolve) ? `${chunkKey}/${turn}` : "";
  useEffect(() => {
    if (!turnKey || !turn) return;
    let alive = true;
    let request: Promise<FlopChunk | null>;
    if (live && liveBase) {
      request = solveTurnLive(chunkKey, liveBase, live.chance, live.card, (p) => {
        if (alive) setProgress({ ...p, key: turnKey });
      });
    } else if (fullSolve) {
      request = fullSolve.turn(turn);
    } else return;
    void request.then(
      (value) => {
        if (alive) setTurnChunk(value ? { key: turnKey, status: "ready", value } : { key: turnKey, status: "error" });
      },
      () => {
        if (alive) setTurnChunk({ key: turnKey, status: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [turnKey, turn, live, liveBase, fullSolve, chunkKey, attempt]);
  const turnSolve = turnChunk.key === turnKey && turnChunk.status === "ready" ? turnChunk.value : null;

  const flopSolve = fullSolve?.flop ?? librarySolve;
  const solve = turn ? turnSolve : flopSolve;
  // A decision named by its path (a hand's analysis) until the walk moves on.
  const pathNode = path && flopSolve && !turn ? nodeAt(flopSolve.result, path) : -1;
  const wanted = pathNode >= 0 ? pathNode : node;
  const nodeIndex = solve && solve.result.nodes[wanted]?.kind === "action" ? wanted : 0;
  const rangeData = useRangeData(solve, nodeIndex, picked);
  const masks = useMemo(() => filterMasks(rangeData, filter), [rangeData, filter]);
  const goNode = (next: number) => {
    setPath(null);
    setDeal(null);
    setNode(next);
  };
  const goFlop = (next: number) => {
    setTurn(null);
    goNode(next);
  };

  // The view, for the host to keep (the web's address bar), so a link lands here.
  useEffect(() => {
    if (!state || !onView) return;
    onView({
      set: setId,
      line: state.line,
      flop: flopKey && flop ? flop.join("") : undefined,
      node: flopKey ? nodeIndex : 0,
      turn: flopKey && turn ? turn.replace(/^live:/, "").replace(/^turn\//, "").replace(/\.bin$/, "") : undefined,
    });
  }, [onView, setId, state, flop, flopKey, nodeIndex, turn]);

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
    setTurn(null);
    setDeal(null);
    setPath(null);
    setNode(0);
  };

  let body: ReactNode;
  if (!state || !manifest) {
    body = <RailLoader label={t.loadingLibrary} showLabel centered />;
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
  } else if ((chunk.key === chunkKey && chunk.status === "error" && !fullSolve) || (turn && turnChunk.key === turnKey && turnChunk.status === "error")) {
    body = (
      <div className={styles.message}>
        <p>{t.loadError}</p>
        <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
          {t.retry}
        </button>
      </div>
    );
  } else if (solve && picked && flop && flopSolve) {
    let turnChance: number | null = null;
    if (turn && live) turnChance = live.chance;
    else if (turn && fullSolve) {
      const entry = fullSolve.manifest.turns.find((x) => x.file === turn);
      const at = entry ? flopSolve.result.nodes.findIndex((n) => n.kind === "chance" && n.path === entry.flopPath) : -1;
      turnChance = at >= 0 ? at : null;
    }
    const where: Where = { flop: flopSolve, turn: turn ? solve : null, turnChance, full: fullSolve };
    const include = masks ? masks[solve.result.nodes[nodeIndex].player] : undefined;
    const source = fullSolve ? t.fullNote : turn ? t.liveNote : "";
    const model = flopModel(solve, nodeIndex, picked, goNode, setDeal, source, t, include);
    body = (
      <StrategyView
        model={model}
        toolbar={
          <div className={styles.viewTabs} role="tablist" aria-label={t.tabs.label}>
            {(["strategy", "ranges"] as const).map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                className={styles.viewTab}
                onClick={() => {
                  if (x === tab) return;
                  setTab(x);
                  setSwappedAt(model.id);
                }}
              >
                {t.tabs[x]}
              </button>
            ))}
          </div>
        }
        main={tab === "ranges" && rangeData ? <RangesView data={rangeData} masks={masks} strategy={model} /> : undefined}
        fade={swappedAt === model.id}
        filters={<HandFilters data={rangeData} filter={filter} onFilter={setFilter} colours={model.actions.map((a) => a.colour)} />}
        overview={
          <FlopOverview
            where={where}
            index={nodeIndex}
            board={flop}
            picked={picked}
            deal={deal}
            onGo={goNode}
            onFlop={goFlop}
            onTurn={(file, next) => {
              setTurn(file);
              goNode(next);
            }}
            onChange={() => setPicker(true)}
            t={t}
          />
        }
      />
    );
  } else if (live) {
    // The turn is being solved here.
    const shown = progress?.key === turnKey ? progress : null;
    body = <RailLoader label={t.solvingTurn(shown?.iteration ?? 0, shown?.exploitabilityPct ?? null)} showLabel centered />;
  } else {
    // The flop's (or the turn's) solve is downloading.
    body = <RailLoader label={t.loadingSolve} showLabel centered />;
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
            setTurn(null);
            setDeal(null);
            setPath(null);
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

function flopModel(
  chunk: FlopChunk,
  index: number,
  picked: PickedFlop,
  onGo: (node: number) => void,
  onDeal: (deal: number) => void,
  /** Where the turn comes from, for the note: a full solve's, a live one's, or "" on a library flop. */
  source: string,
  t: Dict,
  include?: Uint8Array,
): StrategyModel {
  const view = exploreNode(chunk, index, include);
  const unfiltered = include ? exploreNode(chunk, index).reach : view.reach;
  const colours = actionColours(view.actions);
  // The turn and the river are dealt, not the end of the walk - unless the flop went all-in (nothing left to solve).
  const dealable = (deal: number) => deal >= 0 && (chunk.result.street === "turn" || turnDeal(chunk, deal) !== null);
  return {
    id: `flop|${chunk.header.line}|${chunk.header.flop}|${chunk.result.board.join("")}|${index}`,
    actor: view.position,
    actions: view.actions.map((action, a) => ({
      key: action.label,
      label: t.action(action.kind, action.sizePot, action.amount),
      colour: colours[a],
      share: view.totals[a].share,
      combos: view.totals[a].combos,
      ends:
        // A deal stays clickable: it opens the card picker.
        action.ends === "street" ? (dealable(action.deal) ? null : t.panel.showdown) : action.ends ? t.panel.ends[action.ends] : null,
      onPick: () => {
        if (action.child >= 0) onGo(action.child);
        else if (dealable(action.deal)) onDeal(action.deal);
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
      classCombos(chunk, index, k, include).map((combo) => ({
        ...combo,
        cards: `${picked.toPicked(combo.cards.slice(0, 2))}${picked.toPicked(combo.cards.slice(2, 4))}`,
      })),
    note:
      (include ? `${view.reach > 0 ? t.filters.note(view.reach, view.reach / unfiltered) : t.filters.none} ` : "") +
      `${t.rangeValue(view.reach, view.value)} · ${t.solvedTo(chunk.result.exploitabilityPct, chunk.result.iterations)} ${source}${t.flopNote}`,
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

/** Where the walk is: the flop's solve, and on a turn that turn's solve and the flop's deal it came from. */
interface Where {
  flop: FlopChunk;
  turn: FlopChunk | null;
  turnChance: number | null;
  /** A full solve, when one is served: its turn files are picked instead of solving live. */
  full: FullSolve | null;
}

function FlopOverview({
  where,
  index,
  board,
  picked,
  deal,
  onGo,
  onFlop,
  onTurn,
  onChange,
  t,
}: {
  where: Where;
  index: number;
  board: readonly string[];
  picked: PickedFlop;
  deal: number | null;
  onGo: (node: number) => void;
  onFlop: (node: number) => void;
  onTurn: (file: string, node: number) => void;
  onChange: () => void;
  t: Dict;
}) {
  const chunk = where.turn ?? where.flop;
  const view = exploreNode(chunk, index);
  const history = exploreHistory(chunk, index);
  const shown = (card: string) => picked.toPicked(card);
  const label = (step: { position: string; action: { kind: string; sizePot: number; amount: number } }) =>
    t.panel.step(step.position, t.action(step.action.kind, step.action.sizePot, step.action.amount));

  // On a turn: the flop's decisions that led to it, then the turn card.
  let flopSteps: Array<{ node: number; text: string }> = [];
  const chance = where.turnChance;
  if (where.turn && chance !== null) {
    const nodes = where.flop.result.nodes;
    const last = nodes[chance].parent;
    flopSteps = [
      ...exploreHistory(where.flop, last).map((step) => ({ node: step.node, text: label(step) })),
      { node: last, text: label({ position: where.flop.header.players[nodes[last].player], action: exploreNode(where.flop, last).actions[nodes[chance].parentEdge] }) },
    ];
  }
  const river = history.find((step) => step.card)?.card;
  const cards = [...board, ...(where.turn ? [shown(where.turn.result.board[3])] : []), ...(river ? [shown(river)] : [])];

  // The card being picked: the turn (a deal of the flop's solve) or a river (a deal inside the turn file).
  let options: Array<{ card: string; go: () => void }> = [];
  if (deal !== null) {
    if (!where.turn && where.full) {
      const path = where.flop.result.nodes[deal]?.path;
      options = where.full.manifest.turns
        .filter((x) => x.flopPath === path)
        .map((x) => ({ card: x.card, go: () => onTurn(x.file, 0) }));
    } else if (!where.turn) {
      // No full solve: the picked card's turn is solved here.
      options = dealtCards(where.flop, deal).map((x) => ({ card: x.card, go: () => onTurn(`live:${liveTurnId(deal, x.card)}`, 0) }));
    } else {
      options = dealtCards(where.turn, deal)
        .filter((x) => x.node >= 0)
        .map((x) => ({ card: x.card, go: () => onGo(x.node) }));
    }
    options.sort((a, b) => "AKQJT98765432".indexOf(a.card[0]) - "AKQJT98765432".indexOf(b.card[0]) || a.card.localeCompare(b.card));
  }

  return (
    <div className={styles.overview}>
      <div className={styles.boardRow}>
        <CardRow cards={cards} size="sm" />
        <button type="button" className="btn btn--sm" onClick={onChange}>
          {t.flop.change}
        </button>
      </div>
      <p className={styles.overviewTitle}>
        <strong>{t.panel.toAct(view.position)}</strong> <span className={analysis.muted}>{t.panel.pot(view.pot, view.toCall)}</span>
      </p>
      <nav className={styles.history} aria-label={t.panel.history}>
        <button type="button" className={styles.step} disabled={!where.turn && index === 0} onClick={() => onFlop(0)}>
          {t.panel.start}
        </button>
        {flopSteps.map((step) => (
          <span key={`f${step.node}`} className={styles.stepWrap}>
            <span aria-hidden="true">›</span>
            <button type="button" className={styles.step} onClick={() => onFlop(step.node)}>
              {step.text}
            </button>
          </span>
        ))}
        {where.turn ? (
          <span className={styles.stepWrap}>
            <span aria-hidden="true">›</span>
            <button type="button" className={styles.step} disabled={index === 0} onClick={() => onGo(0)}>
              {t.panel.street("turn", shown(where.turn.result.board[3]))}
            </button>
          </span>
        ) : null}
        {history.map((step) => (
          <span key={step.node} className={styles.stepWrap}>
            <span aria-hidden="true">›</span>
            <button type="button" className={styles.step} onClick={() => onGo(step.node)}>
              {label(step)}
            </button>
            {step.card ? (
              <>
                <span aria-hidden="true">›</span>
                <span className={styles.step}>{t.panel.street("river", shown(step.card))}</span>
              </>
            ) : null}
          </span>
        ))}
      </nav>
      {options.length ? (
        <div className={styles.dealRow} role="group" aria-label={t.panel.dealPick(where.turn ? "river" : "turn")}>
          <p className={analysis.muted}>{t.panel.dealPick(where.turn ? "river" : "turn")}</p>
          <div className={styles.dealCards}>
            {options.map((x) => (
              <button key={x.card} type="button" className={styles.dealCard} onClick={x.go} aria-label={shown(x.card)}>
                <CardRow cards={[shown(x.card)]} size="xs" />
              </button>
            ))}
          </div>
          <p className={analysis.muted}>{t.panel.isomorphic}</p>
        </div>
      ) : null}
    </div>
  );
}
