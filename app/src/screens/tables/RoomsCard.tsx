/**
 * (T5) The rooms: one row each - its name, whether tiling is allowed there
 * (the Rust side's word: `hud_policy`'s `tiling`), its tables open now, and
 * the user's switch, off and greyed with the reason where the room does not
 * allow it. A row that can be switched is one label: a click anywhere on it
 * flips the switch. Rooms not allowed with no table open fold away.
 */
import { useState } from "react";

import { useT } from "../../i18n";
import type { HudPolicy, HudStatus, TilingSettings } from "../../lib/ipc";
import { Toggle } from "../settings/Toggle";
import { roomRows, setRoomOn, type RoomRow } from "./model";
import styles from "./Tables.module.css";

export function RoomsCard({
  policy,
  settings,
  status,
  onSave,
}: {
  policy: HudPolicy;
  settings: TilingSettings;
  status: HudStatus | null;
  onSave: (next: TilingSettings) => void;
}) {
  const r = useT().tables.rooms;
  const [unfolded, setUnfolded] = useState(false);
  const { shown, folded } = roomRows(policy, settings, status);
  const line = (row: RoomRow) => (
    <Room key={row.id} row={row} onChange={(on) => onSave(setRoomOn(settings, row.id, on))} />
  );
  return (
    <section className={styles.card} aria-label={r.label}>
      <ul className={styles.rows}>
        {shown.map(line)}
        {unfolded ? folded.map(line) : null}
      </ul>
      {folded.length > 0 ? (
        <button type="button" className={styles.textButton} aria-expanded={unfolded} onClick={() => setUnfolded((was) => !was)}>
          <span aria-hidden="true">{unfolded ? "▾ " : "▸ "}</span>
          {unfolded ? r.fewer : r.more(folded.length)}
        </button>
      ) : null}
    </section>
  );
}

function Room({ row, onChange }: { row: RoomRow; onChange: (on: boolean) => void }) {
  const r = useT().tables.rooms;
  const allowed = row.verdict === "allowed";
  const why = row.verdict === "approval" ? r.whyApproval(row.name) : row.verdict === "notAllowed" ? r.whyNot(row.name) : null;
  const badge = row.verdict === "allowed" ? r.allowed : row.verdict === "approval" ? r.approval : r.notAllowed;
  const body = (
    <>
      <span className={styles.roomName}>{row.name}</span>
      <span className={styles.badge} data-verdict={row.verdict} title={why ?? undefined}>
        {badge}
      </span>
      <span className={styles.count} title={row.tables === 0 ? r.noTable : undefined}>
        {row.tables > 0 ? r.tables(row.tables) : "—"}
      </span>
      <Toggle label={r.tile(row.name)} checked={allowed && row.on} disabled={!allowed} onChange={onChange} />
    </>
  );
  return (
    <li>
      {allowed ? (
        <label className={styles.row} data-clickable="true">
          {body}
        </label>
      ) : (
        <div className={styles.row} title={why ?? undefined}>
          {body}
        </div>
      )}
    </li>
  );
}
