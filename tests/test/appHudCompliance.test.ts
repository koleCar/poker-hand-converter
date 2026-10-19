/**
 * Compliance mode in the desktop app's window (docs/RAIL-PLAN.md R3.10):
 * `app/src/lib/hudCompliance.ts` words what the Rust side decided - which
 * tables the HUD is on, which it refused and why, where the HUD may be used.
 * Made-up rooms and tables only. And the window has no override: no screen
 * offers to switch the HUD on where compliance mode said no.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  allowedRooms,
  checkedOn,
  hudState,
  notAllowedRooms,
  policyLink,
  refusalWhy,
  refusedRoomNames,
  refusedRows,
} from "../../app/src/lib/hudCompliance.js";
import type { HudPolicy, HudStatus, RoomPolicy } from "../../app/src/lib/ipc.js";

const APP_SRC = join(__dirname, "../../app/src");

function room(id: string, name: string, allowed: boolean | null, extra: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    id,
    name,
    kind: "room",
    allowed,
    permitted: allowed === true,
    source: `https://example.invalid/${id}/rules`,
    checkedAt: "2026-10-14",
    notes: "",
    restrictions: null,
    stricterThanShipped: false,
    ...extra,
  };
}

const POLICY: HudPolicy = {
  rooms: [
    room("alpha", "Alpha Poker", true),
    room("beta", "Beta Poker", false),
    room("gamma", "Gamma Poker", null, { source: null }),
    room("delta", "Delta Poker", false, { stricterThanShipped: true }),
    room("net", "Some Network", null, { kind: "network", source: null }),
    room("repo", "Closed Room", false, { source: "docs/research/hh-formats/closed.md" }),
  ],
  remote: true,
  url: "https://example.invalid/sites.json",
  fetchedAt: 1_760_000_000,
  lastCheck: { at: 1_760_000_100, outcome: { kind: "current" } },
  notes: [],
};

function status(extra: Partial<HudStatus> = {}): HudStatus {
  return {
    phase: "running",
    error: null,
    tablesOpen: 1,
    tablesWaiting: 0,
    tables: [{ site: "alpha", window: 1, table: "Made-up I", waiting: false }],
    refused: [
      { site: "delta", window: 4, table: "Made-up IV", reason: "prohibited" },
      { site: "beta", window: 2, table: "Made-up II", reason: "prohibited" },
      { site: "gamma", window: 3, table: null, reason: "unknown" },
      { site: "beta", window: 2, table: "Made-up II", reason: "prohibited" },
      { site: "net", window: 5, table: "Made-up V", reason: "not-a-room" },
      { site: "nowhere", window: 6, table: null, reason: "unknown-site" },
    ],
    remotePolicy: true,
    ...extra,
  };
}

describe("compliance mode in the window", () => {
  it("says why each table was refused, once per window, by room", () => {
    const rows = refusedRows(status(), POLICY);
    expect(rows.map((r) => [r.refused.window, r.why])).toEqual([
      [2, "prohibited"],
      [4, "withdrawn"],
      [3, "unknown"],
      [6, "unknownSite"],
      [5, "notARoom"],
    ]);
    expect(refusedRoomNames(status(), POLICY)).toEqual([
      "Beta Poker",
      "Delta Poker",
      "Gamma Poker",
      "nowhere",
      "Some Network",
    ]);
    expect(refusedRows(null, POLICY)).toEqual([]);
  });

  it("tells a re-check that withdrew a room from a room that never allowed one", () => {
    expect(refusalWhy("prohibited", room("x", "X", false))).toBe("prohibited");
    expect(refusalWhy("prohibited", room("x", "X", false, { stricterThanShipped: true }))).toBe("withdrawn");
    expect(refusalWhy("prohibited", null)).toBe("prohibited");
    expect(refusalWhy("unknown", null)).toBe("unknown");
    expect(refusalWhy("not-a-room", null)).toBe("notARoom");
    expect(refusalWhy("unknown-site", null)).toBe("unknownSite");
  });

  it("links only a room's own web page, and reads the date as that day", () => {
    expect(policyLink(room("a", "A", true))).toBe("https://example.invalid/a/rules");
    expect(policyLink(room("r", "R", false, { source: "docs/research/hh-formats/closed.md" }))).toBeNull();
    expect(policyLink(room("h", "H", false, { source: "http://example.invalid/" }))).toBeNull();
    expect(policyLink(null)).toBeNull();
    expect(checkedOn(room("a", "A", true))?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(checkedOn(room("a", "A", true, { checkedAt: null }))).toBeNull();
    expect(checkedOn(room("a", "A", true, { checkedAt: "14.10.2026." }))).toBeNull();
  });

  it("lists where the HUD may be used and where not (rooms only)", () => {
    expect(allowedRooms(POLICY).map((r) => r.id)).toEqual(["alpha"]);
    expect(notAllowedRooms(POLICY).map((r) => r.id)).toEqual(["beta", "gamma", "delta", "repo"]);
    expect(allowedRooms(null)).toEqual([]);
  });

  it("puts the HUD process in a word", () => {
    expect(hudState(status())).toBe("running");
    expect(hudState(status({ phase: "starting" }))).toBe("starting");
    expect(hudState(status({ phase: "backoff" }))).toBe("starting");
    for (const phase of ["off", "not-installed", "stopped"]) expect(hudState(status({ phase }))).toBe("off");
    expect(hudState(null)).toBe("off");
  });

  it("offers no override anywhere: nothing in the window can attach the HUD where it was refused", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    for (const path of sources(APP_SRC)) {
      const text = readFileSync(path, "utf8");
      // No command that would set a room's policy or force an attach.
      expect(text, path).not.toMatch(/invoke<[^>]*>\("hud_(allow|override|force|attach|set_policy)/);
      expect(text, path).not.toMatch(/\boverride(Policy|Compliance|Hud)\b/i);
    }
    const ipc = readFileSync(join(APP_SRC, "lib/ipc.ts"), "utf8");
    const commands = [...ipc.matchAll(/invoke<[^>]*>\("(hud_[a-z_]+)"/g)].map((m) => m[1]);
    expect(commands.filter((c) => c?.includes("policy"))).toEqual(["hud_policy", "hud_policy_check", "hud_open_policy_source"]);
  });
});
