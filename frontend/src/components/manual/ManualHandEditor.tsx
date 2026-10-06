/**
 * `/convert/manual`: build a hand by hand.
 *
 * Four panels top to bottom, in the order a hand happens — the game, the
 * players, the action, the showdown — and the finished hand under them. The
 * editor owns one serializable `EditorState`; the engine, the settlement and
 * the built PHF hand are all derived from it on every render (they are cheap:
 * a hand is a few dozen actions), so there is no second copy of anything to
 * drift.
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
  type ManualMeta,
} from "../../lib/manual";
import { ActionPanel } from "./ActionPanel";
import { CardDialog, type CardTarget } from "./CardDialog";
import {
  cardsBySeat,
  clearStored,
  defaultState,
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

  return (
    <div className="stack">
      <div className={styles.toolbar}>
        <div className={styles.modeSwitch} role="group" aria-label={t.amounts.label}>
          <span className={styles.modeLabel}>{t.amounts.label}</span>
          {(["bb", "money"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`chip-btn ${state.amountMode === mode ? "is-active" : ""}`}
              aria-pressed={state.amountMode === mode}
              onClick={() => update({ amountMode: mode })}
            >
              {mode === "bb" ? t.amounts.bb : state.format === "cash" && state.currency !== "CHIPS" ? unit.code : t.amounts.money}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
          {t.reset}
        </button>
      </div>

      {restored ? <p className="notice notice--info">{t.restored}</p> : null}

      <GamePanel state={state} update={update} />
      <PlayersPanel state={state} update={update} engine={engine} onPickCards={setCardTarget} {...fmtProps} />

      {problems.length > 0 ? (
        <ul className={`notice notice--warn ${styles.problems}`}>
          {problems.map((problem) => (
            <li key={problem}>{t.setupProblems[problem]}</li>
          ))}
        </ul>
      ) : null}

      <ActionPanel
        state={state}
        update={update}
        engine={engine}
        disabled={problems.length > 0}
        onPickBoard={() => setCardTarget({ kind: "board" })}
        {...fmtProps}
      />

      {engine.status.kind === "complete" && problems.length === 0 ? (
        <ResultPanel
          state={state}
          update={update}
          engine={engine}
          settlement={settlement}
          onPickCards={setCardTarget}
          {...fmtProps}
        />
      ) : null}

      <OutputPanel
        built={built}
        stored={stored?.handId === state.handId ? stored : null}
        onStored={(id) => {
          storedHandIdRef.current = state.handId;
          setStored({ handId: state.handId, id });
        }}
        onSaved={onSaved}
      />

      <CardDialog target={cardTarget} state={state} update={update} engine={engine} onClose={() => setCardTarget(null)} />
    </div>
  );
}
