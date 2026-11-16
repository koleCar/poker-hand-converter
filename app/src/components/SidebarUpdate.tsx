import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useId, useState, type ReactNode } from "react";

import { useT } from "../i18n";
import { liveNumberFormat } from "../i18n/format";
import type { UpdatePhase, UpdateStatus } from "../lib/ipc";
import { readableNotes, useUpdates, type UseUpdates } from "../lib/useUpdates";
import { percentOf } from "./BackfillProgress";
import styles from "./Sidebar.module.css";

const MEGABYTES = liveNumberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });

const mb = (bytes: number) => MEGABYTES.format(bytes / (1024 * 1024));

/** A phase the card shows: a newer Rail found, on its way, or a step that failed. */
function shown(phase: UpdatePhase | undefined): phase is Exclude<UpdatePhase, { state: "idle" | "checking" | "upToDate" }> {
  if (!phase) return false;
  if (phase.state === "failed") return phase.stage !== "check";
  return phase.state !== "idle" && phase.state !== "checking" && phase.state !== "upToDate";
}

/**
 * The update card above the account (`updates.rs`), whenever a newer Rail
 * is there: what it is and its one step - "Update" downloads it (with its
 * progress), then "Install and restart". The app looks by itself shortly
 * after start and every few hours; nothing about updates lives in Settings.
 * Collapsed, it is one icon button that takes the same step.
 */
export function SidebarUpdate({ collapsed, tablesOpen }: { collapsed: boolean; tablesOpen: boolean }) {
  const updates = useUpdates();
  const { status } = updates;
  if (!status || !shown(status.phase)) return null;
  return collapsed ? (
    <Compact status={status} updates={updates} />
  ) : (
    <Card status={status} updates={updates} tablesOpen={tablesOpen} />
  );
}

/** The step a click takes, or `null` while one runs. */
function stepOf(status: UpdateStatus, updates: UseUpdates): (() => void) | null {
  const phase = status.phase;
  switch (phase.state) {
    case "available":
      return updates.download;
    case "ready":
      return status.installBlocker ? updates.openDownloadPage : updates.install;
    case "failed":
      return phase.stage === "download" ? updates.download : updates.check;
    default:
      return null;
  }
}

function Card({ status, updates, tablesOpen }: { status: UpdateStatus; updates: UseUpdates; tablesOpen: boolean }) {
  const t = useT();
  const u = t.nav.update;
  const phase = status.phase;
  const blocker = status.installBlocker;
  const step = stepOf(status, updates);

  let line: string;
  let below: ReactNode;
  let button: string | null = null;
  let progress: number | null = null;
  switch (phase.state) {
    case "available":
      line = u.available(phase.version);
      below = <Notes notes={phase.notes} />;
      button = u.download;
      break;
    case "downloading":
      line = u.downloading(phase.version);
      progress = phase.total ? percentOf(phase.downloaded, phase.total) : null;
      below = (
        <span className={styles.updateMuted}>
          {phase.total
            ? u.progress(mb(phase.downloaded), mb(phase.total), progress ?? 0)
            : u.progressUnknown(mb(phase.downloaded))}
        </span>
      );
      break;
    case "ready":
      line = u.ready(phase.version);
      below = (
        <>
          <Notes notes={phase.notes} />
          {blocker && <span className={styles.updateMuted}>{u.blockers[blocker]}</span>}
          {!blocker && tablesOpen && <span className={styles.updateWarning}>{u.tablesOpen}</span>}
        </>
      );
      button = blocker ? u.downloadPage : u.install;
      break;
    case "installing":
      line = u.installing(phase.version);
      below = <RailLoader size="inline" label={line} delay={0} />;
      break;
    case "failed":
      line = u.failed[phase.stage];
      below = (
        <>
          <span className={styles.updateMuted}>
            {phase.kind === "other" ? u.kinds.other(phase.reason) : u.kinds[phase.kind]}
          </span>
          <button type="button" className={styles.updateLink} onClick={updates.openDownloadPage}>
            {u.downloadPage}
          </button>
        </>
      );
      button = u.tryAgain;
      break;
    default:
      return null;
  }

  return (
    <div className={styles.update} role={phase.state === "failed" ? "alert" : "status"}>
      <div className={styles.updateHead}>
        <Icon name="download" className={styles.updateIcon} />
        <span className={styles.updateLine}>{line}</span>
      </div>
      {below}
      {phase.state === "downloading" && (
        <span
          className={styles.updateBar}
          role="progressbar"
          aria-label={line}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <span className={styles.updateFill} style={{ width: `${progress ?? 0}%` }} />
        </span>
      )}
      {button && step && (
        <button
          type="button"
          className={phase.state === "failed" ? `btn btn--sm ${styles.updateButton}` : `btn btn--primary btn--sm ${styles.updateButton}`}
          onClick={step}
        >
          {button}
        </button>
      )}
      {updates.error && (
        <span className={styles.updateWarning} role="alert">
          {updates.error}
        </span>
      )}
    </div>
  );
}

/** Collapsed: the icon with a dot, the line as its name, the step on click. */
function Compact({ status, updates }: { status: UpdateStatus; updates: UseUpdates }) {
  const t = useT();
  const u = t.nav.update;
  const phase = status.phase;
  const step = stepOf(status, updates);
  let label: string;
  switch (phase.state) {
    case "available":
      label = `${u.available(phase.version)}: ${u.download}`;
      break;
    case "downloading":
      label = u.downloading(phase.version);
      break;
    case "ready":
      label = `${u.ready(phase.version)}: ${status.installBlocker ? u.downloadPage : u.install}`;
      break;
    case "installing":
      label = u.installing(phase.version);
      break;
    case "failed":
      label = `${u.failed[phase.stage]} ${u.tryAgain}`;
      break;
    default:
      return null;
  }
  return (
    <button
      type="button"
      className={styles.updateCompact}
      onClick={step ?? undefined}
      disabled={!step}
      title={label}
      aria-label={label}
    >
      <Icon name="download" className={styles.icon} />
      <span className={styles.updateDot} aria-hidden="true" />
    </button>
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
        className={styles.updateLink}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {t.nav.update.whatsNew}
      </button>
      {open && (
        <p id={id} className={styles.updateNotes}>
          {text}
        </p>
      )}
    </>
  );
}
