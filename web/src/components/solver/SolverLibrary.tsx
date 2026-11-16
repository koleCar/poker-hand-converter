/**
 * The Solver library (`/solver`): the preflop chart sets (GTO Wizard
 * solutions, transcribed) and the flop library solved on them, browsed the
 * way a solver's viewer shows them.
 *
 * ```
 * a table (format × players × stack depth: every set `CHART_SETS` holds)
 *   ─▶ the preflop line, a card per decision (PreflopBar): each decision is the chart node's grid (lib/charts);
 *      a past decision's card shows its grid again
 *   ─▶ preflop only where the flop library has no solve on the set (none since analysis/41)
 *   ─▶ the line ends heads-up on a library line ─▶ a flop (FlopPicker; any suits, the library files canonical flops)
 *   ─▶ the chunk (`FlopLibraryLoader.load`, the analysis' own reader) ─▶ a flop decision (`exploreNode`)
 *   ─▶ an action ─▶ the next flop decision, until the flop's betting is over
 *   ─▶ a turn card ─▶ the turn's decisions ─▶ a river card ─▶ the river's
 * ```
 *
 * The whole line is one bar, as a solver's viewer strings it: the preflop
 * cards, then the flop's card and a card per postflop decision, the turn's
 * and the river's cards between them (PostflopBar). Actions are picked there;
 * the action boxes beside the grid only show the mix.
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
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { flopLinesFor } from "../../lib/analysis/flopLibrary";
import { followWalk, parseWalk, type WalkStep } from "../../lib/analysis/solverWalk";
import { preflopChartSet } from "../../lib/chartSet";
import { CHART_SETS, chartSetKind, DEFAULT_CHART_SET, type ChartNode, type ChartSet } from "../../lib/charts";
import {
  classCombos,
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
import { actionTotals, GRID_CELLS, OFF_RANGE_WEIGHT, playedOptions } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import { FlopPicker } from "./FlopPicker";
import { loadFullSolve, type FullSolve } from "./fullSolve";
import { HandFilters } from "./HandFilters";
import { useSolverHost, type NodelockAt, type SolverDict, type StrategyCompare } from "./host";
import { liveTurnCached, liveTurnId, parseLiveTurnId, solveTurnLive } from "./liveTurn";
import { DealPicker, FlopCard, PostflopCards, type Where } from "./PostflopBar";
import { PreflopBar, type TableOption } from "./PreflopBar";
import { preflopState } from "./preflop";
import { filterMasks, useRangeData } from "./rangeData";
import { RangesView } from "./RangesView";
import { actionColours, StrategyView, type StrategyHero, type StrategyModel } from "./StrategyView";
import styles from "./solver.module.css";

type Dict = SolverDict;

/**
 * The chart sets offered, in `CHART_SETS`' order: every set Rail ships. A set
 * the flop library has no manifest for (none since analysis/41) is preflop
 * only, and says so where a line reaches the flop.
 */
export const SOLVER_SETS: readonly string[] = CHART_SETS.map((spec) => spec.id);

const TABLES: readonly TableOption[] = CHART_SETS.map((spec) => ({
  id: spec.id,
  players: spec.players,
  stackBb: spec.stackBb,
  format: chartSetKind(spec),
}));

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
  /**
   * A hand's line to a decision (`lib/analysis/solverWalk.ts`), in place of
   * `initialNode` and `initialTurn`: followed through the flop's solve, and
   * on to the turn it deals and that turn's river, as far as the trees go.
   */
  initialWalk?: string | null;
  /** Hears the view as it changes - the web keeps it in the address bar, the app in its route. */
  onView?: (view: SolverView) => void;
  /** The hero's hand, when the view comes from one of their decisions: marked in the grid where they act. */
  hero?: StrategyHero | null;
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
  const { t } = useSolverHost();
  if (!SOLVER_SETS.length) return <p className={analysis.muted}>{t.unavailable}</p>;
  // Without a flop library reader the preflop charts still show: every line is preflop only.
  return <Browser {...props} />;
}

function Browser({ initialSet, initialLine, initialFlop, initialNode, initialTurn, initialPath, initialWalk, onView, hero = null }: SolverLibraryProps) {
  const { t, loader, fullSolveBase, nodelock } = useSolverHost();
  const [setId, setSetId] = useState<string>(
    initialSet && SOLVER_SETS.includes(initialSet) ? initialSet : SOLVER_SETS.includes(DEFAULT_CHART_SET) ? DEFAULT_CHART_SET : SOLVER_SETS[0],
  );
  const [line, setLine] = useState(initialLine ?? "");
  const [flop, setFlop] = useState<string[] | null>(initialFlop ? flopCards(initialFlop) : null);
  const [node, setNode] = useState(initialNode ?? 0);
  /** A flop decision named by its path, read once the flop's solve is in (`initialPath`). */
  const [path, setPath] = useState(initialPath ?? null);
  /** A hand's line being followed (`initialWalk`): the turn and the decision are read off it until the walk moves on. */
  const [walk, setWalk] = useState<WalkStep[] | null>(() => parseWalk(initialWalk));
  const [picker, setPicker] = useState(false);
  /** The line whose automatic flop prompt was closed: it does not come back for that line. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [charts, setCharts] = useState<Loaded<ChartSet>>({ key: "", status: "loading" });
  const [entries, setEntries] = useState<Loaded<Map<string, string[]>>>({ key: "", status: "loading" });
  const [chunk, setChunk] = useState<Loaded<FlopChunk>>({ key: "", status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [full, setFull] = useState<Loaded<FullSolve | null>>({ key: "", status: "loading" });
  /** The turn being walked - a full solve's file (`turn/X-X~Kd.bin`) or a live turn (`live:12~Kd`) - or null on the flop. */
  const [pickedTurn, setTurn] = useState<string | null>(
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
  /** A past preflop decision the grid shows instead of the line's own (its line), set by clicking its card. */
  const [viewing, setViewing] = useState<string | null>(null);

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
    void (loader ? loader.listed(setId) : Promise.resolve([] as Array<{ line: string; flop: string }>))
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
    // A chunk is only ever named from the reader's own manifest.
    if (!chunkKey || !libraryLine || !flopKey || !loader) return;
    let live = true;
    void loader
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
  /** The app's nodelock: a locked solution of this flop shown in place of the library's (never on the web). */
  const override = chunkKey && nodelock?.override?.key === chunkKey ? nodelock.override : null;
  const fullReady = full.key === chunkKey && full.status === "ready";
  const fullSolve = fullReady && !override ? full.value : null;
  const librarySolve = chunk.key === chunkKey && chunk.status === "ready" ? chunk.value : null;
  const shownFlop = override?.flop ?? librarySolve;
  /** Without a full solve, turns are solved live from the library's chunk (or the locked one). */
  const liveBase = fullReady && !fullSolve ? shownFlop : null;
  const flopSolve = fullSolve?.flop ?? shownFlop;
  /** Turns solved live from a locked flop are kept apart from the library's. */
  const liveKey = override?.flop ? `${chunkKey}#${override.id}` : chunkKey;

  // A hand's line: followed on the flop's solve, then onto the turn its deal deals - a full solve's file, or solved live.
  const flopWalk = useMemo(() => (walk && flopSolve && picked ? followWalk(flopSolve, walk, picked.perm) : null), [walk, flopSolve, picked]);
  const walkTurn = useMemo(() => {
    if (!flopWalk?.card || flopWalk.deal === null || !flopSolve || !fullReady) return null;
    if (fullSolve) {
      const at = flopSolve.result.nodes[flopWalk.deal].path;
      return fullSolve.manifest.turns.find((x) => x.flopPath === at && x.card === flopWalk.card)?.file ?? null;
    }
    // An all-in on the flop: nothing left to solve.
    return turnDeal(flopSolve, flopWalk.deal) ? `live:${liveTurnId(flopWalk.deal, flopWalk.card)}` : null;
  }, [flopWalk, flopSolve, fullReady, fullSolve]);
  const turn = walk ? walkTurn : pickedTurn;
  const live = useMemo(() => (turn?.startsWith("live:") ? parseLiveTurnId(turn.slice(5)) : null), [turn]);
  /** A turn (or river) lock's solve, in place of this live turn. */
  const lockedTurn = live && override?.turn?.id === liveTurnId(live.chance, live.card) ? override.turn.chunk : null;

  const turnKey = turn && (live ? liveBase : fullSolve) ? `${liveKey}/${turn}` : "";
  useEffect(() => {
    if (!turnKey || !turn || lockedTurn) return;
    let alive = true;
    let request: Promise<FlopChunk | null>;
    if (live && liveBase) {
      request = solveTurnLive(liveKey, liveBase, live.chance, live.card, (p) => {
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
  }, [turnKey, turn, live, liveBase, fullSolve, liveKey, lockedTurn, attempt]);
  const turnSolve = lockedTurn ?? (turnChunk.key === turnKey && turnChunk.status === "ready" ? turnChunk.value : null);
  const turnWalk = useMemo(
    () => (walk && turn && turnSolve && flopWalk?.card ? followWalk(turnSolve, flopWalk.rest, flopWalk.perm) : null),
    [walk, turn, turnSolve, flopWalk],
  );
  /** The walk is still waiting on a solve: the flop's, the full solve's word on the turn, or the turn's. */
  const walkPending = walk !== null && (!flopWalk || (flopWalk.card !== null && !fullReady) || (turn !== null && !turnWalk));
  const walkEnd = walk && !walkPending ? (turn ? turnWalk : flopWalk) : null;

  const solve = turn ? turnSolve : flopSolve;
  // A decision named by its path (a hand's analysis) until the walk moves on.
  const pathNode = path && flopSolve && !turn ? nodeAt(flopSolve.result, path) : -1;
  const wanted = walkEnd ? walkEnd.node : pathNode >= 0 ? pathNode : node;
  const nodeIndex = solve && solve.result.nodes[wanted]?.kind === "action" ? wanted : 0;
  // A walk that ends at a deal opens its card picker - the turn's only when there is a turn to solve.
  const walkDeal = walkEnd?.deal ?? null;
  const shownDeal = walkEnd
    ? walkDeal !== null && (turn || (flopSolve && turnDeal(flopSolve, walkDeal))) ? walkDeal : null
    : deal;
  const rangeData = useRangeData(solve, nodeIndex, picked);
  const masks = useMemo(() => filterMasks(rangeData, filter), [rangeData, filter]);
  /** The walk's view becomes the browser's own once the reader moves from it. */
  const settle = () => {
    if (!walk) return;
    setTurn(turn);
    setNode(nodeIndex);
    setDeal(shownDeal);
    setWalk(null);
  };
  const goNode = (next: number) => {
    settle();
    setPath(null);
    setDeal(null);
    setNode(next);
  };
  const goFlop = (next: number) => {
    goNode(next);
    setTurn(null);
  };
  /** A deal of the shown solve (from decision `from`): its card is picked. */
  const goDeal = (from: number, chance: number) => {
    settle();
    setPath(null);
    setNode(from);
    setDeal(chance);
  };
  /** The flop's deal, from a turn too: the turn card is (re)picked. */
  const goFlopDeal = (from: number, chance: number) => {
    goDeal(from, chance);
    setTurn(null);
  };

  // The view, for the host to keep (the web's address bar), so a link lands here.
  useEffect(() => {
    if (!state || !onView || walkPending) return;
    onView({
      set: setId,
      line: state.line,
      flop: flopKey && flop ? flop.join("") : undefined,
      node: flopKey ? nodeIndex : 0,
      turn: flopKey && turn ? turn.replace(/^live:/, "").replace(/^turn\//, "").replace(/\.bin$/, "") : undefined,
    });
  }, [onView, setId, state, flop, flopKey, nodeIndex, turn, walkPending]);

  // A line that ends on a solved flop line with no flop yet asks for one, once.
  const lineKey = `${setId}|${line}`;
  const pickerOpen = solved.length > 0 && (picker || (!flopKey && dismissed !== lineKey));
  const closePicker = () => {
    setPicker(false);
    setDismissed(lineKey);
  };

  const goLine = (next: string) => {
    setViewing(null);
    setWalk(null);
    setLine(next);
    setFlop(null);
    setTurn(null);
    setDeal(null);
    setPath(null);
    setNode(0);
  };

  const looked = viewing !== null ? (state?.cards.find((c) => c.kind === "past" && c.line === viewing)?.node ?? null) : null;

  // The nodelock slot (the app only): where the view is, on a library flop decision or a live turn's.
  const at: NodelockAt | null =
    nodelock && state && solve && picked && flop && librarySolve && libraryLine && flopKey && (!turn || live) && !(looked ?? state.node)
      ? {
          set: setId,
          line: libraryLine.id,
          flop: flopKey,
          preflop: state.line,
          picked,
          board: live ? [...flop, picked.toPicked(live.card)] : flop,
          library: librarySolve,
          chunk: solve,
          node: nodeIndex,
          turn: live ? { chance: live.chance, card: live.card } : null,
          locked: Boolean(override && (live ? lockedTurn || override.flop : override.flop)),
        }
      : null;

  // The line after preflop, on the same bar: the flop's card (or the prompt to pick one), then its decisions, the turn's, the river's.
  const lineAtFlop = end?.kind === "flop" && solved.length > 0;
  const flopPot = flopSolve ? exploreNode(flopSolve, 0).pot : null;
  let postflop: ReactNode = lineAtFlop ? (
    <FlopCard board={flopKey && flop ? flop : null} pot={flopKey ? flopPot : null} onChange={() => setPicker(true)} t={t} />
  ) : null;
  /** The turn's (or the river's) cards to pick from, under the bar. */
  let dealPicker: ReactNode = null;

  let body: ReactNode;
  if (!state || !manifest) {
    body = <RailLoader label={t.loadingLibrary} showLabel centered />;
  } else if (looked ?? state.node) {
    // A past decision looked back at, else the one to make. Its actions are picked on the bar.
    const shown = looked ?? state.node!;
    const model = preflopModel(shown, looked ? viewing! : state.line, t);
    body = <StrategyView model={model} hero={hero} overview={<PreflopOverview node={shown} t={t} />} />;
  } else if (end?.kind === "folded") {
    body = <p className={styles.message}>{t.preflop.folded(end.winner)}</p>;
  } else if (end?.kind === "uncaptured") {
    body = <p className={styles.message}>{t.preflop.uncaptured}</p>;
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
  } else if ((chunk.key === chunkKey && chunk.status === "error" && !fullSolve) || (turn && !lockedTurn && turnChunk.key === turnKey && turnChunk.status === "error")) {
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
    const model = flopModel(solve, nodeIndex, picked, t, include);
    postflop = (
      <>
        {postflop}
        <PostflopCards
          where={where}
          index={nodeIndex}
          deal={shownDeal}
          picked={picked}
          moves={{ flopNode: goFlop, flopDeal: goFlopDeal, node: goNode, deal: goDeal, changeFlop: () => setPicker(true) }}
          t={t}
        />
      </>
    );
    if (shownDeal !== null) {
      dealPicker = (
        <DealPicker
          where={where}
          deal={shownDeal}
          picked={picked}
          onTurn={(file) => {
            goNode(0);
            setTurn(file);
          }}
          onNode={goNode}
          t={t}
        />
      );
    }
    const compare = at?.locked && nodelock?.compare ? compareWith(at, chunkKey, include, nodelock.compareLabel, nodelock.shareDelta) : null;
    body = (
      <StrategyView
        model={model}
        compare={compare}
        hero={hero}
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
        main={tab === "ranges" && rangeData ? (onHand) => <RangesView data={rangeData} masks={masks} strategy={model} onHand={onHand} /> : undefined}
        fade={swappedAt === model.id}
        filters={<HandFilters data={rangeData} filter={filter} onFilter={setFilter} colours={model.actions.map((a) => a.colour)} />}
        overview={<FlopOverview chunk={solve} index={nodeIndex} action={at && nodelock ? nodelock.nodeAction(at) : null} t={t} />}
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
        viewing={looked ? viewing : null}
        onView={setViewing}
        after={postflop}
      />
      {dealPicker}
      {nodelock ? nodelock.banner(at) : null}
      {body}
      {pickerOpen ? (
        <FlopPicker
          open
          onClose={closePicker}
          solved={solved}
          current={flopKey ? flop : null}
          onPick={(cards) => {
            setWalk(null);
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

function preflopModel(node: ChartNode, line: string, t: Dict): StrategyModel {
  const classes = node.range.length;
  const totals = actionTotals(node);
  const played = playedOptions(node);
  const colours = actionColours(node.options.map((o) => ({ kind: o.action, amount: o.toBb })));
  return {
    id: `pre|${line}`,
    actor: node.actor,
    actions: node.options.map((option, a) => ({
      key: option.code,
      label: t.preflop.action(option.action, option.toBb),
      colour: colours[a],
      share: totals[a].share,
      combos: totals[a].combos,
      hidden: !played[a],
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
      };
    }),
  };
}

function flopModel(
  chunk: FlopChunk,
  index: number,
  picked: PickedFlop,
  t: Dict,
  include?: Uint8Array,
): StrategyModel {
  const view = exploreNode(chunk, index, include);
  const whole = include ? exploreNode(chunk, index) : view;
  const colours = actionColours(view.actions);
  return {
    id: `flop|${chunk.header.line}|${chunk.header.flop}|${chunk.result.board.join("")}|${index}`,
    actor: view.position,
    actions: view.actions.map((action, a) => ({
      key: action.label,
      label: t.action(action.kind, action.sizePot, action.amount),
      colour: colours[a],
      share: view.totals[a].share,
      combos: view.totals[a].combos,
      // Judged on the whole range: a hand filter never hides an action.
      hidden: whole.totals[a].combos < 0.5,
    })),
    classes: GRID_CELLS.map((cell) => {
      const c = view.classes[cell.index];
      return {
        state: c.combos === 0 ? "absent" : c.weight === 0 ? "faint" : "in",
        fill: c.combos > 0 ? Math.min(1, c.weight / c.combos) : 0,
        freq: c.freq,
        ev: c.ev,
        value: c.value,
      };
    }),
    combos: (k) =>
      classCombos(chunk, index, k, include).map((combo) => ({
        ...combo,
        cards: `${picked.toPicked(combo.cards.slice(0, 2))}${picked.toPicked(combo.cards.slice(2, 4))}`,
      })),
  };
}

/**
 * GTO at the decision a locked solution shows (the app's nodelock compare):
 * the library's flop decision on the same path, or on a turn the library's
 * own live turn when it was solved this session. Null when there is none, or
 * the trees differ.
 */
function compareWith(
  at: NodelockAt,
  chunkKey: string,
  include: Uint8Array | undefined,
  label: string,
  shareDelta: (delta: number) => string,
): StrategyCompare | null {
  const base = at.turn ? liveTurnCached(chunkKey, at.turn.chance, at.turn.card) : at.library;
  if (!base) return null;
  const shown = at.chunk.result.nodes[at.node];
  const index = nodeAt(base.result, shown.path);
  const node = base.result.nodes[index];
  if (!node || node.kind !== "action" || node.actions.length !== shown.actions.length) return null;
  const sameHands = base.result.hands[node.player].length === at.chunk.result.hands[shown.player].length;
  const view = exploreNode(base, index, sameHands ? include : undefined);
  return {
    label,
    shareDelta,
    shares: view.totals.map((x) => x.share),
    classes: view.classes.map((c) => ({ freq: c.freq, ev: c.ev, value: c.value })),
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

/** The decision shown: who acts, the pot, and the app's Nodelock action. The line itself is on the bar. */
function FlopOverview({ chunk, index, action, t }: { chunk: FlopChunk; index: number; action: ReactNode; t: Dict }) {
  const view = exploreNode(chunk, index);
  return (
    <div className={styles.overview}>
      <div className={styles.overviewHead}>
        <p className={styles.overviewTitle}>
          <strong>{t.panel.toAct(view.position)}</strong> <span className={analysis.muted}>{t.panel.pot(view.pot, view.toCall)}</span>
        </p>
        {action}
      </div>
    </div>
  );
}
