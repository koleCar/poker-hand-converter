import { useEffect, useState } from "react";
import { extractCards, resolveHeroQuery } from "../lib/cards";
import type { HandFilters } from "../lib/handStore";
import { CardRow } from "./replayer/PlayingCard";

interface HandFiltersBarProps {
  value: HandFilters;
  onApply: (filters: HandFilters) => void;
  onReset: () => void;
  loading: boolean;
}

export function HandFiltersBar({ value, onApply, onReset, loading }: HandFiltersBarProps) {
  const [draft, setDraft] = useState<HandFilters>(value);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function set<K extends keyof HandFilters>(key: K, next: HandFilters[K]) {
    setDraft((current) => ({ ...current, [key]: next }));
  }

  const boardPreview = extractCards(draft.board);
  // Same resolution the query uses, so the hint never lies about the filter.
  const heroQuery = resolveHeroQuery(draft.heroCards);

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
            placeholder="npr. Ah Kd 2c  ili  AhKd"
            onChange={(event) => set("board", event.target.value)}
          />
          <span className="field__hint">
            {boardPreview.length ? (
              <>
                Traži handove čiji board sadrži <CardRow cards={boardPreview} size="xs" />
              </>
            ) : (
              "Sve karte moraju biti na boardu"
            )}
          </span>
        </label>

        <label className="field field--grow">
          <span className="field__label">Hero hole cards</span>
          <input
            type="text"
            value={draft.heroCards}
            placeholder="npr. AhKs  ili  AKs  ili  TT"
            onChange={(event) => set("heroCards", event.target.value)}
          />
          <span className="field__hint">
            {heroQuery.kind === "class" ? (
              `Klasa ruke: ${heroQuery.values.join(" / ")}`
            ) : heroQuery.kind === "cards" ? (
              <>
                Točne karte <CardRow cards={heroQuery.values} size="xs" />
              </>
            ) : (
              "Karte (AhKs) ili klasa (AKs, AKo, AK, TT)"
            )}
          </span>
        </label>

        <div className="filters__actions">
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? "Tražim…" : "Traži"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onReset}>
            Reset
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setAdvanced((current) => !current)}
          >
            {advanced ? "Manje filtera" : "Više filtera"}
          </button>
        </div>
      </div>

      <div className="filters__quick">
        <span className="muted">Brzo:</span>
        <button
          type="button"
          className={`chip-btn ${draft.showdownOnly ? "is-active" : ""}`}
          onClick={() => {
            const next = { ...draft, showdownOnly: !draft.showdownOnly };
            setDraft(next);
            onApply(next);
          }}
        >
          Samo showdown
        </button>
        <button
          type="button"
          className={`chip-btn ${draft.heroWonOnly ? "is-active" : ""}`}
          onClick={() => {
            const next = { ...draft, heroWonOnly: !draft.heroWonOnly };
            setDraft(next);
            onApply(next);
          }}
        >
          Hero u plusu
        </button>
        <button
          type="button"
          className={`chip-btn ${draft.sort === "pot_desc" ? "is-active" : ""}`}
          onClick={() => {
            const next: HandFilters = {
              ...draft,
              sort: draft.sort === "pot_desc" ? "played_desc" : "pot_desc",
            };
            setDraft(next);
            onApply(next);
          }}
        >
          Najveći potovi
        </button>
      </div>

      {advanced ? (
        <div className="filters__row filters__row--advanced">
          <label className="field">
            <span className="field__label">Igrač</span>
            <input
              type="text"
              value={draft.player}
              placeholder="ime igrača"
              onChange={(event) => set("player", event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Stol</span>
            <input
              type="text"
              value={draft.tableName}
              placeholder="npr. NLHPurple"
              onChange={(event) => set("tableName", event.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">Min pot</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.minPot}
              onChange={(event) => set("minPot", event.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">Od</span>
            <input
              type="date"
              value={draft.fromDate}
              onChange={(event) => set("fromDate", event.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">Do</span>
            <input
              type="date"
              value={draft.toDate}
              onChange={(event) => set("toDate", event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Sortiranje</span>
            <select
              value={draft.sort}
              onChange={(event) => set("sort", event.target.value as HandFilters["sort"])}
            >
              <option value="played_desc">Najnovije</option>
              <option value="played_asc">Najstarije</option>
              <option value="pot_desc">Najveći pot</option>
              <option value="profit_desc">Hero najveći plus</option>
              <option value="profit_asc">Hero najveći minus</option>
            </select>
          </label>
        </div>
      ) : null}
    </form>
  );
}
