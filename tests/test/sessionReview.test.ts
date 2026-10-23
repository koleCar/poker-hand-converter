/**
 * The session review (R5.1, `packages/ui/review/`): which hands of a session
 * are worth a look, one screen for both surfaces (the web's today).
 *
 * - The ranking, the de-duplication and the badges (`select.ts`): each list
 *   ranked, a hand shown once in the first list it is in, the others its
 *   badges, every list filled to its cap from the hands not shown above.
 * - The web's address (`sessionQuery.ts`): a whitelist, round trips, a
 *   hand's way back.
 * - The web's source (`lib/db/sessionReview.ts`) against a faked `rpc`: what
 *   it asks `session_review` and `report_sessions` for, and what it hands
 *   the screen.
 * - The view rendered to markup (React from the web's install) in English
 *   and Croatian: the summary, the lists and their badges, the notes, the
 *   empty states; the screen's first render, and A10's `hiddenDuringPlay`
 *   reading nothing.
 *
 * The session rule itself is the database's (pgTAP `session_review`, held
 * to `report_sessions`); the screen at 375 px is `responsive.mjs`'s.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import {
  gradeRank,
  shippedChartDeviations,
  type ReviewDecision,
  type ReviewHand,
  type SessionQuery,
  type SessionReview,
  type SessionReviewSource,
} from "@rail/ui/review/model";
import { SessionReviewScreen, SessionReviewView, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";
import { bbPer100, minutesBetween, rankDeviations, rankPots, rankWorst, selectWorthALook } from "@rail/ui/review/select";
import { reviewUiEn } from "@rail/ui/strings/review.en";
import { reviewUiHr } from "@rail/ui/strings/review.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";

import {
  cameFromSession,
  fromSessionQuery,
  parseSessionQuery,
  sessionFilterOf,
  sessionQueryString,
} from "../../frontend/src/components/analysis/session/sessionQuery.js";
import {
  PICKER_DAYS,
  reviewFromPayload,
  serverFilter,
  sessionsFromPayload,
  webSessionReviewSource,
} from "../../frontend/src/lib/db/sessionReview.js";

const rpc = vi.fn();
vi.mock("../../frontend/src/lib/db/client.js", () => ({
  rpc: (...args: unknown[]) => rpc(...args),
  currentUserId: () => Promise.resolve("00000000-0000-0000-0000-0000000000a1"),
}));

/* ------------------------------------------------------------- fixtures - */

function hand(id: string, extra: Partial<ReviewHand> = {}): ReviewHand {
  return {
    handId: id,
    playedAt: `2026-09-01T10:${id.padStart(2, "0")}:00Z`,
    site: "pokerstars",
    stakesLabel: "$1/$2",
    gameFormat: "cash",
    currency: "USD",
    currencySymbol: "$",
    minorUnits: 100,
    bigBlind: 200,
    tableName: "T1",
    position: "BTN",
    heroCards: ["Ah", "Kh"],
    handClass: "AKs",
    board: [],
    potType: "single-raised",
    potBb: 10,
    net: -600,
    netBbMilli: -3000,
    evNetBbMilli: null,
    grade: null,
    evLossBb: null,
    ...extra,
  };
}

function decision(handId: string, grade: string, evLossBb: number | null, extra: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    handId,
    ord: 0,
    actionIndex: 4,
    street: "preflop",
    action: "call",
    best: "fold",
    scenario: "vs-open",
    position: "BTN",
    source: "chart",
    grade,
    evLossBb,
    evLossPot: null,
    chosenFreq: 0.01,
    ...extra,
  };
}

const HANDS: Record<string, ReviewHand> = Object.fromEntries(
  ["1", "2", "3", "4", "5", "6"].map((id) => [id, hand(id)]),
);

/* ------------------------------------------------------------- ranking - */

describe("ranking the lists", () => {
  it("grade ranks follow the analysis's order", () => {
    expect(["perfect", "good", "inaccurate", "mistake", "blunder", "x", null].map(gradeRank)).toEqual([1, 2, 3, 4, 5, 0, 0]);
  });

  it("worst: Inaccurate or worse only, worst grade first, then EV, one decision per hand", () => {
    const ranked = rankWorst(
      [
        decision("1", "mistake", 4),
        decision("2", "blunder", 1),
        decision("3", "good", 9),
        decision("2", "inaccurate", 7, { ord: 1 }),
        decision("4", "blunder", 2.5),
        decision("5", "mistake", null),
      ],
      HANDS,
    );
    expect(ranked.map((row) => `${row.handId}:${row.grade}`)).toEqual(["4:blunder", "2:blunder", "1:mistake", "5:mistake"]);
  });

  it("deviations: by the EV they cost, then the grade", () => {
    const ranked = rankDeviations(
      [decision("1", "inaccurate", 0.2), decision("2", "blunder", 0.2), decision("3", "mistake", 3), decision("4", "mistake", null)],
      HANDS,
    );
    expect(ranked.map((row) => row.handId)).toEqual(["3", "2", "1", "4"]);
  });

  it("pots: biggest first, ties newest first", () => {
    const ranked = rankPots(
      [
        { handId: "1", potBb: 20 },
        { handId: "2", potBb: 55 },
        { handId: "3", potBb: 20 },
      ],
      HANDS,
    );
    expect(ranked.map((row) => row.handId)).toEqual(["2", "3", "1"]);
  });

  it("a hand is shown once, in the first list it is in, with badges for the others", () => {
    const sections = selectWorthALook(
      {
        worst: [decision("1", "blunder", 5, { street: "river", source: "solver" }), decision("2", "mistake", 1)],
        deviations: [decision("2", "mistake", 1), decision("3", "inaccurate", 0.3)],
        pots: [
          { handId: "1", potBb: 80 },
          { handId: "4", potBb: 60 },
          { handId: "3", potBb: 40 },
          { handId: "5", potBb: 30 },
        ],
        hands: HANDS,
      },
      6,
    );
    const view = sections.map((section) => ({
      kind: section.kind,
      items: section.items.map((item) => `${item.handId}${item.badges.map((b) => `+${b.kind}#${b.rank}`).join("")}`),
      shownAbove: section.shownAbove,
      candidates: section.candidates,
    }));
    expect(view).toEqual([
      { kind: "worst", items: ["1+pots#1", "2+deviations#1"], shownAbove: 0, candidates: 2 },
      { kind: "deviations", items: ["3+pots#3"], shownAbove: 1, candidates: 2 },
      { kind: "pots", items: ["4", "5"], shownAbove: 2, candidates: 4 },
    ]);
    // The pot of a hand listed for a decision is still on it.
    expect(sections[0]?.items[0]?.potBb).toBe(10);
  });

  it("each list fills up to its cap from the hands not shown above", () => {
    const sections = selectWorthALook(
      {
        worst: [decision("1", "blunder", 1), decision("2", "blunder", 1)],
        deviations: [],
        pots: ["1", "2", "3", "4", "5"].map((handId, index) => ({ handId, potBb: 100 - index })),
        hands: HANDS,
      },
      2,
    );
    expect(sections.map((section) => section.items.map((item) => item.handId))).toEqual([["2", "1"], [], ["3", "4"]]);
    expect(sections[2]?.items.map((item) => item.rank)).toEqual([3, 4]);
  });

  it("a cap of 0 shows nothing; a hand the lists name but the map lacks is still listed", () => {
    expect(selectWorthALook({ worst: [decision("9", "blunder", 1)], deviations: [], pots: [], hands: {} }, 0)[0]?.items).toEqual([]);
    const [worst] = selectWorthALook({ worst: [decision("9", "blunder", 1)], deviations: [], pots: [], hands: {} }, 3);
    expect(worst?.items[0]?.hand).toBeNull();
  });

  it("a deviation source is pluggable: the shipped one answers the review's chart deviations", async () => {
    const review = reviewFromPayload({ deviations: [{ handId: "1", grade: "mistake", street: "preflop" }] }, 30);
    const query: SessionQuery = { at: null, gapMinutes: 30, filter: {} };
    expect((await shippedChartDeviations.deviations(review, query)).decisions.map((row) => row.handId)).toEqual(["1"]);
    expect(shippedChartDeviations.id).toBe("shipped-charts");
  });

  it("bb/100 and the length", () => {
    expect(bbPer100(-90_000, 4)).toBe(-2250);
    expect(bbPer100(null, 4)).toBeNull();
    expect(bbPer100(1000, 0)).toBeNull();
    expect(minutesBetween("2026-09-01T10:00:00Z", "2026-09-01T11:10:00Z")).toBe(70);
    expect(minutesBetween("2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z")).toBe(1);
  });
});

/* ------------------------------------------------------------- address - */

describe("the address", () => {
  it("reads a whitelist: the instant, the gap, the filter's groups", () => {
    const query = parseSessionQuery({
      at: "2026-09-01T10:00:00.000Z",
      gap: "60",
      site: "pokerstars,ggpoker",
      fmt: "cash",
      stake: "USD:200",
      pos: "UTG+1,<script>",
      from: "2026-01-01T00:00:00Z",
      extra: "x",
    });
    expect(query).toEqual({
      at: "2026-09-01T10:00:00.000Z",
      gapMinutes: 60,
      filter: { sites: ["pokerstars", "ggpoker"], formats: ["cash"], stakes: ["USD:200"], positions: ["UTG+1"] },
    });
  });

  it("drops what is not an instant or a gap", () => {
    expect(parseSessionQuery(new URLSearchParams("at=yesterday&gap=3"))).toEqual({ at: null, gapMinutes: 30, filter: {} });
    expect(parseSessionQuery(new URLSearchParams("at=2026-13-45T99:00:00Z&gap=721")).at).toBeNull();
    expect(parseSessionQuery(new URLSearchParams("gap=720")).gapMinutes).toBe(720);
    expect(parseSessionQuery(new URLSearchParams("at=2026-09-01T12:00:00%2B02:00")).at).toBe("2026-09-01T10:00:00.000Z");
  });

  it("writes defaults out and round-trips", () => {
    const query: SessionQuery = {
      at: "2026-09-01T10:00:00.000Z",
      gapMinutes: 45,
      filter: { formats: ["cash"], sizes: ["6max"] },
    };
    expect(sessionQueryString({ at: null, gapMinutes: 30, filter: {} })).toBe("");
    expect(parseSessionQuery(new URLSearchParams(sessionQueryString(query)))).toEqual(query);
  });

  it("a Statistics filter keeps its groups, never its dates or searches", () => {
    expect(
      sessionFilterOf({ formats: ["cash"], stakes: ["USD:200"], from: "2026-01-01T00:00:00Z", heroCards: ["Ah"], sites: [] }),
    ).toEqual({ formats: ["cash"], stakes: ["USD:200"] });
  });

  it("a hand opened from the review knows its way back", () => {
    const back = fromSessionQuery({ at: "2026-09-01T10:00:00.000Z", gapMinutes: 30, filter: { formats: ["cash"] } });
    expect(back).toBe("from=session&at=2026-09-01T10%3A00%3A00.000Z&fmt=cash");
    const params = new URLSearchParams(`t=a4&${back}`);
    expect(cameFromSession(params)).toBe(true);
    expect(parseSessionQuery(params).at).toBe("2026-09-01T10:00:00.000Z");
    expect(cameFromSession(new URLSearchParams("t=a4"))).toBe(false);
  });
});

/* -------------------------------------------------------------- source - */

const PAYLOAD = {
  gapMinutes: 30,
  analysisVersion: "analysis/34",
  limit: 20,
  session: {
    startedAt: "2026-09-01T10:00:00+00:00",
    endedAt: "2026-09-01T11:10:00+00:00",
    finished: true,
    previousAt: null,
    nextAt: "2026-09-01T12:00:00+00:00",
    hands: 4,
    tables: 2,
    allInHands: 1,
    mixedUnitKind: false,
    mixedCurrency: false,
    cash: true,
    currency: "USD",
    currencySymbol: "$",
    currencyMinorUnits: 100,
    netBbMilli: -90000,
    evNetBbMilli: -82000,
    net: -18000,
    evNet: -16400,
  },
  ongoing: null,
  analysis: { hands: 4, analysed: 3, graded: 3, notAnalysed: 0 },
  worst: [
    { handId: "h13", ord: 1, actionIndex: 15, street: "river", action: "call", best: "fold", scenario: "pfr-ip-vs-bet", position: null, source: "solver", grade: "blunder", evLossBb: 5, evLossPot: 0.4, chosenFreq: 0 },
    { handId: "h11", ord: 0, actionIndex: 4, street: "preflop", action: "call", best: "fold", scenario: "vs-open", position: "BTN", source: "chart", grade: "blunder", evLossBb: 3, evLossPot: 0.5, chosenFreq: 0.01 },
    { handId: "h12", ord: 1, actionIndex: 9, street: "flop", action: "bet", best: "check", scenario: "pfr-ip-first", position: null, source: "solver", grade: "mistake", evLossBb: 1.5, evLossPot: 0.05, chosenFreq: 0.2 },
  ],
  deviations: [
    { handId: "h11", ord: 0, actionIndex: 4, street: "preflop", action: "call", best: "fold", scenario: "vs-open", position: "BTN", source: "chart", grade: "blunder", evLossBb: 3, evLossPot: 0.5, chosenFreq: 0.01 },
    { handId: "h13", ord: 0, actionIndex: 4, street: "preflop", action: "raise", best: "fold", scenario: "unopened", position: "BTN", source: "chart", grade: "inaccurate", evLossBb: 0.2, evLossPot: 0.01, chosenFreq: 0.01 },
  ],
  pots: [
    { handId: "h14", potBb: 200 },
    { handId: "h12", potBb: 30 },
    { handId: "h11", potBb: 10 },
    { handId: "h13", potBb: 5 },
  ],
  hands: Object.fromEntries(
    [
      ["h11", 0, -3000, null, "blunder", ["Ah", "Kh"]],
      ["h12", 20, 15000, 23000, "mistake", ["Qs", "Qd"]],
      ["h13", 45, -2000, null, "blunder", ["7c", "2d"]],
      ["h14", 10, -100000, null, null, ["Jc", "Tc"]],
    ].map(([id, minute, bb, ev, grade, cards]) => [
      id,
      {
        playedAt: `2026-09-01T10:${String(minute).padStart(2, "0")}:00+00:00`,
        site: "pokerstars",
        stakesLabel: "$1/$2",
        gameFormat: "cash",
        currency: "USD",
        currencySymbol: "$",
        minorUnits: 100,
        bigBlind: 200,
        tableName: "T1",
        position: "BTN",
        heroCards: cards,
        handClass: null,
        board: [],
        potType: "single-raised",
        potBb: 10,
        net: Number(bb) / 5,
        netBbMilli: bb,
        evNetBbMilli: ev,
        grade,
        evLossBb: null,
      },
    ]),
  ),
};

describe("the web's source", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("asks session_review with this build's versions, the gap, the cap, and no dates", async () => {
    rpc.mockResolvedValueOnce(PAYLOAD);
    const review = await webSessionReviewSource.review(
      { at: "2026-09-01T10:30:00.000Z", gapMinutes: 45, filter: { formats: ["cash"], from: "2026-01-01T00:00:00Z" } },
      20,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("session_review");
    expect(args.p_at).toBe("2026-09-01T10:30:00.000Z");
    expect(args.p_gap_minutes).toBe(45);
    expect(args.p_limit).toBe(20);
    const filter = args.p_filter as Record<string, unknown>;
    expect(filter.formats).toEqual(["cash"]);
    expect(filter.from).toBeUndefined();
    expect(filter.statsVersion).toMatch(/^stats\/\d+$/);
    expect(filter.evVersion).toMatch(/^ev\/\d+$/);
    expect(filter.analysisVersion).toMatch(/^analysis\/\d+$/);
    expect(review.session?.hands).toBe(4);
    expect(review.session?.nextAt).toBe("2026-09-01T12:00:00+00:00");
    expect(review.coverage).toEqual({ hands: 4, analysed: 3, graded: 3, notAnalysed: 0 });
    expect(review.worst.map((row) => row.handId)).toEqual(["h13", "h11", "h12"]);
    expect(review.chartDeviations[0]?.chosenFreq).toBe(0.01);
    expect(review.hands.h12?.evNetBbMilli).toBe(23000);
    expect(review.hands.h12?.heroCards).toEqual(["Qs", "Qd"]);
  });

  it("the latest session: no instant sent", async () => {
    rpc.mockResolvedValueOnce({ gapMinutes: 30, session: null, ongoing: null });
    const review = await webSessionReviewSource.review({ at: null, gapMinutes: 30, filter: {} }, 20);
    expect((rpc.mock.calls[0] as [string, Record<string, unknown>])[1].p_at).toBeUndefined();
    expect(review.session).toBeNull();
    expect(review.worst).toEqual([]);
  });

  it("the picker: the last days from report_sessions, the window's oldest left out", async () => {
    const sessions = (n: number) => ({
      sessions: Array.from({ length: n }, (_, i) => ({
        startedAt: `2026-09-${String(20 - i).padStart(2, "0")}T10:00:00+00:00`,
        endedAt: `2026-09-${String(20 - i).padStart(2, "0")}T11:00:00+00:00`,
        hands: 100 + i,
        tables: 2,
        netBbMilli: 1000 * i,
        net: null,
      })),
    });
    rpc.mockResolvedValueOnce(sessions(4));
    const list = await webSessionReviewSource.sessions({ at: null, gapMinutes: 30, filter: { formats: ["cash"] } });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("report_sessions");
    expect(args.p_gap_minutes).toBe(30);
    const from = Date.parse(String((args.p_filter as Record<string, unknown>).from));
    expect(Math.abs(Date.now() - PICKER_DAYS * 86_400_000 - from)).toBeLessThan(60_000);
    expect(list.map((item) => item.hands)).toEqual([100, 101, 102]);
  });

  it("the picker reads the whole history when the window has fewer than two sessions", async () => {
    rpc.mockResolvedValueOnce({ sessions: [{ startedAt: "a", endedAt: "b", hands: 3, tables: 1, netBbMilli: 0 }] });
    rpc.mockResolvedValueOnce({ sessions: [{ startedAt: "c", endedAt: "d", hands: 9, tables: 1, netBbMilli: 0 }] });
    const list = await webSessionReviewSource.sessions({ at: null, gapMinutes: 30, filter: {} });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(((rpc.mock.calls[1] as [string, Record<string, unknown>])[1].p_filter as Record<string, unknown>).from).toBeUndefined();
    expect(list.map((item) => item.hands)).toEqual([9]);
  });

  it("maps an empty or odd payload to an empty review", () => {
    expect(reviewFromPayload(null, 15)).toMatchObject({ gapMinutes: 15, session: null, worst: [], pots: [], hands: {} });
    expect(sessionsFromPayload({ sessions: "x" }, true)).toEqual([]);
    expect(serverFilter({ to: "2026-01-01T00:00:00Z", sites: ["winamax"] })).not.toHaveProperty("to");
  });
});

/* ---------------------------------------------------------------- view - */

function strings(locale: "en" | "hr"): UiStrings {
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    review: locale === "en" ? reviewUiEn : reviewUiHr,
    // The hero's cards (`CardRow`) read the replayer's card words.
    replayer: locale === "en" ? replayerEn : replayerHr,
  } as unknown as UiStrings;
}

function render(locale: "en" | "hr", node: ReactNode): string {
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node));
}

const link = ({ handId, actionIndex, sessionAt, label, className, children }: HandLinkProps) =>
  createElement(
    "a",
    { href: `/h/${handId}?t=a${actionIndex ?? ""}&at=${sessionAt}`, className, "aria-label": label },
    children,
  );

const state = (kind: string, text: string) => createElement("p", { "data-state": kind }, text);

/** The markup with its entities read back, so the words compare as written. */
const plain = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function view(locale: "en" | "hr", review: SessionReview, extra: Record<string, unknown> = {}): string {
  return plain(render(
    locale,
    createElement(SessionReviewView, {
      review,
      deviations: review.chartDeviations,
      sessions: [
        { startedAt: "2026-09-01T12:00:00+00:00", endedAt: "2026-09-01T12:40:00+00:00", hands: 3, tables: 1, netBbMilli: 3000 },
      ],
      query: { at: "2026-09-01T10:00:00.000Z", gapMinutes: 30, filter: {} },
      onQuery: () => undefined,
      renderHandLink: link,
      renderState: state,
      ...extra,
    }),
  ));
}

describe("the view", () => {
  const review = reviewFromPayload(PAYLOAD, 30);

  for (const locale of ["en", "hr"] as const) {
    const r = locale === "en" ? reviewUiEn : reviewUiHr;

    it(`${locale}: the summary, the three lists in order, each hand once`, () => {
      const html = view(locale, review);
      for (const heading of [r.lists.worst.heading, r.lists.deviations.heading, r.lists.pots.heading, r.summary.label]) {
        expect(html).toContain(heading);
      }
      expect(html.indexOf(r.lists.worst.heading)).toBeLessThan(html.indexOf(r.lists.deviations.heading));
      expect(html.indexOf(r.lists.deviations.heading)).toBeLessThan(html.indexOf(r.lists.pots.heading));
      // Four hands, four links, each opening at its decision (the pot at the hand's default).
      const links = [...html.matchAll(/href="\/h\/(h\d+)\?t=a(\d*)&at=([^"]+)"/g)].map((m) => `${m[1]}@${m[2]}`);
      expect(links).toEqual(["h13@15", "h11@4", "h12@9", "h14@"]);
      expect(html).toContain("at=2026-09-01T10:00:00+00:00");
      // Badges: h13 is off chart (#2) and a big pot (#4); h11 off chart #1 and big pot #3; h12 big pot #2.
      expect(html).toContain(r.badges.deviations(2));
      expect(html).toContain(r.badges.deviations(1));
      expect(html).toContain(r.badges.pots(4));
      expect(html).toContain(r.badges.pots(2));
      expect(html).toContain(r.grades.blunder);
      expect(html).toContain(r.grades.mistake);
      expect(html).toContain(r.lists.more(2));
      expect(html).toContain(r.summary.evNote(1));
      expect(html).toContain(r.picker.latest);
      expect(html).toContain(r.picker.gap(30));
      expect(html).not.toContain(r.notFinished);
    });

    it(`${locale}: what is not analysed yet, the surface's action beside it`, () => {
      const partial = reviewFromPayload(
        { ...PAYLOAD, analysis: { hands: 4, analysed: 0, graded: 0, notAnalysed: 0 }, worst: [], deviations: [] },
        30,
      );
      const html = view(locale, partial, { coverageAction: createElement("a", { href: "/analysis" }, "RUN") });
      expect(html).toContain(r.coverage.missing(4, 4));
      expect(html).toContain('href="/analysis"');
      expect(html).toContain(r.lists.worst.emptyUnanalysed);
      expect(html).toContain(r.lists.deviations.emptyUnanalysed);
      expect(html).not.toContain(r.lists.pots.empty);
    });

    it(`${locale}: an ongoing session is named, an unfinished one says so, money withheld across currencies`, () => {
      const odd = reviewFromPayload(
        {
          ...PAYLOAD,
          ongoing: { startedAt: "2026-09-02T18:00:00+00:00", endedAt: "2026-09-02T19:00:00+00:00" },
          session: { ...PAYLOAD.session, finished: false, mixedCurrency: true, net: null, currency: null },
        },
        30,
      );
      const html = view(locale, odd);
      expect(html).toContain(r.ongoing.reviewNow);
      expect(html).toContain(r.notFinished);
      expect(html).toContain(r.summary.mixedCurrency);
      expect(html).not.toContain(`<dt>${r.summary.result}</dt>`);
    });

    it(`${locale}: no session - an empty library, or a filter that matches nothing`, () => {
      const none = reviewFromPayload({ gapMinutes: 30, session: null }, 30);
      expect(view(locale, none, { query: { at: null, gapMinutes: 30, filter: {} } })).toContain(r.noHands);
      const filtered = view(locale, none, { query: { at: null, gapMinutes: 30, filter: { formats: ["spin"] } } });
      expect(filtered).toContain(r.noMatch);
      expect(filtered).toContain(r.picker.clearFilter);
    });
  }

  it("the screen's first render is the loading state; A10 hides it and reads nothing", () => {
    const source: SessionReviewSource = { review: vi.fn(), sessions: vi.fn() };
    const props = {
      source,
      query: { at: null, gapMinutes: 30, filter: {} },
      onQuery: () => undefined,
      renderHandLink: link,
      renderState: state,
      title: "Session review",
    };
    const loading = render("en", createElement(SessionReviewScreen, props));
    expect(loading).toContain(reviewUiEn.loading);
    const hidden = render("hr", createElement(SessionReviewScreen, { ...props, hiddenDuringPlay: true }));
    expect(hidden).toContain(reviewUiHr.hiddenDuringPlay);
    expect(hidden).not.toContain(reviewUiHr.loading);
    expect(source.review).not.toHaveBeenCalled();
    expect(source.sessions).not.toHaveBeenCalled();
  });

  it("both languages have the same keys", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, inner]) => [`${prefix}${key}`, ...keys(inner, `${prefix}${key}.`)])
        : [];
    expect(keys(reviewUiHr).sort()).toEqual(keys(reviewUiEn).sort());
  });
});
