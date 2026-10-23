/**
 * The Hands screen (guideline §6 "Ruke": the list with filters, the
 * replayer, tags and notes; R2.7a). Since R4.5b the screen itself is the
 * shared package's (`@rail/ui/hands/HandsScreen`), which the web's library
 * renders too; this is the app's side of it: the store as its
 * `HandsSource`, the open hand in the address (`#/hands/<hand key>`, which
 * is how the command palette opens one), the hand panel with tags and a
 * note, the rebuild notice, and the filter the Players screen or the
 * palette hands over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HandsScreen } from "@rail/ui/hands/HandsScreen";

import { RecomputeNotice, useRecompute } from "../components/RecomputeNotice";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { useRowHeight } from "../lib/appearance";
import { storeHandsSource } from "../lib/handsSource";
import { inApp, ipc, type HandAnnotations, type HandRow } from "../lib/ipc";
import { replaceParam, useRouteParam } from "../lib/router";
import { EMPTY_FILTER, onFilterRequested, takeRequestedFilter, type FilterState } from "./hands/filter";
import { HandPanel } from "./hands/HandPanel";
import styles from "./hands/HandsApp.module.css";

export function Hands() {
  const t = useT();
  const selected = useRouteParam();
  // Opened from a player's profile: their hands (R2.7c).
  const [filter, setFilter] = useState<FilterState>(() => takeRequestedFilter() ?? EMPTY_FILTER);
  // A saved filter chosen in the palette while the screen is open (R2.8).
  useEffect(
    () =>
      onFilterRequested((target) => {
        if (target !== "hands") return;
        const next = takeRequestedFilter("hands");
        if (next) setFilter(next);
      }),
    [],
  );
  const rebuild = useRecompute();
  const rowHeight = useRowHeight();
  // Every hand in the store, for "N of M hands" under a filter.
  const [storeHands, setStoreHands] = useState<number | null>(null);
  useEffect(() => {
    if (!inApp) return;
    ipc
      .storeStatus()
      .then((status) => setStoreHands(status.error === null ? status.hands : null))
      .catch(() => undefined);
  }, [filter]);
  const panelRef = useRef<HTMLDivElement>(null);

  // The open hand's row when the loaded pages do not reach it (a hand opened
  // from the palette).
  const [single, setSingle] = useState<HandRow | null>(null);
  const loadSingle = useCallback((handKey: string) => {
    ipc
      .handsByKey([handKey])
      .then((rows) => setSingle(rows[0] ?? null))
      .catch(() => undefined);
  }, []);

  const select = useCallback((handKey: string) => replaceParam("hands", handKey), []);
  const close = useCallback(() => {
    replaceParam("hands", null);
    // Back to the list, on the row that was open.
    const key = selected;
    window.requestAnimationFrame(() => {
      const node = key ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
      node?.focus();
    });
  }, [selected]);
  const openReplayer = useCallback(() => {
    // The replayer's keys (←/→, space, Home/End) work while it has focus.
    window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".rp")?.focus());
  }, []);

  if (!inApp) {
    return (
      <div className={styles.unavailable}>
        <h1 className={styles.title}>{t.screens.hands.title}</h1>
        <p className={styles.message}>{t.hands.unavailable}</p>
      </div>
    );
  }

  return (
    <HandsScreen
      fill
      source={storeHandsSource}
      filter={filter}
      onFilterChange={setFilter}
      selected={selected}
      onSelect={select}
      onOpen={openReplayer}
      title={t.screens.hands.title}
      emptyText={t.hands.empty}
      libraryTotal={storeHands}
      densityKey={rowHeight}
      panelRef={panelRef}
      notice={<RecomputeNotice status={rebuild} filling={t.hands.rebuilding} className={styles.notice} />}
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
      renderPanel={(handKey, listed, list) => (
        <SelectedHand
          handKey={handKey}
          listed={listed}
          single={single}
          loadSingle={loadSingle}
          knownTags={list.facets?.tags.map((tag) => tag.value) ?? []}
          onClose={close}
          onAnnotated={(key: string, annotations: HandAnnotations) =>
            list.updateRow(key, { tags: annotations.tags, hasNote: annotations.note !== null })
          }
        />
      )}
    />
  );
}

/** The panel, with the open hand's row read on its own when the list has not loaded it. */
function SelectedHand({
  handKey,
  listed,
  single,
  loadSingle,
  knownTags,
  onClose,
  onAnnotated,
}: {
  handKey: string;
  listed: HandRow | null;
  single: HandRow | null;
  loadSingle: (handKey: string) => void;
  knownTags: string[];
  onClose: () => void;
  onAnnotated: (handKey: string, annotations: HandAnnotations) => void;
}) {
  useEffect(() => {
    if (listed === null) loadSingle(handKey);
  }, [handKey, listed, loadSingle]);
  const row = listed ?? (single?.handKey === handKey ? single : null);
  return <HandPanel handKey={handKey} row={row} knownTags={knownTags} onClose={onClose} onAnnotated={onAnnotated} />;
}
