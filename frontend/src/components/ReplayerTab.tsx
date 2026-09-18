import { useCallback, useEffect, useRef, useState } from "react";
import { convertCashWeplayFile } from "../lib/converter";
import {
  isWeplayFormat,
  parseHand,
  splitHands,
  type ParsedHand,
} from "../lib/handParser";
import {
  fetchHandText,
  saveSingleHand,
  searchHands,
  type HandFilters,
  type StoredHandRow,
} from "../lib/handStore";
import { EMPTY_FILTERS } from "../lib/handStore";
import { isSupabaseConfigured } from "../lib/supabase";
import { HandFiltersBar } from "./HandFiltersBar";
import { HandList } from "./HandList";
import { ShareHandButton } from "./share/ShareHandButton";
import { ReplayViewer } from "./replayer/ReplayViewer";

const PAGE_SIZE = 25;

type LoadedHand = {
  hand: ParsedHand;
  /** Row id when the hand came from the database. */
  storedId: string | null;
  origin: "db" | "upload";
  /** Original text when the upload had to be converted first. */
  sourceText: string | null;
  sourceFilename: string | null;
  converted: boolean;
};

interface ReplayerTabProps {
  refreshToken: number;
}

export function ReplayerTab({ refreshToken }: ReplayerTabProps) {
  const [filters, setFilters] = useState<HandFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<StoredHandRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<LoadedHand | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [savingUpload, setSavingUpload] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(
    async (nextFilters: HandFilters, nextPage: number) => {
      if (!isSupabaseConfigured) {
        return;
      }
      setLoading(true);
      setListError(null);
      try {
        const result = await searchHands(nextFilters, {
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

  function applyFilters(next: HandFilters) {
    setFilters(next);
    setPage(0);
    void runSearch(next, 0);
  }

  async function openStoredHand(row: StoredHandRow) {
    setUploadError(null);
    try {
      const text = await fetchHandText(row.id);
      const hand = parseHand(text);
      if (!hand) {
        setListError("This hand could not be parsed.");
        return;
      }
      setLoaded({
        hand,
        storedId: row.id,
        origin: "db",
        sourceText: null,
        sourceFilename: row.source_filename,
        converted: false,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load this hand.");
    }
  }


  /**
   * Accepts either GG or WePlay text. Invalid WePlay input is run through the
   * converter first; only if that also fails do we give up.
   */
  function loadFromText(text: string, fileName: string | null) {
    setUploadError(null);
    setUploadNotice(null);

    const direct = splitHands(text);
    const firstDirect = direct.length ? parseHand(direct[0]) : null;

    if (firstDirect && !isWeplayFormat(direct[0])) {
      setLoaded({
        hand: firstDirect,
        storedId: null,
        origin: "upload",
        sourceText: null,
        sourceFilename: fileName,
        converted: false,
      });
      setUploadNotice(
        direct.length > 1
          ? `File contains ${direct.length} hands — the first one was loaded. Use the Converter tab for batches.`
          : "Hand parsed and ready to replay.",
      );
      return;
    }

    const converted = convertCashWeplayFile(fileName ?? "hand.txt", text);
    if (converted.status !== "converted") {
      setUploadError(
        firstDirect
          ? "Recognised as WePlay format, but the conversion failed."
          : converted.message ?? "That text is not a recognisable hand history.",
      );
      setLoaded(null);
      return;
    }

    const convertedChunks = splitHands(converted.outputText);
    const hand = convertedChunks.length ? parseHand(convertedChunks[0]) : null;
    if (!hand) {
      setUploadError("Conversion succeeded, but the hand could not be parsed.");
      setLoaded(null);
      return;
    }

    setLoaded({
      hand,
      storedId: null,
      origin: "upload",
      sourceText: text,
      sourceFilename: fileName,
      converted: true,
    });
    setUploadNotice(
      `Input was WePlay format — converted to GG${
        convertedChunks.length > 1 ? ` (${convertedChunks.length} hands, first one loaded)` : ""
      }.`,
    );
  }

  async function saveLoadedHand() {
    if (!loaded || loaded.storedId) {
      return;
    }
    setSavingUpload(true);
    setUploadError(null);
    try {
      const result = await saveSingleHand(loaded.hand, {
        source: loaded.converted ? "weplay" : "gg",
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
              Upload a single hand (GG or WePlay format) or paste the text. WePlay hands are
              converted automatically before replay.
            </p>
          </div>
          <div className="card__head-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPasteOpen((v) => !v)}>
              {pasteOpen ? "Close paste" : "Paste text"}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              Choose file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                loadFromText(await file.text(), file.name);
                event.target.value = "";
              }}
            />
          </div>
        </header>

        {pasteOpen ? (
          <div className="paste">
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="Poker Hand #HD…  or  Weplay Hand #…"
              rows={8}
              spellCheck={false}
            />
            <div className="card__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => loadFromText(pasteText, null)}
                disabled={!pasteText.trim()}
              >
                Load
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
                {loaded.origin === "upload" && !loaded.storedId && isSupabaseConfigured ? (
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
              {isSupabaseConfigured
                ? `${total} hands match the filters`
                : "No database configured."}
            </p>
          </div>
        </header>

        <HandFiltersBar
          value={filters}
          onApply={applyFilters}
          onReset={() => applyFilters(EMPTY_FILTERS)}
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
