import { useCallback, useEffect, useState } from "react";
import { Icon } from "@rail/ui/icon/Icon";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import headerStyles from "../components/ScreenHeader.module.css";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { inApp, ipc, onManualImportChanged, type ManualImportStatus } from "../lib/ipc";
import { REFUSED, screenHref } from "../lib/router";
import styles from "./Import.module.css";

/** The current (or last) import, reloaded on every change the app reports. */
function useImportStatus(): [ManualImportStatus | null, () => void] {
  const [status, setStatus] = useState<ManualImportStatus | null>(null);
  const reload = useCallback(() => {
    ipc
      .manualImportStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
    return onManualImportChanged(reload);
  }, [reload]);
  return [status, reload];
}

/** Files and folders dropped on the window while this screen is open. */
function useDrop(onDrop: (paths: string[]) => void, enabled: boolean): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!inApp || !enabled) return;
    let stop: (() => void) | null = null;
    let stopped = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setOver(true);
        } else if (payload.type === "leave") {
          setOver(false);
        } else {
          setOver(false);
          if (payload.paths.length > 0) onDrop(payload.paths);
        }
      })
      .then((unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      stop?.();
    };
  }, [onDrop, enabled]);
  return over && enabled;
}

/**
 * Import: hand histories picked by hand - files, or a folder with its
 * subfolders - read once into Rail (`manual_import.rs`), without watching
 * them afterwards; watched folders are Settings, Folders. Clean, as the
 * other screens: no visible title, the pickers and the drop target, then the
 * import's progress and what it came to.
 */
export function Import() {
  const t = useT();
  const m = t.manualImport;
  const [status, reload] = useImportStatus();
  const [error, setError] = useState<string | null>(null);
  const running = status?.phase === "finding" || status?.phase === "importing";

  const start = useCallback(
    (paths: string[]) => {
      setError(null);
      ipc
        .manualImportStart(paths)
        .then(reload)
        .catch((reason: unknown) => setError(String(reason)));
    },
    [reload],
  );
  const over = useDrop(start, !running);

  if (!inApp) {
    return <StateMessage kind="empty">{m.unavailable}</StateMessage>;
  }

  const pickFiles = () => {
    ipc
      .pickImportFiles()
      .then((paths) => paths && paths.length > 0 && start(paths))
      .catch((reason: unknown) => setError(String(reason)));
  };
  const pickFolder = () => {
    ipc
      .pickFolder()
      .then((path) => path && start([path]))
      .catch((reason: unknown) => setError(String(reason)));
  };

  return (
    <div className={styles.screen}>
      {/* No header row: nothing to say before the pickers; the heading stays for assistive technology. */}
      <h1 className={headerStyles.visuallyHidden}>{t.screens.import.title}</h1>
      {running && status ? (
        <Progress status={status} />
      ) : (
        <div className={over ? `${styles.drop} ${styles.over}` : styles.drop}>
          <Icon name="upload" className={styles.dropIcon} />
          {over ? (
            <p className={styles.dropText}>{m.dropActive}</p>
          ) : (
            <>
              <div className={styles.actions}>
                <button type="button" className="btn btn--primary" onClick={pickFiles}>
                  {m.pickFiles}
                </button>
                <button type="button" className="btn" onClick={pickFolder}>
                  {m.pickFolder}
                </button>
              </div>
              <p className={styles.dropText}>{m.drop}</p>
              <p className={styles.hint}>{m.hint}</p>
            </>
          )}
        </div>
      )}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!running && status && <Result status={status} />}
    </div>
  );
}

function Progress({ status }: { status: ManualImportStatus }) {
  const t = useT();
  const m = t.manualImport;
  const share = status.bytes > 0 ? Math.min(1, status.bytesDone / status.bytes) : 0;
  return (
    <div className={styles.progress} role="status">
      <div className={styles.progressRow}>
        <span className={styles.number}>
          {status.phase === "finding" ? m.finding : m.progress(status.filesDone, status.files)}
        </span>
        <button type="button" className="btn btn--ghost" onClick={() => void ipc.manualImportCancel()}>
          {m.stop}
        </button>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <span className={styles.fill} style={{ width: `${share * 100}%` }} />
      </div>
      <Counts status={status} />
    </div>
  );
}

function Counts({ status }: { status: ManualImportStatus }) {
  const t = useT();
  const m = t.manualImport;
  return (
    <ul className={styles.counts}>
      <li className={status.inserted > 0 ? styles.positive : undefined}>{m.inserted(status.inserted)}</li>
      {status.duplicates > 0 && <li>{m.duplicates(status.duplicates)}</li>}
      {status.refused > 0 && <li className={styles.negative}>{m.refused(status.refused)}</li>}
      {status.unrecognized > 0 && <li>{m.unrecognized(status.unrecognized)}</li>}
      {status.errorCount > 0 && <li className={styles.negative}>{m.unreadable(status.errorCount)}</li>}
    </ul>
  );
}

/** What the last import came to, under the pickers. */
function Result({ status }: { status: ManualImportStatus }) {
  const t = useT();
  const m = t.manualImport;
  if (status.phase === "idle") return null;
  if (status.phase === "failed") {
    return (
      <p className={styles.error} role="alert">
        {m.failed(status.error ?? "")}
      </p>
    );
  }
  if (status.phase === "done" && status.files === 0 && status.errorCount === 0) {
    return <p className={styles.hint}>{m.nothingFound}</p>;
  }
  return (
    <div className={styles.result}>
      <span className={styles.resultLabel}>{status.phase === "cancelled" ? m.stopped : m.done}</span>
      <Counts status={status} />
      <div className={styles.links}>
        {status.inserted > 0 && (
          <a className={styles.link} href={screenHref("hands")}>
            {m.openHands}
          </a>
        )}
        {status.refused > 0 && (
          <a className={styles.link} href={screenHref(REFUSED)}>
            {m.openRefused}
          </a>
        )}
      </div>
      {status.errors.length > 0 && (
        <ul className={styles.errors}>
          {status.errors.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
