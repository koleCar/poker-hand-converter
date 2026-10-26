"use client";

/**
 * Settings -> Your data (Rail R6.5, GDPR Art. 15 / 20), on
 * `/settings#your-data`: download everything the account holds as one ZIP,
 * built in this tab (`lib/account/export.ts`) and written straight to a file
 * the user picks where the browser can (File System Access), else downloaded
 * when complete. Nothing is stored on the server.
 */

import { useEffect, useRef, useState } from "react";
import { exportAccount, ExportCancelled, exportFileName, type ExportProgress } from "../../lib/account/export";
import { buildReadme } from "../../lib/account/readme";
import { BlobSink, writableSink, ZipWriter, type ZipSink } from "../../lib/account/zipWriter";
import { databaseExportSource } from "../../lib/db/accountData";
import { DatabaseRpcError } from "../../lib/db/client";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import styles from "./account.module.css";

/** `12 345 678` bytes -> `12.3 MB`, in the reader's number format. */
export function formatSize(bytes: number, intl: string): string {
  if (bytes < 1_000_000) {
    return `${Math.max(1, Math.round(bytes / 1000)).toLocaleString(intl)} kB`;
  }
  if (bytes < 1_000_000_000) {
    return `${(bytes / 1_000_000).toLocaleString(intl, { maximumFractionDigits: 1 })} MB`;
  }
  return `${(bytes / 1_000_000_000).toLocaleString(intl, { maximumFractionDigits: 2 })} GB`;
}

type State =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "running"; progress: ExportProgress | null }
  | { kind: "done"; name: string; bytes: number; url: string | null }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

interface SaveFileHandle {
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

/** The progress lines, for the running export. Exported for the tests. */
export function ExportProgressView({ progress, t, intl }: { progress: ExportProgress | null; t: Dict["yourData"]["data"]; intl: string }) {
  if (!progress || progress.phase === "manifest" || progress.phase === "profile") {
    return <p className="muted" role="status">{t.counting}</p>;
  }
  const share =
    progress.phase === "hands"
      ? progress.handsTotal > 0
        ? progress.handsDone / progress.handsTotal
        : 0
      : progress.phase === "sections"
        ? progress.sectionsTotal > 0
          ? progress.sectionsDone / progress.sectionsTotal
          : 0
        : progress.phase === "originals"
          ? progress.originalsTotal > 0
            ? progress.originalsDone / progress.originalsTotal
            : 0
          : 1;
  const line =
    progress.phase === "hands"
      ? t.progressHands(progress.handsDone, progress.handsTotal)
      : progress.phase === "sections"
        ? t.progressSections(progress.sectionsDone, progress.sectionsTotal)
        : progress.phase === "originals"
          ? t.progressOriginals(progress.originalsDone, progress.originalsTotal)
          : t.finishing;
  return (
    <div className={styles.progress}>
      <p className={styles.small} role="status">
        {line}
      </p>
      <div
        className={styles.meter}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, share) * 100)}
        aria-label={line}
      >
        <div className={styles.meterFill} style={{ width: `${Math.round(Math.min(1, share) * 100)}%` }} />
      </div>
      <p className={`muted ${styles.small}`}>{t.written(formatSize(progress.bytes, intl))}</p>
    </div>
  );
}

export function YourDataPanel({ username }: { username: string | null }) {
  const en = useDict();
  const t = en.yourData.data;
  // Off by default: rebuilt from the hands, and about three times the file and
  // four times the wait (R6.5, measured on 1 000 000 hands).
  const [derived, setDerived] = useState(false);
  const [originals, setOriginals] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const section = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#your-data") {
      section.current?.scrollIntoView();
    }
  }, []);

  // A download URL is a reference to the whole archive: let it go.
  const doneUrl = state.kind === "done" ? state.url : null;
  useEffect(() => {
    return () => {
      if (doneUrl) URL.revokeObjectURL(doneUrl);
    };
  }, [doneUrl]);

  async function start() {
    const name = exportFileName(username, new Date());
    let sink: ZipSink;
    let blob: BlobSink | null = null;
    let fileStream: { abort(): Promise<void> } | null = null;
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (typeof picker === "function") {
      setState({ kind: "picking" });
      try {
        const handle = await picker({
          suggestedName: name,
          types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
        });
        const writable = await handle.createWritable();
        fileStream = writable;
        sink = writableSink(writable);
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") {
          setState({ kind: "idle" });
          return;
        }
        blob = new BlobSink();
        sink = blob;
      }
    } else {
      blob = new BlobSink();
      sink = blob;
    }

    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: "running", progress: null });
    try {
      const result = await exportAccount(databaseExportSource, new ZipWriter(sink), {
        derived,
        originals,
        readme: (context) => buildReadme(en.yourData.readme, context),
        signal: controller.signal,
        onProgress: (progress) => setState({ kind: "running", progress }),
      });
      let url: string | null = null;
      if (blob) {
        url = URL.createObjectURL(blob.toBlob());
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setState({ kind: "done", name, bytes: result.bytes, url });
    } catch (error) {
      await fileStream?.abort().catch(() => undefined);
      if (error instanceof ExportCancelled) {
        setState({ kind: "cancelled" });
      } else if (error instanceof DatabaseRpcError && error.code === "53400") {
        setState({ kind: "failed", message: t.rateLimited });
      } else {
        setState({ kind: "failed", message: t.failed(error instanceof Error ? error.message : String(error)) });
      }
    } finally {
      abort.current = null;
    }
  }

  const busy = state.kind === "running" || state.kind === "picking";

  return (
    <section id="your-data" ref={section} className={`card ${styles.panel}`} aria-labelledby="settings-your-data">
      <h2 id="settings-your-data" className={styles.heading}>
        {t.heading}
      </h2>
      <p>{t.intro}</p>
      <p className={`muted ${styles.small}`}>{t.formats}</p>

      <fieldset className={styles.options} disabled={busy}>
        <label className={styles.check}>
          <input type="checkbox" checked={derived} onChange={(event) => setDerived(event.target.checked)} />
          <span>{t.derived}</span>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={originals} onChange={(event) => setOriginals(event.target.checked)} />
          <span>{t.originals}</span>
        </label>
      </fieldset>
      <p className={`muted ${styles.small}`}>{t.bigHint}</p>

      {state.kind === "picking" ? <p className="muted">{t.pickFile}</p> : null}
      {state.kind === "running" ? <ExportProgressView progress={state.progress} t={t} intl={en.chrome.intl} /> : null}
      {state.kind === "done" ? (
        <p className="notice notice--info" role="status">
          {t.done(state.name, formatSize(state.bytes, en.chrome.intl))} {state.url ? null : t.savedToDisk}
        </p>
      ) : null}
      {state.kind === "cancelled" ? <p className="notice notice--warn">{t.cancelled}</p> : null}
      {state.kind === "failed" ? (
        <p className="notice notice--error" role="alert">
          {state.message}
        </p>
      ) : null}

      <div className={styles.actions}>
        {state.kind === "running" ? (
          <button type="button" className="btn" onClick={() => abort.current?.abort()}>
            {t.cancel}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void start()}>
            {t.start}
          </button>
        )}
        {state.kind === "done" && state.url ? (
          <a className="btn btn--ghost" href={state.url} download={state.name}>
            {t.saveAgain}
          </a>
        ) : null}
      </div>
    </section>
  );
}
