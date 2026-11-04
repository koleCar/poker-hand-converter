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
    expect(scopeFilters(state)).toEqual({ gameKind: "tournament" });
    expect(parseListState({}).kind).toBeNull();
    expect(scopeFilters(parseListState({}))).toEqual({});
  });

  it("reads an older address's one format as its kind", () => {
    expect(parseListState({ fmt: "sng" }).kind).toBe("tournament");
    expect(parseListState({ fmt: "cash" }).kind).toBe("cash");
    expect(parseListState({ fmt: "nope" }).kind).toBeNull();
  });
});

describe("Leaks, Progress and Reports", () => {
  it("carry the kind with the other report filters", () => {
    const state = parseReportsState({ kind: "cash", pos: "BTN" });
    expect(state.kind).toBe("cash");
    expect(reportsFilters(state)).toEqual({ gameKind: "cash", position: "BTN" });
    expect(reportsQuery(state)).toBe("pos=BTN&kind=cash");
    expect(leaksQuery(parseLeaksState({ kind: "tournament", sort: "count" }))).toContain("kind=tournament");
    expect(reportsFilters(parseReportsState({})).gameKind).toBeUndefined();
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
