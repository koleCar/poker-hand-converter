/**
 * The Hands screen (guideline §6 "Ruke": the list with filters and the
 * replayer), on both surfaces (R4.5b): the filter row, the virtualised list
 * (newest first, or in the order chosen), and the hand chosen opened beside
 * the list - or above it where the screen is narrow - in whatever panel the
 * surface draws (`renderPanel`: the web's replayer with share and publish),
 * or nowhere on the screen (the desktop opens it in the replayer's own
 * window, `app/src/screens/Hands.tsx`). The data is the surface's
 * `HandsSource`; the filter, the chosen hand and where they live (the app's
 * route, the web's state) are the surface's too.
 *
 * On a library with both cash and tournaments the list shows one kind - the
 * Cash / Tournaments toggle's, else the one with more hands
 * (`gameKind.ts`); the filter the surface keeps is narrowed when it is read.
 * A surface that keeps the kind itself (the desktop's sidebar) passes it as
 * `kind`, and the screen has no toggle of its own.
 *
 * The desktop app's screen (R2.7a, `app/src/screens/Hands.tsx` before
 * R4.5b), lifted out of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useUiStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import { FilterBar } from "./FilterBar";
import { activeGroups, toQuery, type FilterState } from "./filter";
import { holdKind, kindOf, pinKind, type GameKind } from "./gameKind";
import { HandSessionsContext } from "./sessions";
import type { MenuPoint } from "./ContextMenu";
import { HandList } from "./HandList";
import { KindToggle } from "./KindToggle";
import toggleStyles from "./KindToggle.module.css";
import styles from "./Hands.module.css";
import type { HandFacets, HandFilter, HandRow, HandSort, HandsSource } from "./model";
import { useHandList, type HandList as HandListState } from "./useHandList";
import { useHandSelection } from "./useHandSelection";

/** The orders whose values the bb/$ toggle changes. */
const MONEY_SORTS: ReadonlySet<HandSort> = new Set<HandSort>(["pot", "potAsc", "won", "lost"]);

export interface HandsScreenProps {
  source: HandsSource;
  filter: FilterState;
  onFilterChange: (filter: FilterState) => void;
  /**
   * The kind of game the surface shows, chosen elsewhere (the desktop's
   * sidebar): the list holds to it and has no Cash / Tournaments toggle.
   */
  kind?: GameKind;
  /** The hand open beside the list (its row key), if any. */
  selected: string | null;
  onSelect: (handKey: string) => void;
  /** Enter on a row (and a click, with `openOnClick`): focus whatever the panel offers (the replayer). */
  onOpen?: (handKey: string) => void;
  /** A click on a row opens it too, not only Enter. */
  openOnClick?: boolean;
  /**
   * The open hand's panel beside the list: its list row when loaded, and the
   * list (to update a row). None: the surface shows the hand elsewhere (the
   * desktop's replayer window) and the list keeps the whole width.
   */
  renderPanel?: (handKey: string, row: HandRow | null, list: HandListState) => ReactNode;
  /** The list, for a surface without a panel that still updates a row. */
  listRef?: { current: HandListState | null };
  /** The loading, empty and error states, in the surface's own look. */
  renderState: (kind: "loading" | "empty" | "error", text: string) => ReactNode;
  /** The heading's words, and its level on the surface's page. */
  title: string;
  /**
   * Keep the heading for assistive technology only (the desktop, whose
   * sidebar names the screen: the owner's rule, 2026-11-05).
   */
  hideTitle?: boolean;
  titleTag?: "h1" | "h2";
  /** Under the heading: the surface's lines (a sync under way, a rebuild). */
  status?: ReactNode;
  /** Between the filters and the list (notices). */
  notice?: ReactNode;
  /** No hands at all, in the surface's words ("they appear as Rail imports them"). */
  emptyText: string;
  /** Every hand the reader has, for "N of M hands"; the source's `library` count when it has one. */
  libraryTotal?: number | null;
  /** A new value reads the first page and the counts again. */
  reloadToken?: unknown;
  /** The desktop's density: the row height is read again when it changes. */
  densityKey?: unknown;
  /** The panel's wrapper, so the surface can move focus into it. */
  panelRef?: Ref<HTMLDivElement>;
  /** Fill the surface's main area (the desktop) or size to the page (the web). */
  fill?: boolean;
  /**
   * Several hands can be chosen, and a right click on a row hands the chosen
   * ones (in the list's order) to the surface's menu (the desktop's).
   */
  onRowsMenu?: (handKeys: string[], at: MenuPoint) => void;
  /**
   * The chosen hands' own actions (the desktop's bar at the window's foot),
   * given the chosen hands in the list's order, how to let them go, and
   * whether a phone is choosing (its Select button or a long press: the bar
   * shows from the first hand, or none).
   */
  renderChosen?: (handKeys: string[], clear: () => void, choosing: boolean) => ReactNode;
}

export function HandsScreen({
  source,
  filter: chosen,
  onFilterChange,
  kind,
  selected,
  onSelect,
  onOpen,
  openOnClick = false,
  renderPanel,
  listRef,
  renderState,
  title,
  hideTitle = false,
  titleTag: Title = "h1",
  status,
  notice,
  emptyText,
  libraryTotal,
  reloadToken,
  densityKey,
  panelRef,
  fill = false,
  onRowsMenu,
  renderChosen,
}: HandsScreenProps) {
  const t = useUiStrings().hands;
  // Big blinds or each hand's money, for the list's results (as on Live).
  const [unit, setUnit] = useState<"bb" | "money">("bb");
  // Cash and tournaments never add up: a filter that does not pick one kind
  // shows the one with more hands (the Game chip's counts, which leave its
  // own choice out, decide; the first page waits for them).
  const [facetsSeen, setFacetsSeen] = useState<HandFacets | null>(null);
  const filter = useMemo(
    () => (kind === undefined ? pinKind(chosen, facetsSeen).filter : holdKind(chosen, kind, facetsSeen)),
    [chosen, kind, facetsSeen],
  );
  // A date preset is resolved when the filter is set ("last 7 days" from now).
  // The pot and the result sort in the unit the list shows (`$` sorts by
  // money, not by big blinds); other orders do not refetch on the toggle.
  const sortInMoney =
    unit === "money" && kindOf(filter.formats) !== "tournament" && MONEY_SORTS.has(filter.sort);
  const query = useMemo(() => {
    const built = toQuery(filter);
    if (sortInMoney) built.sortUnit = "money";
    return built;
  }, [filter, sortInMoney]);
  const list = useHandList(source, query, facetsSeen !== null);
  if (list.facets !== null && list.facets !== facetsSeen) {
    setFacetsSeen(list.facets);
  }
  useEffect(() => {
    if (listRef) listRef.current = list;
  });
  const selection = useHandSelection(list.rows);
  // A phone has no modifier keys: its Select button (or a long press on a
  // row) turns taps into choosing hands, until Done or the bar's clear.
  const [choosing, setChoosing] = useState(false);
  const clearChosen = useCallback(() => {
    selection.clear();
    setChoosing(false);
  }, [selection]);
  const startChoosing = useCallback(
    (handKey: string) => {
      selection.only(handKey);
      setChoosing(true);
    },
    [selection],
  );
  const loadFacets = useCallback((draft: HandFilter) => source.facets(draft), [source]);

  const { reload } = list;
  const firstToken = useRef(reloadToken);
  useEffect(() => {
    if (firstToken.current === reloadToken) return;
    firstToken.current = reloadToken;
    reload();
  }, [reloadToken, reload]);

  const facets = list.facets;
  const filtered = activeGroups(filter) > 0;
  const total = libraryTotal ?? facets?.library ?? null;
  let countLine: string | null = null;
  if (facets) {
    countLine = filtered && total !== null ? t.countOf(facets.total, total) : t.count(facets.total);
    if (onRowsMenu && selection.size > 1) countLine = `${countLine} · ${t.chosen(selection.size)}`;
  }

  // Another filter's first page on its way: the rows shown are the previous
  // filter's, dimmed, with the loader by the count (a reload of the same
  // filter keeps its rows as they are).
  const refetching = list.loading && list.rows.length > 0 && list.rowsKey !== JSON.stringify(query);

  // Money where every row has one (cash); a tournament's chips are big blinds only.
  const moneyShown = kindOf(filter.formats) !== "tournament";
  const shownUnit = unit === "money" && moneyShown ? "money" : "bb";
  const symbols = new Set(list.rows.map((candidate) => candidate.currencySymbol).filter((symbol) => symbol !== ""));
  const moneySymbol = symbols.size === 1 ? [...symbols][0] : null;

  const row = selected === null ? null : (list.rows.find((candidate) => candidate.handKey === selected) ?? null);

  let body;
  if (list.error !== null) {
    body = renderState("error", t.storeError(list.error));
  } else if (list.rows.length === 0) {
    body = list.loading
      ? renderState("loading", t.loading)
      : renderState("empty", filtered ? t.noMatch : emptyText);
  } else {
    body = (
      <HandList
        rows={list.rows}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        total={facets?.total ?? null}
        selected={selected}
        onSelect={onSelect}
        onOpen={onOpen ?? (() => undefined)}
        openOnClick={openOnClick}
        onLoadMore={list.loadMore}
        orderLabel={t.filters.sorts[filter.sort]}
        sort={filter.sort}
        sorts={["newest", ...source.features.sorts]}
        onSort={(sort) => onFilterChange({ ...chosen, sort })}
        unit={shownUnit}
        densityKey={densityKey}
        enterKey={list.rowsKey}
        selection={onRowsMenu ? selection : undefined}
        onRowsMenu={onRowsMenu}
        choosing={choosing && onRowsMenu !== undefined}
        onLongPress={onRowsMenu ? startChoosing : undefined}
      />
    );
  }

  return (
    <HandSessionsContext.Provider value={source.sessions ?? null}>
      <div className={`${styles.screen} ${fill ? styles.fill : styles.page}`}>
        <header className={styles.top}>
          <Title className={hideTitle ? styles.visuallyHidden : styles.title}>{title}</Title>
          {countLine !== null ? (
            <span className={styles.count} aria-live="polite">
              {countLine}
            </span>
          ) : null}
          {refetching ? <RailLoader size="inline" label={t.loading} /> : null}
          <span className={styles.spacer} />
          <div className={toggleStyles.toggle} role="group" aria-label={t.units.label}>
            <button
              type="button"
              className={`chip-btn${shownUnit === "bb" ? " is-active" : ""}`}
              aria-pressed={shownUnit === "bb"}
              onClick={() => setUnit("bb")}
            >
              {t.units.bb}
            </button>
            <button
              type="button"
              className={`chip-btn${shownUnit === "money" ? " is-active" : ""}`}
              aria-pressed={shownUnit === "money"}
              disabled={!moneyShown}
              onClick={() => setUnit("money")}
            >
              {moneySymbol ?? t.units.money}
            </button>
          </div>
          {kind === undefined ? <KindToggle filter={filter} facets={facets} onChange={onFilterChange} /> : null}
          {onRowsMenu && list.rows.length > 0 ? (
            <button
              type="button"
              className={`chip-btn ${styles.select}${choosing ? " is-active" : ""}`}
              aria-pressed={choosing}
              onClick={() => {
                if (choosing) {
                  clearChosen();
                } else {
                  selection.clear();
                  setChoosing(true);
                }
              }}
            >
              {choosing ? t.selectDone : t.select}
            </button>
          ) : null}
        </header>
        {status}
        <FilterBar
          filter={filter}
          facets={facets}
          onChange={onFilterChange}
          features={source.features}
          saved={source.savedFilters}
          sorts={source.features.sorts}
          loadFacets={loadFacets}
        />
        {notice}
        <div className={selected === null || !renderPanel ? styles.body : `${styles.body} ${styles.split}`}>
          <div className={`${styles.list} rail-dims`} aria-busy={refetching}>
            {body}
          </div>
          {selected !== null && renderPanel ? (
            <div className={styles.panel} ref={panelRef}>
              {renderPanel(selected, row, list)}
            </div>
          ) : null}
        </div>
      </div>
      {renderChosen && onRowsMenu
        ? renderChosen(
            list.rows.filter((candidate) => selection.checked.has(candidate.handKey)).map((candidate) => candidate.handKey),
            clearChosen,
            choosing,
          )
        : null}
    </HandSessionsContext.Provider>
  );
}
