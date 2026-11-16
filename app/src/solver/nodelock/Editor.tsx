/**
 * The nodelock editor (`docs/NODELOCK.md` §5.2), laid out like GTO Wizard's,
 * in Rail's own look: a full-window overlay.
 *
 * ```
 * ┌ board · who acts · pot ─────────────────────────── Undo Redo Reset  × ┐
 * │ Set strategy                  │ Range | Hand classes | Combos  ⊞ ⊟ ⇄ │
 * │  Hands | Range | Hand classes │ current strategy, GTO ticks           │
 * │  sliders / brush / classes    │ 13×13 grid (paint, lock badges)       │
 * │  Suggestions (opponent types) │ or the classes, or one hand's combos  │
 * ├ Lock earlier nodes · Accuracy ─────── engine line · Solve on this computer ┤
 * ```
 *
 * The state is `editor/state.ts`'s reducer; this file draws it and turns the
 * clicks into its steps. Solving hands the lock to `session.ts`.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useLocale, useT } from "../../i18n";
import {
  actionColours,
  availableArchetypes,
  ComboText,
  DRAWS,
  HAND_CLASSES,
  liveTurnId,
  MADE_HANDS,
  nodelockSuggestEn,
  nodelockSuggestHr,
  suggestLocks,
  type Archetype,
  type NodelockSuggestion,
  type SolverDict,
} from "../door";
import type { LockEarlier, LockSet, NodelockSummary } from "./contract";
import { editorReducer, fromLockArrays, initialState, lockedCount, sharesOf, type EditorAction, type EditorState } from "./editor/state";
import { engineInfo, type EngineInfo } from "./engine";
import styles from "./Editor.module.css";
import { closeEditor, startSolve, useNodelockSession, type EditorOpen } from "./session";
import { lockSpec, lockTarget, suggestContext, type LockTarget } from "./spot";

type Mode = "hands" | "range" | "classes";
type View = "range" | "classes" | "combos";
/** A hand class of the classes mode and view: a made hand or a draw (`MADE_HANDS`, `DRAWS`). */
type ClassId = { group: "made" | "draw"; index: number };

const SUIT_SIGN: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

function boardText(cards: readonly string[]): string {
  return cards.map((card) => `${card[0]}${SUIT_SIGN[card[1]] ?? card[1]}`).join("");
}

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

export function Editor({ open, solverT }: { open: EditorOpen; solverT: SolverDict }) {
  const t = useT().nodelock;
  const locale = useLocale();
  const session = useNodelockSession();
  const suggestDict = locale === "hr" ? nodelockSuggestHr : nodelockSuggestEn;
  const target = useMemo(() => lockTarget(open.at, solverT), [open.at, solverT]);
  const [state, dispatch] = useReducer(
    (s: EditorState, a: EditorAction) => editorReducer(target.spot, s, a),
    undefined,
    () => {
      const start = initialState(target.spot);
      const node = open.from?.lockSet.nodes.find((x) => x.path === target.path);
      return node ? { ...start, ...fromLockArrays(target.spot, node), preset: open.from?.preset ?? null } : start;
    },
  );
  const [mode, setMode] = useState<Mode>("range");
  const [view, setView] = useState<View>("range");
  const [brush, setBrush] = useState<number[]>(() => target.actions.map((_, a) => (a === 0 ? 100 : 0)));
  const [held, setHeld] = useState<boolean[]>(() => target.actions.map(() => false));
  const [cell, setCell] = useState<number | null>(null);
  const [klass, setKlass] = useState<ClassId | null>(null);
  const [earlier, setEarlier] = useState<LockEarlier>(open.from?.lockSet.earlier ?? "player");
  const [accuracy, setAccuracy] = useState<number>(open.from?.lockSet.targetPct ?? 1);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [suggested, setSuggested] = useState<NodelockSuggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
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
  const gtoShares = useMemo(() => sharesOf(target.spot, target.spot.gto.map((row) => Array.from(row))), [target]);
  const shares = sharesOf(target.spot, state.strategy);
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
    if (!counts.locked) {
      setMessage(t.nothingLocked);
      return;
    }
    const { at } = target;
    const spot: LockSet["spot"] = { set: at.set, line: at.line, flop: at.flop };
    if (at.turn) spot.turn = at.turn.card;
    if (target.river) spot.river = target.river;
    const lockSet: LockSet = { version: 1, spot, nodes: [lockSpec(target, state)], earlier, targetPct: accuracy };
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
    };
    const who = state.preset ? `${suggestDict.names[state.preset as Archetype] ?? state.preset} ${target.position}` : target.position;
    const name = open.from?.name ?? t.name(who, boardText(at.board), target.players[1], target.players[0]);
    const started = await startSolve({ at, lockSet, name, preset: state.preset, summary });
    if (!started) setMessage(session.running ? t.busy : t.noEngine);
  };

  /* ------------------------------------------------------------- pieces - */

  const sliderRow = (a: number, value: number, onValue: (v: number, merge: boolean) => void, gto: number, hold: boolean) => (
    <div key={target.actions[a].label} className={styles.sliderRow}>
      <span className={styles.sliderName}>
        <span className={`${styles.dot} ${colours[a]}`} aria-hidden="true" />
        {target.actions[a].name}
      </span>
      <span className={styles.slider} style={{ "--gto": `${gto * 100}%` } as CSSProperties}>
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
        {mode !== "hands" ? <span className={styles.gtoTick} aria-hidden="true" /> : null}
      </span>
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
          className={`${styles.iconButton} ${held[a] ? styles.on : ""}`}
          aria-pressed={held[a]}
          title={t.hold(target.actions[a].name)}
          aria-label={t.hold(target.actions[a].name)}
          onClick={() => setHeld(held.map((x, k) => (k === a ? !x : x)))}
        >
          <Icon name="lock" />
        </button>
      ) : (
        <span />
      )}
    </div>
  );

  let left: ReactNode;
  if (mode === "hands") {
    left = (
      <>
        <p className={styles.label}>{t.brush}</p>
        <div className={styles.brushPresets}>
          {target.actions.map((action, a) => (
            <button
              key={action.label}
              type="button"
              className={`${styles.chip} ${brush[a] === 100 ? styles.on : ""}`}
              onClick={() => setBrush(target.actions.map((_, k) => (k === a ? 100 : 0)))}
            >
              <span className={`${styles.dot} ${colours[a]}`} aria-hidden="true" />
              {action.name}
            </button>
          ))}
        </div>
        {target.actions.map((_, a) => sliderRow(a, brush[a] / 100, (v) => setBrush(brush.map((x, k) => (k === a ? v * 100 : x))), 0, false))}
        <span className={styles.mixBar} aria-hidden="true">
          {brush.map((x, a) => (
            <span key={a} className={colours[a]} style={{ flexGrow: x }} />
          ))}
        </span>
        <p className={styles.hint}>{t.brushHint}</p>
      </>
    );
  } else if (mode === "range") {
    left = (
      <>
        {target.actions.map((_, a) =>
          sliderRow(a, shares[a], (v, merge) => dispatch({ type: "frequency", action: a, target: v, held, merge }), gtoShares[a], target.actions.length > 2),
        )}
        <p className={styles.hint}>{t.rangeHint}</p>
      </>
    );
  } else {
    const mask = classMaskOf;
    const classShares = mask ? sharesOf(target.spot, state.strategy, mask) : null;
    const classGto = mask ? sharesOf(target.spot, target.spot.gto.map((row) => Array.from(row)), mask) : null;
    left = (
      <>
        <ClassList
          classes={classes}
          state={state}
          target={target}
          colours={colours}
          picked={shownClass?.id ?? null}
          onPick={(id) => setKlass(id)}
          madeLabel={t.made}
          drawLabel={t.draws}
        />
        {mask && classShares && classGto ? (
          <div className={styles.classSliders}>
            <p className={styles.label}>{shownClass?.name}</p>
            {target.actions.map((_, a) =>
              sliderRow(
                a,
                classShares[a],
                (v, merge) => dispatch({ type: "frequency", action: a, target: v, mask, held, merge }),
                classGto[a],
                target.actions.length > 2,
              ),
            )}
          </div>
        ) : (
          <p className={styles.hint}>{t.classesHint}</p>
        )}
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
    <div className={styles.grid} role="grid" aria-label={t.editorLabel(target.position)} onPointerLeave={() => (painting.current = false)}>
      {Array.from({ length: 13 }, (_, row) => (
        <div key={row} role="row" className={styles.gridRow}>
          {cells.slice(row * 13, row * 13 + 13).map((c, col) => {
            const k = row * 13 + col;
            const { mix, reach } = mixOf(target, state, c.hands);
            const lockedHere = c.hands.filter((i) => state.locked[i]).length;
            const allLocked = c.hands.length > 0 && lockedHere === c.hands.length;
            const fill = c.all > 0 ? reach / c.all : 0;
            return (
              <div key={c.name} role="gridcell" className={styles.cellWrap}>
                <button
                  type="button"
                  className={`${styles.cell} ${c.hands.length ? "" : styles.cellOff} ${cell === k ? styles.cellPicked : ""}`}
                  aria-label={t.cellLabel(c.name, mixLabel(mix), allLocked)}
                  aria-pressed={cell === k}
                  disabled={!c.hands.length}
                  onPointerDown={(event) => {
                    if (mode !== "hands" || view === "combos") return;
                    event.preventDefault();
                    painting.current = true;
                    paint(c.hands, false);
                  }}
                  onPointerEnter={() => {
                    if (painting.current && mode === "hands" && view !== "combos") paint(c.hands, true);
                  }}
                  onClick={(event) => {
                    // A paint happened on pointer down; a keyboard click paints here.
                    if (mode === "hands" && view !== "combos" && event.detail === 0) paint(c.hands, false);
                    if (mode !== "hands" || view === "combos") setCell(cell === k ? null : k);
                  }}
                >
                  {c.hands.length ? (
                    <span className={styles.cellFill} style={{ blockSize: `${Math.max(8, fill * 100)}%` }} aria-hidden="true">
                      {mix.map((x, a) => (x > 0 ? <span key={a} className={colours[a]} style={{ inlineSize: `${x * 100}%` }} /> : null))}
                    </span>
                  ) : null}
                  <span className={styles.cellName}>{c.name}</span>
                  {lockedHere ? (
                    <span className={`${styles.badge} ${allLocked ? "" : styles.badgePart}`} aria-hidden="true">
                      <Icon name="lock" />
                    </span>
                  ) : null}
                </button>
                {c.hands.length && mode !== "hands" ? (
                  <button
                    type="button"
                    className={styles.badgeButton}
                    title={t.toggleLock(c.name)}
                    aria-label={t.toggleLock(c.name)}
                    onClick={() => dispatch({ type: "toggleLock", hands: c.hands })}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  let right: ReactNode;
  if (view === "classes") {
    right = (
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
    right = (
      <div className={view === "combos" ? styles.gridWithCombos : undefined}>
        {grid}
        {view === "combos" ? (
          cell !== null && cells[cell].hands.length ? (
            <ul className={styles.tiles} aria-label={cells[cell].name}>
              {cells[cell].hands.map((i) => {
                const mix = state.strategy.map((row) => row[i]);
                return (
                  <li key={i}>
                    <button
                      type="button"
                      className={`${styles.tile} ${state.locked[i] ? styles.tileLocked : ""}`}
                      aria-label={t.cellLabel(target.cards[i], mixLabel(mix), Boolean(state.locked[i]))}
                      onClick={() => (mode === "hands" ? paint([i], false) : dispatch({ type: "toggleLock", hands: [i] }))}
                    >
                      <span className={styles.tileFill} aria-hidden="true">
                        {mix.map((x, a) => (
                          <span key={a} className={colours[a]} style={{ blockSize: `${x * 100}%` }} />
                        ))}
                      </span>
                      <span className={styles.tileCards}>
                        <ComboText cards={target.cards[i]} />
                      </span>
                      {state.locked[i] ? (
                        <span className={styles.badge} aria-hidden="true">
                          <Icon name="lock" />
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={styles.hint}>{t.pickCell}</p>
          )
        ) : null}
      </div>
    );
  }

  const running = session.running;
  const memoryMb = info?.memoryMb ?? 0;

  return (
    <dialog
      ref={dialog}
      className={styles.editor}
      aria-label={t.editorLabel(target.position)}
      onCancel={(event) => {
        event.preventDefault();
        closeEditor();
      }}
    >
      <header className={styles.head}>
        <CardRow cards={[...target.at.board]} size="sm" />
        <p className={styles.where}>
          <strong>{solverT.panel.toAct(target.position)}</strong> <span>{solverT.panel.pot(target.pot, target.toCall)}</span>
        </p>
        <div className={styles.headTools}>
          <button type="button" className="btn btn--sm btn--ghost" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>
            {t.undo}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
            {t.redo}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" disabled={!counts.locked} onClick={() => dispatch({ type: "reset" })}>
            {t.reset}
          </button>
          <button type="button" className="btn btn--icon btn--ghost" aria-label={t.close} title={t.close} onClick={closeEditor}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.left}>
          <div className={styles.tabs} role="tablist" aria-label={t.modesLabel}>
            {(["hands", "range", "classes"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={styles.tab} onClick={() => setMode(m)}>
                {t.modes[m]}
              </button>
            ))}
          </div>
          <div className={styles.leftBody}>{left}</div>
          {archetypes.length ? (
            <section className={styles.suggestions} aria-label={t.suggestions}>
              <p className={styles.label}>{t.suggestions}</p>
              <div className={styles.chips}>
                {archetypes.map((archetype) => (
                  <button
                    key={archetype}
                    type="button"
                    className={`${styles.chip} ${state.preset === archetype ? styles.on : ""}`}
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

        <section className={styles.right}>
          <div className={styles.toolbar}>
            <div className={styles.tabs} role="tablist" aria-label={t.viewsLabel}>
              {(["range", "classes", "combos"] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} className={styles.tab} onClick={() => setView(v)}>
                  {t.views[v]}
                </button>
              ))}
            </div>
            <div className={styles.lockTools}>
              <button type="button" className="btn btn--sm" onClick={() => dispatch({ type: "lockAll" })}>
                <Icon name="lock" /> {t.lockAll}
              </button>
              <button type="button" className="btn btn--sm" disabled={!counts.locked} onClick={() => dispatch({ type: "unlockAll" })}>
                {t.unlockAll}
              </button>
              <button type="button" className="btn btn--sm" onClick={() => dispatch({ type: "invert" })}>
                {t.invert}
              </button>
            </div>
          </div>
          <div className={styles.current} aria-label={t.current}>
            <span className={styles.currentBar}>
              {shares.map((x, a) => (
                <span key={a} className={colours[a]} style={{ flexGrow: x }} />
              ))}
              {gtoShares.slice(0, -1).map((_, a) => (
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
                  <span className={`${styles.dot} ${colours[a]}`} aria-hidden="true" />
                  {action.name} <strong>{pctText(shares[a])}</strong> <small>{`${t.gto} ${pctText(gtoShares[a])}`}</small>
                </span>
              ))}
              <span className={styles.lockedCount}>{t.locked(counts.locked, counts.reaching)}</span>
            </span>
          </div>
          {right}
        </section>
      </div>

      <footer className={styles.foot}>
        <div className={styles.footGroup} role="radiogroup" aria-label={t.earlierLabel}>
          <span className={styles.label}>{t.earlierLabel}</span>
          {(["none", "player", "all"] as const).map((x) => (
            <button key={x} type="button" role="radio" aria-checked={earlier === x} className={styles.seg} onClick={() => setEarlier(x)}>
              {t.earlier[x]}
            </button>
          ))}
        </div>
        <div className={styles.footGroup} role="radiogroup" aria-label={t.accuracyLabel}>
          <span className={styles.label}>{t.accuracyLabel}</span>
          {([1, 2.5] as const).map((x) => (
            <button key={x} type="button" role="radio" aria-checked={accuracy === x} className={styles.seg} onClick={() => setAccuracy(x)}>
              {x === 1 ? t.accuracy.standard : t.accuracy.quick}
            </button>
          ))}
        </div>
        <div className={styles.solve}>
          <button type="button" className="btn btn--primary" disabled={Boolean(running) || info?.kind === null} onClick={() => void solve()}>
            {t.solve}
          </button>
          <p className={styles.engineLine}>
            {message ?? (running ? t.busy : info === null ? "" : info.kind === null ? t.noEngine : t.engineLine(info.threads, info.cores, memoryMb))}
          </p>
        </div>
      </footer>
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
                return (
                  <li key={`${group}${c.id.index}`} className={styles.classRow}>
                    <button type="button" className={`${styles.classPick} ${on ? styles.on : ""}`} aria-pressed={on} onClick={() => onPick(c.id)}>
                      <span className={styles.className}>{c.name}</span>
                      <span className={styles.classCombos}>{Math.round(reach * 10) / 10}</span>
                      <span className={styles.mixBar} aria-hidden="true">
                        {mix.map((x, a) => (
                          <span key={a} className={colours[a]} style={{ flexGrow: x }} />
                        ))}
                      </span>
                    </button>
                    {onLock && lockLabel ? (
                      <button
                        type="button"
                        className={`${styles.iconButton} ${locked === c.hands.length ? styles.on : ""}`}
                        aria-pressed={locked === c.hands.length}
                        title={lockLabel(c.name)}
                        aria-label={lockLabel(c.name)}
                        onClick={() => onLock(c.hands)}
                      >
                        <Icon name="lock" />
                      </button>
                    ) : locked ? (
                      <span className={styles.classLocked} aria-hidden="true">
                        <Icon name="lock" />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
