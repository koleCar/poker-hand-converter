/**
 * The HUD screen's "At the tables" view (`#/hud/tables`; docs/RAIL-PLAN.md
 * R3.9, R3.10; guideline §7, compliance mode). Top to bottom:
 *
 * - **The games** (`GameCards`): the design each game's tables get, and the
 *   rules that send some of them elsewhere.
 * - **One-row cards, only when needed**: the macOS permission (R3.11), the
 *   HUD not running and why, no table open.
 * - **The rooms**: one row each - allowed or not, its tables, and a ⋯ menu
 *   with the tables' names, why a table was left alone, the user's answer
 *   to "my client seats me at the bottom" (R3.6, `hud_set_preferred_seat`),
 *   the room's policy page and the date it was read. Rooms with a table open
 *   or that are allowed are listed; the rest fold into "N more rooms not
 *   allowed". At its foot, "Why can't I enable the HUD here?" (ⓘ) and the
 *   room list in force with "Look for an update now" (⋯).
 *
 * There is no override: nothing here (or anywhere in the app) turns the HUD
 * on at a table compliance mode refused. The decisions are the Rust side's
 * (`hud_status`, `hud_policy`, `hud_assign`); `lib/hudCompliance.ts` only
 * words them.
 *
 * (R3.11) On a Mac the HUD reads table windows' titles through the
 * Accessibility API. Only while the permission is missing *and* granting it
 * would find tables (a supported client runs, or the simulator's test entry
 * is on) does the view show its row: what it is for (in the ⓘ: titles and
 * window places only - no screen recording, no input monitoring), a button
 * that has macOS show its own prompt and opens System Settings at the pane,
 * and it notices the grant from the status it polls. The user grants it;
 * nothing here changes a setting. Without a supported client the view says
 * only that none is running, and asks for nothing.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { liveDateFormat } from "../../i18n/format";
import {
  allowedRooms,
  checkedOn,
  hudState,
  noSupportedClient,
  notAllowedRooms,
  permissionNeeded,
  policyLink,
  refusalWhy,
  refusedRows,
  roomOf,
  type HudPermission,
  type RefusalWhy,
} from "../../lib/hudCompliance";
import {
  errorText,
  inApp,
  ipc,
  onHudLayoutsChanged,
  type HudEditorState,
  type HudPolicy,
  type HudRefused,
  type HudStatus,
  type HudTable,
  type RoomPolicy,
} from "../../lib/ipc";
import type { HudCompliance } from "../../lib/useHudCompliance";
import { GameCards } from "./GameCards";
import { InfoTip, MoreMenu } from "./popovers";
import styles from "./HudStatusPanel.module.css";

const day = liveDateFormat({ dateStyle: "medium", timeZone: "UTC" });
/** The policy dates are days (`YYYY-MM-DD`, read as UTC noon); the app's own times are the reader's. */
const localDay = liveDateFormat({ dateStyle: "medium" });
const moment = liveDateFormat({ dateStyle: "medium", timeStyle: "short" });

/** The editor's state (designs, assignments, the user's answers per room), read again when it changes. */
function useEditorState(): { state: HudEditorState | null; failed: string | null; reload: () => void } {
  const [state, setState] = useState<HudEditorState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => onHudLayoutsChanged(() => setGeneration((n) => n + 1)), []);
  useEffect(() => {
    if (!inApp) return;
    let live = true;
    ipc
      .hudEditorState()
      .then((value) => {
        if (!live) return;
        setState(value);
        setFailed(null);
      })
      .catch((reason: unknown) => {
        if (live) setFailed(errorText(reason));
      });
    return () => {
      live = false;
    };
  }, [generation]);
  return { state, failed, reload: () => setGeneration((n) => n + 1) };
}

interface PreferredSeats {
  seats: Record<string, boolean | null> | null;
  set: (site: string, preferred: boolean | null) => void;
  error: string | null;
}

/** (R3.6) The user's answers per room, from the editor's state, with the one just given shown at once. */
function usePreferredSeats(state: HudEditorState | null, reload: () => void): PreferredSeats {
  const [given, setGiven] = useState<Record<string, boolean | null>>({});
  const [error, setError] = useState<string | null>(null);
  const seats =
    state === null ? null : { ...Object.fromEntries(state.roomSettings.map((r) => [r.site, r.preferredSeat])), ...given };
  const forget = (site: string) =>
    setGiven((old) => {
      const next = { ...old };
      delete next[site];
      return next;
    });
  const set = (site: string, preferred: boolean | null) => {
    setError(null);
    setGiven((old) => ({ ...old, [site]: preferred }));
    ipc
      .hudSetPreferredSeat(site, preferred)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => {
        forget(site);
        reload();
      });
  };
  return { seats, set, error };
}

/** A one-row card: a dot, the line, and on the right what to do about it. */
function RowCard({
  tone,
  children,
  actions,
  under,
}: {
  tone: "live" | "idle" | "warn";
  children: ReactNode;
  actions?: ReactNode;
  under?: ReactNode;
}) {
  return (
    <div className={styles.rowCard} role="status">
      <div className={styles.rowMain}>
        <span className={styles.dot} data-tone={tone} aria-hidden="true" />
        <span className={styles.rowText}>{children}</span>
        {actions ? <span className={styles.rowActions}>{actions}</span> : null}
      </div>
      {under}
    </div>
  );
}

/**
 * (R3.11) The Accessibility permission, as one row: what it is for in the
 * ⓘ, the button, then "waiting" until the status says it is granted - and
 * a line saying so once it is, after the user asked here.
 */
function PermissionCard({ status }: { status: HudStatus }) {
  const t = useT();
  const p = t.hudStatus.permission;
  const needed: HudPermission | null = permissionNeeded(status);
  const [phase, setPhase] = useState<"idle" | "opening" | "asked">("idle");
  const [failed, setFailed] = useState<string | null>(null);
  const [granted, setGranted] = useState(false);
  const wasNeeded = useRef(needed !== null);

  useEffect(() => {
    if (needed === null && wasNeeded.current && phase === "asked") setGranted(true);
    wasNeeded.current = needed !== null;
  }, [needed, phase]);

  if (needed === null) {
    return granted ? <RowCard tone="live">{p.granted}</RowCard> : null;
  }
  const open = () => {
    setPhase("opening");
    setFailed(null);
    ipc
      .hudRequestPermission(needed)
      .then(() => setPhase("asked"))
      .catch((e: unknown) => {
        setFailed(errorText(e));
        setPhase("asked");
      });
  };
  return (
    <RowCard
      tone="warn"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={open} disabled={phase === "opening"}>
          {phase === "opening" ? p.opening : p.open}
        </button>
      }
      under={
        failed !== null || phase === "asked" ? (
          <p className={styles.under}>
            {failed !== null ? `${p.failed(failed)} ` : null}
            {phase === "asked" ? p.waiting : null}
          </p>
        ) : null
      }
    >
      {p.heading}
      <InfoTip label={t.hudStatus.permissionInfo}>
        <p>{p.why}</p>
        <p>{p.not}</p>
        <p>{p.steps}</p>
        <p className={styles.muted}>{p.stale}</p>
      </InfoTip>
    </RowCard>
  );
}

function whyText(t: ReturnType<typeof useT>, why: RefusalWhy, name: string): string {
  const w = t.hudStatus.why;
  switch (why) {
    case "prohibited":
      return w.prohibited(name);
    case "withdrawn":
      return w.withdrawn(name);
    case "unknown":
      return w.unknown(name);
    case "notARoom":
      return w.notARoom(name);
    case "unknownSite":
      return w.unknownSite;
  }
}

/** Why a room not allowed is not, from the list (no window refused there). */
function roomWhy(room: RoomPolicy): RefusalWhy {
  if (room.kind !== "room") return "notARoom";
  return refusalWhy(room.allowed === null ? "unknown" : "prohibited", room);
}

/** A room as the list shows it: the room list's entry (if any), its tables, its refused windows. */
interface RoomRow {
  site: string;
  name: string;
  room: RoomPolicy | null;
  permitted: boolean;
  tables: HudTable[];
  refused: { refused: HudRefused; why: RefusalWhy }[];
}

/** The rooms listed (allowed, or with a table open) and those folded away (not allowed, no table). */
function roomRows(status: HudStatus, policy: HudPolicy): { shown: RoomRow[]; folded: RoomRow[] } {
  const rows = new Map<string, RoomRow>();
  const row = (site: string): RoomRow => {
    let found = rows.get(site);
    if (!found) {
      const room = roomOf(policy, site);
      found = { site, name: room?.name ?? site, room, permitted: room?.permitted ?? false, tables: [], refused: [] };
      rows.set(site, found);
    }
    return found;
  };
  for (const room of allowedRooms(policy)) row(room.id);
  for (const table of status.tables) row(table.site).tables.push(table);
  for (const { refused, why } of refusedRows(status, policy)) row(refused.site).refused.push({ refused, why });
  const listed = [...rows.values()];
  const allowed = listed.filter((r) => r.permitted);
  const open = listed.filter((r) => !r.permitted).sort((a, b) => a.name.localeCompare(b.name));
  const folded = notAllowedRooms(policy)
    .filter((room) => !rows.has(room.id))
    .map((room): RoomRow => ({ site: room.id, name: room.name, room, permitted: false, tables: [], refused: [] }));
  return { shown: [...allowed, ...open], folded };
}

/** A room's ⋯: its tables, why one was left alone, how it seats the user, its policy and when it was read. */
function RoomMenu({
  row,
  seat,
  onSeat,
}: {
  row: RoomRow;
  seat: boolean | null | undefined;
  onSeat: (preferred: boolean | null) => void;
}) {
  const t = useT();
  const s = t.hudStatus;
  const [seatsOpen, setSeatsOpen] = useState(false);
  const link = policyLink(row.room);
  const on = checkedOn(row.room);
  const answers: { value: boolean | null; short: string; long: string }[] = [
    { value: null, short: s.seatsShort.auto, long: s.preferredSeatAuto },
    { value: true, short: s.seatsShort.yes, long: s.preferredSeatYes },
    { value: false, short: s.seatsShort.no, long: s.preferredSeatNo },
  ];
  const current = answers.find((a) => a.value === (seat ?? null)) ?? answers[0];
  const tables = row.tables.length > 0 || row.refused.length > 0;
  const room = (row.permitted && seat !== undefined) || link !== null || on !== null;
  return (
    <div className={styles.menuBody}>
      {row.tables.length > 0 ? (
        <ul className={styles.menuList} aria-label={s.attachedLabel}>
          {row.tables.map((table) => (
            <li key={table.window}>
              {s.tableAt(row.name, table.table ?? s.untitled)}
              {table.waiting ? <span className={styles.muted}> · {s.waiting}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {row.refused.length > 0 ? (
        <>
          <ul className={styles.menuList} aria-label={s.refusedLabel}>
            {row.refused.map(({ refused, why }) => (
              <li key={refused.window} data-why={why}>
                {s.tableAt(row.name, refused.table ?? s.untitled)}
                <span className={styles.muted}> · {whyText(t, why, row.name)}</span>
              </li>
            ))}
          </ul>
          <p className={styles.menuDim}>{s.noOverride}</p>
        </>
      ) : null}
      {tables && room ? <hr className={styles.rule} /> : null}
      {row.permitted && seat !== undefined ? (
        <div className={styles.seats}>
          <button
            type="button"
            className={styles.menuItem}
            title={s.preferredSeat}
            aria-expanded={seatsOpen}
            onClick={() => setSeatsOpen((was) => !was)}
          >
            {s.seats(current?.short ?? s.seatsShort.auto)}
            <span aria-hidden="true">{seatsOpen ? " ▾" : " ▸"}</span>
          </button>
          {seatsOpen ? (
            <div className={styles.seatOptions} role="group" aria-label={`${row.name}: ${s.preferredSeat}`}>
              {answers.map((answer) => (
                <button
                  key={String(answer.value)}
                  type="button"
                  className={styles.menuItem}
                  aria-pressed={answer.value === (seat ?? null)}
                  onClick={() => onSeat(answer.value)}
                >
                  {answer.long}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {link !== null && row.room !== null ? (
        <a
          className={styles.menuItem}
          href={link}
          aria-label={s.policyPage(row.name)}
          onClick={(event) => {
            event.preventDefault();
            if (inApp && row.room) ipc.hudOpenPolicySource(row.room.id).catch(() => undefined);
          }}
        >
          {s.policyLink} <span aria-hidden="true">↗</span>
        </a>
      ) : null}
      {on !== null ? <p className={styles.menuDim}>{s.checked(day.format(on))}</p> : null}
    </div>
  );
}

/** One room: its name … allowed or not, its tables, ⋯. */
function RoomLine({
  row,
  seat,
  onSeat,
}: {
  row: RoomRow;
  seat: boolean | null | undefined;
  onSeat: (preferred: boolean | null) => void;
}) {
  const t = useT();
  const s = t.hudStatus;
  const count = row.tables.length + row.refused.length;
  const first = row.refused[0];
  const why = first
    ? whyText(t, first.why, row.name)
    : !row.permitted && row.room
      ? whyText(t, roomWhy(row.room), row.name)
      : null;
  const names = [
    ...row.tables.map((table) => s.tableAt(row.name, table.table ?? s.untitled)),
    ...row.refused.map(({ refused }) => s.tableAt(row.name, refused.table ?? s.untitled)),
  ].join("\n");
  return (
    <li className={styles.room} data-why={first?.why}>
      <span className={styles.roomName}>{row.name}</span>
      <span className={styles.badge} data-allowed={row.permitted} title={why ?? undefined}>
        {row.permitted ? s.rooms.allowed : s.rooms.notAllowed}
      </span>
      <span className={styles.count} title={count > 0 ? names : s.rooms.noTable}>
        {count > 0 ? s.pill.tables(count) : "—"}
      </span>
      <MoreMenu label={s.rooms.menu(row.name)}>{() => <RoomMenu row={row} seat={seat} onSeat={onSeat} />}</MoreMenu>
    </li>
  );
}

/** The room list in force: "look now", where it came from, the last look for an update, what was not taken. */
function ListMenu({ policy, checking, checkNow }: { policy: HudPolicy; checking: boolean; checkNow: () => void }) {
  const s = useT().hudStatus;
  const lines: string[] = [];
  lines.push(
    policy.remote && policy.fetchedAt !== null ? s.listRemote(localDay.format(policy.fetchedAt * 1000)) : s.listShipped,
  );
  const check = policy.lastCheck;
  if (check !== null) {
    const at = moment.format(check.at * 1000);
    switch (check.outcome.kind) {
      case "updated":
        lines.push(s.lastUpdated(at));
        break;
      case "current":
        lines.push(s.lastCurrent(at));
        break;
      case "refused":
        lines.push(s.lastRefused(at));
        break;
      case "failed":
        lines.push(s.lastFailed(at));
        break;
    }
  }
  return (
    <div className={styles.menuBody}>
      <button type="button" className={styles.menuItem} onClick={checkNow} disabled={checking}>
        {checking ? s.checking : s.checkNow}
      </button>
      {lines.map((line) => (
        <p key={line} className={styles.menuDim}>
          {line}
        </p>
      ))}
      {policy.notes.length > 0 ? (
        <>
          <p className={styles.menuDim}>{s.notes}</p>
          <ul className={styles.notes}>
            {policy.notes.map((note) => (
              <li key={note} className={styles.mono}>
                {note}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Rooms({
  status,
  policy,
  compliance,
  seats,
}: {
  status: HudStatus;
  policy: HudPolicy;
  compliance: HudCompliance;
  seats: PreferredSeats;
}) {
  const s = useT().hudStatus;
  const [unfolded, setUnfolded] = useState(false);
  const { shown, folded } = roomRows(status, policy);
  const line = (row: RoomRow) => (
    <RoomLine
      key={row.site}
      row={row}
      seat={seats.seats === null ? undefined : (seats.seats[row.site] ?? null)}
      onSeat={(value) => seats.set(row.site, value)}
    />
  );
  return (
    <section className={styles.card} aria-label={s.roomsHeading}>
      {allowedRooms(policy).length === 0 ? <p className={styles.muted}>{s.noneAllowed}</p> : null}
      <ul className={styles.roomList}>
        {shown.map(line)}
        {unfolded ? folded.map(line) : null}
      </ul>
      {seats.error !== null ? <p className={styles.error}>{s.preferredSeatFailed(seats.error)}</p> : null}
      <div className={styles.foot}>
        {folded.length > 0 ? (
          <button
            type="button"
            className={styles.textButton}
            aria-expanded={unfolded}
            title={s.notAllowedLead(folded.length)}
            onClick={() => setUnfolded((was) => !was)}
          >
            <span aria-hidden="true">{unfolded ? "▾ " : "▸ "}</span>
            {unfolded ? s.rooms.fewer : s.rooms.more(folded.length)}
          </button>
        ) : null}
        <span className={styles.footEnd}>
          <InfoTip label={s.explainSummary} align="end">
            <p>{s.explain1}</p>
            <p>{s.explain2}</p>
            <p>{s.explain3}</p>
            <p>{s.explain4}</p>
          </InfoTip>
          <MoreMenu label={s.rooms.listMenu}>
            {() => <ListMenu policy={policy} checking={compliance.checking} checkNow={compliance.checkNow} />}
          </MoreMenu>
        </span>
      </div>
    </section>
  );
}

export function HudStatusPanel({ compliance }: { compliance: HudCompliance }) {
  const t = useT();
  const s = t.hudStatus;
  const h = t.hudEditor;
  const editor = useEditorState();
  const seats = usePreferredSeats(editor.state, editor.reload);
  const { status, policy, error } = compliance;

  if (!inApp) {
    return <p className={styles.muted}>{s.unavailable}</p>;
  }

  const games =
    editor.failed !== null ? (
      <StateMessage kind="error" compact>
        {h.failed(editor.failed)}
      </StateMessage>
    ) : editor.state === null ? (
      <StateMessage kind="loading" compact>
        {h.loading}
      </StateMessage>
    ) : (
      <GameCards state={editor.state} onChanged={editor.reload} />
    );

  let rest: ReactNode;
  if (error !== null && status === null) {
    rest = (
      <StateMessage kind="error" compact>
        {s.failed(error)}
      </StateMessage>
    );
  } else if (status === null || policy === null) {
    rest = (
      <StateMessage kind="loading" compact>
        {s.loading}
      </StateMessage>
    );
  } else {
    const state = hudState(status);
    const quiet = state === "running" && permissionNeeded(status) === null;
    rest = (
      <>
        <PermissionCard status={status} />
        {state === "off" ? <RowCard tone="idle">{status.error ? s.offWhy(status.error) : s.off}</RowCard> : null}
        {state === "starting" ? <RowCard tone="idle">{s.starting}</RowCard> : null}
        {noSupportedClient(status) ? (
          <RowCard tone="idle">{s.permission.noClient}</RowCard>
        ) : quiet && status.tables.length === 0 && status.refused.length === 0 ? (
          <RowCard tone="idle">{s.noTables}</RowCard>
        ) : null}
        <Rooms status={status} policy={policy} compliance={compliance} seats={seats} />
      </>
    );
  }

  return (
    <div className={styles.view}>
      {games}
      {rest}
    </div>
  );
}
