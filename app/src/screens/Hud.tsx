/**
 * The HUD screen (R3.9, R3.10; the final design of 2026-11-07): one header
 * row - the HUD's state as a pill on the left, `Editor | At the tables` on
 * the right - over one of its two views: the editor of its designs
 * (`#/hud`), or the HUD at the tables (`#/hud/tables`, `HUD_TABLES`): which
 * design each game gets, and the rooms where it may be used.
 *
 * (R6.4) While the plan holds the HUD back the pill says so and offers what
 * the plan's reason calls for (upgrade, sign in, check again); the editor
 * stays usable, so designs can be made ready.
 */
import { lockReason } from "../components/ProLock";
import { HeaderRow, PillSwitch, StatusPill } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { hudState, noSupportedClient, permissionNeeded } from "../lib/hudCompliance";
import { HUD_TABLES, go, useRouteParam } from "../lib/router";
import { useEntitlements, type UseEntitlements } from "../lib/useEntitlements";
import { useHudCompliance, type HudCompliance } from "../lib/useHudCompliance";
import { HudEditor } from "./hud/HudEditor";
import { HudStatusPanel } from "./hud/HudStatusPanel";

type View = "editor" | "tables";

export function Hud() {
  const t = useT();
  const v = t.hudStatus.views;
  const compliance = useHudCompliance();
  const plan = useEntitlements();
  const view: View = useRouteParam() === HUD_TABLES ? "tables" : "editor";

  return (
    <>
      <HeaderRow
        title={t.screens.hud.title}
        start={<HudPill compliance={compliance} plan={plan} />}
        end={
          <PillSwitch
            label={v.label}
            options={[
              { id: "editor", label: v.editor },
              { id: "tables", label: v.tables },
            ]}
            value={view}
            onChange={(next: View) => go("hud", next === "tables" ? HUD_TABLES : null)}
          />
        }
      />
      {view === "tables" ? <HudStatusPanel compliance={compliance} /> : <HudEditor />}
    </>
  );
}

/**
 * The HUD in a pill: part of Pro (gold, the plan's way on), needs a
 * permission (amber, "Fix ›" opens At the tables), running on N tables
 * (green), ready with no table open, starting, or off (grey; why, on
 * hover and At the tables). Nothing while the status is not known yet.
 */
function HudPill({ compliance, plan }: { compliance: HudCompliance; plan: UseEntitlements }) {
  const t = useT();
  const s = t.hudStatus;
  const p = s.pill;
  const { status } = compliance;
  const tables = () => go("hud", HUD_TABLES);

  const lockedByPlan = plan.status !== null && plan.locked("hud");
  if (lockedByPlan || hudState(status) === "locked") {
    const reason = plan.status?.effective.reason;
    const [meta, act] =
      reason === "signedOut"
        ? [p.signIn, plan.signIn]
        : reason === "notChecked" || reason === "graceExpired"
          ? [plan.checking ? t.plan.checking : p.checkAgain, plan.checkNow]
          : [p.upgrade, plan.upgrade];
    const why = plan.status !== null && lockedByPlan ? lockReason(plan.status, t.plan) : s.locked;
    return <StatusPill tone="warn" label={p.pro} meta={meta} hint={`${t.plan.features.hud} ${why}`} onClick={act} />;
  }
  if (status === null) return null;
  if (permissionNeeded(status) !== null) {
    return <StatusPill tone="warn" label={p.permission} meta={p.fix} hint={s.permission.heading} onClick={tables} />;
  }
  switch (hudState(status)) {
    case "running":
      return status.tables.length > 0 ? (
        <StatusPill tone="live" label={p.running} meta={p.tables(status.tables.length)} />
      ) : (
        <StatusPill
          tone="idle"
          label={p.ready}
          meta={p.noTables}
          hint={noSupportedClient(status) ? s.permission.noClient : s.noTables}
        />
      );
    case "starting":
      return <StatusPill tone="idle" label={p.starting} />;
    default:
      return status.error ? (
        <StatusPill tone="warn" label={p.off} meta={p.fix} hint={s.offWhy(status.error)} onClick={tables} />
      ) : (
        <StatusPill tone="idle" label={p.off} hint={s.off} />
      );
  }
}
