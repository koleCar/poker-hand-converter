/**
 * The desktop app's Hands screen filter (`app/src/screens/hands/filter.ts`,
 * R2.7a): what the store is asked for, the date presets as UTC instants of
 * local days, and saved filters read back whatever they hold; (R2.7c) the
 * player filter of "hands with this player", the hand-off from the Players
 * screen, and the Players screen's route parameter. Pure TypeScript, so it
 * runs here; the app has no test runner of its own.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTER,
  activeGroups,
  dateRange,
  fromSaved,
  ordered,
  requestFilter,
  takeRequestedFilter,
  toQuery,
  toSaved,
  type FilterState,
} from "../../app/src/screens/hands/filter.js";
import { parsePlayerParam, playerParam } from "../../app/src/screens/players/param.js";

const NOW = new Date(2026, 9, 14, 15, 30); // local time, 14 Oct 2026 15:30

describe("Hands filter", () => {
  it("asks for everything when nothing is set", () => {
    const query = toQuery(EMPTY_FILTER, NOW);
    expect(query.from).toBeNull();
    expect(query.to).toBeNull();
    expect(query.positions).toEqual([]);
    expect(query.allIn).toBeNull();
    expect(activeGroups(EMPTY_FILTER)).toBe(0);
  });

  it("turns date presets into local days as instants", () => {
    const at = (preset: FilterState["date"]) => dateRange({ ...EMPTY_FILTER, date: preset }, NOW);
    expect(at("today")).toEqual({ from: new Date(2026, 9, 14).toISOString(), to: null });
    expect(at("week")).toEqual({ from: new Date(2026, 9, 8).toISOString(), to: null });
    expect(at("month")).toEqual({ from: new Date(2026, 8, 15).toISOString(), to: null });
    expect(at("year").from).toBe(new Date(2025, 9, 15).toISOString());
    // A custom range includes its last day.
    const custom = dateRange({ ...EMPTY_FILTER, date: "custom", dateFrom: "2026-01-31", dateTo: "2026-02-28" }, NOW);
    expect(custom).toEqual({ from: new Date(2026, 0, 31).toISOString(), to: new Date(2026, 2, 1).toISOString() });
    // Half a range, or a malformed day, is that bound left open.
    expect(dateRange({ ...EMPTY_FILTER, date: "custom", dateFrom: "", dateTo: "2026-2-1" }, NOW)).toEqual({
      from: null,
      to: null,
    });
  });

  it("writes instants the store compares with PHF's played_at", () => {
    const { from } = toQuery({ ...EMPTY_FILTER, date: "today" }, NOW);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("round-trips a saved filter and survives a damaged one", () => {
    const filter: FilterState = {
      ...EMPTY_FILTER,
      positions: ["BTN", "CO"],
      stakes: ["USD:200"],
      allIn: true,
      hasNote: false,
      tags: ["river spot"],
      date: "week",
    };
    expect(fromSaved(toSaved(filter))).toEqual(filter);
    expect(activeGroups(filter)).toBe(6);
    expect(fromSaved("not json")).toBeNull();
    expect(fromSaved("[1,2]")).toEqual(EMPTY_FILTER);
    expect(fromSaved('{"positions":"BTN","allIn":"yes","date":"someday","tags":["a",3]}')).toEqual({
      ...EMPTY_FILTER,
      tags: ["a"],
    });
  });

  it("orders chips by the table, the unknown after them", () => {
    const values = ["SB", "zz", "BTN", "UTG", "aa"].map((value) => ({ value }));
    expect(ordered(values, ["UTG", "BTN", "SB"]).map((v) => v.value)).toEqual(["UTG", "BTN", "SB", "aa", "zz"]);
  });

  it("narrows to a player: counted, asked for, saved, handed over once", () => {
    const player = { site: "pokerstars", player: "Made Up: 7" };
    const filter: FilterState = { ...EMPTY_FILTER, player };
    expect(activeGroups(filter)).toBe(1);
    expect(toQuery(filter, NOW).player).toEqual(player);
    expect(toQuery(EMPTY_FILTER, NOW).player).toBeNull();
    expect(fromSaved(toSaved(filter))).toEqual(filter);
    expect(fromSaved('{"player":{"site":"pokerstars","player":""}}')).toEqual(EMPTY_FILTER);
    expect(fromSaved('{"player":{"site":3,"player":"x"}}')).toEqual(EMPTY_FILTER);
    expect(fromSaved('{"player":"x"}')).toEqual(EMPTY_FILTER);
    expect(takeRequestedFilter()).toBeNull();
    requestFilter(filter);
    expect(takeRequestedFilter()).toEqual(filter);
    expect(takeRequestedFilter()).toBeNull();
  });
});

describe("Players route parameter", () => {
  it("is the site key, a colon, and the name (which may hold colons)", () => {
    expect(parsePlayerParam(playerParam("pokerstars", "a:b c"))).toEqual({ site: "pokerstars", player: "a:b c" });
    expect(parsePlayerParam(null)).toBeNull();
    expect(parsePlayerParam("pokerstars")).toBeNull();
    expect(parsePlayerParam(":name")).toBeNull();
    expect(parsePlayerParam("pokerstars:")).toBeNull();
  });
});
