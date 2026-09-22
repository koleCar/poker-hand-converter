/**
 * Your saved hands: browse, filter, replay.
 *
 * Uploading used to live here too, which put the single most common first
 * action on the app's *second* tab. That moved to `upload/SingleHandPanel`, so
 * this tab is now one thing — the library — plus the viewer for whichever hand
 * you opened out of it.
 *
 * The one piece of upload plumbing that stays is the hand-off: the batch
 * converter's "Replay" button parks a hand in `sessionStorage` and navigates
 * here, because a converted hand is not in the library yet and has nowhere else
 * to be shown.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { getHand, isDatabaseConfigured, searchHands, type HandSummary } from "../lib/db";
import { parseHand, toParsedHand, type ParsedHand } from "../lib/handParser";
import { saveSingleHand } from "../lib/handStore";
import { getParser } from "../lib/phf";
import type { PhfHand } from "../lib/phf/types";
import { PENDING_HAND_KEY, type PendingHand } from "./converter/handoff";
import { HandFiltersBar } from "./HandFiltersBar";
import {
  EMPTY_REPLAYER_FILTERS,
  toHandFilters,
  type ReplayerFilterForm,
} from "./handFilters";
import { HandList } from "./HandList";
import { ReplayViewer } from "./replayer/ReplayViewer";
import { ShareHandButton } from "./share/ShareHandButton";

const PAGE_SIZE = 25;

/** `standard` is our own re-import format, not a room, so it is not a label. */
function siteLabel(id: string): string | null {
  if (!id || id === "standard") {
    return null;
  }
  return getParser(id)?.name ?? id;
}

/**
 * A hand parked by the converter is only honoured for this long.
 *
 * `sessionStorage` survives a reload but not a tab close, so the realistic
 * stale case is "clicked Replay, wandered off, came back an hour later and
 * navigated here by hand". Loading a hand they have forgotten about would be
 * confusing; ten minutes covers the real hand-off.
 */
const PENDING_HAND_MAX_AGE_MS = 10 * 60 * 1000;

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

type LoadedHand = {
  hand: ParsedHand;
  /** Row id when the hand came from the library. */
  storedId: string | null;
  origin: "db" | "converter";
  sourceFilename: string | null;
  /** Parser the hand came from, so saving records the real room. */
  siteId: string;
};

interface ReplayerTabProps {
  refreshToken: number;
}

export function ReplayerTab({ refreshToken }: ReplayerTabProps) {
  const auth = useAuth();
  const [filters, setFilters] = useState<ReplayerFilterForm>(EMPTY_REPLAYER_FILTERS);
  const [rows, setRows] = useState<HandSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<LoadedHand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const runSearch = useCallback(
    async (nextFilters: ReplayerFilterForm, nextPage: number) => {
      if (!isDatabaseConfigured) {
        return;
      }
      setLoading(true);
      setListError(null);
      try {
        const result = await searchHands(toHandFilters(nextFilters), {
          offset: nextPage * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        setRows(result.rows);
        setTotal(result.total);
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Could not load hands.");
        setRows([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // `isSignedIn` is a dependency because the library *is* the session: signing
  // in has to populate the list, and signing out has to empty it rather than
  // leave the previous account's hands on screen.
  useEffect(() => {
    void runSearch(filters, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, refreshToken, auth.isSignedIn]);

  function applyFilters(next: ReplayerFilterForm) {
    setFilters(next);
    setPage(0);
    void runSearch(next, 0);
  }

  async function openStoredHand(row: HandSummary) {
    setNotice(null);
    try {
      const record = await getHand(row.id);
      const hand = record ? parseHand(record.standardText) : null;
      if (!hand) {
        setListError("This hand could not be parsed.");
        return;
      }
      setLoaded({
        hand,
        storedId: row.id,
        origin: "db",
        sourceFilename: row.sourceFilename,
        siteId: row.site,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load this hand.");
    }
  }

  /** Loads a hand the converter parked for us on its way to this route. */
  const loadPhf = useCallback((hand: PhfHand) => {
    setLoaded({
      hand: toParsedHand(hand),
      storedId: null,
      origin: "converter",
      sourceFilename: hand.meta.originalFilename ?? null,
      siteId: hand.meta.siteId,
    });
    setNotice("From the converter — not saved to your library.");
  }, []);

  // Runs once per mount, and clears the key so a later reload does not
  // resurrect it.
  useEffect(() => {
    const pending = takePendingHand();
    if (pending) {
      loadPhf(pending.phf);
    }
  }, [loadPhf]);

  /** Set when save was pressed with no session, so the click survives the dialog. */
  const wantsSaveRef = useRef(false);

  useEffect(() => {
    if (auth.isSignedIn && wantsSaveRef.current) {
      wantsSaveRef.current = false;
      void saveLoadedHand();
    }
    // `saveLoadedHand` closes over `loaded`, which has not changed across the
    // sign-in; depending on its identity would re-save on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isSignedIn]);

  async function saveLoadedHand() {
    if (!loaded || loaded.storedId) {
      return;
    }
    if (!auth.isSignedIn) {
      wantsSaveRef.current = true;
      auth.requestSignIn("Sign in to keep this hand. Only you will see it.");
      return;
    }
    setSaving(true);
    try {
      const result = await saveSingleHand(loaded.hand, {
        source: loaded.siteId,
        sourceFilename: loaded.sourceFilename,
      });
      setLoaded({ ...loaded, storedId: result.id });
      setNotice(result.duplicate ? "Already in your library." : "Saved to your library.");
      void runSearch(filters, page);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="stack">
      {loaded ? (
        <section className="card card--flush">
          {notice ? <p className="notice notice--info">{notice}</p> : null}
          <ReplayViewer
            key={loaded.hand.handKey}
            hand={loaded.hand}
            site={siteLabel(loaded.siteId)}
            onClose={() => {
              setLoaded(null);
              setNotice(null);
            }}
            headerExtra={
              <>
                <ShareHandButton hand={loaded.hand} storedHandId={loaded.storedId} iconOnly />
                {/* Only for a hand that is not in the library yet — which here
                    means one the converter handed over. */}
                {loaded.origin !== "db" && !loaded.storedId && isDatabaseConfigured ? (
                  <button
                    type="button"
                    className="btn btn--icon"
                    onClick={() => void saveLoadedHand()}
                    disabled={saving}
                    aria-label="Save to my library"
                    title={saving ? "Saving…" : "Save to my library"}
                  >
                    💾
                  </button>
                ) : null}
              </>
            }
          />
        </section>
      ) : null}

      <section className="card">
        <header className="card__head">
          <div>
            <h2>My hands</h2>
            <p className="muted">
              {!isDatabaseConfigured
                ? "No database configured."
                : !auth.isSignedIn
                  ? "Private to your account."
                  : `${total.toLocaleString("en-US")} ${total === 1 ? "hand" : "hands"}`}
            </p>
          </div>
        </header>

        {/* Signed out, the filters and the list would both be furniture around
            nothing — there is no library to filter. The gate replaces them
            rather than sitting above an empty table. `loading` is excluded so a
            returning user does not see it flash before their session restores. */}
        {isDatabaseConfigured && !auth.isSignedIn && auth.status !== "loading" ? (
          <div className="signin-gate">
            <p>Sign in to see the hands you have saved.</p>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => auth.requestSignIn("Sign in to open your hand library.")}
            >
              Sign in
            </button>
          </div>
        ) : (
          <>
            <HandFiltersBar
              value={filters}
              onApply={applyFilters}
              onReset={() => applyFilters(EMPTY_REPLAYER_FILTERS)}
              loading={loading}
            />

            {listError ? <p className="notice notice--error">{listError}</p> : null}

            <HandList
              rows={rows}
              loading={loading}
              activeId={loaded?.storedId ?? null}
              onOpen={openStoredHand}
            />

            {pageCount > 1 ? (
              <div className="pager">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={page === 0}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                >
                  ← Previous
                </button>
                <span className="muted">
                  Page {page + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next →
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
