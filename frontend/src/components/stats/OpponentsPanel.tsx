/**
 * Opponents: the HUD you keep on the regulars, and what you make against each.
 *
 * Off by default, because it is not free: a row per opponent per hand is about
 * six times the storage of the hero's own statistics. Switching it on derives
 * rows for the library already stored (server-side, the same rebuild the
 * coverage badge uses); switching it off deletes them again — they are pure
 * functions of the hands, so nothing is lost either way.
 *
 * Two kinds of room are never in this list, and the panel says so rather than
 * quietly showing fewer people:
 *   - positional rooms (Ignition) have no opponent rows at all — the "name" is
 *     a seat label that is a different person every hand;
 *   - opaque-id rooms (GGPoker) have rows, but their names do not survive a
 *     session, so summing one across sessions would invent a person.
 */

"use client";

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  fetchStatsOpponents,
  myPlayerNotes,
  pruneVillainStats,
  rebuildStats,
  setPlayerNote,
  setVillainRowsEnabled,
  villainRowsEnabled,
  type PlayerNote,
  type OpponentFilters,
  type StatsFilters,
  type StatsOpponents,
} from "../../lib/db";
import { getParser } from "../../lib/phf";
import { emptyMoney, rates } from "../../lib/stats";
import { count } from "./format";

const PCT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const AF = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const BB = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, signDisplay: "exceptZero" });

const MIN_HANDS_OPTIONS = [1, 10, 50, 200];

/** Storage changes in this tab come through `setEnabled`; nothing to subscribe to. */
const subscribeNever = () => () => undefined;

type Phase =
  | { kind: "idle" }
  | { kind: "working"; label: string; done: number }
  | { kind: "error"; message: string };

function pct(value: number | null): string {
  return value === null ? "—" : PCT.format(value);
}

export function OpponentsPanel({
  filters,
  refreshToken,
}: {
  filters: StatsFilters;
  refreshToken: number;
}) {
  // The setting lives in this browser's storage, which the server render cannot
  // see: null until hydrated, so neither card flashes in the wrong state.
  const stored = useSyncExternalStore(subscribeNever, villainRowsEnabled, () => null);
  const [override, setEnabled] = useState<boolean | null>(null);
  const enabled = override ?? stored;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [search, setSearch] = useState("");
  const [minHands, setMinHands] = useState(10);
  const [data, setData] = useState<StatsOpponents | null>(null);
  const [version, setVersion] = useState(0);
  // #54: the caller's private notes, keyed `site:player`.
  const [notes, setNotes] = useState<Map<string, PlayerNote>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (stored) {
      // Catch up on anything uploaded from another browser, where the setting
      // was off. Cheap when there is nothing to do: one request.
      void rebuildStats().then(
        () => setVersion((value) => value + 1),
        () => undefined,
      );
    }
  }, [stored]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    myPlayerNotes().then(
      (list) => {
        if (live) setNotes(new Map(list.map((note) => [`${note.site}:${note.player}`, note])));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled]);

  const saveNote = useCallback(async (site: string, player: string, note: string, tags: string[]) => {
    const saved = await setPlayerNote(site, player, note, tags);
    setNotes((current) => {
      const next = new Map(current);
      if (saved) next.set(`${site}:${player}`, saved);
      else next.delete(`${site}:${player}`);
      return next;
    });
    setEditing(null);
  }, []);

  const requestKey = JSON.stringify({ ...filters, minHands } satisfies OpponentFilters);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let live = true;
    const handle = window.setTimeout(() => {
      fetchStatsOpponents(JSON.parse(requestKey) as OpponentFilters, search.trim()).then(
        (next) => {
          if (live) {
            setData(next);
          }
        },
        (failure: unknown) => {
          if (live) {
            setPhase({ kind: "error", message: failure instanceof Error ? failure.message : String(failure) });
          }
        },
      );
    }, search ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(handle);
    };
  }, [enabled, requestKey, search, refreshToken, version]);

  const turnOn = useCallback(async () => {
    if (!setVillainRowsEnabled(true)) {
      setPhase({ kind: "error", message: "This browser would not save the setting (private mode?)." });
      return;
    }
    setEnabled(true);
    setPhase({ kind: "working", label: "Reading opponents from your hands…", done: 0 });
    try {
      await rebuildStats((progress) =>
        setPhase({ kind: "working", label: "Reading opponents from your hands…", done: progress.processed }),
      );
      setPhase({ kind: "idle" });
      setVersion((value) => value + 1);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const turnOff = useCallback(async () => {
    setVillainRowsEnabled(false);
    setEnabled(false);
    setData(null);
    setPhase({ kind: "working", label: "Removing opponent statistics…", done: 0 });
    try {
      await pruneVillainStats();
      setPhase({ kind: "idle" });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  if (enabled === null) {
    return null;
  }

  const status =
    phase.kind === "working" ? (
      <p className="notice notice--info" role="status" aria-live="polite">
        {phase.label} {phase.done > 0 ? `${count(phase.done)} hands` : ""}
      </p>
    ) : phase.kind === "error" ? (
      <p className="notice notice--error">{phase.message}</p>
    ) : null;

  if (!enabled) {
    return (
      <section className="card stats-group">
        <div className="card__head">
          <h3>Opponents</h3>
        </div>
        {status}
        <p className="muted">
          A HUD on every regular you have played, and what you win or lose against each. It
          stores a row per opponent per hand — roughly six times the space your own statistics
          take — so it is off until you turn it on. Turning it off later deletes those rows;
          your hands and your own numbers are untouched either way.
        </p>
        <div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={phase.kind === "working"}
            onClick={() => void turnOn()}
          >
            Turn on opponent statistics
          </button>
        </div>
      </section>
    );
  }

  const rows = data?.rows ?? [];

  return (
    <section className="card stats-group">
      <div className="card__head stats-breakdown__head">
        <h3>Opponents</h3>
        <div className="stats-matrix__controls">
          <label className="field">
            <span className="field__label">Find a player</span>
            <input
              type="search"
              value={search}
              placeholder="Screen name"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">At least</span>
            <select value={minHands} onChange={(event) => setMinHands(Number(event.target.value))}>
              {MIN_HANDS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? "any sample" : `${value} hands`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {status}

      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col" className="num">Hands</th>
              <th scope="col" className="num" title="Voluntarily put money in pot">VPIP</th>
              <th scope="col" className="num" title="Preflop raise">PFR</th>
              <th scope="col" className="num" title="3-bet facing one raise">3-bet</th>
              <th scope="col" className="num" title="Fold to 3-bet after opening">F3B</th>
              <th scope="col" className="num" title="Flop continuation bet">Cbet</th>
              <th scope="col" className="num" title="Fold to a flop continuation bet">FvCb</th>
              <th scope="col" className="num" title="Postflop (bets + raises) / calls">AF</th>
              <th scope="col" className="num" title="Went to showdown, having seen a flop">WTSD</th>
              {data && !data.mixedUnitKind ? (
                <th scope="col" className="num" title="Your result in the hands they were dealt into">
                  You vs them
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const r = rates({ counters: row.counters, money: emptyMoney(), moneyHands: 0 });
              const room = getParser(row.site)?.name ?? row.site;
              const noteKey = `${row.site}:${row.player}`;
              const note = notes.get(noteKey);
              return (
                <Fragment key={noteKey}>
                <tr>
                  <th scope="row">
                    {row.player}
                    <span className="stats-opponents__room">{room}</span>
                    <button
                      type="button"
                      className="stats-opponents__note"
                      aria-expanded={editing === noteKey}
                      onClick={() => setEditing(editing === noteKey ? null : noteKey)}
                      title={note?.note || "Add a private note"}
                    >
                      {note ? [note.tags.join(" · "), note.note].filter(Boolean).join(" — ") : "+ note"}
                    </button>
                  </th>
                  <td className="num">{count(row.counters.hands)}</td>
                  <td className="num">{pct(r.vpip)}</td>
                  <td className="num">{pct(r.pfr)}</td>
                  <td className={`num ${row.counters.three_bet_opp < 20 ? "is-thin" : ""}`}>{pct(r.threeBet)}</td>
                  <td className={`num ${row.counters.fold_to_three_bet_opp < 20 ? "is-thin" : ""}`}>
                    {pct(r.foldToThreeBet)}
                  </td>
                  <td className={`num ${row.counters.cbet_flop_opp < 20 ? "is-thin" : ""}`}>{pct(r.cbetFlop)}</td>
                  <td className={`num ${row.counters.fold_to_cbet_flop_opp < 20 ? "is-thin" : ""}`}>
                    {pct(r.foldToCbetFlop)}
                  </td>
                  <td className="num">{r.aggressionFactor === null ? "—" : AF.format(r.aggressionFactor)}</td>
                  <td className={`num ${row.counters.wtsd_opp < 20 ? "is-thin" : ""}`}>{pct(r.wtsd)}</td>
                  {data && !data.mixedUnitKind ? (
                    <td
                      className={`num ${
                        row.heroNetBb === null ? "" : row.heroNetBb >= 0 ? "is-up" : "is-down"
                      } ${row.heroMoneyHands < 100 ? "is-thin" : ""}`}
                      title={`over ${count(row.heroMoneyHands)} hands`}
                    >
                      {row.heroNetBb === null ? "—" : `${BB.format(row.heroNetBb)} bb`}
                    </td>
                  ) : null}
                </tr>
                {editing === noteKey ? (
                  <tr>
                    <td colSpan={11}>
                      <NoteEditor
                        note={note ?? null}
                        onSave={(text, tags) => saveNote(row.site, row.player, text, tags)}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              );
            })}
            {data && rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  {search ? "Nobody by that name in this scope." : "No opponents in this scope yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="muted stats-breakdown__note">
        {data && data.opaqueRows > 0
          ? `${count(data.opaqueRows)} opponent-hands from rooms that hide names between sessions (GGPoker) are not listed — the same tag in two sessions may be two people. `
          : ""}
        Rooms that label seats by position (Ignition) never record opponents.{" "}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void turnOff()}>
          Turn off and delete opponent statistics
        </button>
      </p>
    </section>
  );
}

/**
 * A private note on one opponent: free text and a few tags. Saved through
 * `set_player_note`, which refuses players the caller has not sat with in a
 * room that shows real names — so a note can never attach to a seat label.
 */
function NoteEditor({
  note,
  onSave,
  onCancel,
}: {
  note: PlayerNote | null;
  onSave: (note: string, tags: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(note?.note ?? "");
  const [tags, setTags] = useState((note?.tags ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(clear = false) {
    setBusy(true);
    setError(null);
    try {
      await onSave(
        clear ? "" : text,
        clear ? [] : tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^[a-z_]+:\s*/, "") : String(failure));
      setBusy(false);
    }
  }

  return (
    <div className="stats-note">
      <label className="field">
        <span className="field__label">Note (only you see it)</span>
        <textarea value={text} rows={2} maxLength={2000} onChange={(event) => setText(event.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Tags, comma-separated</span>
        <input value={tags} placeholder="nit, station, reg" onChange={(event) => setTags(event.target.value)} />
      </label>
      {error ? <p className="notice notice--error">{error}</p> : null}
      <div className="stats-note__actions">
        <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        {note ? (
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void save(true)}>
            Delete note
          </button>
        ) : null}
        <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
