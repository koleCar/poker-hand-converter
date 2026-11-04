/**
 * The filter builder ("All filters"): every group the row has, in panes on
 * a left rail - Situation (quick filters, positions, pot and action), Cards
 * (the hero's hand, the board), Context (game, result, date, table, marks) -
 * a search over all of them on top, and on the right what is set, in
 * words, each one a click from its pane or a × from gone. It edits a draft:
 * nothing reaches the list until "Show N hands", which counts the draft as
 * it changes (where the surface can count). Escape or Cancel leaves the
 * filter as it was.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useUiStrings } from "../i18n";
import { toQuery, type FilterState } from "./filter";
import styles from "./FilterBar.module.css";
import { GroupEditor, Pills } from "./GroupEditor";
import { SearchIcon, useSearchHits } from "./AddFilter";
import { PANES, clearAll, clearGroup, paneOf, quickFor, shownSet, useGroupWords, type GroupId, type PaneId } from "./groups";
import type { HandFacets, HandFilter } from "./model";
import { SaveForm, type SavedFiltersState } from "./SavedFilters";

export interface FilterBuilderProps {
  groups: readonly GroupId[];
  filter: FilterState;
  facets: HandFacets | null;
  /** Counts the draft (and lists its values); without it the button says "Apply". */
  loadFacets?: ((query: HandFilter) => Promise<HandFacets>) | undefined;
  saved?: SavedFiltersState | undefined;
  startPane?: PaneId | undefined;
  onApply: (filter: FilterState) => void;
  onClose: () => void;
}

/** The draft's counts, a moment after it stops changing; the last ones stay while the next load. */
function useDraftFacets(draft: FilterState, fallback: HandFacets | null, load: FilterBuilderProps["loadFacets"]) {
  const [state, setState] = useState<{ key: string; facets: HandFacets } | null>(null);
  const key = useMemo(() => JSON.stringify(toQuery(draft)), [draft]);
  useEffect(() => {
    if (!load) return;
    let live = true;
    const timer = window.setTimeout(() => {
      load(JSON.parse(key) as HandFilter)
        .then((facets) => {
          if (live) setState({ key, facets });
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key, load]);
  return {
    facets: state?.facets ?? fallback,
    total: load && state?.key === key ? state.facets.total : null,
  };
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function FilterBuilder({ groups, filter, facets, loadFacets, saved, startPane, onApply, onClose }: FilterBuilderProps) {
  const strings = useUiStrings();
  const t = strings.hands.filters;
  const b = t.builder;
  const words = useGroupWords();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState(filter);
  const [query, setQuery] = useState("");
  const quick = useMemo(() => quickFor(groups), [groups]);

  // The panes this row has: a pane with none of its groups is not shown.
  const sections = useMemo(
    () =>
      PANES.map((section) => ({
        ...section,
        panes: section.panes
          .map((pane) => ({ ...pane, groups: pane.groups.filter((group) => groups.includes(group)) }))
          .filter((pane) => (pane.id === "quick" ? quick.length > 0 : pane.groups.length > 0)),
      })).filter((section) => section.panes.length > 0),
    [groups, quick],
  );
  const panes = sections.flatMap((section) => section.panes);
  const firstPane = panes[0]?.id ?? "quick";
  const [pane, setPane] = useState<PaneId>(startPane && panes.some((p) => p.id === startPane) ? startPane : firstPane);
  const current = panes.find((p) => p.id === pane) ?? panes[0];

  const { facets: draftFacets, total } = useDraftFacets(draft, facets, loadFacets);
  const hits = useSearchHits(groups, draft, draftFacets, query);
  const searching = query.trim() !== "";

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const set = shownSet(groups, draft, draftFacets);
  const active = set.length + (draft.player !== null ? 1 : 0);
  const paneActive = (id: PaneId) =>
    id === "quick" ? quick.some((q) => q.on(draft)) : (panes.find((p) => p.id === id)?.groups ?? []).some((g) => set.includes(g));

  const go = (id: PaneId) => {
    setPane(id);
    setQuery("");
  };

  return (
    <dialog
      ref={ref}
      className={styles.builder}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog itself, outside its panel) closes it.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className={styles.builderPanel}>
        <header className={styles.builderHead}>
          <h2 id={titleId} className={styles.builderTitle}>
            {b.title}
          </h2>
          <label className={styles.builderSearch}>
            <SearchIcon />
            <span className={styles.visuallyHidden}>{b.search}</span>
            <input type="search" value={query} placeholder={b.placeholder} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" className={styles.iconButton} aria-label={b.close} title={b.close} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>

        <div className={styles.builderBody}>
          <nav className={styles.builderNav} aria-label={b.categories}>
            {sections.map((section) => (
              <div key={section.section} className={styles.navSection}>
                <span className={styles.navLabel}>{b.sections[section.section]}</span>
                {section.panes.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.navItem}
                    aria-current={!searching && p.id === current?.id ? "page" : undefined}
                    onClick={() => go(p.id)}
                  >
                    <span>{b.panes[p.id].title}</span>
                    {paneActive(p.id) ? <span className={styles.navDot} role="img" aria-label={b.hasFilters} /> : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className={styles.builderMain}>
            {searching ? (
              <div className={styles.results}>
                <p className={styles.resultsTitle}>{hits.length > 0 ? b.results(hits.length) : b.noResults(query.trim())}</p>
                {hits.slice(0, 40).map((hit) => (
                  <button
                    key={hit.key}
                    type="button"
                    className={styles.resultRow}
                    aria-pressed={hit.on}
                    onClick={() => setDraft((was) => hit.apply(was))}
                  >
                    <span className={styles.menuLabel}>{hit.label}</span>
                    <span className={styles.menuWhere}>{hit.where}</span>
                    <span className={styles.resultVerb}>{hit.on ? b.added : b.add}</span>
                  </button>
                ))}
              </div>
            ) : current ? (
              <>
                <div className={styles.paneHead}>
                  <h3>{b.panes[current.id].title}</h3>
                  <p>{b.panes[current.id].text}</p>
                </div>
                {current.id === "quick" ? (
                  <Pills
                    label={b.panes.quick.title}
                    options={quick.map((q) => ({ value: q.id, label: t.quick[q.id] }))}
                    selected={quick.filter((q) => q.on(draft)).map((q) => q.id)}
                    onChange={(next) => {
                      setDraft((was) => {
                        let value = was;
                        for (const q of quick) {
                          if (q.on(value) !== next.includes(q.id)) value = q.toggle(value);
                        }
                        return value;
                      });
                    }}
                  />
                ) : (
                  current.groups.map((group) => (
                    <GroupEditor
                      key={group}
                      group={group}
                      filter={draft}
                      facets={draftFacets}
                      onChange={setDraft}
                      variant="builder"
                      titled={current.groups.length > 1 || group === "position"}
                    />
                  ))
                )}
              </>
            ) : null}
          </div>

          <aside className={styles.builderAside} aria-label={b.active}>
            <div className={styles.asideHead}>
              <strong>{b.active}</strong>
              <span>{b.allMustMatch}</span>
            </div>
            <ul className={styles.conditions}>
              {draft.player !== null ? (
                <li className={styles.condition}>
                  <span className={styles.conditionBody}>
                    <span className={styles.conditionKey}>{t.groups.player}</span>
                    <span className={styles.conditionValue}>{draft.player.player}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={t.remove(t.groups.player)}
                    onClick={() => setDraft((was) => ({ ...was, player: null }))}
                  >
                    <CloseIcon size={12} />
                  </button>
                </li>
              ) : null}
              {set.map((group) => (
                <li key={group} className={styles.condition}>
                  <button type="button" className={styles.conditionBody} onClick={() => go(paneOf(group))}>
                    <span className={styles.conditionKey}>{words.name(group)}</span>
                    <span className={styles.conditionValue}>{words.summary(group, draft, draftFacets)}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={t.remove(words.name(group))}
                    onClick={() => setDraft((was) => clearGroup(group, was, draftFacets))}
                  >
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
            {active === 0 ? <p className={styles.hint}>{b.none}</p> : null}
            {saved && active > 0 ? (
              <div className={styles.asideFoot}>
                <span className={styles.asideSaveTitle}>{b.saveAs}</span>
                <SaveForm state={saved} filter={draft} />
              </div>
            ) : null}
          </aside>
        </div>

        <footer className={styles.builderFoot}>
          <button type="button" className={styles.textButton} onClick={() => setDraft((was) => clearAll(was, draftFacets))} disabled={active === 0}>
            {b.reset}
          </button>
          <span className={styles.spacer} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {b.cancel}
          </button>
          <button
            type="button"
            className={`btn btn--primary ${styles.applyButton}`}
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            {total !== null ? b.show(total) : b.apply}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
