import { useT } from "../i18n";
import type { FoundFolder } from "../lib/ipc";
import { liveDateFormat, liveNumberFormat } from "../i18n/format";
import styles from "./FoundFolderTable.module.css";

const number = liveNumberFormat();
const day = liveDateFormat({ dateStyle: "medium" });

/** A row: a folder discovery found, or one picked by hand. */
export interface FoundRow {
  path: string;
  /** `null` for a folder added by hand. */
  found: FoundFolder | null;
  checked: boolean;
}

/**
 * The folders discovery found (R1.4), each with a checkbox: room, folder,
 * file count and the last hand's date, with notes on unverified templates
 * and samples that look like another room's. The first-run screen and
 * Settings, Folders ("Find folders again") both show it.
 */
export function FoundFolderTable({
  rows,
  onToggle,
  disabled = false,
}: {
  rows: FoundRow[];
  onToggle: (path: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const d = t.foundFolders;

  const files = (found: FoundFolder) => {
    if (found.files === 0) {
      return d.noFiles;
    }
    const count = number.format(found.files);
    return found.complete ? count : d.atLeast(count);
  };
  const notThisRoom = (found: FoundFolder) =>
    found.sampleLooked !== null && found.sampleLooked > 0 && found.sampleClaimed === 0;

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">
            <span className={styles.srOnly}>{d.folder}</span>
          </th>
          <th scope="col">{d.room}</th>
          <th scope="col">{d.folder}</th>
          <th scope="col" className={styles.number}>
            {d.files}
          </th>
          <th scope="col">{d.lastHand}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path}>
            <td>
              <input
                type="checkbox"
                aria-label={d.watch(row.path)}
                checked={row.checked || Boolean(row.found?.watched)}
                disabled={Boolean(row.found?.watched) || disabled}
                onChange={(event) => onToggle(row.path, event.target.checked)}
              />
            </td>
            <td>
              {row.found ? row.found.name : d.manual}
              {row.found?.watched && <span className={styles.note}>{d.watched}</span>}
            </td>
            <td className={styles.mono}>
              {row.path}
              {row.found && !row.found.verified && <span className={styles.note}>{d.unverified}</span>}
              {row.found && notThisRoom(row.found) && <span className={styles.warning}>{d.notThisRoom}</span>}
            </td>
            <td className={styles.number}>{row.found ? files(row.found) : d.unknown}</td>
            <td>
              {row.found?.newestMs != null
                ? day.format(row.found.newestMs)
                : row.found?.files === 0
                  ? d.noFiles
                  : d.unknown}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
