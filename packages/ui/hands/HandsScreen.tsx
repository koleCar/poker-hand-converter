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
 * The desktop app's screen (R2.7a, `app/src/screens/Hands.tsx` before
 * R4.5b), lifted out of it.
 */
import { useEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import { useUiStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import { FilterBar, handGroups } from "./FilterBar";
import { activeGroups, toQuery, type FilterState } from "./filter";
import { HandList } from "./HandList";
import styles from "./Hands.module.css";
import type { HandRow, HandsSource } from "./model";
import { useHandList, type HandList as HandListState } from "./useHandList";

export interface HandsScreenProps {
  source: HandsSource;
  filter: FilterState;
  onFilterChange: (filter: FilterState) => void;
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
}

export function HandsScreen({
  source,
  filter,
  onFilterChange,
  selected,
  onSelect,
  onOpen,
  openOnClick = false,
  renderPanel,
  listRef,
  renderState,
  title,
  titleTag: Title = "h1",
  status,
  notice,
  emptyText,
  libraryTotal,
  reloadToken,
  densityKey,
  panelRef,
  fill = false,
}: HandsScreenProps) {
  const t = useUiStrings().hands;
  // A date preset is resolved when the filter is set ("last 7 days" from now).
  const query = useMemo(() => toQuery(filter), [filter]);
  const list = useHandList(source, query);
  useEffect(() => {
    if (listRef) listRef.current = list;
  });
  const groups = useMemo(() => handGroups(source.features), [source.features]);
  const searchFields = useMemo(
    () => ({
      search: source.features.search,
      tableName: source.features.more.includes("tableName"),
      minPot: source.features.more.includes("minPot"),
    }),
    [source.features],
  );

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
  }

  // Another filter's first page on its way: the rows shown are the previous
  // filter's, dimmed, with the loader by the count (a reload of the same
  // filter keeps its rows as they are).
  const refetching = list.loading && list.rows.length > 0 && list.rowsKey !== JSON.stringify(query);

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
        densityKey={densityKey}
        enterKey={list.rowsKey}
      />
    );
  }

  return (
    <div className={`${styles.screen} ${fill ? styles.fill : styles.page}`}>
      <header className={styles.top}>
        <Title className={styles.title}>{title}</Title>
        {countLine !== null ? (
          <span className={styles.count} aria-live="polite">
            {countLine}
          </span>
        ) : null}
        {refetching ? <RailLoader size="inline" label={t.loading} /> : null}
      </header>
      {status}
      <FilterBar
        filter={filter}
        facets={facets}
        onChange={onFilterChange}
        groups={groups}
        saved={source.savedFilters}
        sorts={source.features.sorts}
        search={searchFields}
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
  );
}
