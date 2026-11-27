/**
 * Your saved hands: browse, filter, replay - the shared Hands screen
 * (`@rail/ui/hands/HandsScreen`, the desktop app's since R2.7a) over this
 * account's library (R4.5b).
 *
 * What is the web's around it:
 *
 * - **The data**: `webHandsSource` (`library_page` / `library_facets`, under
 *   RLS), the hand itself through the package's `DataSource`
 *   (`webDataSource`, `get_hand`), mounted here.
 * - **The panel**: the shared replayer with this site's actions in its
 *   header - share, and the hand on its own page in a new tab.
 * - **The hand-offs**: the converter's "Replay" parks a hand in
 *   `sessionStorage` and navigates here; a converted hand is not in the
 *   library, so it opens above the screen with a save button. Players'
 *   "hands with this player" parks an opponent (`playerHandoff.ts`): the
 *   list opens filtered to their room and name.
 * - **Live arrival** (R1.10, R4.3): each batch the shell hands over tells the
 *   list, which reads its first page again and puts what is newer on top -
 *   rows the reader is looking at do not move - and re-counts the chips. A
 *   line under the heading says when a computer is syncing into the account.
 * - **The gate**: signed out, there is no library to filter; the sign-in
 *   prompt replaces the screen.
 * - **Deleting** (20271119200000): hands are chosen as in a file list
 *   (Cmd/Ctrl + click, Shift + click, Cmd/Ctrl + A); a right click opens a
 *   menu for the chosen hands (or the one clicked), two or more chosen show
 *   a bar at the window's foot, and the open hand's replayer has a delete
 *   button. A phone has Select (or a long press on a row): taps then choose,
 *   and the bar sits over the tab bar, full width, from the first hand. Each asks first (`DeleteHandsDialog`); after it the list, its
 *   counts and the plan's stored-hands count are read again.
 *
 * The address stays `/library`; the open hand is the page's state, as it was.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataSourceProvider, useHand } from "@rail/ui/data";
import { ContextMenu, type MenuPoint } from "@rail/ui/hands/ContextMenu";
import { EMPTY_FILTER, type FilterState } from "@rail/ui/hands/filter";
import { HandsScreen } from "@rail/ui/hands/HandsScreen";
import { useUiStrings } from "@rail/ui/i18n";
import type { HandRow } from "@rail/ui/hands/model";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { ReplayViewer } from "@rail/ui/replayer/ReplayViewer";
import { useAuth } from "../../lib/auth";
import {
  deleteHands,
  isDatabaseConfigured,
  latestDesktopSync,
  saveHand,
  type DesktopSync,
} from "../../lib/db";
import { webDataSource } from "../../lib/db/dataSource";
import { deriveNow, fetchDerivePending } from "../../lib/db/derive";
import { notifyHandsChanged, webHandsSource } from "../../lib/db/handsSource";
import { useDict, useLocale } from "../../lib/i18n/client";
import { INTL_LOCALE } from "../../lib/i18n/dictionaries";
import { paths } from "../../lib/routes";
import type { ArrivalBatch } from "../../lib/live/arrivals";
import { getParser, toStandardText } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { PENDING_HAND_KEY, type PendingHand } from "../converter/handoff";
import liveStyles from "../live/live.module.css";
import { ShareHandButton } from "../share/ShareHandButton";
import { DeleteHandsDialog } from "./DeleteHandsDialog";
import styles from "./library.module.css";
import { takePlayerFilter } from "./playerHandoff";
import { Dismissible } from "@rail/ui/notice/Dismissible";

/**
 * How long after a desktop sync the "hands arriving" line stays up. The app
 * sends a played hand within seconds and backfills in batches every second or
 * two, so ten quiet minutes means it has stopped.
 */
const SYNC_FRESH_MS = 10 * 60 * 1000;

/**
 * A hand parked by the converter is only honoured for this long.
 *
 * `sessionStorage` survives a reload but not a tab close, so the realistic
 * stale case is "clicked Replay, wandered off, came back an hour later and
 * navigated here by hand". Loading a hand they have forgotten about would be
 * confusing; ten minutes covers the real hand-off.
 */
const PENDING_HAND_MAX_AGE_MS = 10 * 60 * 1000;

/** `standard` is our own re-import format, not a room, so it is not a label. */
function siteLabel(id: string): string | null {
  if (!id || id === "standard") {
    return null;
  }
  return getParser(id)?.name ?? id;
}

/** Picks up a hand the converter parked on its way to this route, once. */
function takePendingHand(): PendingHand | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_HAND_KEY);
    sessionStorage.removeItem(PENDING_HAND_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const payload = JSON.parse(raw) as PendingHand;
    if (!payload?.phf) {
      return null;
    }
    const age = Date.now() - Date.parse(payload.at);
    if (Number.isFinite(age) && age > PENDING_HAND_MAX_AGE_MS) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

interface LibraryHandsProps {
  refreshToken: number;
  /**
   * Saving here changes the library the *shell* is reasoning about - its hand
   * count, and whether this tab is offered at all - so the shell is told, and
   * answers by bumping `refreshToken`, which reads the list again.
   */
  onHandsSaved: () => void;
  /** The latest live batch from the shell (`AppFrame`, R1.10); null until one arrives. */
  arrival?: ArrivalBatch | null;
}

export function LibraryHands({ refreshToken, onHandsSaved, arrival = null }: LibraryHandsProps) {
  const en = useDict();
  const ui = useUiStrings();
  const t = en.converter.library;
  const auth = useAuth();
  const locale = INTL_LOCALE[useLocale()];
  const source = useMemo(() => webHandsSource(t.standardFormat), [t.standardFormat]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);

  // "Hands with this player" from Players (R4.5c): the list opens on them, once.
  useEffect(() => {
    const parked = takePlayerFilter();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the hand-off on mount
    if (parked) setFilter(parked);
  }, []);
  // The open hand, with the account it belongs to: another account (or
  // none) opens nothing.
  const [selection, setSelection] = useState<{ user: string | null; key: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // A live batch: the list reads its first page and counts again.
  const handledArrival = useRef(0);
  useEffect(() => {
    if (!arrival || arrival.seq === handledArrival.current) return;
    handledArrival.current = arrival.seq;
    notifyHandsChanged();
  }, [arrival]);

  const userId = auth.isSignedIn ? (auth.user?.id ?? null) : null;

  // The filter builder's facts (20271116130000) are worked out on the server
  // when a hand arrives (docs/POOL.md P1). While the Effective stack chip is
  // set and hands are still being processed, the list says so under it: the
  // count is read, never computed here.
  const effStackChip = filter.effStacks.length > 0;
  const [processing, setProcessing] = useState<{ user: string; pending: number } | null>(null);
  useEffect(() => {
    if (!userId || !isDatabaseConfigured || !effStackChip) return;
    let live = true;
    void fetchDerivePending().then((pending) => {
      if (live) setProcessing({ user: userId, pending });
    });
    return () => {
      live = false;
    };
  }, [userId, effStackChip]);
  const filling = processing !== null && processing.user === userId && effStackChip ? processing.pending : 0;

  const selected = selection !== null && selection.user === userId ? selection.key : null;
  const select = useCallback((key: string) => setSelection({ user: userId, key }), [userId]);

  // Deleting: the row menu, then the confirmation for the hands it names
  // (with how to let the chosen ones go once they are gone).
  const [menu, setMenu] = useState<{ keys: string[]; at: MenuPoint } | null>(null);
  const [toDelete, setToDelete] = useState<{ keys: string[]; clear?: () => void } | null>(null);
  const openMenu = useCallback((keys: string[], at: MenuPoint) => {
    if (keys.length > 0) setMenu({ keys, at });
  }, []);
  const deleted = useCallback(() => {
    const gone = toDelete;
    setToDelete(null);
    gone?.clear?.();
    if (gone && selected !== null && gone.keys.includes(selected)) setSelection(null);
    onHandsSaved();
    notifyHandsChanged();
    // A delete empties the pool until P2 (docs/POOL.md): the server queues
    // the library again and this works the caller's queue out now.
    void deriveNow().catch(() => undefined);
  }, [toDelete, selected, onHandsSaved]);
  // A phone choosing hands (Select, or a long press) has the bar from the
  // first hand - or none, with a hint and Delete waiting.
  const chosenBar = useCallback(
    (keys: string[], clear: () => void, choosing: boolean) =>
      keys.length > 1 || choosing ? (
        <div className={styles.bar} role="toolbar" aria-label={t.delete.menuLabel(keys.length)}>
          <span className={styles.barCount} aria-live="polite">
            {keys.length === 0 ? t.delete.pickHint : t.delete.chosen(keys.length)}
          </span>
          <button
            type="button"
            className={styles.barAction}
            disabled={keys.length === 0}
            onClick={() => setToDelete({ keys, clear })}
          >
            {t.delete.button}
          </button>
          <button type="button" className={styles.barClear} aria-label={t.delete.clear} title={t.delete.clear} onClick={clear}>
            ×
          </button>
        </div>
      ) : null,
    [t],
  );

  // The "a computer is syncing" line: on sign-in, and again whenever a
  // desktop batch lands. Signing out clears it with the list.
  const [desktopSync, setDesktopSync] = useState<DesktopSync | null>(null);
  const [syncNow, setSyncNow] = useState(() => Date.now());
  const desktopBatch = arrival?.desktop || arrival?.resync ? arrival.seq : 0;
  useEffect(() => {
    let active = true;
    const read = userId ? latestDesktopSync() : Promise.resolve(null);
    void read.then((next) => {
      if (!active) return;
      setDesktopSync(next);
      setSyncNow(Date.now());
    });
    return () => {
      active = false;
    };
  }, [userId, desktopBatch]);
  const syncAge = desktopSync ? syncNow - Date.parse(desktopSync.lastIngestAt) : Number.POSITIVE_INFINITY;
  const syncing = syncAge < SYNC_FRESH_MS;
  // Take the line down once it goes stale, without waiting for a batch.
  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => setSyncNow(Date.now()), Math.max(1000, SYNC_FRESH_MS - syncAge + 1000));
    return () => clearTimeout(timer);
  }, [syncing, syncAge]);

  const close = useCallback(() => {
    const key = selected;
    setSelection(null);
    window.requestAnimationFrame(() => {
      const node = key ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
      node?.focus();
    });
  }, [selected]);
  const openReplayer = useCallback(() => {
    window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".rp")?.focus());
  }, []);

  const status =
    auth.isSignedIn && syncing && desktopSync ? (
      <p
        className={`${liveStyles.syncing} rail-fade`}
        title={t.syncingTitle(new Date(desktopSync.lastIngestAt).toLocaleString(locale))}
      >
        <span className={liveStyles.dot} aria-hidden="true" />
        {t.syncing(desktopSync.deviceName)}
      </p>
    ) : null;

  let screen;
  if (!isDatabaseConfigured) {
    screen = (
      <section className="card">
        <h2>{t.heading}</h2>
        <p className="muted">{t.noDatabase}</p>
      </section>
    );
  } else if (!auth.isSignedIn) {
    // Signed out, the filters and the list would both be furniture around
    // nothing. While the session restores it is the loader instead, so a
    // returning reader does not see the gate flash.
    screen =
      auth.status === "loading" ? (
        <RailLoader label={en.settings.loading} centered />
      ) : (
        <section className="card">
          <h2>{t.heading}</h2>
          <p className="muted">{t.privateToAccount}</p>
          <div className="signin-gate">
            <p>{t.signInPrompt}</p>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => auth.requestSignIn(t.signInReason)}
            >
              {t.signIn}
            </button>
          </div>
        </section>
      );
  } else {
    screen = (
      <section className={`card ${styles.card}`}>
        <HandsScreen
          key={userId ?? ""}
          source={source}
          filter={filter}
          onFilterChange={setFilter}
          selected={selected}
          onSelect={select}
          onOpen={openReplayer}
          title={t.heading}
          titleTag="h2"
          status={status}
          notice={filling > 0 ? <Dismissible className="notice notice--info rail-fade" role="status" messageKey="filling">{ui.hands.effStackFilling(filling)}</Dismissible> : null}
          emptyText={t.empty}
          reloadToken={refreshToken}
          panelRef={panelRef}
          onRowsMenu={openMenu}
          renderChosen={chosenBar}
          renderState={(kind, text) =>
            kind === "loading" ? (
              <RailLoader label={text} centered />
            ) : (
              kind === "error" ? (
                <Dismissible as="div" className="notice notice--error rail-fade" role="alert">
                  {text}
                </Dismissible>
              ) : (
                <div className="empty rail-fade" role="status">
                  {text}
                </div>
              )
            )
          }
          renderPanel={(handKey, row) => (
            <StoredHandPanel
              handKey={handKey}
              row={row}
              onClose={close}
              onDelete={() => setToDelete({ keys: [handKey] })}
            />
          )}
        />
      </section>
    );
  }

  return (
    <DataSourceProvider source={webDataSource}>
      <div className="stack">
        <ConverterHand onHandsSaved={onHandsSaved} />
        {screen}
      </div>
      {menu !== null ? (
        <ContextMenu
          at={menu.at}
          label={t.delete.menuLabel(menu.keys.length)}
          onClose={() => setMenu(null)}
          items={[{ label: t.delete.action(menu.keys.length), onSelect: () => setToDelete({ keys: menu.keys }) }]}
        />
      ) : null}
      {toDelete !== null ? (
        <DeleteHandsDialog
          count={toDelete.keys.length}
          run={(onProgress) => deleteHands(toDelete.keys, onProgress)}
          onClose={() => setToDelete(null)}
          onDone={deleted}
        />
      ) : null}
    </DataSourceProvider>
  );
}

/** The open hand from the library: the shared replayer, with share, a new tab and delete. */
function StoredHandPanel({
  handKey,
  row,
  onClose,
  onDelete,
}: {
  handKey: string;
  row: HandRow | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  const t = useDict().converter.library;
  const state = useHand(handKey);
  if (state.status !== "ready") {
    return (
      <div className={styles.panelStatus}>
        {state.status === "loading" ? (
          <RailLoader label={t.loadingHand} showLabel />
        ) : (
          <p role="alert">{t.loadHandFailed}</p>
        )}
      </div>
    );
  }
  return (
    <div className={`${styles.panel} rail-fade`}>
      <ReplayViewer
        fitToScreen
        phoneTakeover
        key={handKey}
        // The address does not name the open hand, so a `?t=` left by the
        // last one must not place the next: every hand opens at its start.
        urlSync={false}
        hand={state.hand}
        site={siteLabel(row?.site ?? state.hand.meta.siteId)}
        onClose={onClose}
        headerExtra={
          <>
            <ShareHandButton hand={state.hand} storedHandId={handKey} iconOnly />
            <OpenInNewTab handId={handKey} />
            <button
              type="button"
              className="btn btn--icon"
              onClick={onDelete}
              aria-label={t.delete.deleteHand}
              title={t.delete.deleteHand}
            >
              <Icon name="trash" />
            </button>
          </>
        }
      />
    </div>
  );
}

/** The stored hand on its own page (`/analysis/h/<id>`), in a new tab. */
function OpenInNewTab({ handId }: { handId: string }) {
  const t = useDict().converter.library;
  return (
    <a
      className="btn btn--icon"
      href={paths.analysisHand(handId)}
      target="_blank"
      rel="noopener"
      aria-label={t.openInNewTab}
      title={t.openInNewTab}
    >
      <Icon name="external" />
    </a>
  );
}

/**
 * A hand the converter handed over: not in the library yet, so it opens on
 * its own above the screen, with a button that saves it.
 */
function ConverterHand({ onHandsSaved }: { onHandsSaved: () => void }) {
  const en = useDict();
  const t = en.converter.library;
  const auth = useAuth();
  const [hand, setHand] = useState<PhfHand | null>(null);
  const [storedId, setStoredId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Runs once per mount, and clears the key so a later reload does not
  // resurrect it.
  useEffect(() => {
    const pending = takePendingHand();
    if (pending) {
      setHand(pending.phf);
      setNotice(t.fromConverter);
    }
  }, [t]);

  /** Set when save was pressed with no session, so the click survives the dialog. */
  const wantsSaveRef = useRef(false);

  async function save() {
    if (!hand || storedId) return;
    if (!auth.isSignedIn) {
      wantsSaveRef.current = true;
      auth.requestSignIn(en.converter.save.signInReason);
      return;
    }
    setSaving(true);
    try {
      // The canonical document goes to the database, not a re-parse of the
      // text rendered from it.
      const result = await saveHand(hand, toStandardText(hand));
      setStoredId(result.id);
      setNotice(result.duplicate ? en.converter.save.alreadySaved : en.converter.save.saved);
      onHandsSaved();
      notifyHandsChanged();
      if (!result.duplicate) {
        // Background, server-side; see ConverterTab.
        void deriveNow().catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : en.converter.save.failed);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (auth.isSignedIn && wantsSaveRef.current) {
      wantsSaveRef.current = false;
      void save();
    }
    // `save` closes over `hand`, which has not changed across the sign-in;
    // depending on its identity would re-save on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isSignedIn]);

  if (!hand) return null;
  return (
    <section className="card card--flush">
      {notice ? <Dismissible className="notice notice--info">{notice}</Dismissible> : null}
      {error ? <Dismissible className="notice notice--error">{error}</Dismissible> : null}
      <ReplayViewer
        fitToScreen
        phoneTakeover
        key={hand.meta.handKey}
        urlSync={false}
        hand={hand}
        site={siteLabel(hand.meta.siteId)}
        onClose={() => {
          setHand(null);
          setNotice(null);
        }}
        headerExtra={
          <>
            <ShareHandButton hand={hand} storedHandId={storedId} iconOnly />
            {storedId ? <OpenInNewTab handId={storedId} /> : null}
            {!storedId && isDatabaseConfigured ? (
              <button
                type="button"
                className="btn btn--icon"
                onClick={() => void save()}
                disabled={saving}
                aria-label={en.converter.save.button}
                title={saving ? en.converter.save.saving : en.converter.save.button}
              >
                {saving ? <RailLoader size="inline" label={en.converter.save.saving} delay={0} /> : <Icon name="save" />}
              </button>
            ) : null}
          </>
        }
      />
    </section>
  );
}
