/**
 * The Tables screen (T5, docs/research/TABLE-TILING.md §4.5; the owner's
 * design A of 2026-11-11). One header row - tiling's state as a pill, then
 * the layout in force, "+ Layout", "Re-tile" and the switch - over the
 * displays drawn to scale with the tiled tables on them, and two cards:
 * the rooms (tiling allowed or not, the user's tiling and RNG switches per
 * room) with the rules that switch the layout by table count, and the RNG
 * (its switch, colour bands, when it rolls, size and opacity). The slot editor ("Draw slots", a layout's
 * "Edit slots") takes the displays' place while it is open.
 *
 * Free: table tiling and the RNG need no plan (`entitlements.rs`), so no
 * lock here. Whether a room may be tiled or show the RNG is the Rust side's
 * (`hud_policy`'s `tiling` / `rng`); a switch never allows a room the
 * policy does not. The HUD process does the tiling; this screen stores the
 * settings (`set_tiling_settings`, `set_rng_settings`) and shows what the
 * HUD reports (`hud_status().tiling`).
 */
import { useState } from "react";

import { HeaderRow, PillSwitch, StatusPill } from "../components/ScreenHeader";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { hudState } from "../lib/hudCompliance";
import { errorText, inApp, ipc, type HudStatus, type TilingSettings } from "../lib/ipc";
import { useHudCompliance } from "../lib/useHudCompliance";
import { Toggle } from "./settings/Toggle";
import { AutoSwitchCard } from "./tables/AutoSwitchCard";
import { LayoutAdd, LayoutMenu } from "./tables/LayoutControls";
import { Monitors } from "./tables/Monitors";
import { RngCard } from "./tables/RngCard";
import { RoomsCard } from "./tables/RoomsCard";
import { SlotEditor, type EditorTarget } from "./tables/SlotEditor";
import { activeId, chooseLayout } from "./tables/model";
import { useTableSettings } from "./tables/useTableSettings";
import styles from "./tables/Tables.module.css";

export function Tables() {
  const t = useT();
  const s = t.tables;
  const compliance = useHudCompliance();
  const settings = useTableSettings();
  const [retileError, setRetileError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const { tiling, rng } = settings;
  const { status, policy } = compliance;

  if (!inApp) {
    return (
      <>
        <HeaderRow title={t.screens.tables.title} />
        <StateMessage kind="empty">{s.unavailable}</StateMessage>
      </>
    );
  }
  if (settings.failed !== null) {
    return (
      <>
        <HeaderRow title={t.screens.tables.title} />
        <StateMessage kind="error">{s.loadFailed(settings.failed)}</StateMessage>
      </>
    );
  }
  if (tiling === null || rng === null || policy === null) {
    return (
      <>
        <HeaderRow title={t.screens.tables.title} />
        <StateMessage kind="loading">{s.loading}</StateMessage>
      </>
    );
  }

  const save = (next: TilingSettings) => void settings.saveTiling(next);
  const retile = () => {
    setRetileError(null);
    ipc.retileTables().catch((e: unknown) => setRetileError(errorText(e)));
  };
  const options = [{ id: "auto", label: s.auto }, ...tiling.layouts.map((l) => ({ id: l.id, label: l.name }))];
  const active = activeId(tiling.active);
  const custom = tiling.layouts.find((l) => l.id === active) ?? null;
  const error = settings.saveError ?? retileError;

  return (
    <>
      <HeaderRow
        title={t.screens.tables.title}
        start={<TilingPill enabled={tiling.enabled} status={status} />}
        end={
          <>
            <PillSwitch label={s.layouts} options={options} value={active} onChange={(id) => save(chooseLayout(tiling, id))} />
            {custom !== null ? <LayoutMenu layout={custom} settings={tiling} onSave={save} onEdit={setEditing} /> : null}
            <LayoutAdd settings={tiling} onSave={settings.saveTiling} onEdit={setEditing} />
            <button type="button" className={`btn btn--sm ${styles.headerButton}`} title={s.retileHint} disabled={!tiling.enabled} onClick={retile}>
              {s.retile}
            </button>
            <Toggle label={s.switchLabel} checked={tiling.enabled} onChange={(on) => save({ ...tiling, enabled: on })} />
          </>
        }
      />
      <div className={styles.view}>
        {error !== null ? <p className={styles.error}>{s.saveFailed(error)}</p> : null}
        {editing !== null ? (
          <SlotEditor
            key={`${editing.layout.id}:${String(editing.existing)}`}
            settings={tiling}
            status={status}
            policy={policy}
            target={editing}
            onSave={settings.saveTiling}
            onClose={() => setEditing(null)}
          />
        ) : (
          <Monitors status={status} policy={policy} />
        )}
        <div className={styles.cards}>
          <div className={styles.column}>
            <RoomsCard
              policy={policy}
              settings={tiling}
              rng={rng}
              status={status}
              onSave={save}
              onSaveRng={(next) => void settings.saveRng(next)}
            />
            <AutoSwitchCard settings={tiling} status={status} onSave={save} />
          </div>
          <RngCard policy={policy} rng={rng} onSave={settings.saveRng} />
        </div>
      </div>
    </>
  );
}

/** Tiling on (green: its tables and displays) or off; on while the HUD is not running says so. */
function TilingPill({ enabled, status }: { enabled: boolean; status: HudStatus | null }) {
  const p = useT().tables.pill;
  if (!enabled) return <StatusPill tone="idle" label={p.off} />;
  const report = status?.tiling ?? null;
  if (report === null || !report.enabled) {
    const off = status !== null && hudState(status) === "off";
    return <StatusPill tone={off ? "warn" : "idle"} label={p.on} meta={off ? p.hudOff : null} />;
  }
  const meta = [p.tables(report.tables), ...(report.monitors.length > 0 ? [p.displays(report.monitors.length)] : [])].join(" · ");
  return <StatusPill tone="live" label={p.on} meta={meta} />;
}
