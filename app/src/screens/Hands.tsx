/**
 * The Hands screen (guideline §6 "Ruke": the list with filters, the
 * replayer, tags and notes; R2.7a). The list is the local store's, newest
 * first, virtualised; the filter chips narrow it and say how many hands
 * each would leave; the hand chosen opens beside the list in the shared
 * replayer, with its tags and note under it. The open hand is in the
 * address (`#/hands/<hand key>`), which is how the command palette opens one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../i18n";
import { inApp, ipc, type HandAnnotations, type HandRow, type StatsStatus } from "../lib/ipc";
import { replaceParam, useRouteParam } from "../lib/router";
import { EMPTY_FILTER, activeGroups, takeRequestedFilter, toQuery, type FilterState } from "./hands/filter";
import { FilterBar } from "./hands/FilterBar";
import { count } from "./hands/format";
import { HandList } from "./hands/HandList";
import { HandPanel } from "./hands/HandPanel";
import styles from "./hands/Hands.module.css";
import { useHandList } from "./hands/useHandList";

/** While the statistics rebuild after an upgrade, the list fills as it goes. */
function useRebuild(): StatsStatus | null {
  const [status, setStatus] = useState<StatsStatus | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      ipc
        .statsStatus()
        .then((value) => {
          if (stopped) return;
          setStatus(value);
          if (value.activity === "rebuilding") timer = window.setTimeout(poll, 2000);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

export function Hands() {
  const t = useT();
  const selected = useRouteParam();
  // Opened from a player's profile: their hands (R2.7c).
  const [filter, setFilter] = useState<FilterState>(() => takeRequestedFilter() ?? EMPTY_FILTER);
  // A date preset is resolved when the filter is set ("last 7 days" from now).
  const query = useMemo(() => toQuery(filter), [filter]);
  const list = useHandList(query);
  const rebuild = useRebuild();
  // Every hand in the store, for "N of M hands" under a filter.
  const [storeHands, setStoreHands] = useState<number | null>(null);
  const facetsNow = list.facets;
  useEffect(() => {
    if (!inApp) return;
    ipc
      .storeStatus()
      .then((status) => setStoreHands(status.error === null ? status.hands : null))
      .catch(() => undefined);
  }, [facetsNow]);
  const panelRef = useRef<HTMLDivElement>(null);

  // The open hand's row: from the list, or read on its own (a hand opened
  // from the palette that the loaded pages do not reach).
  const listed = selected === null ? null : (list.rows.find((row) => row.handKey === selected) ?? null);
  const [single, setSingle] = useState<HandRow | null>(null);
  useEffect(() => {
    if (!inApp || selected === null || listed !== null) return;
    let current = true;
    ipc
      .handsByKey([selected])
      .then((rows) => {
        if (current) setSingle(rows[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [selected, listed]);
  const row = listed ?? (single?.handKey === selected ? single : null);

  const select = useCallback((handKey: string) => replaceParam("hands", handKey), []);
  const close = useCallback(() => {
    replaceParam("hands", null);
    // Back to the list, on the row that was open.
    const key = selected;
    window.requestAnimationFrame(() => {
      const node = key
        ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
        : null;
      node?.focus();
    });
  }, [selected]);
  const openReplayer = useCallback(() => {
    // The replayer's keys (←/→, space, Home/End) work while it has focus.
    window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".rp")?.focus());
  }, []);
  const { updateRow } = list;
  const annotated = useCallback(
    (handKey: string, annotations: HandAnnotations) =>
      updateRow(handKey, { tags: annotations.tags, hasNote: annotations.note !== null }),
    [updateRow],
  );

  if (!inApp) {
    return (
      <div className={styles.screen}>
        <h1 className={styles.title}>{t.screens.hands.title}</h1>
        <p className={styles.message}>{t.hands.unavailable}</p>
      </div>
    );
  }

  const facets = list.facets;
  const filtered = activeGroups(filter) > 0;
  let countLine: string | null = null;
  if (facets) {
    countLine =
      filtered && storeHands !== null
        ? t.hands.countOf(count(facets.total), count(storeHands))
        : t.hands.count(count(facets.total));
  }

  let body;
  if (list.error !== null) {
    body = <p className={styles.message}>{t.hands.storeError(list.error)}</p>;
  } else if (list.rows.length === 0) {
    body = (
      <p className={styles.message} role="status">
        {list.loading ? t.hands.loading : filtered ? t.hands.noMatch : t.hands.empty}
      </p>
    );
  } else {
    body = (
      <HandList
        rows={list.rows}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        total={facets?.total ?? null}
        selected={selected}
        onSelect={select}
        onOpen={openReplayer}
        onLoadMore={list.loadMore}
      />
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <h1 className={styles.title}>{t.screens.hands.title}</h1>
        {countLine !== null ? (
          <span className={styles.count} aria-live="polite">
            {countLine}
          </span>
        ) : null}
      </header>
      <FilterBar filter={filter} facets={facets} onChange={setFilter} />
      {rebuild?.activity === "rebuilding" && rebuild.rebuildTotal !== null ? (
        <p className={styles.notice} role="status">
          {t.hands.rebuilding(count(rebuild.rebuildDone ?? 0), count(rebuild.rebuildTotal))}
        </p>
      ) : null}
      <div className={selected === null ? styles.body : `${styles.body} ${styles.split}`}>
        <div className={styles.list}>{body}</div>
        {selected !== null ? (
          <div className={styles.panel} ref={panelRef}>
            <HandPanel
              handKey={selected}
              row={row}
              knownTags={facets?.tags.map((tag) => tag.value) ?? []}
              onClose={close}
              onAnnotated={annotated}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
