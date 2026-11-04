/**
 * The HUD screen's one line about the HUD itself, shown only when the user
 * has something to do: macOS has not given Rail the Accessibility
 * permission it needs to see the tables (R3.11), or the HUD stopped with
 * an error. Everything else about the HUD at the tables - its status, the
 * rooms it may be used at - is in Settings, HUD.
 */
import { useT } from "../../i18n";
import { hudState, permissionNeeded } from "../../lib/hudCompliance";
import type { HudCompliance } from "../../lib/useHudCompliance";
import styles from "./HudEditor.module.css";

export function HudNotice({ compliance }: { compliance: HudCompliance }) {
  const n = useT().hudStatus.notice;
  const { status } = compliance;
  if (status === null) return null;
  const words =
    permissionNeeded(status) !== null
      ? n.permission
      : hudState(status) === "off" && status.error
        ? n.off(status.error)
        : null;
  if (words === null) return null;
  return (
    <div className={styles.notice} role="status">
      <span>{words}</span>
      <a className={styles.noticeLink} href="#/settings/hud">
        {n.open}
      </a>
    </div>
  );
}
