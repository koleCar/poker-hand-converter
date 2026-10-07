/**
 * `/convert/manual`: build a hand on the table.
 *
 * The felt is the page. A settings bar above it holds what is set once per
 * hand (the game, the players, bb or money, undo, a new hand); the table shows
 * the hand as it stands, with the player to act lit; clicking a player opens
 * their action (or their seat) in the panel beside the table, and after every
 * action the panel moves on to the next player. The board is dealt by clicking
 * it, and the picker opens by itself when a street needs cards.
 *
 * The editor owns one serializable `EditorState`; the engine, the settlement,
 * the table frame and the built PHF hand are all derived from it on every
 * render (a hand is a few dozen actions), so there is no second copy of
 * anything to drift.
 *
 * Like the rest of `/convert`, nothing here talks to a server until the user
 * explicitly saves to their library. The unfinished hand is kept in this
 * browser's `localStorage` so a reload does not lose it.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDict } from "../../lib/i18n/client";
import {
  buildManualDraft,
  buildManualHand,
  newManualHandId,
  passUntil,
  replayManual,
  settleManual,
  setupProblems,
  type ManualAction,
  type ManualMeta,
} from "../../lib/manual";
import type { Dict } from "../../lib/i18n/types";
import { formatAmount } from "../../lib/phf/types";
import { Overlay } from "../ui/Overlay";
import { createAmountFormatter } from "../replayer/tableMath";
import { ActionBar } from "./ActionBar";
import { ActionBubble } from "./ActionBubble";
import { ManualTable } from "./ManualTable";
import { SeatPanel } from "./SeatPanel";
import { tableFrame, tableHand } from "./tableFrame";
import { CardDialog, type CardTarget } from "./CardDialog";
import {
  cardsBySeat,
  clearStored,
  defaultState,
  formatFor,
  loadStored,
  setupOf,
  store,
  unitOf,
  type EditorState,
} from "./editorState";
import { GamePanel, PlayersPanel } from "./SetupPanels";
import { OutputPanel } from "./OutputPanel";
import { ResultPanel } from "./ResultPanel";
import styles from "./manual.module.css";

interface ManualHandEditorProps {
  onSaved?: () => void;
}

export function ManualHandEditor({ onSaved }: ManualHandEditorProps) {
  const t = useDict().manual;
  const [state, setState] = useState<EditorState>(() => defaultState(t.players.defaultName));
  const [restored, setRestored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [cardTarget, setCardTarget] = useState<CardTarget | null>(null);
  /** Seat picked on the felt; null follows the player to act. */
  const [selected, setSelected] = useState<number | null>(null);
  const [settings, setSettings] = useState<"game" | "players" | null>(null);
  /** How many entered actions the table is showing; null is the end of the hand. */
  const [cursor, setCursor] = useState<number | null>(null);

  // Restore after mount, not in the initial state: the server render has no
  // storage, and the first client render has to match it.
  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setState(stored);
      setRestored(stored.actions.length > 0);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) store(state);
  }, [state, loaded]);

  /** The library row of the hand as last saved, keyed by its hand number. */
  const [stored, setStored] = useState<{ handId: string; id: string | null } | null>(null);
  const storedHandIdRef = useRef<string | null>(null);

  const update = (patch: Partial<EditorState> | ((current: EditorState) => EditorState)) =>
    setState((current) => {
      const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      // Editing a hand that is already saved makes a different hand: give it a
      // new number, or saving it would be refused as a duplicate of the old one.
      if (next !== current && storedHandIdRef.current === current.handId) {
        return { ...next, handId: newManualHandId() };
      }
      return next;
    });

  const setup = useMemo(() => setupOf(state), [state]);
  const problems = useMemo(() => setupProblems(setup), [setup]);
  const unit = unitOf(state);
  const cards = useMemo(() => cardsBySeat(state), [state]);
  const engine = useMemo(() => replayManual(setup, state.actions, state.board), [setup, state.actions, state.board]);
  const settlement = useMemo(
    () => settleManual(engine, state.board, cards, state.format === "cash" ? state.rake : 0, state.picks),
    [engine, state.board, cards, state.rake, state.picks, state.format],
  );

  const meta: ManualMeta = {
    format: state.format,
    currency: state.currency,
    tableName: state.tableName,
    playedAt: state.playedAt,
    tournament: state.format === "tournament" ? state.tournament : null,
    handId: state.handId,
  };
  const built = useMemo(() => {
    if (problems.length > 0 || !settlement.resolved) return null;
    const draft = buildManualDraft(engine, settlement, state.board, cards, meta);
    return buildManualHand(draft, meta);
    // `meta` is rebuilt every render from fields of `state` that are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problems, settlement, engine, state.board, cards, state.format, state.currency, state.tableName, state.playedAt, state.tournament, state.handId]);

  const reset = () => {
    if (!window.confirm(t.resetConfirm)) return;
    clearStored();
    setRestored(false);
    storedHandIdRef.current = null;
    setState(defaultState(t.players.defaultName));
  };

  const fmtProps = { mode: state.amountMode, unit, bigBlind: state.bigBlind };
  const fmt = (amount: number) => formatFor(amount, state.amountMode, unit, state.bigBlind);
  const status = engine.status;
  const actorSeat = status.kind === "betting" ? status.options.seat : null;
  // The panel follows whoever is to act unless a seat was picked on the felt.
  const focused = selected !== null && engine.players.some((p) => p.seat === selected) ? selected : actorSeat;

  // Picking a seat further round the table skips ahead to it: the seats in
  // between pass (fold preflop, check when there is nothing to call). The
  // table previews that, and the bubble offers the picked seat's options.
  const jump = useMemo(() => {
    if (actorSeat === null || problems.length > 0) return null;
    return passUntil(setup, state.actions, state.board)(focused ?? actorSeat);
  }, [setup, state.actions, state.board, focused, actorSeat, problems.length]);
  // Stepping back through the hand shows the table as it was after `cursor`
  // actions. Nothing is changed by looking; entering an action or undoing
  // returns to the end.
  const viewing = cursor !== null && cursor < engine.validCount;
  const past = useMemo(
    () => (viewing ? replayManual(setup, state.actions.slice(0, cursor!), state.board) : null),
    [viewing, setup, state.actions, cursor, state.board],
  );
  const step = (to: number | null) => setCursor(to === null || to >= engine.validCount ? null : Math.max(0, to));
  const position = viewing ? cursor! : engine.validCount;

  const shown = past ?? jump?.state ?? engine;
  const bubbleStatus = viewing ? undefined : jump?.state.status;
  const skipped = jump ? jump.actions.slice(engine.validCount) : [];

  /** Adds a decision (and any passes skipped over), dropping what no longer fits. */
  const act = (action: ManualAction) => {
    const actions = [...(jump?.actions ?? state.actions.slice(0, engine.validCount)), action];
    update({ actions });
    setSelected(null);
    setCursor(null);
    // The street closed and needs cards: open the picker straight away.
    if (replayManual(setup, actions, state.board).status.kind === "needs-board") {
      setCardTarget({ kind: "board" });
    }
  };
  const undo = () => {
    setCursor(null);
    update((current) => ({ ...current, actions: current.actions.slice(0, Math.max(0, engine.validCount - 1)), picks: {} }));
  };

  // The arrow keys step through the hand, unless a field or a dialog has them.
  const stepRef = useRef(step);
  stepRef.current = step;
  const positionRef = useRef(position);
  positionRef.current = position;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, dialog")) return;
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === "ArrowLeft") stepRef.current(positionRef.current - 1);
      else if (event.key === "ArrowRight") stepRef.current(positionRef.current + 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const format = useMemo(
    () => createAmountFormatter(state.amountMode === "bb" ? "bb" : "chips", unit, state.bigBlind),
    [state.amountMode, unit, state.bigBlind],
  );
  const frame = useMemo(
    () =>
      tableFrame(
        state,
        shown,
        !viewing && status.kind === "complete" ? settlement : null,
        unit,
        (entry, amount) => t.table.pills[entry.kind](amount),
        (amount) => format(amount / unit.minorUnits, amount / state.bigBlind),
      ),
    [state, shown, viewing, status.kind, settlement, unit, t, format],
  );
  const actor = shown.players.find((p) => p.seat === (bubbleStatus?.kind === "betting" ? bubbleStatus.options.seat : actorSeat));
  const tableRef = useRef<HTMLDivElement>(null);
  const positionOf = (seat: number) => {
    const player = engine.players.find((p) => p.seat === seat);
    return player?.position ?? player?.name ?? "";
  };

  return (
    <div className="stack">
      {restored ? <p className="notice notice--info">{t.restored}</p> : null}

      <div className={styles.settingsBar}>
        <div className={styles.summary}>
          <strong>{gameLabelFor(state, t)}</strong>
          <span>{t.bar.stakes(formatAmount(state.smallBlind, unit), formatAmount(state.bigBlind, unit))}</span>
          <span>{t.game.tableSizeOption(state.maxSeats)}</span>
          <span>{t.bar.effective(formatFor(effectiveStack(state), state.amountMode, unit, state.bigBlind))}</span>
        </div>
        <div className={styles.row}>
          <button type="button" className="btn btn--sm" onClick={() => setSettings("game")}>
            ⚙ {t.bar.game}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setSettings("players")}>
            {t.bar.players}
          </button>
          <div className={styles.modeSwitch} role="group" aria-label={t.amounts.label}>
            {(["bb", "money"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`chip-btn ${state.amountMode === mode ? "is-active" : ""}`}
                aria-pressed={state.amountMode === mode}
                onClick={() => update({ amountMode: mode })}
              >
                {mode === "bb" ? "bb" : state.format === "cash" && state.currency !== "CHIPS" ? unit.code : t.amounts.money}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
            {t.reset}
          </button>
        </div>
      </div>

      <div className={styles.workspace}>
        <div className={styles.tableCol}>
          <div ref={tableRef}>
            <ManualTable
              hand={tableHand(state, unit)}
              frame={frame}
              format={format}
              selectedSeat={selected}
              onSeatClick={(seat) => {
                setCursor(null);
                setSelected(seat === actorSeat ? null : seat);
              }}
              onSeatCardsClick={(seat) => setCardTarget({ kind: "seat", seat })}
              onBoardClick={() => setCardTarget({ kind: "board" })}
            />
          </div>
          <div className={styles.nav} role="group" aria-label={t.nav.label}>
            <button type="button" className="btn btn--sm" disabled={position === 0} onClick={() => step(0)} aria-label={t.nav.start} title={t.nav.start}>
              ⏮
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={position === 0}
              onClick={() => step(position - 1)}
              aria-label={t.nav.back}
              title={t.nav.back}
            >
              ◀ {t.nav.back}
            </button>
            <span className={styles.navStep}>{t.nav.step(position, engine.validCount)}</span>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!viewing}
              onClick={() => step(position + 1)}
              aria-label={t.nav.forward}
              title={t.nav.forward}
            >
              {t.nav.forward} ▶
            </button>
            <button type="button" className="btn btn--sm" disabled={!viewing} onClick={() => step(null)} aria-label={t.nav.end} title={t.nav.end}>
              ⏭
            </button>
            <button type="button" className={`btn ${styles.undo}`} disabled={engine.validCount === 0} onClick={undo}>
              ↶ {t.actions.undo}
            </button>
          </div>
          {/* After mount only: the bubble is a portal, which the server cannot render. */}
          {loaded && bubbleStatus?.kind === "betting" && actor && !cardTarget && !settings ? (
            <ActionBubble tableRef={tableRef} seat={actor.seat} layoutKey={`${state.actions.length}-${focused}-${state.amountMode}`}>
              <ActionBar
                key={`${engine.validCount}-${actor.seat}-${state.amountMode}`}
                options={bubbleStatus.options}
                player={actor}
                street={shown.street}
                onAct={act}
                note={
                  skipped.length > 0
                    ? t.table.skipped(
                        skipped.map((pass) => `${positionOf(pass.seat)} ${t.table.pills[pass.kind as "fold" | "check"]()}`).join(", "),
                      )
                    : null
                }
                {...fmtProps}
              />
            </ActionBubble>
          ) : null}
          <div className={styles.strip} aria-live="polite">
            {viewing ? (
              <span className={styles.dim}>{t.nav.reviewing}</span>
            ) : problems.length > 0 ? (
              <>
                <span className="notice notice--warn">{t.setupProblems[problems[0]]}</span>
                <button type="button" className="btn btn--sm" onClick={() => setSettings("players")}>
                  {t.bar.players}
                </button>
              </>
            ) : bubbleStatus?.kind === "betting" && actor ? (
              <>
                <strong className={styles.next}>{t.table.next(actor.position ?? "", actor.name)}</strong>
                <span className={styles.dim}>
                  {t.actions.pot(fmt(bubbleStatus.options.pot))}
                  {bubbleStatus.options.toCall > 0 ? ` · ${t.actions.toCall(fmt(bubbleStatus.options.toCall))}` : ""}
                </span>
                <span className={styles.dim}>{t.table.hint}</span>
              </>
            ) : status.kind === "needs-board" ? (
              <>
                <strong className={styles.next}>{status.runout ? t.actions.runout : t.actions.dealStreet[status.street]}</strong>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setCardTarget({ kind: "board" })}>
                  {t.actions.dealStreet[status.street]}
                </button>
              </>
            ) : status.kind === "complete" ? (
              <strong className={styles.next}>
                {status.ending === "fold"
                  ? t.actions.wonUncontested(engine.players.find((p) => !p.folded)?.name ?? "")
                  : t.actions.showdown}
              </strong>
            ) : null}
          </div>
        </div>

        <aside className={styles.side}>
          {problems.length === 0 && status.kind === "complete" ? (
            <ResultPanel
              state={state}
              update={update}
              engine={engine}
              settlement={settlement}
              onPickCards={setCardTarget}
              {...fmtProps}
            />
          ) : problems.length === 0 && focused !== null ? (
            <SeatPanel seat={focused} state={state} update={update} engine={engine} onPickCards={setCardTarget} {...fmtProps} />
          ) : null}
        </aside>
      </div>

      <OutputPanel
        built={built}
        stored={stored?.handId === state.handId ? stored : null}
        onStored={(id) => {
          storedHandIdRef.current = state.handId;
          setStored({ handId: state.handId, id });
        }}
        onSaved={onSaved}
      />

      <Overlay open={settings === "game"} onClose={() => setSettings(null)} title={t.game.heading} className={styles.settingsDialog}>
        <GamePanel state={state} update={update} />
      </Overlay>
      <Overlay
        open={settings === "players"}
        onClose={() => setSettings(null)}
        title={t.players.heading}
        className={styles.settingsDialog}
      >
        <PlayersPanel state={state} update={update} engine={engine} onPickCards={setCardTarget} {...fmtProps} />
      </Overlay>

      <CardDialog target={cardTarget} state={state} update={update} engine={engine} onClose={() => setCardTarget(null)} />
    </div>
  );
}

function gameLabelFor(state: EditorState, t: Dict["manual"]): string {
  const limit = state.limit === "pl" ? "PL" : "NL";
  return `${limit} ${t.game[state.variant]}`;
}

/** Hero against the deepest opponent, from the starting stacks. */
function effectiveStack(state: EditorState): number {
  const taken = state.seats.filter((seat) => seat.taken);
  const hero = taken.find((seat) => seat.seat === state.heroSeat);
  const deepest = Math.max(0, ...taken.filter((seat) => seat.seat !== state.heroSeat).map((seat) => seat.stack));
  return hero ? Math.min(hero.stack, deepest) : 0;
}
