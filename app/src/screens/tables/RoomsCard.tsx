/**
 * (T5) The rooms: one row each - its name, whether tiling is allowed there
 * (the Rust side's word: `hud_policy`'s `tiling`), its tables open now, and
 * the user's switches: tiling and (T5 follow-up) the RNG, each off and
 * greyed with the reason where the room does not allow it (`hud_policy`'s
 * `tiling` / `rng`: "Needs room approval" from the sites.json notes
 * prefix, else "Not allowed by <room>"). A switch never allows what the
 * policy does not: the HUD checks the room's permit first, whatever the
 * settings say. A row that tiling may move is one label: a click anywhere
 * on it flips the tiling switch. Rooms where neither is allowed, with no
 * table open, fold away.
 */
import { useState } from "react";

import { useT } from "../../i18n";
import type { HudPolicy, HudStatus, RngSettings, TilingSettings } from "../../lib/ipc";
import { Toggle } from "../settings/Toggle";
import { roomRows, setRngRoomOn, setRoomOn, type RoomRow, type RoomVerdict } from "./model";
import styles from "./Tables.module.css";

export function RoomsCard({
  policy,
  settings,
  rng,
  status,
  onSave,
  onSaveRng,
}: {
  policy: HudPolicy;
  settings: TilingSettings;
  rng: RngSettings;
  status: HudStatus | null;
  onSave: (next: TilingSettings) => void;
  onSaveRng: (next: RngSettings) => void;
}) {
  const r = useT().tables.rooms;
  const [unfolded, setUnfolded] = useState(false);
  const { shown, folded } = roomRows(policy, settings, status, rng);
  const line = (row: RoomRow) => (
    <Room
      key={row.id}
      row={row}
      onChange={(on) => onSave(setRoomOn(settings, row.id, on))}
      onRngChange={(on) => onSaveRng(setRngRoomOn(rng, row.id, on))}
    />
  );
  return (
    <section className={styles.card} aria-label={r.label}>
      <ul className={styles.rows}>
        <li className={styles.rowHead} aria-hidden="true">
          <span className={styles.columnName}>{r.tileColumn}</span>
          <span className={styles.columnName}>{r.rngColumn}</span>
        </li>
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

function Room({ row, onChange, onRngChange }: { row: RoomRow; onChange: (on: boolean) => void; onRngChange: (on: boolean) => void }) {
  const r = useT().tables.rooms;
  const allowed = row.verdict === "allowed";
  const rngAllowed = row.rngVerdict === "allowed";
  const why = (verdict: RoomVerdict, notAllowed: string) =>
    verdict === "approval" ? `${r.approval}: ${r.whyApproval(row.name)}` : verdict === "notAllowed" ? notAllowed : null;
  const tilingWhy = why(row.verdict, r.whyNot(row.name));
  const rngWhy = why(row.rngVerdict, r.rngNotAllowedBy(row.name));
  const badge = row.verdict === "allowed" ? r.allowed : row.verdict === "approval" ? r.approval : r.notAllowed;
  const body = (
    <>
      <span className={styles.roomName}>{row.name}</span>
      <span className={styles.badge} data-verdict={row.verdict} title={tilingWhy ?? undefined}>
        {badge}
      </span>
      <span className={styles.count} title={row.tables === 0 ? r.noTable : undefined}>
        {row.tables > 0 ? r.tables(row.tables) : "—"}
      </span>
      <span className={styles.switchCell} title={tilingWhy ?? undefined}>
        <Toggle label={r.tile(row.name)} checked={allowed && row.on} disabled={!allowed} onChange={onChange} />
      </span>
      <span
        className={styles.switchCell}
        title={rngWhy ?? undefined}
        onClick={(event) => {
          // Inside the row's label, a click here is the RNG switch's alone:
          // never the label's (which would flip tiling), even on the
          // greyed switch or beside it.
          const target = event.target as HTMLElement;
          if (target === event.currentTarget || (target instanceof HTMLInputElement && target.disabled)) event.preventDefault();
        }}
      >
        <Toggle label={r.rng(row.name)} checked={rngAllowed && row.rngOn} disabled={!rngAllowed} onChange={onRngChange} />
      </span>
    </>
  );
  return (
    <li>
      {allowed ? (
        <label className={styles.row} data-clickable="true">
          {body}
        </label>
      ) : (
        <div className={styles.row} title={tilingWhy ?? undefined}>
          {body}
        </div>
      )}
    </li>
  );
}
