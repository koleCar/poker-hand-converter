/**
 * The HUD screen's "At the tables" (docs/RAIL-PLAN.md R3.10; guideline §7,
 * compliance mode): which tables the HUD is on, which tables it found and
 * left alone and why - in plain words, with the room's policy page and the
 * date it was read -, "Why can't I enable the HUD here?", where the HUD may
 * be used, and where the room list in force came from. There is no override:
 * nothing here (or anywhere in the app) turns the HUD on at a table compliance
 * mode refused. The decisions are the Rust side's (`hud_status`,
 * `hud_policy`); `lib/hudCompliance.ts` only words them.
 */
import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { liveDateFormat } from "../../i18n/format";
import {
  allowedRooms,
  checkedOn,
  hudState,
  notAllowedRooms,
  policyLink,
  refusedRows,
  roomOf,
  type RefusalWhy,
} from "../../lib/hudCompliance";
import { inApp, ipc, type HudPolicy, type RoomPolicy } from "../../lib/ipc";
import type { HudCompliance } from "../../lib/useHudCompliance";
import styles from "./HudStatusPanel.module.css";

const day = liveDateFormat({ dateStyle: "medium", timeZone: "UTC" });
/** The policy dates are days (`YYYY-MM-DD`, read as UTC noon); the app's own times are the reader's. */
const localDay = liveDateFormat({ dateStyle: "medium" });
const moment = liveDateFormat({ dateStyle: "medium", timeStyle: "short" });

/** A room's policy page (opened by the Rust side in the browser) and the date it was read. */
function PolicySource({ room }: { room: RoomPolicy | null }) {
  const t = useT();
  const s = t.hudStatus;
  const link = policyLink(room);
  const on = checkedOn(room);
  if (room === null || (link === null && on === null)) return null;
  const open = () => {
    if (inApp) ipc.hudOpenPolicySource(room.id).catch(() => undefined);
  };
  return (
    <span className={styles.source}>
      {link !== null && (
        <a
          className={styles.link}
          href={link}
          aria-label={s.policyPage(room.name)}
          onClick={(event) => {
            event.preventDefault();
            open();
          }}
        >
          {s.policyLink}
        </a>
      )}
      {on !== null && <span className={styles.muted}>{s.checked(day.format(on))}</span>}
    </span>
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

function ListSource({ policy }: { policy: HudPolicy }) {
  const t = useT();
  const s = t.hudStatus;
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
    <>
      {lines.map((line) => (
        <p key={line} className={styles.muted}>
          {line}
        </p>
      ))}
      {policy.notes.length > 0 && (
        <>
          <p className={styles.muted}>{s.notes}</p>
          <ul className={styles.notes}>
            {policy.notes.map((note) => (
              <li key={note} className={styles.mono}>
                {note}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function HudStatusPanel({ compliance }: { compliance: HudCompliance }) {
  const t = useT();
  const s = t.hudStatus;
  const { status, policy, error, checking, checkNow } = compliance;

  if (!inApp) {
    return (
      <section className={styles.card} aria-labelledby="hud-status">
        <h2 id="hud-status" className={styles.heading}>
          {s.heading}
        </h2>
        <p className={styles.muted}>{s.unavailable}</p>
      </section>
    );
  }
  if (error !== null && status === null) {
    return <StateMessage kind="error" compact>{s.failed(error)}</StateMessage>;
  }
  if (status === null || policy === null) {
    return <StateMessage kind="loading" compact>{s.loading}</StateMessage>;
  }

  const state = hudState(status);
  const refused = refusedRows(status, policy);
  const allowed = allowedRooms(policy);
  const notAllowed = notAllowedRooms(policy);
  const nameOf = (site: string) => roomOf(policy, site)?.name ?? site;

  return (
    <section className={styles.card} aria-labelledby="hud-status">
      <h2 id="hud-status" className={styles.heading}>
        {s.heading}
      </h2>
      <p className={styles.state} data-state={state}>
        {state === "running"
          ? s.running
          : state === "starting"
            ? s.starting
            : status.error
              ? s.offWhy(status.error)
              : s.off}
      </p>

      {state === "running" && status.tables.length === 0 && refused.length === 0 && (
        <p className={styles.muted}>{s.noTables}</p>
      )}
      {status.tables.length > 0 && (
        <>
          <p className={styles.lead}>{s.attached(status.tables.length)}</p>
          <ul className={styles.list} aria-label={s.attachedLabel}>
            {status.tables.map((table) => (
              <li key={table.window} className={styles.item}>
                <span className={styles.table}>{s.tableAt(nameOf(table.site), table.table ?? s.untitled)}</span>
                {table.waiting && <span className={styles.muted}>{s.waiting}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {refused.length > 0 && (
        <div className={styles.refused} role="status">
          <h3 className={styles.subheading}>{s.refusedHeading(refused.length)}</h3>
          <ul className={styles.list} aria-label={s.refusedLabel}>
            {refused.map(({ refused: row, room, why }) => {
              const name = room?.name ?? row.site;
              return (
                <li key={row.window} className={styles.refusal} data-why={why}>
                  <span className={styles.table}>{s.tableAt(name, row.table ?? s.untitled)}</span>
                  <span>{whyText(t, why, name)}</span>
                  <PolicySource room={room} />
                </li>
              );
            })}
          </ul>
          <p className={styles.muted}>{s.noOverride}</p>
        </div>
      )}

      <details className={styles.explain} open={refused.length > 0 ? true : undefined}>
        <summary className={styles.summary}>{s.explainSummary}</summary>
        <p>{s.explain1}</p>
        <p>{s.explain2}</p>
        <p>{s.explain3}</p>
        <p>{s.explain4}</p>
      </details>

      <div className={styles.rooms}>
        <h3 className={styles.subheading}>{s.roomsHeading}</h3>
        <p className={styles.lead}>{s.allowedLead}</p>
        {allowed.length === 0 ? (
          <p className={styles.muted}>{s.noneAllowed}</p>
        ) : (
          <ul className={styles.list}>
            {allowed.map((room) => (
              <li key={room.id} className={styles.item}>
                <span className={styles.table}>{room.name}</span>
                <PolicySource room={room} />
              </li>
            ))}
          </ul>
        )}
        <details className={styles.explain}>
          <summary className={styles.summary}>{s.notAllowedLead(notAllowed.length)}</summary>
          <ul className={`${styles.list} ${styles.inner}`}>
            {notAllowed.map((room) => (
              <li key={room.id} className={styles.item}>
                <span>{room.name}</span>
                <PolicySource room={room} />
              </li>
            ))}
          </ul>
        </details>
        <ListSource policy={policy} />
        <div>
          <button type="button" className={styles.button} onClick={checkNow} disabled={checking}>
            {checking ? s.checking : s.checkNow}
          </button>
        </div>
      </div>
    </section>
  );
}
