/**
 * One kind of game on the web's Analysis screens (the owner's rule,
 * 2026-11-04: cash and tournament hands are never combined in a view): the
 * address's `kind`, the overview's older `fmt`, and the filters each screen
 * sends (`gameKind`, the server's `20271104090000_game_kind_filter.sql`).
 */
import { describe, expect, it } from "vitest";

import { parseKind } from "../../web/src/components/analysis/analysisKind";
import { listQuery, parseListState, scopeFilters } from "../../web/src/components/analysis/listState";
import { leaksQuery, parseLeaksState } from "../../web/src/components/analysis/leaks/leaksState";
import { parseReportsState, reportsFilters, reportsQuery } from "../../web/src/components/analysis/reports/reportsState";
import { parseTrainState, trainQuery } from "../../web/src/components/analysis/train/trainState";

describe("the address's kind", () => {
  it("reads cash or tournament, nothing else", () => {
    expect(parseKind({ kind: "cash" })).toBe("cash");
    expect(parseKind(new URLSearchParams("kind=tournament"))).toBe("tournament");
    expect(parseKind({ kind: "chips" })).toBeNull();
    expect(parseKind({})).toBeNull();
  });
});

describe("the overview", () => {
  it("keeps the kind in the address; none named leaves it to the screen", () => {
    const state = parseListState({ kind: "tournament" });
    expect(state.kind).toBe("tournament");
    expect(listQuery(state)).toBe("kind=tournament");
    expect(scopeFilters(state)).toEqual({ potKind: "hu", gameKind: "tournament" });
    expect(parseListState({}).kind).toBeNull();
    // analysis/45-46: heads-up pots only, always.
    expect(scopeFilters(parseListState({}))).toEqual({ potKind: "hu" });
  });

  it("reads an older address's one format as its kind", () => {
    expect(parseListState({ fmt: "sng" }).kind).toBe("tournament");
    expect(parseListState({ fmt: "cash" }).kind).toBe("cash");
    expect(parseListState({ fmt: "nope" }).kind).toBeNull();
  });
});

describe("Leaks, Progress and Reports", () => {
  it("carry the kind with the Hands list's filter (2026-11-16: one filter row everywhere)", () => {
    // A link from before the shared row: its seat becomes the filter's position group.
    const state = parseReportsState({ kind: "cash", pos: "BTN" });
    expect(state.kind).toBe("cash");
    expect(state.filter.positions).toEqual(["BTN"]);
    const filters = reportsFilters(state);
    expect(filters.gameKind).toBe("cash");
    expect(filters.hands).toMatchObject({ positions: ["BTN"], formats: [], statsVersion: expect.stringMatching(/^stats\//) });
    // The address carries the shared filter's saved form, and reads it back.
    const query = reportsQuery(state);
    expect(query).toContain("kind=cash");
    expect(parseReportsState(new URLSearchParams(query))).toEqual(state);
    expect(leaksQuery(parseLeaksState({ kind: "tournament", sort: "count" }))).toContain("kind=tournament");
    // No group set: no hand list, the readers' summaries answer.
    expect(reportsFilters(parseReportsState({}))).toEqual({ potKind: "hu" });
    // Old dates, room and stake become the same groups.
    const old = parseReportsState({ from: "2026-01-02", to: "2026-01-09", room: "pokerstars", stake: "USD:200" });
    expect(old.filter).toMatchObject({ date: "custom", dateFrom: "2026-01-02", dateTo: "2026-01-09", sites: ["pokerstars"], stakes: ["USD:200"] });
    expect(reportsFilters(old).hands).toMatchObject({ sites: ["pokerstars"], stakes: ["USD:200"] });
  });
});

describe("the trainer's drills", () => {
  it("keep the kind in the drills' address only", () => {
    const drills = parseTrainState({ mode: "drills", kind: "tournament" });
    expect(drills.kind).toBe("tournament");
    expect(trainQuery(drills)).toBe("mode=drills&kind=tournament");
    expect(trainQuery({ ...drills, mode: "preflop" })).not.toContain("kind");
  });
});
