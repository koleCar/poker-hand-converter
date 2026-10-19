/**
 * Compliance mode, as the window says it (guideline §7; plan R3.10). The
 * decisions are the Rust side's - the HUD process refuses a window whose
 * room's policy is not "allowed", over the room list in force (this
 * version's own, with any update from the web merged in, which can only make
 * it stricter) - and nothing here can change them: there is no override.
 * This file only turns the HUD's status and the room list into what the HUD
 * screen and Today show. Pure, so the tests run it
 * (`tests/test/appHudCompliance.test.ts`).
 */
import type { HudPolicy, HudRefused, HudStatus, RefusalReason, RoomPolicy } from "./ipc";

/** Why a window was refused, as the screen explains it. */
export type RefusalWhy =
  /** The room's own rules forbid a HUD. */
  | "prohibited"
  /** The room was allowed in this version, and a re-check switched it off. */
  | "withdrawn"
  /** The room's rules were not established (unknown counts as no). */
  | "unknown"
  /** The entry is a network of rooms or a format, not one room's client. */
  | "notARoom"
  /** The window matched no room Rail knows. */
  | "unknownSite";

/** The HUD process, in a word. */
export type HudState = "off" | "starting" | "running";

/** The entry `site` of the room list, if any. */
export function roomOf(policy: HudPolicy | null, site: string): RoomPolicy | null {
  return policy?.rooms.find((room) => room.id === site) ?? null;
}

/** A refusal's explanation: the HUD's reason, told apart where the room list says more. */
export function refusalWhy(reason: RefusalReason, room: RoomPolicy | null): RefusalWhy {
  switch (reason) {
    case "prohibited":
      return room?.stricterThanShipped ? "withdrawn" : "prohibited";
    case "unknown":
      return "unknown";
    case "not-a-room":
      return "notARoom";
    case "unknown-site":
      return "unknownSite";
  }
}

/** The room's policy page, when it is a web page (`https`); a note in Rail's repository is not a link. */
export function policyLink(room: RoomPolicy | null): string | null {
  const source = room?.source ?? null;
  return source !== null && source.startsWith("https://") ? source : null;
}

/** The day the room's policy was read, as a date at UTC noon (so no time zone moves it a day); `null` when unknown. */
export function checkedOn(room: RoomPolicy | null): Date | null {
  const text = room?.checkedAt ?? null;
  if (text === null || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T12:00:00Z`);
  return Number.isNaN(at) ? null : new Date(at);
}

/** The HUD process in a word: off (not installed, switched off, stopped), starting (or starting again), running. */
export function hudState(status: HudStatus | null): HudState {
  switch (status?.phase) {
    case "running":
      return "running";
    case "starting":
    case "backoff":
      return "starting";
    default:
      return "off";
  }
}

/** The rooms whose HUD is allowed, in the list's order. */
export function allowedRooms(policy: HudPolicy | null): RoomPolicy[] {
  return policy?.rooms.filter((room) => room.permitted) ?? [];
}

/** Every room (not networks or formats) whose HUD is not allowed, in the list's order. */
export function notAllowedRooms(policy: HudPolicy | null): RoomPolicy[] {
  return policy?.rooms.filter((room) => !room.permitted && room.kind === "room") ?? [];
}

/** The refused windows, one per window, by room name then table. */
export function refusedRows(
  status: HudStatus | null,
  policy: HudPolicy | null,
): { refused: HudRefused; room: RoomPolicy | null; why: RefusalWhy }[] {
  const seen = new Set<number>();
  const rows = (status?.refused ?? [])
    .filter((refused) => {
      if (seen.has(refused.window)) return false;
      seen.add(refused.window);
      return true;
    })
    .map((refused) => {
      const room = roomOf(policy, refused.site);
      return { refused, room, why: refusalWhy(refused.reason, room) };
    });
  const name = (row: (typeof rows)[number]) => row.room?.name ?? row.refused.site;
  return rows.sort(
    (a, b) => name(a).localeCompare(name(b)) || (a.refused.table ?? "").localeCompare(b.refused.table ?? ""),
  );
}

/** The names of the rooms with a refused window, each once (Today's line). */
export function refusedRoomNames(status: HudStatus | null, policy: HudPolicy | null): string[] {
  const names: string[] = [];
  for (const row of refusedRows(status, policy)) {
    const name = row.room?.name ?? row.refused.site;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
