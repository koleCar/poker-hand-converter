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
 * The screen ("Studio", SV-A), top to bottom: the top row (the host's `top`,
 * the table, a copy-link button), the action strip - the whole line as one
 * row of position cards, as a solver's viewer strings it: the preflop cards
 * (folded into one once the flop is reached), then the flop's card and a card
 * per postflop decision, the turn's and the river's cards between them
 * (PreflopBar, PostflopBar); actions are picked there - then the toolbar
 * (`Strategy + EV | Ranges`, the active hand filters, the nodelock slot's
 * tools at its right end), and the decision: the grid and the panel beside
 * it (StrategyView).
 *
 * The turn comes from a full solve's turn file when one is served
 * (fullSolve.ts, local), and otherwise is solved here, in a worker, from the
 * chunk's ranges at the deal (liveTurn.ts): a few seconds, nothing stored.
 *
 * A flop decision has two tabs: the actor's strategy (StrategyView) and both
 * ranges side by side (RangesView, each grid by its own measure). The
 * hand filters (HandFilters) sit in the panel beside either and stay set
 * while the line is walked.
 *
 * Public, like the preflop chart browser: nothing here reads an account. The
 * chunks are the public bucket's, the same files the analysis grades with.
 * The table, the preflop line, the flop and the flop decision live in the
 * address bar (`?set=…&line=…&flop=…&node=…`), so a link lands on the same
 * view.
 */

"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { flopLinesFor } from "../../lib/analysis/flopLibrary";
import { followWalk, parseWalk, type WalkStep } from "../../lib/analysis/solverWalk";
import { preflopChartSet } from "../../lib/chartSet";
import { CHART_SETS, chartSetKind, DEFAULT_CHART_SET, type ChartNode, type ChartSet } from "../../lib/charts";
import {
  classCombos,
  comboIds,
  exploreNode,
  flopCards,
  EMPTY_FILTER,
  filterActive,
  flopFeatures,
  LIVE_TURN,
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
import { ActiveFilters, filterLabel, HandFilters } from "./HandFilters";
import { useSolverHost, type FlopGateAnswer, type NodelockAt, type SolverDict, type StrategyCompare } from "./host";
import { liveTurnCached, liveTurnId, parseLiveTurnId, solveTurnLive } from "./liveTurn";
import { DealPicker, FlopCard, PostflopCards, type Where } from "./PostflopBar";
import { PreflopCards, Strip, TableSelect, type TableOption } from "./PreflopBar";
import { preflopState } from "./preflop";
import { filterMasks, useRangeData, type RangeData } from "./rangeData";
import { DEFAULT_RANGE_MODES, RangesView, type RangeModes } from "./RangesView";
import { actionColours, StrategyView, type StrategyHero, type StrategyModel } from "./StrategyView";
import { IconButton, Segmented } from "./ui";
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
  const { t, loader, fullSolveBase, nodelock, top, side, link, flops: gate, lockedTools } = useSolverHost();
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
  /** What the Ranges tab's grids show, by role: kept as the line is walked. */
  const [rangeModes, setRangeModes] = useState<RangeModes>(DEFAULT_RANGE_MODES);
  /** The preflop cards opened from their summary (the line is at the flop): until the line changes. */
  const [preflopOpen, setPreflopOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
  /** The line ends heads-up on a flop the library has solves for. */
  const lineAtFlop = end?.kind === "flop" && solved.length > 0;
  const flopKey = picked && solved.includes(picked.key) ? picked.key : null;
  const chunkKey = libraryLine && flopKey ? `${setId}/${libraryLine.id}/${flopKey}` : "";

  // Flops a day (the host's `flops`): the flop is asked about before its solve loads.
  const gated = gate !== undefined;
  const gateReady = gate?.ready ?? true;
  const openFlop = gate?.open;
  const [gateAnswer, setGateAnswer] = useState<{ key: string; answer: FlopGateAnswer } | null>(null);
  useEffect(() => {
    if (!gated || !gateReady || !openFlop || !flopKey) return;
    let live = true;
    void openFlop(flopKey).then(
      (answer) => {
        if (live) setGateAnswer({ key: flopKey, answer });
      },
      () => {
        if (live) setGateAnswer({ key: flopKey, answer: "open" });
      },
    );
    return () => {
      live = false;
    };
  }, [gated, gateReady, openFlop, flopKey]);
  const gateNow = gateAnswer && gateAnswer.key === flopKey ? gateAnswer.answer : null;
  /** The flop may load: no gate, or the gate said so. */
  const flopOpen = !gated || (gateReady && gateNow === "open");
  const flopClosed = gated && gateNow !== null && gateNow !== "open" ? gateNow : null;

  // The chunk of the line and the flop.
  useEffect(() => {
    // A chunk is only ever named from the reader's own manifest.
    if (!chunkKey || !libraryLine || !flopKey || !loader || !flopOpen) return;
    let live = true;
    void loader
      .load(setId, libraryLine.id, flopKey)
      .then((value) => {
        if (live) setChunk(value ? { key: chunkKey, status: "ready", value } : { key: chunkKey, status: "error" });
      });
    return () => {
      live = false;
    };
  }, [chunkKey, setId, libraryLine, flopKey, attempt, loader, flopOpen]);

  // A full solve of the flop, when one is served (local).
  useEffect(() => {
    if (!chunkKey || !libraryLine || !flopKey || !flopOpen) return;
    let live = true;
    void loadFullSolve(fullSolveBase, setId, "flop-m1", libraryLine.id, flopKey).then((value) => {
      if (live) setFull({ key: chunkKey, status: "ready", value });
    });
    return () => {
      live = false;
    };
  }, [chunkKey, setId, libraryLine, flopKey, fullSolveBase, flopOpen]);
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
  const view = useMemo<SolverView | null>(
    () =>
      state
        ? {
            set: setId,
            line: state.line,
            flop: flopKey && flop ? flop.join("") : undefined,
            node: flopKey ? nodeIndex : 0,
            turn: flopKey && turn ? turn.replace(/^live:/, "").replace(/^turn\//, "").replace(/\.bin$/, "") : undefined,
          }
        : null,
    [setId, state, flop, flopKey, nodeIndex, turn],
  );
  useEffect(() => {
    if (view && onView && !walkPending) onView(view);
  }, [onView, view, walkPending]);
  const shareLink = view && link ? link(view) : null;
  const copy = () => {
    if (!shareLink) return;
    void navigator.clipboard.writeText(shareLink).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  // A line that ends on a solved flop line with no flop yet asks for one, once.
  const lineKey = `${setId}|${line}`;
  const pickerOpen = solved.length > 0 && (picker || (!flopKey && dismissed !== lineKey));
  const closePicker = () => {
    setPicker(false);
    setDismissed(lineKey);
  };
  /** The strip's box and its flop card: the picker opens under the card, and a click on the card is not outside it. */
  const stripBox = useRef<HTMLDivElement>(null);
  const flopAnchor = useRef<HTMLElement | null>(null);
  const [pickerLeft, setPickerLeft] = useState(0);
  useLayoutEffect(() => {
    if (!pickerOpen) return;
    const box = stripBox.current;
    const card = box?.querySelector<HTMLElement>("[data-flop]") ?? null;
    flopAnchor.current = card;
    if (box && card) setPickerLeft(card.getBoundingClientRect().left - box.getBoundingClientRect().left);
  }, [pickerOpen]);

  /** A flop picked (the picker, or one of today's flops reopened): its first decision. */
  const pickFlop = (cards: string[]) => {
    setWalk(null);
    setFlop(cards);
    setTurn(null);
    setDeal(null);
    setPath(null);
    setNode(0);
  };
  /** One of today's flops (any suits), on this line: null when the line has no solve of it. */
  const reopen = (key: string) => {
    const cards = flopCards(key);
    return lineAtFlop && solved.includes(pickedFlop(cards).key) ? () => pickFlop(cards) : null;
  };

  const goLine = (next: string) => {
    setPreflopOpen(false);
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
  const flopPot = flopSolve ? exploreNode(flopSolve, 0).pot : null;
  const flopCard = lineAtFlop ? (
    <FlopCard
      board={flopKey && flop ? flop : null}
      pot={flopKey ? flopPot : null}
      onChange={() => (pickerOpen ? closePicker() : setPicker(true))}
      t={t}
    />
  ) : null;
  let postflop: ReactNode = flopCard;
  /** The turn's (or the river's) cards to pick from, under the strip. */
  let dealPicker: ReactNode = null;
  /** The row between the strip and the decision: the tabs, the active filters, the nodelock's tools. */
  let toolbar: ReactNode = null;

  let body: ReactNode;
  if (!state || !manifest) {
    body = <RailLoader label={t.loadingLibrary} showLabel centered />;
  } else if (looked ?? state.node) {
    // A past decision looked back at, else the one to make. Its actions are picked on the bar.
    const shown = looked ?? state.node!;
    const model = preflopModel(shown, looked ? viewing! : state.line, t);
    body = (
      <StrategyView
        model={model}
        hero={hero}
        overview={<Overview actor={shown.actor} pot={shown.potBb} toCall={Math.max(0, shown.toMatchBb - shown.inBb)} t={t} />}
      />
    );
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
      <div className={styles.empty}>
        <button type="button" className={styles.link} onClick={() => setPicker(true)}>
          {t.flop.pick}
        </button>
      </div>
    );
  } else if (flopClosed && gate) {
    // Not opened (today's flops are used, or the visitor must sign in): the host says so, small.
    body = gate.closed(flopClosed, flopKey);
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
    const model = flopModel(solve, nodeIndex, picked, t, include, rangeData, masks);
    // The app's lock marks (§7.3): on the flop's decisions and a live turn's; the web sets none.
    const marks = nodelock?.lockMark && librarySolve && (!turn || live) ? { library: librarySolve, turn: live ? { chance: live.chance, card: live.card } : null } : null;
    const mark = marks && nodelock?.lockMark ? nodelock.lockMark({ ...marks, flop: flopSolve, chunk: solve, node: nodeIndex, picked }) : null;
    postflop = (
      <>
        {postflop}
        <PostflopCards
          where={where}
          index={nodeIndex}
          deal={shownDeal}
          picked={picked}
          moves={{ flopNode: goFlop, flopDeal: goFlopDeal, node: goNode, deal: goDeal, changeFlop: () => setPicker(true) }}
          marks={marks}
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
    const compare = at?.locked && nodelock?.compare ? compareWith(at, chunkKey, include, nodelock.compareLabel, nodelock.shareDelta, t) : null;
    const ranges = tab === "ranges" && rangeData;
    toolbar = (
      <div className={styles.tools}>
        <Segmented
          tabs
          label={t.tabs.label}
          value={tab}
          options={(["strategy", "ranges"] as const).map((x) => ({ value: x, label: t.tabs[x] }))}
          onChange={(x) => {
            setTab(x);
            setSwappedAt(model.id);
          }}
        />
        <ActiveFilters filter={filter} onFilter={setFilter} />
        <span className={styles.spacer} />
        {at && nodelock ? nodelock.nodeAction(at) : null}
        {nodelock?.tabTools ? nodelock.tabTools(at) : null}
        {nodelock ? null : lockedTools}
      </div>
    );
    const decision = exploreNode(solve, nodeIndex);
    body = (
      <StrategyView
        model={model}
        compare={compare}
        actionMark={mark ? (key) => (mark.actions.has(key) ? mark.render(key) : null) : undefined}
        hero={hero}
        main={ranges ? (onHand) => <RangesView data={rangeData} masks={masks} strategy={model} modes={rangeModes} onModes={setRangeModes} onHand={onHand} /> : undefined}
        empty={
          include && filterActive(filter) && (model.reach ?? 1) <= 0 ? (
            <div className={styles.empty}>
              <p>{t.filters.none(model.actor)}</p>
              <button type="button" className={styles.link} onClick={() => setFilter(EMPTY_FILTER)}>
                {t.filters.clearFilter}
              </button>
            </div>
          ) : undefined
        }
        fade={swappedAt === model.id}
        filters={<HandFilters data={rangeData} filter={filter} onFilter={setFilter} colours={model.actions.map((a) => a.colour)} />}
        overview={<Overview actor={decision.position} pot={decision.pot} toCall={decision.toCall} t={t} />}
      />
    );
  } else if (live) {
    // The turn is being solved here: the strip runs to the turn's card with the progress, the solve's card below.
    const shown = progress?.key === turnKey ? progress : null;
    const share = shown
      ? Math.min(0.99, Math.max(shown.iteration / LIVE_TURN.maxIterations, shown.exploitabilityPct ? LIVE_TURN.targetPct / shown.exploitabilityPct : 0))
      : 0;
    const card = picked ? picked.toPicked(live.card) : live.card;
    if (flopSolve && picked && flopSolve.result.nodes[live.chance]?.kind === "chance") {
      const where: Where = { flop: flopSolve, turn: null, turnChance: null, full: null };
      postflop = (
        <>
          {postflop}
          <PostflopCards
            where={where}
            index={flopSolve.result.nodes[live.chance].parent}
            deal={live.chance}
            picked={picked}
            moves={{ flopNode: goFlop, flopDeal: goFlopDeal, node: goFlop, deal: goFlopDeal, changeFlop: () => setPicker(true) }}
            marks={nodelock?.lockMark && librarySolve ? { library: librarySolve, turn: null } : null}
            solving={{ card, share }}
            t={t}
          />
        </>
      );
    }
    body = (
      <div className={styles.solve} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        <strong className={styles.solveTitle}>
          {t.solving.title("turn")} · <CardRow cards={[card]} size="xs" />
        </strong>
        <span className={styles.solveBar} aria-hidden="true">
          <span style={{ inlineSize: `${Math.round(share * 100)}%` }} />
        </span>
        <span className={styles.solveLine}>{t.solving.progress(shown?.iteration ?? 0, shown?.exploitabilityPct ?? null)}</span>
        <span className={styles.solveNote}>{t.solving.note}</span>
      </div>
    );
  } else {
    // The flop's (or the turn's) solve is downloading.
    body = <RailLoader label={t.loadingSolve} showLabel centered />;
  }

  return (
    <div className={styles.solver}>
      <div className={styles.top}>
        {top}
        <TableSelect
          tables={TABLES}
          table={table}
          onTable={(id) => {
            setSetId(id);
            goLine("");
          }}
        />
        <span className={styles.spacer} />
        {gate?.today ? gate.today(reopen) : null}
        {shareLink ? (
          <IconButton label={copied ? t.top.copied : t.top.link} onClick={copy}>
            <Icon name={copied ? "check" : "link"} />
          </IconButton>
        ) : null}
      </div>
      <div className={styles.stripBox} ref={stripBox}>
        <Strip label={t.preflop.label}>
          <PreflopCards
            state={state}
            onLine={goLine}
            viewing={looked ? viewing : null}
            onView={setViewing}
            folded={lineAtFlop && !preflopOpen && !looked}
            onUnfold={() => setPreflopOpen(true)}
          />
          {postflop}
        </Strip>
        {pickerOpen ? (
          <FlopPicker
            onClose={closePicker}
            solved={solved}
            current={flopKey ? flop : null}
            anchor={flopAnchor}
            left={pickerLeft}
            onPick={(cards) => {
              pickFlop(cards);
              closePicker();
            }}
          />
        ) : null}
      </div>
      {dealPicker}
      {nodelock ? nodelock.banner(at) : null}
      {toolbar}
      {side ? (
        <div className={styles.withSide}>
          {side}
          <div className={styles.withSideMain}>{body}</div>
        </div>
      ) : (
        body
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the models - */

/** Combos of a grid class: 6 of a pair, 4 suited, 12 offsuit. */
function classSize(name: string): number {
  return name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12;
}

/** Each action's EV over the hands that take it: their weight times the frequency, the class's EV for the action. */
function actionEvs(actions: number, classes: ReadonlyArray<{ weight: number; freq: readonly number[]; ev: readonly number[] }>): Array<number | null> {
  return Array.from({ length: actions }, (_, a) => {
    let weight = 0;
    let sum = 0;
    for (const c of classes) {
      const w = c.weight * (c.freq[a] ?? 0);
      if (w <= 0 || !Number.isFinite(c.ev[a])) continue;
      weight += w;
      sum += w * c.ev[a];
    }
    return weight > 1e-9 ? sum / weight : null;
  });
}

function preflopModel(node: ChartNode, line: string, t: Dict): StrategyModel {
  const classes = node.range.length;
  const totals = actionTotals(node);
  const played = playedOptions(node);
  const colours = actionColours(node.options.map((o) => ({ kind: o.action, amount: o.toBb })));
  const evs = actionEvs(
    node.options.length,
    GRID_CELLS.map((cell) => ({
      weight: node.range[cell.index] * classSize(cell.name),
      freq: node.options.map((_, a) => node.freq[a * classes + cell.index]),
      ev: node.options.map((_, a) => node.ev[a * classes + cell.index]),
    })),
  );
  return {
    id: `pre|${line}`,
    actor: node.actor,
    actions: node.options.map((option, a) => ({
      key: option.code,
      label: t.preflop.action(option.action, option.toBb),
      short: t.short(option.action, 0, option.toBb),
      colour: colours[a],
      kind: option.action,
      amount: option.toBb,
      share: totals[a].share,
      combos: totals[a].combos,
      ev: evs[a],
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
  ranges?: RangeData | null,
  masks?: [Uint8Array, Uint8Array] | null,
): StrategyModel {
  const view = exploreNode(chunk, index, include);
  const whole = include ? exploreNode(chunk, index) : view;
  const colours = actionColours(view.actions);
  const evs = actionEvs(view.actions.length, view.classes);
  return {
    id: `flop|${chunk.header.line}|${chunk.header.flop}|${chunk.result.board.join("")}|${index}`,
    actor: view.position,
    reach: view.reach,
    board: chunk.result.board.map((card) => picked.toPicked(card)),
    category: ranges ? (k) => classCategory(ranges, masks ?? null, k, t) : undefined,
    actions: view.actions.map((action, a) => ({
      key: action.label,
      label: t.action(action.kind, action.sizePot, action.amount),
      short: t.short(action.kind, action.sizePot, action.amount),
      colour: colours[a],
      kind: action.kind,
      amount: action.amount,
      size: action.kind === "bet" ? t.zoom.size(action.amount) : null,
      share: view.totals[a].share,
      combos: view.totals[a].combos,
      ev: evs[a],
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
 * own live turn when it was solved this session. Null when there is none.
 *
 * Actions pair by their tree label: a lock that took an action away (its own
 * sizes, §8) lists GTO's as `missing`, a size of its own has no GTO share.
 */
function compareWith(
  at: NodelockAt,
  chunkKey: string,
  include: Uint8Array | undefined,
  label: string,
  shareDelta: (delta: number) => string,
  t: Dict,
): StrategyCompare | null {
  const base = at.turn ? liveTurnCached(chunkKey, at.turn.chance, at.turn.card) : at.library;
  if (!base) return null;
  const shown = at.chunk.result.nodes[at.node];
  const index = nodeAt(base.result, shown.path);
  const node = base.result.nodes[index];
  if (!node || node.kind !== "action" || shown.kind !== "action" || node.player !== shown.player) return null;
  const player = shown.player as 0 | 1;

  // The same hands in both solves, matched by combo (a range lock may leave some out).
  const handsHere = at.chunk.result.hands[player];
  const handsBase = base.result.hands[player];
  const inBase = new Map<number, number>();
  handsBase.forEach((combo, j) => inBase.set(combo, j));
  const toBase = Array.from(handsHere, (combo) => inBase.get(combo) ?? -1);
  let baseInclude: Uint8Array | undefined;
  if (include) {
    baseInclude = new Uint8Array(handsBase.length);
    toBase.forEach((j, i) => {
      if (j >= 0) baseInclude![j] = include[i];
    });
  }
  const view = exploreNode(base, index, baseInclude);

  const baseLabels = node.labels;
  const shares = shown.labels.map((key) => {
    const a = baseLabels.indexOf(key);
    return a >= 0 ? view.totals[a].share : null;
  });
  const colours = actionColours(view.actions);
  const missing = view.actions
    .map((action, a) => ({ action, a }))
    .filter(({ action, a }) => !shown.labels.includes(action.label) && view.totals[a].share > 0)
    .map(({ action, a }) => ({
      key: action.label,
      label: t.action(action.kind, action.sizePot, action.amount),
      colour: colours[a],
      share: view.totals[a].share,
    }));

  return {
    label,
    shareDelta,
    shares,
    missing,
    classes: view.classes.map((c) => ({ freq: c.freq, ev: c.ev, value: c.value })),
  };
}

/**
 * What a class makes on the board, as most of its combos at the decision
 * do (the acting player's, through the hand filter): a made-hand label.
 */
function classCategory(data: RangeData, masks: [Uint8Array, Uint8Array] | null, k: number, t: Dict): string | null {
  const p = data.ranges.actor;
  const side = data.ranges.sides[p];
  const weights = new Map<string, number>();
  for (const i of data.byClass[p][k]) {
    const r = masks && !masks[p][i] ? 0 : side.reach[i];
    if (r <= 0) continue;
    const made = comboIds(data.cards[p][i], data.features[p][i], data.equity ? data.equity[p][i] : Number.NaN).find((id) => id.startsWith("made:"));
    if (made) weights.set(made, (weights.get(made) ?? 0) + r);
  }
  let best: string | null = null;
  for (const [id, w] of weights) if (best === null || w > weights.get(best)!) best = id;
  return best ? filterLabel(best, t) : null;
}

/* ---------------------------------------------------------- the overview - */

/** The panel's first line: who acts and the pot. The line itself is on the strip. */
function Overview({ actor, pot, toCall, t }: { actor: string; pot: number; toCall: number; t: Dict }) {
  return (
    <p className={styles.over}>
      <strong>{t.panel.toAct(actor)}</strong>
      <span>{t.panel.pot(pot, toCall)}</span>
    </p>
  );
}
