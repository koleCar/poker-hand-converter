import { RailLoader } from "@rail/ui/loader/RailLoader";

import { percentOf } from "../../components/BackfillProgress";
import { useT } from "../../i18n";
import { liveDateFormat, liveNumberFormat } from "../../i18n/format";
import type { UpdatePhase, UpdateStatus } from "../../lib/ipc";
import { useTablesOpen } from "../../lib/useTablesOpen";
import { readableNotes, useUpdates } from "../../lib/useUpdates";
import styles from "./Settings.module.css";

const WHEN = liveDateFormat({ dateStyle: "medium", timeStyle: "short" });
const DAY = liveDateFormat({ dateStyle: "medium" });
const MEGABYTES = liveNumberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });

const mb = (bytes: number) => MEGABYTES.format(bytes / (1024 * 1024));

/**
 * Settings, Updates (`updates.rs`): this version, "Check for updates", and
 * for a newer one its notes, the download with its progress, then "Install
 * and restart". Each step is the user's click; the automatic check (the
 * setting below) only looks.
 */
export function Updates() {
  const t = useT();
  const u = t.settings.updates;
  const { status, error, check, download, install, setAutomatic, openDownloadPage } = useUpdates();
  const tablesOpen = useTablesOpen();

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{u.heading}</h2>
      {!status && !error && (
        <p className={styles.muted}>
          <RailLoader size="inline" label={t.settings.loading} showLabel />
        </p>
      )}
      {status && (
        <>
          <div className={styles.row}>
            <span>
              <span className={styles.label}>{u.current(status.current)}</span>
              <br />
              <span className={styles.hint}>
                {status.lastCheckedMs !== null ? u.lastChecked(WHEN.format(status.lastCheckedMs)) : u.notChecked}
              </span>
            </span>
            <button
              type="button"
              className={styles.quietButton}
              onClick={check}
              disabled={busy(status.phase)}
            >
              {status.phase.state === "checking" ? u.checking : u.check}
            </button>
          </div>

          <PhaseView
            status={status}
            tablesOpen={tablesOpen}
            onDownload={download}
            onInstall={install}
            onRetry={check}
            onDownloadPage={openDownloadPage}
          />

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={status.automatic}
              onChange={(event) => setAutomatic(event.target.checked)}
            />
            <span>
              <span className={styles.label}>{u.automatic}</span>
              <br />
              <span className={styles.hint}>{u.automaticHint}</span>
            </span>
          </label>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function busy(phase: UpdatePhase): boolean {
  return phase.state === "checking" || phase.state === "downloading" || phase.state === "installing";
}

/** What the last step left: nothing to say, up to date, a version to get, its download, the install. */
function PhaseView({
  status,
  tablesOpen,
  onDownload,
  onInstall,
  onRetry,
  onDownloadPage,
}: {
  status: UpdateStatus;
  tablesOpen: boolean;
  onDownload: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onDownloadPage: () => void;
}) {
  const t = useT();
  const u = t.settings.updates;
  const phase = status.phase;
  const blocker = status.installBlocker;

  switch (phase.state) {
    case "idle":
    case "checking":
      return null;

    case "upToDate":
      return (
        <p className={styles.notice} role="status">
          {u.upToDate}
        </p>
      );

    case "available":
      return (
        <div className={styles.update} role="status">
          <p className={styles.label}>
            <strong>{u.available(phase.version)}</strong>
            {phase.dateMs !== null && <span className={styles.hint}> {u.published(DAY.format(phase.dateMs))}</span>}
          </p>
          <Notes notes={phase.notes} />
          <div className={styles.buttons}>
            <button type="button" className={styles.button} onClick={onDownload}>
              {u.download}
            </button>
          </div>
          <p className={styles.hint}>{u.downloadHint}</p>
        </div>
      );

    case "downloading": {
      const percent = phase.total ? percentOf(phase.downloaded, phase.total) : null;
      const label = u.downloading(phase.version);
      return (
        <div className={styles.update} role="status">
          <p className={styles.label}>
            <RailLoader size="inline" label={label} delay={0} /> {label}
          </p>
          <progress
            className={styles.bar}
            max={100}
            value={percent ?? undefined}
            aria-label={label}
          />
          <p className={styles.hint}>
            {phase.total
              ? u.progress(mb(phase.downloaded), mb(phase.total), percent ?? 0)
              : u.progressUnknown(mb(phase.downloaded))}
          </p>
        </div>
      );
    }

    case "ready":
      return (
        <div className={styles.update} role="status">
          <p className={styles.label}>
            <strong>{u.ready(phase.version)}</strong>
          </p>
          <Notes notes={phase.notes} />
          {blocker ? (
            <>
              <p className={styles.hint}>{u.blockers[blocker]}</p>
              <div className={styles.buttons}>
                <button type="button" className={styles.button} onClick={onDownloadPage}>
                  {u.downloadPage}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.buttons}>
                <button type="button" className={styles.button} onClick={onInstall}>
                  {u.install}
                </button>
              </div>
              <p className={styles.hint}>{u.installHint}</p>
              {tablesOpen && <p className={styles.warning}>{u.tablesOpen}</p>}
            </>
          )}
        </div>
      );

    case "installing":
      return (
        <p className={styles.label} role="status">
          <RailLoader size="inline" label={u.installing(phase.version)} delay={0} /> {u.installing(phase.version)}
        </p>
      );

    case "failed": {
      const kind = phase.kind === "other" ? u.kinds.other(phase.reason) : u.kinds[phase.kind];
      return (
        <div className={styles.update} role="alert">
          <p className={styles.error}>
            {u.failed[phase.stage]} {kind}
          </p>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.quietButton}
              onClick={phase.stage === "download" ? onDownload : onRetry}
              // A failed download is tried again; a failed install starts over with a check.
            >
              {u.tryAgain}
            </button>
            {phase.stage !== "check" && (
              <button type="button" className={styles.linkButton} onClick={onDownloadPage}>
                {u.downloadPage}
              </button>
            )}
          </div>
        </div>
      );
    }
  }
}

/** The release notes, folded away: a click shows them. */
function Notes({ notes }: { notes: string | null }) {
  const t = useT();
  if (!notes) return null;
  const text = readableNotes(notes);
  if (!text) return null;
  return (
    <details className={styles.notes}>
      <summary>{t.settings.updates.whatsNew}</summary>
      <p className={styles.notesText}>{text}</p>
    </details>
  );
}
