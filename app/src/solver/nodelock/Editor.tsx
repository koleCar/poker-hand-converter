/**
 * The nodelock editor (`docs/NODELOCK.md` §5.2), in the Solver library's
 * look ("Studio", SV-A; NE-A): over the library under its action strip, so
 * the line being locked stays in view above it.
 *
 * ```
 * ┌ [Ranges] ···························· 312 of 1,081 locked  ↶ ↷ Reset × ┐
 * │ [Range | Hand classes | Combos] ··· Lock all … │ [Range | Hands | Hand classes] │
 * │ the range's mix, GTO's ticks                   │ an action per row: a slider    │
 * │ 13×13 grid (paint, locked edges)               │ with GTO's tick, the typed %,  │
 * │ or the classes, or one hand's combos           │ hold; Suggestions              │
 * ├ Earlier nodes [..] · Accuracy [..] · the plan, the engine · ≈ time [Solve] ┤
 * ```
 *
 * The head names no decision: the library's action strip above says which
 * one it is, and on which flop (#409).
 *
 * The state is `editor/state.ts`'s reducer; this file draws it and turns the
 * clicks into its steps. Solving hands the lock to `session.ts`.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { ComboCards, GridZoom, aggressiveFirst, zoomAnchor, type ZoomAction, type ZoomAnchor, type ZoomCombo } from "@rail/ui/charts/ComboZoom";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useLocale, useT } from "../../i18n";
import { go } from "../../lib/router";
import {
  actionColours,
  availableArchetypes,
  cardIndex,
  DRAWS,
  HAND_CLASSES,
  IconButton,
  liveTurnId,
  LockGlyph,
  MADE_HANDS,
  MixBar,
  nodelockSuggestEn,
  nodelockSuggestHr,
  Segmented,
  solverStyles,
  suggestLocks,
  ToolButton,
  handsRange,
  type Archetype,
  type NodelockSuggestion,
  type SolverDict,
} from "../door";
import type { LockEarlier, LockSet, NodelockSummary, RangeLock, RangeShift } from "./contract";
import { actionsFromLabels, carryStrategy, isLibrary, passiveActions, sizeAction, sortActions, withActions } from "./editor/sizes";
import { editorReducer, fromLockArrays, initialState, lockedCount, sameStrategy, sharesOf, strategyToSolve, type EditorAction, type EditorState } from "./editor/state";
import { initialRangeEdit, rangeEditLocks, rangeEditReducer, rangeShifts, shiftPp } from "./editor/ranges";
import { engineInfo, type EngineInfo } from "./engine";
import { lockHash, rangesHash, withLockRanges } from "./engine/door";
import styles from "./Editor.module.css";
import { nodelockData } from "./data";
import { chainRanges, pendingRef, planChildLock, planEditLock, planRangeLock, siblingName, type LockFooter, type LockPlan } from "./lineage";
import { RangesStep, usePreflopLine } from "./RangesStep";
import rangeStyles from "./RangesStep.module.css";
import { boardText, closeEditor, LOCKS_PARAM, startSolve, useNodelockSession, type EditorOpen, type EditorWithin } from "./session";
import { lockSpec, lockTarget, suggestContext, type LockAction, type LockTarget } from "./spot";

type Mode = "hands" | "range" | "classes";
type View = "range" | "classes" | "combos";
/** A hand class of the classes mode and view: a made hand or a draw (`MADE_HANDS`, `DRAWS`). */
type ClassId = { group: "made" | "draw"; index: number };

const pctText = (share: number) => `${Math.round(share * 1000) / 10}%`;

function classMask(target: LockTarget, id: ClassId): Uint8Array {
  const values = id.group === "made" ? target.made : target.draw;
  return Uint8Array.from(values, (v) => (v === id.index ? 1 : 0));
}

/** Reach-weighted mix of some hands, and how much of them reaches. */
function mixOf(target: LockTarget, state: EditorState, hands: readonly number[]): { mix: number[]; reach: number } {
  const mix = state.strategy.map(() => 0);
  let reach = 0;
  for (const i of hands) {
    const r = target.spot.reach[i];
    reach += r;
    state.strategy.forEach((row, a) => {
      mix[a] += r * row[i];
    });
  }
  return { mix: reach > 0 ? mix.map((x) => x / reach) : mix, reach };
}

/**
 * Where the editor sits: under the library's action strip, across its width,
 * to the window's bottom; the whole window when the strip is not on screen
 * or leaves too little room under it.
 */
function useFrame(): CSSProperties {
  const [frame, setFrame] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const measure = () => {
      const strip = document.querySelector(`.${CSS.escape(solverStyles.stripBox)}`);
      const box = strip?.getBoundingClientRect();
      const top = box ? Math.max(8, Math.round(box.bottom + 6)) : 0;
      if (!box || window.innerHeight - top < 460) {
        setFrame({});
        return;
      }
      setFrame({
        "--editor-top": `${top}px`,
        "--editor-left": `${Math.max(8, Math.round(box.left))}px`,
        "--editor-right": `${Math.max(8, Math.round(window.innerWidth - box.right))}px`,
      } as CSSProperties);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return frame;
}

/**
 * About how long the solve takes, in seconds, with the native engine (the
 * workers' pace depends too much on the computer to say): a flop game ≈ 75 s
 * at 1 % of the pot, a turn game on the flop's result ≈ 3 s, each scaled by
 * (1 / accuracy)^0.75. Null for the workers, or before the engine is known.
 */
function estimateSeconds(info: EngineInfo | null, game: "flop" | "turn", accuracy: number): number | null {
  if (info?.kind !== "native" || !(accuracy > 0)) return null;
  return (game === "flop" ? 75 : 3) * (1 / accuracy) ** 0.75;
}

/** Undo (back) and Redo: a curved arrow. */
function TurnGlyph({ back }: { back: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={solverStyles.glyph}>
      <path d={back ? "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" : "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"} />
    </svg>
  );
}

export function Editor({ open, solverT }: { open: EditorOpen; solverT: SolverDict }) {
  const t = useT().nodelock;
  const locale = useLocale();
  const session = useNodelockSession();
  const suggestDict = locale === "hr" ? nodelockSuggestHr : nodelockSuggestEn;
  /** The library's decision; `target` is it with the lock's own actions (`editor/sizes.ts`). */
  const base = useMemo(() => lockTarget(open.at, solverT), [open.at, solverT]);
  /** Where the editor opens, and where Reset goes back to: GTO of the view (a lock's solution inside one), or the lock being edited, with its actions. */
  const [opening] = useState<EditorState>(() => {
    const start = initialState(base.spot);
    const node = open.from?.lockSet.nodes.find((x) => x.path === base.path);
    if (!node) return start;
    const own = node.custom ? actionsFromLabels(base, node.actions, solverT.action) : null;
    const at = own ? withActions(base, own) : base;
    return { ...start, ...fromLockArrays(at.spot, node), ...(own ? { actions: own } : {}), preset: open.from?.preset ?? null };
  });
  const [state, dispatch] = useReducer(
    (s: EditorState, a: EditorAction) => editorReducer(withActions(base, s.actions ?? base.library).spot, s, a),
    opening,
  );
  const target = useMemo(() => withActions(base, state.actions ?? base.library), [base, state.actions]);
  /** Inside a lock that gave this node its own sizes: the shown actions are already the lock's, so every lock here keeps `custom`. */
  const inherited = useMemo(() => Boolean(open.within?.open.set.nodes.some((n) => n.custom && n.path === base.path)), [open.within, base.path]);
  /* -------------------------------------------- the Ranges step (§9.4) - */
  const library = open.at.library;
  /** The flop in the chunk's suits: the ranges' combos. */
  const flopCards = useMemo(() => library.result.board.slice(0, 3).map((card) => cardIndex(card)), [library]);
  const players = library.header.players;
  /** The ranges the view's flop was solved from: the lock being edited, else the chain's (§9.3); undefined: the chart's. */
  const startRanges = useMemo<RangeLock[] | undefined>(
    () => (open.from?.lockSet.nodes.every((n) => n.street === "flop") ? open.from.lockSet.ranges : undefined) ?? chainRanges(open.within?.open ?? null, open.within?.ancestors ?? []),
    [open.from, open.within],
  );
  const [rangeEdit, rangeDispatch] = useReducer(rangeEditReducer, undefined, () =>
    initialRangeEdit([handsRange(library.result.hands[0], library.result.weights[0]), handsRange(library.result.hands[1], library.result.weights[1])], startRanges),
  );
  /** Nodelock opens on the ranges; Edit lock (a node already locked) on the decision. */
  const [step, setStep] = useState<"ranges" | "node">(() => (open.from?.lockSet.nodes.some((n) => n.path === base.path) ? "node" : "ranges"));
  const preflop = usePreflopLine(open.at.set, library.header.lineKey, players, solverT);
  const editedRanges = rangeEditLocks(rangeEdit, flopCards);
  /** The ranges differ from the ones the view's flop was solved from: a turn or river lock then needs the flop solved first (§9.3). */
  const rangesMoved = rangesHash(editedRanges) !== rangesHash(startRanges);
  const shifts = rangeShifts(rangeEdit, flopCards, players);
  const shiftText = (list: RangeShift[] | undefined) => (list ?? []).map((x) => t.ranges.shift(x.position, shiftPp(x))).join(", ");

  const actionKey = target.actions.map((a) => a.label).join(" ");
  const [mode, setMode] = useState<Mode>("range");
  const [view, setView] = useState<View>("range");
  const [brush, setBrush] = useState<number[]>(() => target.actions.map((_, a) => (a === 0 ? 100 : 0)));
  const [held, setHeld] = useState<boolean[]>(() => target.actions.map(() => false));
  // Another set of actions: the brush and the holds start over on it (set while rendering, as React advises).
  const [shownKey, setShownKey] = useState(actionKey);
  if (shownKey !== actionKey) {
    setShownKey(actionKey);
    setBrush(target.actions.map((_, a) => (a === 0 ? 100 : 0)));
    setHeld(target.actions.map(() => false));
  }
  const [cell, setCell] = useState<number | null>(null);
  /** The hovered cell measured for the zoom (GTO Wizard's hover); none while a brush stroke paints. */
  const [zoom, setZoom] = useState<ZoomAnchor | null>(null);
  const zoomWrap = useRef<HTMLDivElement>(null);
  const [klass, setKlass] = useState<ClassId | null>(null);
  const [earlier, setEarlier] = useState<LockEarlier>(open.from?.lockSet.earlier ?? "player");
  const [accuracy, setAccuracy] = useState<number>(open.from?.lockSet.targetPct ?? 1);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [suggested, setSuggested] = useState<NodelockSuggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sizeText, setSizeText] = useState("");
  const [sizeError, setSizeError] = useState<string | null>(null);
  /** The Solve click being handed over: a second click must not queue the same lock again. */
  const [submitting, setSubmitting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useFrame();
  const painting = useRef(false);
  const sliding = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let live = true;
    void engineInfo(target.street).then((value) => {
      if (live) setInfo(value);
    });
    return () => {
      live = false;
    };
  }, [target.street]);
  useEffect(() => {
    const stop = () => {
      painting.current = false;
      sliding.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  const colours = useMemo(() => actionColours(target.actions.map((a) => ({ kind: a.kind, amount: a.amount }))), [target]);
  const zoomActions = useMemo<ZoomAction[]>(
    () => target.actions.map((a, k) => ({ label: a.name, size: a.kind === "bet" ? solverT.zoom.size(a.amount) : null, className: colours[k] })),
    [target, colours, solverT],
  );
  const zoomOrder = useMemo(() => aggressiveFirst(target.actions.map((a) => ({ kind: a.kind, size: a.amount }))), [target]);
  const zoomWords = { combos: solverT.zoom.combos, you: solverT.you };
  /** A hand of the grid as a combo card: its cards, its mix now, a lock when it is locked. */
  const comboOf = (i: number): ZoomCombo => ({
    cards: target.cards[i],
    freq: state.strategy.map((row) => row[i]),
    label: t.cellLabel(target.cards[i], mixLabel(state.strategy.map((row) => row[i])), Boolean(state.locked[i])),
    mark: state.locked[i] ? (
      <span className={styles.zoomLock} aria-hidden="true">
        <LockGlyph />
      </span>
    ) : null,
  });
  /** Inside a lock: what the solve will be (§7.4), for the footer's line; the strategy does not change it. */
  const footer = useMemo(() => {
    if (!open.within) return null;
    const stub = { street: target.street, path: target.path, player: target.player, actions: target.actions.map((a) => a.label), strategy: [], locked: [] };
    try {
      return planOf(open.within, spotOf(open.at, target.river), stub).footer;
    } catch {
      return null;
    }
  }, [open.within, open.at, target]);
  /** GTO's share of each action: the library's, 0 for a size it never solved (`gtoOf` shows none). */
  const gtoShares = useMemo(() => {
    const library = sharesOf(base.spot, base.spot.gto.map((row) => Array.from(row)));
    return target.actions.map((a) => (a.gto === null ? 0 : library[a.gto]));
  }, [base, target]);
  const shares = sharesOf(target.spot, state.strategy);
  /** GTO's share of an action, none for a size the library never solved. */
  const gtoOf = (a: number, of: number[]) => (target.actions[a]?.gto === null ? null : of[a]);
  const counts = lockedCount(target.spot, state);
  const ctx = useMemo(() => suggestContext(target), [target]);
  const archetypes = useMemo<Archetype[]>(() => {
    try {
      return availableArchetypes(ctx);
    } catch {
      return [];
    }
  }, [ctx]);

  const mixLabel = (mix: number[]) =>
    mix
      .map((x, a) => (x >= 0.0005 ? `${target.actions[a].name} ${pctText(x)}` : null))
      .filter(Boolean)
      .join(", ");

  /** The node's actions become `next` (sorted as the tree sorts them); the strategy carries over. */
  const setActions = (next: readonly LockAction[]) => {
    const sorted = sortActions(next);
    const to = withActions(base, sorted);
    setSizeError(null);
    dispatch({ type: "actions", actions: isLibrary(to) ? undefined : sorted, ...carryStrategy(target, state, to) });
  };
  const addSize = (pct: number | null) => {
    const made = sizeAction(target, pct, solverT.action);
    if (typeof made === "string") {
      setSizeError(t.sizes.errors[made]);
      return;
    }
    setActions([...target.actions, made]);
    setSizeText("");
  };
  const custom = !isLibrary(target);

  const paint = (hands: readonly number[], merge: boolean) => {
    if (!hands.length) return;
    dispatch({ type: "paint", hands, mix: brush, merge });
  };

  const classes = useMemo(() => {
    const list: Array<{ id: ClassId; name: string; hands: number[] }> = [];
    const add = (group: ClassId["group"], names: readonly string[], values: Int8Array, label: (key: string) => string) => {
      names.forEach((key, index) => {
        const hands: number[] = [];
        values.forEach((v, i) => {
          if (v === index && target.spot.reach[i] > 0) hands.push(i);
        });
        if (hands.length && !(group === "draw" && key === "noDraw")) list.push({ id: { group, index }, name: label(key), hands });
      });
    };
    add("made", MADE_HANDS, target.made, (key) => solverT.filters.made[key as keyof SolverDict["filters"]["made"]]);
    add("draw", DRAWS, target.draw, (key) => solverT.filters.draw[key as keyof SolverDict["filters"]["draw"]]);
    return list;
  }, [target, solverT]);
  const shownClass = klass ? classes.find((c) => c.id.group === klass.group && c.id.index === klass.index) ?? null : null;
  /** The picked class's sliders, under its row in the panel. */
  const classSliders = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode === "classes" && klass) classSliders.current?.scrollIntoView({ block: "nearest" });
  }, [mode, klass]);
  const classMaskOf = useMemo(() => (shownClass ? classMask(target, shownClass.id) : null), [shownClass, target]);

  const pickSuggestion = (archetype: Archetype) => {
    try {
      const suggestion = suggestLocks(ctx, archetype, suggestDict);
      setSuggested(suggestion);
      dispatch({ type: "load", ...fromLockArrays(target.spot, suggestion.nodes[0]), preset: suggestion.id });
      setMode("range");
    } catch {
      setSuggested(null);
    }
  };

  const solve = async () => {
    setMessage(null);
    // Sizes added or taken away are a lock on their own, with no hand fixed (#410).
    const locking = strategyToSolve(target.spot, state, custom || inherited);
    if (!locking) {
      setMessage(t.nothingLocked);
      return;
    }
    const { at } = target;
    const spot = spotOf(at, target.river);
    const spec = lockSpec(target, locking, inherited);
    // New ranges under a turn or river node: the flop with them first, then this lock on it (§9.3).
    const chained = target.street !== "flop" && rangesMoved;
    let first: LockPlan | null = null;
    let plan: LockPlan | null = null;
    let firstKey = "";
    const firstName = t.ranges.name(shiftText(shifts), boardText(at.board.slice(0, 3)));
    try {
      if (chained) {
        first = planRangeLock(open.within?.open ?? null, open.within?.ancestors ?? [], spot, editedRanges ?? null, { targetPct: accuracy });
        // The flop lock's hash names its row for the lock queued after it.
        firstKey = first ? lockHash(first.set) : "";
        plan = first
          ? planChildLock(pendingRef(first, firstKey, firstName, firstKey), [], spot, spec, { earlier, targetPct: accuracy })
          : planChildLock(null, [], spot, spec, { earlier, targetPct: accuracy });
      } else if (open.within) {
        plan = planOf(open.within, spot, spec, { earlier, targetPct: accuracy, ranges: editedRanges ?? null });
      }
    } catch {
      setMessage(t.startError);
      return;
    }
    const lockSet: LockSet = plan?.set ?? withLockRanges({ version: 1, spot, nodes: [spec], earlier, targetPct: accuracy }, target.street === "flop" ? editedRanges : undefined);
    const summary: NodelockSummary = {
      view: {
        set: at.set,
        line: at.preflop,
        flop: at.board.slice(0, 3).join(""),
        node: at.node,
        ...(at.turn ? { turn: liveTurnId(at.turn.chance, at.turn.card) } : {}),
      },
      position: target.position,
      players: target.players,
      steps: target.steps,
      shifts: target.actions.map((a, k) => ({ label: a.name, gto: gtoShares[k], locked: shares[k] })),
      ...(shifts ? { ranges: shifts } : {}),
    };
    const who = state.preset ? `${suggestDict.names[state.preset as Archetype] ?? state.preset} ${target.position}` : target.position;
    setSubmitting(true);
    // Edit lock makes a sibling of the lock that owns the node: `<name> (2)`.
    const name =
      plan?.footer.kind === "sibling"
        ? siblingName(plan.footer.of, await nodelockData.list().then((rows) => rows.map((row) => row.name), () => []))
        : (open.from?.name ?? t.name(who, boardText(at.board), target.players[1], target.players[0]));
    if (first) {
      const flopStarted = await startSolve({ at, lockSet: first.set, name: firstName, preset: null, summary: rangesSummary(at, shifts ?? []), plan: first, chainKey: firstKey });
      if (flopStarted === "noEngine" || flopStarted === "failed") {
        setSubmitting(false);
        setMessage(flopStarted === "noEngine" ? t.noEngine : t.startError);
        return;
      }
    }
    const started = await startSolve({ at, lockSet, name, preset: state.preset, summary, ...(plan ? { plan } : {}) }).finally(() => setSubmitting(false));
    if (started === "noEngine" || started === "failed") setMessage(started === "noEngine" ? t.noEngine : t.startError);
    // The library stays the clean solve: the lock's progress, then the lock, are in My nodelocks.
    // Inside an open lock the view stays where it is; the new lock's row shows under it in the tree.
    else if (!open.within) go("solver", LOCKS_PARAM);
  };

  /** The summary of a lock that changes only the ranges: made at the flop's first decision. */
  const rangesSummary = (at: EditorOpen["at"], list: RangeShift[]): NodelockSummary => ({
    view: { set: at.set, line: at.preflop, flop: at.board.slice(0, 3).join(""), node: 0 },
    position: list[0]?.position ?? players[0],
    players,
    steps: [],
    shifts: [],
    ranges: list,
  });

  /** Solve these ranges (§9.4): a ranges-only lock, or the chain's flop lock with them. */
  const solveRanges = async () => {
    setMessage(null);
    const { at } = target;
    let plan: LockPlan | null;
    try {
      plan = planRangeLock(open.within?.open ?? null, open.within?.ancestors ?? [], spotOf(at, null), editedRanges ?? null, { targetPct: accuracy });
    } catch {
      plan = null;
    }
    if (!plan) {
      setMessage(t.startError);
      return;
    }
    setSubmitting(true);
    const name = t.ranges.name(shiftText(shifts), boardText(at.board.slice(0, 3)));
    const started = await startSolve({ at, lockSet: plan.set, name, preset: null, summary: rangesSummary(at, shifts ?? []), plan }).finally(() => setSubmitting(false));
    if (started === "noEngine" || started === "failed") setMessage(started === "noEngine" ? t.noEngine : t.startError);
    else if (!open.within) go("solver", LOCKS_PARAM);
  };

  /* ------------------------------------------------------------- pieces - */

  /** An action's row: its name, GTO's share, the typed %, hold; under it the slider with GTO's tick (none: the brush). */
  const sliderRow = (a: number, value: number, onValue: (v: number, merge: boolean) => void, gto: number | null, hold: boolean, remove = false) => (
    <div key={target.actions[a].label} className={styles.slider}>
      <div className={styles.sliderHead}>
        <span className={`${solverStyles.actDot} ${colours[a]}`} aria-hidden="true" />
        <span className={styles.sliderName}>{target.actions[a].name}</span>
        {gto !== null ? <span className={solverStyles.actGto}>{`${t.gto} ${pctText(gto)}`}</span> : null}
        <input
          className={styles.number}
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={Math.round(value * 1000) / 10}
          aria-label={t.frequency(target.actions[a].name)}
          onChange={(event) => onValue(Math.min(100, Math.max(0, Number(event.target.value) || 0)) / 100, false)}
        />
        {hold ? (
          <button
            type="button"
            className={`${styles.hold} ${held[a] ? styles.holdOn : ""}`}
            aria-pressed={held[a]}
            title={t.hold(target.actions[a].name)}
            aria-label={t.hold(target.actions[a].name)}
            onClick={() => setHeld(held.map((x, k) => (k === a ? !x : x)))}
          >
            <LockGlyph />
          </button>
        ) : null}
        {remove ? (
          <button
            type="button"
            className={styles.hold}
            title={t.sizes.remove(target.actions[a].name)}
            aria-label={t.sizes.remove(target.actions[a].name)}
            disabled={target.actions.length < 2}
            onClick={() => setActions(target.actions.filter((_, k) => k !== a))}
          >
            <Icon name="close" />
          </button>
        ) : null}
      </div>
      <span className={styles.range} style={{ "--v": value, "--g": gto ?? 0 } as CSSProperties}>
        <span className={`${styles.rangeFill} ${colours[a]}`} aria-hidden="true" />
        {gto !== null ? <span className={styles.rangeTick} aria-hidden="true" /> : null}
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={Math.round(value * 1000) / 10}
          aria-label={t.frequency(target.actions[a].name)}
          onPointerDown={() => {
            sliding.current = false;
          }}
          onChange={(event) => {
            onValue(Number(event.target.value) / 100, sliding.current);
            sliding.current = true;
          }}
        />
      </span>
    </div>
  );

  let left: ReactNode;
  if (mode === "hands") {
    left = (
      <>
        <p className={styles.label}>{t.brush}</p>
        <div className={styles.chips}>
          {target.actions.map((action, a) => (
            <button
              key={action.label}
              type="button"
              className={styles.chip}
              aria-pressed={brush[a] === 100}
              onClick={() => setBrush(target.actions.map((_, k) => (k === a ? 100 : 0)))}
            >
              <span className={`${solverStyles.optDot} ${colours[a]}`} aria-hidden="true" />
              {action.name}
            </button>
          ))}
        </div>
        {target.actions.map((_, a) => sliderRow(a, brush[a] / 100, (v) => setBrush(brush.map((x, k) => (k === a ? v * 100 : x))), null, false))}
        <MixBar mix={brush} colours={colours} />
        <p className={styles.hint}>{t.brushHint}</p>
      </>
    );
  } else if (mode === "range") {
    left = (
      <>
        {target.actions.map((_, a) =>
          sliderRow(
            a,
            shares[a],
            (v, merge) => dispatch({ type: "frequency", action: a, target: v, held, merge }),
            gtoOf(a, gtoShares),
            target.actions.length > 2,
            true,
          ),
        )}
        <div className={styles.sizes}>
          <span className={styles.sizesLabel}>{target.toCall > 0 ? t.sizes.raise : t.sizes.bet}</span>
          <input
            className={styles.number}
            type="number"
            min={1}
            step={1}
            placeholder={t.sizes.placeholder}
            value={sizeText}
            aria-label={t.sizes.pct}
            title={t.sizes.pct}
            onChange={(event) => {
              setSizeText(event.target.value);
              setSizeError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") addSize(Number(sizeText));
            }}
          />
          <span className={styles.sizesUnit}>%</span>
          <ToolButton size="sm" disabled={!sizeText} onClick={() => addSize(Number(sizeText))}>
            {t.sizes.add}
          </ToolButton>
          {target.actions.some((x) => x.kind === "allin") ? null : (
            <ToolButton size="sm" onClick={() => addSize(null)}>
              {t.sizes.allIn}
            </ToolButton>
          )}
          {passiveActions(target).map((x) => (
            <ToolButton key={x.label} size="sm" title={t.sizes.back(x.name)} onClick={() => setActions([...target.actions, x])}>
              {`+ ${x.name}`}
            </ToolButton>
          ))}
          {custom ? (
            <ToolButton size="sm" onClick={() => setActions(base.library)}>
              {t.sizes.reset}
            </ToolButton>
          ) : null}
        </div>
        {sizeError ? (
          <p className={styles.message} role="alert">
            {sizeError}
          </p>
        ) : null}
        <p className={styles.hint}>{custom ? t.sizes.customHint : t.rangeHint}</p>
      </>
    );
  } else {
    const mask = classMaskOf;
    const classShares = mask ? sharesOf(target.spot, state.strategy, mask) : null;
    const libraryClass = mask ? sharesOf(base.spot, base.spot.gto.map((row) => Array.from(row)), mask) : null;
    const classGto = libraryClass ? target.actions.map((a) => (a.gto === null ? 0 : libraryClass[a.gto])) : null;
    left = (
      <>
        {mask ? null : <p className={styles.hint}>{t.classesHint}</p>}
        <ClassList
          classes={classes}
          state={state}
          target={target}
          colours={colours}
          picked={shownClass?.id ?? null}
          onPick={(id) => setKlass(id)}
          madeLabel={t.made}
          drawLabel={t.draws}
          detail={
            mask && classShares && classGto ? (
              // Right under the picked class, scrolled into view: no hunt for the sliders below a long list (#409).
              <div ref={classSliders} className={styles.classSliders}>
                {target.actions.map((_, a) =>
                  sliderRow(
                    a,
                    classShares[a],
                    (v, merge) => dispatch({ type: "frequency", action: a, target: v, mask, held, merge }),
                    gtoOf(a, classGto),
                    target.actions.length > 2,
                  ),
                )}
              </div>
            ) : null
          }
        />
      </>
    );
  }

  /* --------------------------------------------------------------- grid - */

  const cells = useMemo(
    () =>
      HAND_CLASSES.map((c, k) => {
        const hands = target.byCell[k];
        const all = target.cell.reduce((s, x) => s + (x === k ? 1 : 0), 0);
        return { name: c.name, hands, all };
      }),
    [target],
  );

  const grid = (
    <div
      className={`${solverStyles.grid} ${styles.grid}`}
      role="grid"
      aria-label={t.editorLabel(target.position)}
      onPointerLeave={() => {
        painting.current = false;
        setZoom(null);
      }}
    >
      {Array.from({ length: 13 }, (_, row) => (
        <div key={row} role="row" className={solverStyles.gridRow}>
          {cells.slice(row * 13, row * 13 + 13).map((c, col) => {
            const k = row * 13 + col;
            const { mix, reach } = mixOf(target, state, c.hands);
            const lockedHere = c.hands.filter((i) => state.locked[i]).length;
            const allLocked = c.hands.length > 0 && lockedHere === c.hands.length;
            const fill = c.all > 0 ? reach / c.all : 0;
            return (
              <div key={c.name} role="gridcell" className={`${solverStyles.gridCellWrap} ${styles.cellWrap}`}>
                <button
                  type="button"
                  className={[
                    solverStyles.cell,
                    styles.cell,
                    c.hands.length ? "" : solverStyles.cellFaint,
                    cell === k ? solverStyles.cellPicked : "",
                    allLocked ? styles.cellLocked : lockedHere ? styles.cellPart : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={t.cellLabel(c.name, mixLabel(mix), allLocked)}
                  aria-pressed={cell === k}
                  disabled={!c.hands.length}
                  onPointerDown={(event) => {
                    if (mode !== "hands" || view === "combos") return;
                    event.preventDefault();
                    painting.current = true;
                    setZoom(null);
                    paint(c.hands, false);
                  }}
                  onPointerEnter={(event) => {
                    if (painting.current && mode === "hands" && view !== "combos") paint(c.hands, true);
                    else if (!painting.current && zoomWrap.current) setZoom(zoomAnchor(k, event.currentTarget, zoomWrap.current));
                  }}
                  onClick={(event) => {
                    // A paint happened on pointer down; a keyboard click paints here.
                    if (mode === "hands" && view !== "combos" && event.detail === 0) paint(c.hands, false);
                    if (mode !== "hands" || view === "combos") setCell(cell === k ? null : k);
                  }}
                >
                  {c.hands.length ? (
                    <span className={solverStyles.cellFill} style={{ blockSize: `${Math.max(8, fill * 100)}%` }} aria-hidden="true">
                      {mix.map((x, a) => (x > 0 ? <span key={a} className={colours[a]} style={{ inlineSize: `${x * 100}%` }} /> : null))}
                    </span>
                  ) : null}
                  <span className={solverStyles.cellName}>{c.name}</span>
                </button>
                {c.hands.length && mode !== "hands" ? (
                  <button
                    type="button"
                    className={styles.badgeButton}
                    title={t.toggleLock(c.name)}
                    aria-label={t.toggleLock(c.name)}
                    onClick={() => dispatch({ type: "toggleLock", hands: c.hands })}
                  >
                    <LockGlyph />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  let main: ReactNode;
  if (view === "classes") {
    main = (
      <ClassList
        classes={classes}
        state={state}
        target={target}
        colours={colours}
        picked={shownClass?.id ?? null}
        onPick={(id) => {
          const found = classes.find((c) => c.id.group === id.group && c.id.index === id.index);
          if (mode === "hands" && found) paint(found.hands, false);
          else {
            setKlass(id);
            setMode("classes");
          }
        }}
        onLock={(hands) => dispatch({ type: "toggleLock", hands })}
        lockLabel={t.toggleLock}
        madeLabel={t.made}
        drawLabel={t.draws}
        wide
      />
    );
  } else {
    main = (
      <div className={view === "combos" ? styles.gridWithCombos : styles.gridOnly}>
        <div ref={zoomWrap} className={solverStyles.gridZoomWrap}>
          {grid}
          {/* The Combos view lists the combos beside the grid: no zoom under the pointer there. */}
          {zoom && view !== "combos" && cells[zoom.cell]?.hands.length ? (
            <GridZoom
              anchor={zoom}
              name={cells[zoom.cell].name}
              count={cells[zoom.cell].hands.length}
              freq={mixOf(target, state, cells[zoom.cell].hands).mix}
              combos={cells[zoom.cell].hands.map(comboOf)}
              actions={zoomActions}
              order={zoomOrder}
              words={zoomWords}
              locale={locale}
            />
          ) : null}
        </div>
        {view === "combos" ? (
          cell !== null && cells[cell].hands.length ? (
            <ComboCards
              label={cells[cell].name}
              combos={cells[cell].hands.map(comboOf)}
              actions={zoomActions}
              order={zoomOrder}
              words={zoomWords}
              onPick={(_, n) => {
                const i = cells[cell].hands[n];
                if (mode === "hands") paint([i], false);
                else dispatch({ type: "toggleLock", hands: [i] });
              }}
            />
          ) : (
            <p className={styles.hint}>{t.pickCell}</p>
          )
        ) : null}
      </div>
    );
  }

  const running = session.running;
  const memoryMb = info?.memoryMb ?? 0;
  // The game the solve runs: a flop lock's flop, else the turn's (a river lock solves the turn's game too).
  const game = footer ? (footer.kind === "builds" ? "turn" : footer.street) : target.street === "flop" ? "flop" : "turn";
  const estimate = estimateSeconds(info, game, accuracy);

  return (
    <dialog
      ref={dialog}
      className={styles.editor}
      style={frame}
      aria-label={t.editorLabel(target.position)}
      onCancel={(event) => {
        event.preventDefault();
        closeEditor();
      }}
    >
      {step === "ranges" ? (
        <RangesStep
          edit={rangeEdit}
          dispatch={rangeDispatch}
          board={flopCards}
          shownBoard={open.at.board}
          players={players}
          actor={target.player}
          preflop={preflop}
          message={message}
          busy={submitting || info?.kind === null}
          canSolve={rangesMoved}
          onNext={() => {
            setMessage(null);
            setStep("node");
          }}
          onSolveRanges={() => void solveRanges()}
          onClose={closeEditor}
        />
      ) : (
      <>
      <header className={styles.head}>
        <ToolButton size="sm" title={t.ranges.scope} onClick={() => setStep("ranges")}>
          <span className={rangeStyles.back}>{t.ranges.step}</span>
          {shifts ? <span className={rangeStyles.backShift}>{shiftText(shifts)}</span> : null}
        </ToolButton>
        <span className={solverStyles.spacer} />
        <span className={styles.headCount}>{t.locked(counts.locked, counts.reaching)}</span>
        <IconButton size="sm" label={t.undo} disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>
          <TurnGlyph back />
        </IconButton>
        <IconButton size="sm" label={t.redo} disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
          <TurnGlyph back={false} />
        </IconButton>
        <ToolButton size="sm" disabled={sameStrategy(state, opening)} onClick={() => dispatch({ type: "reset", to: opening, preset: opening.preset })}>
          {t.reset}
        </ToolButton>
        <IconButton size="sm" label={t.close} onClick={closeEditor}>
          <Icon name="close" />
        </IconButton>
      </header>

      <div className={styles.body}>
        <section className={styles.main}>
          <div className={solverStyles.tools}>
            <Segmented
              size="sm"
              label={t.viewsLabel}
              value={view}
              options={(["range", "classes", "combos"] as const).map((v) => ({ value: v, label: t.views[v] }))}
              onChange={setView}
            />
            <span className={solverStyles.spacer} />
            <ToolButton size="sm" tone="lock" onClick={() => dispatch({ type: "lockAll" })}>
              <LockGlyph />
              {t.lockAll}
            </ToolButton>
            <ToolButton size="sm" disabled={!counts.locked} onClick={() => dispatch({ type: "unlockAll" })}>
              {t.unlockAll}
            </ToolButton>
            <ToolButton size="sm" onClick={() => dispatch({ type: "invert" })}>
              {t.invert}
            </ToolButton>
          </div>
          <div className={styles.current} aria-label={t.current}>
            <span className={styles.currentBar}>
              {shares.map((x, a) => (
                <span key={a} className={colours[a]} style={{ flexGrow: x }} />
              ))}
              {(custom ? [] : gtoShares.slice(0, -1)).map((_, a) => (
                <span
                  key={`g${a}`}
                  className={styles.currentTick}
                  style={{ insetInlineStart: `${gtoShares.slice(0, a + 1).reduce((s, x) => s + x, 0) * 100}%` }}
                  aria-hidden="true"
                />
              ))}
            </span>
            <span className={styles.currentLegend}>
              {target.actions.map((action, a) => (
                <span key={action.label}>
                  <span className={`${solverStyles.optDot} ${colours[a]}`} aria-hidden="true" />
                  {action.name} <strong>{pctText(shares[a])}</strong>
                  {action.gto === null ? null : <small>{` ${t.gto} ${pctText(gtoShares[a])}`}</small>}
                </span>
              ))}
            </span>
          </div>
          {main}
        </section>

        <aside className={`${solverStyles.panel} ${styles.panel}`}>
          <Segmented
            tabs
            label={t.modesLabel}
            value={mode}
            options={(["range", "hands", "classes"] as const).map((m) => ({ value: m, label: t.modes[m] }))}
            onChange={setMode}
            className={styles.modes}
          />
          <div className={styles.modeBody}>{left}</div>
          {archetypes.length ? (
            <section className={styles.suggestions} aria-label={t.suggestions}>
              <p className={styles.label}>{t.suggestions}</p>
              <div className={styles.chips}>
                {archetypes.map((archetype) => (
                  <button
                    key={archetype}
                    type="button"
                    className={styles.chip}
                    aria-pressed={state.preset === archetype}
                    title={suggestDict.explanation(archetype, ctx.nodeKind, ctx.street)}
                    onClick={() => pickSuggestion(archetype)}
                  >
                    {suggestDict.names[archetype]}
                  </button>
                ))}
              </div>
              {suggested && state.preset === suggested.id ? (
                <p className={styles.hint}>
                  <strong>{suggested.title}</strong> {suggested.explanation}
                </p>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>

      <footer className={styles.foot}>
        <div className={styles.footGroup}>
          <span className={styles.label}>{t.earlierLabel}</span>
          <Segmented
            size="sm"
            label={t.earlierLabel}
            value={earlier}
            options={(["none", "player", "all"] as const).map((x) => ({ value: x, label: t.earlier[x] }))}
            onChange={setEarlier}
          />
        </div>
        <div className={styles.footGroup}>
          <span className={styles.label}>{t.accuracyLabel}</span>
          <Segmented
            size="sm"
            label={t.accuracyLabel}
            value={String(accuracy)}
            options={[
              { value: "1", label: t.accuracy.standard },
              { value: "2.5", label: t.accuracy.quick },
            ]}
            onChange={(x) => setAccuracy(Number(x))}
          />
        </div>
        <div className={styles.footText}>
          {target.street !== "flop" && rangesMoved ? <p className={styles.planLine}>{t.ranges.turnFirst}</p> : footer ? <p className={styles.planLine}>{footerLine(t, footer)}</p> : null}
          <p className={message ? styles.message : styles.engineLine} role={message ? "alert" : undefined}>
            {message ?? (running ? t.queued : info === null ? "" : info.kind === null ? t.noEngine : t.engineLine(info.threads, info.cores, memoryMb))}
          </p>
        </div>
        {estimate !== null ? <span className={styles.estimate}>{t.estimate(estimate)}</span> : null}
        <ToolButton tone="primary" disabled={submitting || info?.kind === null} onClick={() => void solve()}>
          {t.solve}
        </ToolButton>
      </footer>
      </>
      )}
    </dialog>
  );
}

/** The hand classes present: made hands, then draws, each with its mix; a click picks (or paints) one. */
function ClassList({
  classes,
  state,
  target,
  colours,
  picked,
  onPick,
  onLock,
  lockLabel,
  madeLabel,
  drawLabel,
  detail = null,
  wide = false,
}: {
  classes: Array<{ id: ClassId; name: string; hands: number[] }>;
  state: EditorState;
  target: LockTarget;
  colours: string[];
  picked: ClassId | null;
  onPick: (id: ClassId) => void;
  onLock?: (hands: number[]) => void;
  lockLabel?: (name: string) => string;
  madeLabel: string;
  drawLabel: string;
  /** Shown right under the picked class's row (the side panel's sliders). */
  detail?: ReactNode;
  wide?: boolean;
}) {
  const groups: Array<["made" | "draw", string]> = [
    ["made", madeLabel],
    ["draw", drawLabel],
  ];
  return (
    <div className={`${styles.classes} ${wide ? styles.classesWide : ""}`}>
      {groups.map(([group, label]) => {
        const rows = classes.filter((c) => c.id.group === group);
        if (!rows.length) return null;
        return (
          <div key={group} className={styles.classGroup}>
            <p className={styles.label}>{label}</p>
            <ul>
              {rows.map((c) => {
                const { mix, reach } = mixOf(target, state, c.hands);
                const locked = c.hands.filter((i) => state.locked[i]).length;
                const on = picked?.group === c.id.group && picked.index === c.id.index;
                return [
                  <li key={`${group}${c.id.index}`} className={styles.classRow}>
                    <button type="button" className={styles.classPick} aria-pressed={on} onClick={() => onPick(c.id)}>
                      <span className={styles.className}>{c.name}</span>
                      <span className={styles.classCombos}>{Math.round(reach * 10) / 10}</span>
                      <MixBar mix={mix} colours={colours} thin />
                    </button>
                    {onLock && lockLabel ? (
                      <button
                        type="button"
                        className={`${styles.hold} ${locked === c.hands.length ? styles.holdOn : ""}`}
                        aria-pressed={locked === c.hands.length}
                        title={lockLabel(c.name)}
                        aria-label={lockLabel(c.name)}
                        onClick={() => onLock(c.hands)}
                      >
                        <LockGlyph />
                      </button>
                    ) : locked ? (
                      <span className={styles.classLocked} aria-hidden="true">
                        <LockGlyph />
                      </span>
                    ) : null}
                  </li>,
                  on && detail ? (
                    <li key={`${group}${c.id.index}-detail`} className={styles.classDetail}>
                      {detail}
                    </li>
                  ) : null,
                ];
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** The new lock's spot, as the decision names it: the flop, and the turn and river on a later street. */
function spotOf(at: EditorOpen["at"], river: string | null): LockSet["spot"] {
  const spot: LockSet["spot"] = { set: at.set, line: at.line, flop: at.flop };
  if (at.turn) spot.turn = at.turn.card;
  if (river) spot.river = river;
  return spot;
}

/** A lock made inside an open one (§7.4): a child of it (the Nodelock action), or a sibling of the node's owner (Edit lock). */
function planOf(within: EditorWithin, spot: LockSet["spot"], spec: Parameters<typeof planChildLock>[3], settings?: { earlier: LockEarlier; targetPct: number; ranges?: RangeLock[] | null }): LockPlan {
  return (
    (within.edit ? planEditLock(within.open, within.ancestors, spot, spec, settings) : null) ??
    planChildLock(within.open, within.ancestors, spot, spec, settings)
  );
}

/** The footer's line: what the solve will be, the lock it builds on in italics. */
function footerLine(t: ReturnType<typeof useT>["nodelock"], footer: LockFooter): ReactNode {
  const named = (text: string, name: string) => {
    const at = text.indexOf(name);
    return at < 0 ? (
      text
    ) : (
      <>
        {text.slice(0, at)}
        <em>{name}</em>
        {text.slice(at + name.length)}
      </>
    );
  };
  switch (footer.kind) {
    case "adds":
      return named(t.planAdds(footer.parent, footer.street), footer.parent);
    case "builds":
      return named(t.planBuilds(footer.parent), footer.parent);
    case "sibling":
      return named(t.planSibling(footer.of, footer.street), footer.of);
    case "library":
      return t.planLibrary(footer.street);
  }
}
