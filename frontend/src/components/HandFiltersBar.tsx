/**
 * The filter bar over the stored-hand library.
 *
 * Two things shape this file more than anything else.
 *
 * **Money is integer minor units in the database.** The filter form collects
 * display numbers, so "min pot" has to be scaled on the way out — by 100 for a
 * cash table and by 1 for a chip-denominated tournament. A single fixed scale
 * is wrong for half the library, so the scale follows the game filter and the
 * field says which unit it is currently in. See `toHandFilters` in
 * `handFilters.ts`.
 *
 * **Some rooms have no player names.** Ignition / Bodog / Bovada label every
 * seat by its position relative to the button, and the button moves every
 * hand, so the names are not people and are dropped on the way into the
 * database. A name filter can therefore never match one of those hands. Rather
 * than let them vanish silently, the name field says so, and the position
 * filters next to it are the thing that does work on them.
 */

import { useEffect, useMemo, useState } from "react";
import { extractCards, resolveHeroQuery } from "../lib/cards";
import {
  anonymizationNote,
  fetchHandFacets,
  isDatabaseConfigured,
  type HandFacets,
  type PositionLabel,
} from "../lib/db";
import { POSITIONS, type ReplayerFilterForm } from "./handFilters";
import { getParser } from "../lib/phf";
import { CardRow } from "./replayer/PlayingCard";

function siteLabel(id: string): string {
  return getParser(id)?.name ?? id;
}

interface HandFiltersBarProps {
  value: ReplayerFilterForm;
  onApply: (filters: ReplayerFilterForm) => void;
  onReset: () => void;
  loading: boolean;
}

export function HandFiltersBar({ value, onApply, onReset, loading }: HandFiltersBarProps) {
  const [draft, setDraft] = useState<ReplayerFilterForm>(value);
  const [advanced, setAdvanced] = useState(false);
  const [facets, setFacets] = useState<HandFacets | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Facets drive the site list and tell us whether the library actually holds
  // any anonymized hands, so the warning below only appears when it is true.
  useEffect(() => {
    if (!isDatabaseConfigured) {
      return;
    }
    let live = true;
    void fetchHandFacets()
      .then((result) => {
        if (live) setFacets(result);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  function set<K extends keyof ReplayerFilterForm>(key: K, next: ReplayerFilterForm[K]) {
    setDraft((current) => ({ ...current, [key]: next }));
  }

  /** Quick toggles apply immediately; that is the whole point of them. */
  function applyNow(next: ReplayerFilterForm) {
    setDraft(next);
    onApply(next);
  }

  function togglePosition(key: "heroPositions" | "winnerPositions", position: PositionLabel) {
    const current = draft[key];
    set(
      key,
      current.includes(position)
        ? current.filter((entry) => entry !== position)
        : [...current, position],
    );
  }

  const boardPreview = extractCards(draft.board);
  // Same resolution the query uses, so the hint never lies about the filter.
  const heroQuery = resolveHeroQuery(draft.heroCards);

  // Only `positional` rooms are unreachable by name. `opaque-id` rooms do
  // store per-session tokens, so a name search against them is odd but not
  // futile, and counting them here would overstate the loss by six times.
  const positionalCount = useMemo(
    () =>
      (facets?.anonymizations ?? []).find((entry) => entry.value === "positional")?.count ?? 0,
    [facets],
  );
  const positionalNote = anonymizationNote("positional");
  const nameFilterIsLossy = positionalCount > 0 && draft.player.trim().length > 0;

  const potCurrency = draft.gameFormat === "tournament" ? "chips" : "the table currency";

  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <div className="filters__row">
        <label className="field field--grow">
          <span className="field__label">Board</span>
          <input
            type="text"
            value={draft.board}
            placeholder="e.g. Ah Kd 2c  or  AhKd"
            onChange={(event) => set("board", event.target.value)}
          />
          <span className="field__hint">
            {boardPreview.length ? (
              <>
                Hands whose board contains <CardRow cards={boardPreview} size="xs" />
              </>
            ) : (
              "Every card you enter must appear on the board"
            )}
          </span>
        </label>

        <label className="field field--grow">
          <span className="field__label">Hero hole cards</span>
          <input
            type="text"
            value={draft.heroCards}
            placeholder="e.g. AhKs  or  AKs  or  TT"
            onChange={(event) => set("heroCards", event.target.value)}
          />
          <span className="field__hint">
            {heroQuery.kind === "class" ? (
              `Hand class: ${heroQuery.values.join(" / ")}`
            ) : heroQuery.kind === "cards" ? (
              <>
                Exactly <CardRow cards={heroQuery.values} size="xs" />
              </>
            ) : (
              "Exact cards (AhKs) or a hand class (AKs, AKo, AK, TT)"
            )}
          </span>
        </label>

        <div className="filters__actions">
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onReset}>
            Reset
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setAdvanced((current) => !current)}
            aria-expanded={advanced}
          >
            {advanced ? "Fewer filters" : "More filters"}
          </button>
        </div>
      </div>

      <div className="filters__quick">
        <span className="muted">Quick:</span>
        <button
          type="button"
          className={`chip-btn ${draft.showdownOnly ? "is-active" : ""}`}
          aria-pressed={draft.showdownOnly}
          onClick={() => applyNow({ ...draft, showdownOnly: !draft.showdownOnly })}
        >
          Showdown only
        </button>
        <button
          type="button"
          className={`chip-btn ${draft.heroWonOnly ? "is-active" : ""}`}
          aria-pressed={draft.heroWonOnly}
          onClick={() => applyNow({ ...draft, heroWonOnly: !draft.heroWonOnly })}
        >
          Hero in profit
        </button>
        <button
          type="button"
          className={`chip-btn ${draft.sort === "pot_desc" ? "is-active" : ""}`}
          aria-pressed={draft.sort === "pot_desc"}
          onClick={() =>
            applyNow({ ...draft, sort: draft.sort === "pot_desc" ? "played_desc" : "pot_desc" })
          }
        >
          Biggest pots
        </button>
      </div>

      {/* Hero position is the one filter that works on every room, anonymized
          or not, so it sits in the always-visible part of the bar. */}
      <fieldset className="filters__positions">
        <legend className="field__label">Hero position</legend>
        <div className="filters__chips">
          {POSITIONS.map((position) => (
            <button
              key={position}
              type="button"
              className={`chip-btn chip-btn--pos ${draft.heroPositions.includes(position) ? "is-active" : ""}`}
              aria-pressed={draft.heroPositions.includes(position)}
              onClick={() => togglePosition("heroPositions", position)}
            >
              {position}
            </button>
          ))}
          {draft.heroPositions.length ? (
            <button
              type="button"
              className="chip-btn chip-btn--clear"
              onClick={() => set("heroPositions", [])}
            >
              Clear
            </button>
          ) : null}
        </div>
      </fieldset>

      {advanced ? (
        <>
          <div className="filters__row filters__row--advanced">
            <label className="field">
              <span className="field__label">Player at the table</span>
              <input
                type="text"
                value={draft.player}
                placeholder="exact screen name"
                onChange={(event) => set("player", event.target.value)}
              />
              <span className="field__hint">
                {positionalCount > 0
                  ? `Exact screen name. ${positionalCount} hands from rooms that label seats by position cannot match it.`
                  : "Exact screen name, as the room wrote it."}
              </span>
            </label>

            <label className="field">
              <span className="field__label">Site</span>
              <select value={draft.site} onChange={(event) => set("site", event.target.value)}>
                <option value="">Every room</option>
                {(facets?.sites ?? []).map((site) => (
                  <option key={site.value} value={site.value}>
                    {siteLabel(site.value)} ({site.count})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Game</span>
              <select
                value={draft.gameFormat}
                onChange={(event) =>
                  set("gameFormat", event.target.value as ReplayerFilterForm["gameFormat"])
                }
              >
                <option value="">Cash and tournament</option>
                <option value="cash">Cash only</option>
                <option value="tournament">Tournament only</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">Table</span>
              <input
                type="text"
                value={draft.tableName}
                placeholder="e.g. NLHPurple"
                onChange={(event) => set("tableName", event.target.value)}
              />
            </label>

            <label className="field field--narrow">
              <span className="field__label">Min pot</span>
              <input
                type="number"
                step={draft.gameFormat === "tournament" ? "1" : "0.01"}
                min="0"
                value={draft.minPot}
                onChange={(event) => set("minPot", event.target.value)}
              />
              <span className="field__hint">In {potCurrency}</span>
            </label>

            <label className="field field--narrow">
              <span className="field__label">From</span>
              <input
                type="date"
                value={draft.fromDate}
                onChange={(event) => set("fromDate", event.target.value)}
              />
            </label>

            <label className="field field--narrow">
              <span className="field__label">To</span>
              <input
                type="date"
                value={draft.toDate}
                onChange={(event) => set("toDate", event.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">Sort by</span>
              <select
                value={draft.sort}
                onChange={(event) =>
                  set("sort", event.target.value as ReplayerFilterForm["sort"])
                }
              >
                <option value="played_desc">Newest first</option>
                <option value="played_asc">Oldest first</option>
                <option value="pot_desc">Biggest pot</option>
                <option value="profit_desc">Hero's biggest win</option>
                <option value="profit_asc">Hero's biggest loss</option>
              </select>
            </label>
          </div>

          <fieldset className="filters__positions">
            <legend className="field__label">Winner position</legend>
            <div className="filters__chips">
              {POSITIONS.map((position) => (
                <button
                  key={position}
                  type="button"
                  className={`chip-btn chip-btn--pos ${draft.winnerPositions.includes(position) ? "is-active" : ""}`}
                  aria-pressed={draft.winnerPositions.includes(position)}
                  onClick={() => togglePosition("winnerPositions", position)}
                >
                  {position}
                </button>
              ))}
              {draft.winnerPositions.length ? (
                <button
                  type="button"
                  className="chip-btn chip-btn--clear"
                  onClick={() => set("winnerPositions", [])}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <span className="field__hint">
              Who took the pot, by seat. This is the only way to ask that question of a room that
              does not give you names.
            </span>
          </fieldset>
        </>
      ) : null}

      {/* Shown once the user has actually typed a name, because that is the
          moment the missing hands would otherwise disappear without comment. */}
      {nameFilterIsLossy && positionalNote ? (
        <p className="notice notice--warn filters__note">
          <strong>{positionalCount} hands are excluded by the name filter.</strong> {positionalNote}
        </p>
      ) : null}
    </form>
  );
}
