import { useId, useState } from "react";

import { BackfillProgress } from "../../components/BackfillProgress";
import { useT } from "../../i18n";
import type { RoomChoice, WatchSource } from "../../lib/ipc";
import styles from "./Folders.module.css";
import { RefusedHands } from "./RefusedHands";

const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

/** What a folder's controls ask the list to do. */
export interface FolderActions {
  setEnabled: (enabled: boolean) => void;
  setRecursive: (recursive: boolean) => void;
  setPollOnly: (pollOnly: boolean) => void;
  setRoom: (parser: string | null) => void;
  changePath: () => void;
  remove: () => void;
}

/**
 * One watched folder (guideline §3): its room, state and counts (last
 * import, hands today, problems, refused hands with their reasons), and
 * everything the user can change about it.
 */
export function FolderCard({
  source,
  rooms,
  busy,
  actions,
}: {
  source: WatchSource;
  rooms: RoomChoice[];
  busy: boolean;
  actions: FolderActions;
}) {
  const t = useT();
  const d = t.settings.folders;
  const id = useId();
  const [showRefused, setShowRefused] = useState(false);

  const chosen = source.siteOverride
    ? (rooms.find((room) => room.parser === source.siteOverride)?.name ?? source.siteOverride)
    : null;
  const room = chosen
    ? d.roomChosen(chosen)
    : source.siteName
      ? d.roomFound(source.siteName)
      : d.roomDetected;
  const problems = [
    source.error,
    source.fileErrors > 0 ? d.fileErrors(source.fileErrors) : null,
    source.pending > 0 ? d.pending(source.pending) : null,
    source.quarantined > 0 ? d.quarantined(source.quarantined) : null,
  ].filter((item): item is string => item !== null);
  const bad = source.state === "unavailable" || source.state === "error";
  const roomOptions =
    source.siteOverride && !rooms.some((choice) => choice.parser === source.siteOverride)
      ? [...rooms, { parser: source.siteOverride, name: source.siteOverride }]
      : rooms;

  return (
    <li className={styles.folder} aria-labelledby={`${id}-path`}>
      <div className={styles.head}>
        <div className={styles.title}>
          <h3 id={`${id}-path`} className={styles.path}>
            {source.path}
          </h3>
          <p className={styles.room}>{room}</p>
        </div>
        <span className={bad ? styles.stateBad : source.state === "disabled" ? styles.stateOff : styles.state}>
          {t.watch.states[source.state]}
        </span>
      </div>

      <dl className={styles.facts}>
        <div>
          <dt>{d.lastImport}</dt>
          <dd>{source.lastImportAt === null ? d.never : time.format(source.lastImportAt)}</dd>
        </div>
        <div>
          <dt>{d.handsToday}</dt>
          <dd className={styles.number}>{number.format(source.handsToday)}</dd>
        </div>
        <div>
          <dt>{d.hands}</dt>
          <dd className={styles.number}>{number.format(source.hands)}</dd>
        </div>
        <div>
          <dt>{d.files}</dt>
          <dd className={styles.number}>{number.format(source.files)}</dd>
        </div>
        <div className={styles.wide}>
          <dt>{d.problems}</dt>
          <dd className={problems.length > 0 ? styles.problem : undefined}>
            {problems.length > 0 ? problems.join(" · ") : d.noProblems}
          </dd>
        </div>
      </dl>

      {source.backfill && <BackfillProgress backfill={source.backfill} label={t.backfill.of(source.path)} />}

      {source.quarantined > 0 && (
        <div>
          <button
            type="button"
            className={styles.link}
            aria-expanded={showRefused}
            aria-controls={`${id}-refused`}
            onClick={() => setShowRefused((open) => !open)}
          >
            {showRefused ? d.hideRefused : d.showRefused(source.quarantined)}
          </button>
          {showRefused && <RefusedHands id={source.id} path={source.path} panelId={`${id}-refused`} />}
        </div>
      )}

      <fieldset className={styles.controls} disabled={busy} aria-label={d.settingsOf(source.path)}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={source.enabled}
            onChange={(event) => actions.setEnabled(event.target.checked)}
          />
          <span>
            {d.enabled}
            <br />
            <span className={styles.hint}>{d.enabledHint}</span>
          </span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={source.recursive}
            onChange={(event) => actions.setRecursive(event.target.checked)}
          />
          <span>{d.recursive}</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={source.pollOnly}
            onChange={(event) => actions.setPollOnly(event.target.checked)}
          />
          <span>
            {d.pollOnly}
            <br />
            <span className={styles.hint}>{d.pollOnlyHint}</span>
          </span>
        </label>
        <div className={styles.field}>
          <label htmlFor={`${id}-room`}>{d.room}</label>
          <select
            id={`${id}-room`}
            className={styles.select}
            value={source.siteOverride ?? ""}
            aria-describedby={`${id}-room-hint`}
            onChange={(event) => actions.setRoom(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">{d.roomAuto}</option>
            {roomOptions.map((choice) => (
              <option key={choice.parser} value={choice.parser}>
                {choice.name}
              </option>
            ))}
          </select>
          <span id={`${id}-room-hint`} className={styles.hint}>
            {d.roomHint}
          </span>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={actions.changePath}>
            {d.changePath}
          </button>
          <button type="button" className={styles.danger} onClick={actions.remove}>
            {d.remove}
          </button>
        </div>
      </fieldset>
    </li>
  );
}
