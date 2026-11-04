/**
 * The Hands screen (guideline §6 "Ruke": the list with filters, the
 * replayer, tags and notes; R2.7a). Since R4.5b the screen itself is the
 * shared package's (`@rail/ui/hands/HandsScreen`), which the web's library
 * renders too; this is the app's side of it: the store as its
 * `HandsSource`, the open hand in the address (`#/hands/<hand key>`, which
 * is how the command palette opens one), the rebuild notice, and the filter
 * the Players screen or the palette hands over.
 *
 * The open hand is never beside the list: it opens in the replayer's own
 * window (`src-tauri/src/replayer.rs`, `replayer/ReplayerWindow.tsx`), with
 * its tags and note. A click on a row, Enter, or a hand opened from
 * elsewhere brings that window forward; the arrow keys swap the hand in it
 * and keep the keyboard in the list. Closing the window lets go of the
 * hand; a tag or note changed there shows on its row here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HandsScreen } from "@rail/ui/hands/HandsScreen";
import type { HandList } from "@rail/ui/hands/useHandList";

import { RecomputeNotice, useRecompute } from "../components/RecomputeNotice";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { useRowHeight } from "../lib/appearance";
import { storeHandsSource } from "../lib/handsSource";
import { inApp, ipc, onHandAnnotated, onReplayerClosed } from "../lib/ipc";
import { replaceParam, useRouteParam } from "../lib/router";
import { EMPTY_FILTER, onFilterRequested, takeRequestedFilter, type FilterState } from "./hands/filter";
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

  const list = useRef<HandList | null>(null);
  // Whether the next hand in the address brings the window forward: yes for
  // a hand opened from elsewhere (the palette, a player's hands), no for the
  // arrow keys in the list (`select` says so first).
  const focusNext = useRef(true);

  const shown = useRef(selected);
  useEffect(() => {
    shown.current = selected;
  }, [selected]);

  const select = useCallback((handKey: string) => {
    focusNext.current = false;
    replaceParam("hands", handKey);
  }, []);
  // A click or Enter: `select` ran first. A new hand is opened once, by the
  // effect below, now with the keyboard; the hand already shown is only
  // brought forward (its address does not change, so the effect does not run).
  const open = useCallback((handKey: string) => {
    focusNext.current = true;
    if (shown.current === handKey) {
      ipc.replayerOpen(handKey, true).catch(() => undefined);
    }
  }, []);

  // The hand in the address is the one in the replayer window.
  useEffect(() => {
    if (!inApp || selected === null) return;
    const focus = focusNext.current;
    focusNext.current = true;
    ipc.replayerOpen(selected, focus).catch(() => undefined);
  }, [selected]);

  // The window closed: the list lets go of the hand.
  useEffect(
    () =>
      onReplayerClosed(() => {
        focusNext.current = true;
        replaceParam("hands", null);
      }),
    [],
  );

  // A tag or note changed in the window: its row shows it.
  useEffect(
    () =>
      onHandAnnotated(({ handKey, annotations }) =>
        list.current?.updateRow(handKey, { tags: annotations.tags, hasNote: annotations.note !== null }),
      ),
    [],
  );

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
      onOpen={open}
      openOnClick
      listRef={list}
      title={t.screens.hands.title}
      emptyText={t.hands.empty}
      libraryTotal={storeHands}
      densityKey={rowHeight}
      notice={<RecomputeNotice status={rebuild} filling={t.hands.rebuilding} className={styles.notice} />}
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
    />
  );
}
