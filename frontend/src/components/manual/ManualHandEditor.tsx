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
import { HandLog } from "./ActionPanel";
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

  /** Adds a decision, dropping whatever no longer fits after the valid prefix. */
  const act = (action: ManualAction) => {
    const actions = [...state.actions.slice(0, engine.validCount), action];
    update({ actions });
    setSelected(null);
    // The street closed and needs cards: open the picker straight away.
    if (replayManual(setup, actions, state.board).status.kind === "needs-board") {
      setCardTarget({ kind: "board" });
    }
  };
  const undo = () =>
    update((current) => ({ ...current, actions: current.actions.slice(0, Math.max(0, engine.validCount - 1)), picks: {} }));

  const format = useMemo(
    () => createAmountFormatter(state.amountMode === "bb" ? "bb" : "chips", unit, state.bigBlind),
    [state.amountMode, unit, state.bigBlind],
  );
  const frame = useMemo(
    () =>
      tableFrame(
        state,
        engine,
        status.kind === "complete" ? settlement : null,
        unit,
        (entry, amount) => t.table.pills[entry.kind](amount),
        (amount) => format(amount / unit.minorUnits, amount / state.bigBlind),
      ),
    [state, engine, status.kind, settlement, unit, t, format],
  );
  const actor = engine.players.find((p) => p.seat === actorSeat);

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
          <button type="button" className="btn btn--sm" disabled={engine.validCount === 0} onClick={undo}>
            ↶ {t.actions.undo}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
            {t.reset}
          </button>
        </div>
      </div>

      <div className={styles.workspace}>
        <div className={styles.tableCol}>
          <ManualTable
            hand={tableHand(state, unit)}
            frame={frame}
            format={format}
            selectedSeat={selected}
            onSeatClick={(seat) => setSelected(seat === actorSeat ? null : seat)}
            onBoardClick={() => setCardTarget({ kind: "board" })}
          />
          <div className={styles.strip} aria-live="polite">
            {problems.length > 0 ? (
              <>
                <span className="notice notice--warn">{t.setupProblems[problems[0]]}</span>
                <button type="button" className="btn btn--sm" onClick={() => setSettings("players")}>
                  {t.bar.players}
                </button>
              </>
            ) : status.kind === "betting" && actor ? (
              <>
                <strong className={styles.next}>{t.table.next(actor.position ?? "", actor.name)}</strong>
                <span className={styles.dim}>
                  {t.actions.pot(fmt(status.options.pot))}
                  {status.options.toCall > 0 ? ` · ${t.actions.toCall(fmt(status.options.toCall))}` : ""}
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
            <SeatPanel
              seat={focused}
              state={state}
              update={update}
              engine={engine}
              onAct={act}
              onSelect={setSelected}
              onPickCards={setCardTarget}
              {...fmtProps}
            />
          ) : null}
          {problems.length === 0 ? (
            <HandLog
              state={state}
              update={update}
              engine={engine}
              onPickBoard={() => setCardTarget({ kind: "board" })}
              {...fmtProps}
            />
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
