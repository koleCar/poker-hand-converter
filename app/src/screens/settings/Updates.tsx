import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useId, useState } from "react";

import { percentOf } from "../../components/BackfillProgress";
import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import type { UpdateStatus } from "../../lib/ipc";
import { useTablesOpen } from "../../lib/useTablesOpen";
import { readableNotes, useUpdates, type UseUpdates } from "../../lib/useUpdates";
import styles from "./Settings.module.css";
import { Toggle } from "./Toggle";

const MEGABYTES = liveNumberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });

const mb = (bytes: number) => MEGABYTES.format(bytes / (1024 * 1024));

/**
 * Settings, Updates (`updates.rs`): a newer version as a banner on top -
 * its notes, the download with its progress, then "Install and restart" -
 * and under it one row: check automatically, and "Check now". Each step is
 * the user's click; the automatic check only looks.
 */
export function Updates() {
  const t = useT();
  const u = t.settings.updates;
  const updates = useUpdates();
  const { status, error, check, setAutomatic } = updates;
  const autoId = useId();

  if (!status) {
    return error ? (
      <p className={`${styles.note} ${styles.error}`} role="alert">
        {error}
      </p>
    ) : (
      <RailLoader size="inline" label={t.settings.loading} showLabel />
    );
  }
  const state = status.phase.state;
  return (
    <>
      <Banner status={status} updates={updates} />
      <div className={styles.card}>
        <div className={`${styles.row} ${styles.rowWide}`}>
          <label htmlFor={autoId}>{u.automaticShort}</label>
          <span className={styles.actions}>
            {state === "upToDate" && (
              <span className={styles.muted} role="status">
                {u.upToDateShort}
              </span>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={check}
              disabled={state === "checking" || state === "downloading" || state === "installing"}
            >
              {state === "checking" ? u.checking : u.checkNow}
            </button>
            <Toggle id={autoId} checked={status.automatic} onChange={setAutomatic} />
          </span>
        </div>
      </div>
      {error && (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** A newer version: what it is, and its one step (download, install, try again). */
function Banner({ status, updates }: { status: UpdateStatus; updates: UseUpdates }) {
  const t = useT();
  const u = t.settings.updates;
  const tablesOpen = useTablesOpen();
  const phase = status.phase;
  const blocker = status.installBlocker;

  let line: string;
  let below = null;
  let action = null;
  let progress: number | null = null;
  switch (phase.state) {
    case "idle":
    case "checking":
    case "upToDate":
      return null;

    case "available":
      line = u.available(phase.version);
      below = <Notes notes={phase.notes} />;
      action = (
        <button type="button" className="btn btn--primary btn--sm" onClick={updates.download}>
          {u.downloadShort}
        </button>
      );
      break;

    case "downloading": {
      const percent = phase.total ? percentOf(phase.downloaded, phase.total) : null;
      line = u.downloading(phase.version);
      progress = percent;
      action = (
        <span className={styles.muted}>
          {phase.total
            ? u.progress(mb(phase.downloaded), mb(phase.total), percent ?? 0)
            : u.progressUnknown(mb(phase.downloaded))}
        </span>
      );
      break;
    }

    case "ready":
      line = u.ready(phase.version);
      below = (
        <>
          <Notes notes={phase.notes} />
          {blocker && <p className={styles.muted}>{u.blockers[blocker]}</p>}
          {!blocker && tablesOpen && <p className={styles.warning}>{u.tablesOpen}</p>}
        </>
      );
      action = blocker ? (
        <button type="button" className="btn btn--primary btn--sm" onClick={updates.openDownloadPage}>
          {u.downloadPage}
        </button>
      ) : (
        <button type="button" className="btn btn--primary btn--sm" onClick={updates.install}>
          {u.install}
        </button>
      );
      break;

    case "installing":
      line = u.installing(phase.version);
      action = <RailLoader size="inline" label={line} delay={0} />;
      break;

    case "failed": {
      line = u.failed[phase.stage];
      below = (
        <>
          <p className={styles.muted}>{phase.kind === "other" ? u.kinds.other(phase.reason) : u.kinds[phase.kind]}</p>
          {phase.stage !== "check" && (
            <button type="button" className={styles.linkButton} onClick={updates.openDownloadPage}>
              {u.downloadPage}
            </button>
          )}
        </>
      );
      action = (
        // A failed download is tried again; a failed install starts over with a check.
        <button
          type="button"
          className="btn btn--sm"
          onClick={phase.stage === "download" ? updates.download : updates.check}
        >
          {u.tryAgain}
        </button>
      );
      break;
    }
  }

  return (
    <div className={styles.banner} role={phase.state === "failed" ? "alert" : "status"}>
      <span className={styles.bannerIcon}>
        <Icon name="download" />
      </span>
      <span className={styles.value}>
        <span className={styles.strong}>{line}</span>
        {below}
      </span>
      <span className={styles.actions}>{action}</span>
      {phase.state === "downloading" && (
        <span
          className={styles.progress}
          role="progressbar"
          aria-label={line}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <span className={styles.progressFill} style={{ width: `${progress ?? 0}%` }} />
        </span>
      )}
    </div>
  );
}

/** The release notes, folded away: "What's new" shows them. */
function Notes({ notes }: { notes: string | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = notes ? readableNotes(notes) : "";
  if (!text) return null;
  return (
    <>
      <button
        type="button"
        className={styles.linkButton}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {t.settings.updates.whatsNew}
      </button>
      {open && (
        <p id={id} className={styles.notesText}>
          {text}
        </p>
      )}
    </>
  );
}
