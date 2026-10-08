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
  fetchHandFacets,
  isDatabaseConfigured,
  type HandFacets,
  type PositionLabel,
} from "../lib/db";
import { EMPTY_REPLAYER_FILTERS, POSITIONS, type ReplayerFilterForm } from "./handFilters";
import { useDict } from "../lib/i18n/client";
import { getParser } from "../lib/phf";
import { CardRow } from "./replayer/PlayingCard";

function siteLabel(id: string): string {
  return getParser(id)?.name ?? id;
}

/** Remembered per browser: whoever keeps the panel shut wants it shut next time too. */
const OPEN_KEY = "rail.handFilters.open";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private window or blocked storage: the panel just forgets.
  }
}

/** How many filters differ from the empty form, so a shut panel still says it is filtering. */
function activeCount(form: ReplayerFilterForm): number {
  return (Object.keys(EMPTY_REPLAYER_FILTERS) as (keyof ReplayerFilterForm)[]).filter((key) => {
    const current = form[key];
    const empty = EMPTY_REPLAYER_FILTERS[key];
    if (Array.isArray(current)) return current.length > 0;
    return typeof current === "string" ? current.trim() !== empty : current !== empty;
  }).length;
}

interface HandFiltersBarProps {
  value: ReplayerFilterForm;
  onApply: (filters: ReplayerFilterForm) => void;
  onReset: () => void;
  loading: boolean;
}

export function HandFiltersBar({ value, onApply, onReset, loading }: HandFiltersBarProps) {
  const t = useDict().converter.filters;
  const [draft, setDraft] = useState<ReplayerFilterForm>(value);
  const [advanced, setAdvanced] = useState(false);
  // Shut on first paint (server and client agree), then restored from storage.
  const [open, setOpen] = useState(false);
  const [facets, setFacets] = useState<HandFacets | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    setOpen(readOpen());
  }, []);

  function toggleOpen() {
    setOpen((current) => {
      writeOpen(!current);
      return !current;
    });
  }

  const active = activeCount(value);

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
  // The same sentence as `anonymizationNote("positional")` in the data layer,
  // in the reader's language.
  const positionalNote = t.positionalNote;
  const nameFilterIsLossy = positionalCount > 0 && draft.player.trim().length > 0;

  const potCurrencyHint = draft.gameFormat === "tournament" ? t.minPotChips : t.minPotCurrency;

  return (
    <section className={`filters-panel ${open ? "is-open" : ""}`}>
      <div className="filters-panel__head">
        <button
          type="button"
          className="filters-panel__toggle"
          aria-expanded={open}
          aria-controls="hand-filters"
          onClick={toggleOpen}
        >
          <span aria-hidden="true" className="filters-panel__chevron">
            {open ? "▾" : "▸"}
          </span>
          <span>{t.title}</span>
          {active ? <span className="filters-panel__count">{t.activeCount(active)}</span> : null}
        </button>
        {active && !open ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onReset}>
            {t.reset}
          </button>
        ) : null}
      </div>
      <form
        id="hand-filters"
        className="filters"
        hidden={!open}
        onSubmit={(event) => {
          event.preventDefault();
          onApply(draft);
        }}
      >
        <div className="filters__row">
          <label className="field field--grow">
            <span className="field__label">{t.board}</span>
            <input
              type="text"
              value={draft.board}
              placeholder={t.boardPlaceholder}
              onChange={(event) => set("board", event.target.value)}
            />
            <span className="field__hint">
              {boardPreview.length ? (
                <>
                  {t.boardMatches} <CardRow cards={boardPreview} size="xs" />
                </>
              ) : (
                t.boardHint
              )}
            </span>
          </label>

          <label className="field field--grow">
            <span className="field__label">{t.heroCards}</span>
            <input
              type="text"
              value={draft.heroCards}
              placeholder={t.heroCardsPlaceholder}
              onChange={(event) => set("heroCards", event.target.value)}
            />
            <span className="field__hint">
              {heroQuery.kind === "class" ? (
                t.handClass(heroQuery.values.join(" / "))
              ) : heroQuery.kind === "cards" ? (
                <>
                  {t.exactly} <CardRow cards={heroQuery.values} size="xs" />
                </>
              ) : (
                t.heroCardsHint
              )}
            </span>
          </label>

          <div className="filters__actions">
            <button type="submit" className="btn btn--primary" disabled={loading}>
              {loading ? t.searching : t.search}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onReset}>
              {t.reset}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setAdvanced((current) => !current)}
              aria-expanded={advanced}
            >
              {advanced ? t.fewerFilters : t.moreFilters}
            </button>
          </div>
        </div>

        <div className="filters__quick">
          <span className="muted">{t.quick}</span>
          <button
            type="button"
            className={`chip-btn ${draft.showdownOnly ? "is-active" : ""}`}
            aria-pressed={draft.showdownOnly}
            onClick={() => applyNow({ ...draft, showdownOnly: !draft.showdownOnly })}
          >
            {t.showdownOnly}
          </button>
          <button
            type="button"
            className={`chip-btn ${draft.heroWonOnly ? "is-active" : ""}`}
            aria-pressed={draft.heroWonOnly}
            onClick={() => applyNow({ ...draft, heroWonOnly: !draft.heroWonOnly })}
          >
            {t.heroWon}
          </button>
          <button
            type="button"
            className={`chip-btn ${draft.sort === "pot_desc" ? "is-active" : ""}`}
            aria-pressed={draft.sort === "pot_desc"}
            onClick={() =>
              applyNow({
                ...draft,
                sort: draft.sort === "pot_desc" ? "played_desc" : "pot_desc",
              })
            }
          >
            {t.biggestPots}
          </button>
        </div>

        {/* Hero position is the one filter that works on every room, anonymized
          or not, so it sits in the always-visible part of the bar. */}
        <fieldset className="filters__positions">
          <legend className="field__label">{t.heroPosition}</legend>
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
                {t.clear}
              </button>
            ) : null}
          </div>
        </fieldset>

        {advanced ? (
          <>
            <div className="filters__row filters__row--advanced">
              <label className="field">
                <span className="field__label">{t.player}</span>
                <input
                  type="text"
                  value={draft.player}
                  placeholder={t.playerPlaceholder}
                  onChange={(event) => set("player", event.target.value)}
                />
                <span className="field__hint">
                  {positionalCount > 0 ? t.playerHintLossy(positionalCount) : t.playerHint}
                </span>
              </label>

              <label className="field">
                <span className="field__label">{t.site}</span>
                <select value={draft.site} onChange={(event) => set("site", event.target.value)}>
                  <option value="">{t.everyRoom}</option>
                  {(facets?.sites ?? []).map((site) => (
                    <option key={site.value} value={site.value}>
                      {t.siteOption(siteLabel(site.value), site.count)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field__label">{t.game}</span>
                <select
                  value={draft.gameFormat}
                  onChange={(event) =>
                    set("gameFormat", event.target.value as ReplayerFilterForm["gameFormat"])
                  }
                >
                  <option value="">{t.gameAny}</option>
                  <option value="cash">{t.gameCash}</option>
                  <option value="tournament">{t.gameTournament}</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">{t.table}</span>
                <input
                  type="text"
                  value={draft.tableName}
                  placeholder={t.tablePlaceholder}
                  onChange={(event) => set("tableName", event.target.value)}
                />
              </label>

              <label className="field field--narrow">
                <span className="field__label">{t.minPot}</span>
                <input
                  type="number"
                  step={draft.gameFormat === "tournament" ? "1" : "0.01"}
                  min="0"
                  value={draft.minPot}
                  onChange={(event) => set("minPot", event.target.value)}
                />
                <span className="field__hint">{potCurrencyHint}</span>
              </label>

              <label className="field field--narrow">
                <span className="field__label">{t.from}</span>
                <input
                  type="date"
                  value={draft.fromDate}
                  onChange={(event) => set("fromDate", event.target.value)}
                />
              </label>

              <label className="field field--narrow">
                <span className="field__label">{t.to}</span>
                <input
                  type="date"
                  value={draft.toDate}
                  onChange={(event) => set("toDate", event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">{t.sortBy}</span>
                <select
                  value={draft.sort}
                  onChange={(event) =>
                    set("sort", event.target.value as ReplayerFilterForm["sort"])
                  }
                >
                  <option value="played_desc">{t.sort.played_desc}</option>
                  <option value="played_asc">{t.sort.played_asc}</option>
                  <option value="pot_desc">{t.sort.pot_desc}</option>
                  <option value="profit_desc">{t.sort.profit_desc}</option>
                  <option value="profit_asc">{t.sort.profit_asc}</option>
                </select>
              </label>
            </div>

            <fieldset className="filters__positions">
              <legend className="field__label">{t.winnerPosition}</legend>
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
                    {t.clear}
                  </button>
                ) : null}
              </div>
              <span className="field__hint">{t.winnerHint}</span>
            </fieldset>
          </>
        ) : null}

        {/* Shown once the user has actually typed a name, because that is the
          moment the missing hands would otherwise disappear without comment. */}
        {nameFilterIsLossy && positionalNote ? (
          <p className="notice notice--warn filters__note">
            <strong>{t.excluded(positionalCount)}</strong> {positionalNote}
          </p>
        ) : null}
      </form>
    </section>
  );
}
