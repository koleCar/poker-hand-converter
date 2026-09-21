import { useCallback, useEffect, useRef, useState } from "react";
import { parseHand, toParsedHand, type ParsedHand } from "../lib/handParser";
import { convertAny } from "../lib/phf";
import type { PhfHand } from "../lib/phf/types";
import { getHand, isDatabaseConfigured, searchHands, type HandSummary } from "../lib/db";
import { saveSingleHand } from "../lib/handStore";
import { FILE_ACCEPT, loadFile } from "./converter/inputs";
import { PENDING_HAND_KEY, type PendingHand } from "./converter/handoff";
import { HandFiltersBar } from "./HandFiltersBar";
import {
  EMPTY_REPLAYER_FILTERS,
  toHandFilters,
  type ReplayerFilterForm,
} from "./handFilters";
import { HandList } from "./HandList";
import { ShareHandButton } from "./share/ShareHandButton";
import { ReplayViewer } from "./replayer/ReplayViewer";

const PAGE_SIZE = 25;

/**
 * A hand parked by the converter is only honoured for this long.
 *
 * `sessionStorage` survives a reload but not a tab close, so the realistic
 * stale case is "clicked Replay, wandered off, came back an hour later and
 * navigated to the replayer by hand". Loading a hand they have forgotten about
 * would be confusing; ten minutes covers the real hand-off.
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
  /** Row id when the hand came from the database. */
  storedId: string | null;
  origin: "db" | "upload" | "converter";
  /** Original text when the upload had to be converted first. */
  sourceText: string | null;
  sourceFilename: string | null;
  converted: boolean;
  /** Parser the hand came from, so saving records the real room. */
  siteId: string;
};

interface ReplayerTabProps {
  refreshToken: number;
}

export function ReplayerTab({ refreshToken }: ReplayerTabProps) {
  const [filters, setFilters] = useState<ReplayerFilterForm>(EMPTY_REPLAYER_FILTERS);
  const [rows, setRows] = useState<HandSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<LoadedHand | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [savingUpload, setSavingUpload] = useState(false);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    void runSearch(filters, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, refreshToken]);

  function applyFilters(next: ReplayerFilterForm) {
    setFilters(next);
    setPage(0);
    void runSearch(next, 0);
  }

  async function openStoredHand(row: HandSummary) {
    setUploadError(null);
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
        sourceText: null,
        sourceFilename: row.sourceFilename,
        converted: false,
        siteId: row.site,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load this hand.");
    }
  }

  /**
   * Loads one hand out of text from any supported room.
   *
   * This runs the same detection and conversion the converter tab uses, so
   * every registered parser works here too — before this the replayer only
   * understood our own standard text and WePlay, which meant pasting a
   * PokerStars or Winamax hand into the box that says "paste the text" simply
   * failed. Only the first hand is loaded: this is a replayer, and a batch
   * belongs on the converter tab.
   */
  const loadFromText = useCallback(async (text: string, fileName: string | null) => {
    setUploadError(null);
    setUploadNotice(null);
    setLoadingUpload(true);
    try {
      const result = await convertAny(text, { sourceFilename: fileName, validate: true });
      const [first] = result.hands;
      if (!first) {
        // Every parser writes a human-readable reason; the first one is the
        // best guess at what the user actually needs to hear.
        setUploadError(
          result.failures[0]?.message ?? "That text is not a recognisable hand history.",
        );
        setLoaded(null);
        return;
      }

      setLoaded({
        hand: toParsedHand(first),
        storedId: null,
        origin: "upload",
        sourceText: text,
        sourceFilename: fileName,
        converted: first.meta.siteId !== "standard",
        siteId: first.meta.siteId,
      });

      // The box has done its job; leaving eight rows of raw hand history open
      // above the table pushes the replayer off a phone screen entirely.
      setPasteOpen(false);

      const total = result.hands.length;
      setUploadNotice(
        total > 1
          ? `${first.meta.siteName} — ${total} hands found, the first one is loaded. Use the converter for batches.`
          : `${first.meta.siteName} hand loaded.`,
      );
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "That text could not be read.");
      setLoaded(null);
    } finally {
      setLoadingUpload(false);
    }
  }, []);

  /** Loads a hand the converter parked for us on its way to this route. */
  const loadPhf = useCallback((hand: PhfHand, note: string) => {
    setUploadError(null);
    setLoaded({
      hand: toParsedHand(hand),
      storedId: null,
      origin: "converter",
      sourceText: null,
      sourceFilename: hand.meta.originalFilename ?? null,
      converted: hand.meta.siteId !== "standard",
      siteId: hand.meta.siteId,
    });
    setUploadNotice(note);
  }, []);

  // The converter hands a hand over through `sessionStorage` (see
  // `converter/handoff.ts`) because the two tabs are separate routes. Runs once
  // per mount, and clears the key so a later reload does not resurrect it.
  useEffect(() => {
    const pending = takePendingHand();
    if (pending) {
      loadPhf(
        pending.phf,
        `${pending.phf.meta.siteName} hand from the converter. It is not saved to your library.`,
      );
    }
  }, [loadPhf]);

  async function saveLoadedHand() {
    if (!loaded || loaded.storedId) {
      return;
    }
    setSavingUpload(true);
    setUploadError(null);
    try {
      const result = await saveSingleHand(loaded.hand, {
        source: loaded.siteId,
        sourceText: loaded.sourceText,
        sourceFilename: loaded.sourceFilename,
      });
      setLoaded({ ...loaded, storedId: result.id });
      setUploadNotice(result.duplicate ? "This hand was already in the database." : "Hand saved to the database.");
      void runSearch(filters, page);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Saving failed.");
    } finally {
      setSavingUpload(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="stack">
      <section className="card">
        <header className="card__head">
          <div>
            <h2>Load a hand to replay</h2>
            <p className="muted">
              Paste a hand or pick a file from any supported poker room — we work out which one
              wrote it. For whole folders and batches, use the converter.
            </p>
          </div>
          <div className="card__head-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPasteOpen((v) => !v)}>
              {pasteOpen ? "Close paste" : "Paste text"}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => fileRef.current?.click()}
              disabled={loadingUpload}
            >
              {loadingUpload ? "Reading…" : "Choose file"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={FILE_ACCEPT}
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setLoadingUpload(true);
                // Shared with the converter so the replayer gets the same
                // UTF-16 / Windows-1252 handling instead of `file.text()`,
                // which would turn an 8-bit export into mojibake.
                const [source] = await loadFile(file);
                if (!source || source.problem) {
                  setLoadingUpload(false);
                  setUploadNotice(null);
                  setUploadError(source?.problem ?? "That file could not be read.");
                  return;
                }
                await loadFromText(source.text, file.name);
              }}
            />
          </div>
        </header>

        {pasteOpen ? (
          <div className="paste">
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="Paste one hand history here — PokerStars, GGPoker, WePlay, Winamax, 888poker…"
              rows={8}
              spellCheck={false}
            />
            <div className="card__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void loadFromText(pasteText, null)}
                disabled={!pasteText.trim() || loadingUpload}
              >
                {loadingUpload ? "Loading…" : "Load"}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPasteText("")}>
                Clear
              </button>
            </div>
          </div>
        ) : null}

        {uploadError ? <p className="notice notice--error">{uploadError}</p> : null}
        {uploadNotice ? <p className="notice notice--info">{uploadNotice}</p> : null}
      </section>

      {loaded ? (
        <section className="card card--flush">
          <ReplayViewer
            key={loaded.hand.handKey}
            hand={loaded.hand}
            onClose={() => setLoaded(null)}
            headerExtra={
              <>
                {loaded.origin !== "db" && !loaded.storedId && isDatabaseConfigured ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={saveLoadedHand}
                    disabled={savingUpload}
                  >
                    {savingUpload ? "Saving…" : "Save to database"}
                  </button>
                ) : loaded.storedId ? (
                  <span className="tag tag--good">saved</span>
                ) : null}
                <ShareHandButton hand={loaded.hand} storedHandId={loaded.storedId} />
              </>
            }
          />
        </section>
      ) : null}

      <section className="card">
        <header className="card__head">
          <div>
            <h2>Hands in your database</h2>
            <p className="muted">
              {isDatabaseConfigured
                ? `${total.toLocaleString("en-US")} ${total === 1 ? "hand matches" : "hands match"} the filters`
                : "No database configured."}
            </p>
          </div>
        </header>

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
      </section>
    </div>
  );
}
