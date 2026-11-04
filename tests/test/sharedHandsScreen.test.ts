/**
 * The shared Hands screen (`packages/ui/hands/`, R4.5b): one screen, two
 * data sources - the desktop app's local store and the web's library.
 *
 * - The filter model: the web library's searches and order on top of the
 *   app's groups, as a query and as a saved filter.
 * - The row of chips each source gets (`handGroups`): tags and notes only
 *   where kept, the searches and the order only where the source has them.
 * - The web's source (`web/src/lib/db/handsSource.ts`) against a faked
 *   `rpc`: what it asks `library_page` / `library_facets` for, and the rows
 *   and counts it hands the screen.
 * - The list and the filter row rendered to markup (React from the web's
 *   install) with rows shaped as each surface sends them, in English and
 *   Croatian: the words, the marks, the chips.
 *
 * The screen's behaviour in a browser (paging, keyboard, a phone's layout) is
 * checked by hand: `docs/RAIL-PLAN.md` R4.5b.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilterBar, HAND_GROUPS, REPORT_GROUPS, handGroups } from "@rail/ui/hands/FilterBar";
import { PANES, QUICK_FILTERS, clearAll, clearGroup, quickFor, selectedOf, shownSet, withValues } from "@rail/ui/hands/groups";
import { EMPTY_FILTER, activeGroups, fromSaved, toQuery, toSaved, type FilterState } from "@rail/ui/hands/filter";
import { HandList } from "@rail/ui/hands/HandList";
import type { HandFacets, HandRow } from "@rail/ui/hands/model";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";

const rpc = vi.fn();
vi.mock("../../web/src/lib/db/client.js", () => ({ rpc: (...args: unknown[]) => rpc(...args) }));

const NOW = new Date(2026, 9, 14, 15, 30);

function strings(locale: "en" | "hr"): UiStrings {
  // Only what the list and the filter row read; the rest is never touched here.
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    closeNamed: (what: string) => what,
    replayer: locale === "en" ? replayerEn : replayerHr,
    hands: locale === "en" ? handsUiEn : handsUiHr,
  } as unknown as UiStrings;
}

function render(locale: "en" | "hr", node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node));
}

/** A row as the desktop's store sends it (`hands::HandRowDto`). */
const APP_ROW: HandRow = {
  handKey: "pokerstars:1001",
  site: "pokerstars",
  siteName: "PokerStars",
  siteHandId: "1001",
  playedAt: "2026-10-14T12:00:00.000Z",
  gameFormat: "cash",
  variant: "holdem",
  limitType: "nl",
  currency: "USD",
  currencySymbol: "$",
  minorUnits: 100,
  smallBlind: 50,
  bigBlind: 100,
  ante: 0,
  maxSeats: 6,
  tableName: null,
  heroPosition: "BTN",
  heroCards: ["Ah", "Kd"],
  board: ["2c", "7d", "Ks"],
  heroNet: 1250,
  heroNetBbMilli: 12500,
  allIn: true,
  evNet: 800,
  evNetBbMilli: 8000,
  evPending: false,
  potType: "single-raised",
  totalPot: 2600,
  showdown: true,
  hasNote: true,
  tags: ["review"],
};

/** A row as `library_page` sends it, after the web's source has named the room. */
const WEB_ROW: HandRow = {
  ...APP_ROW,
  handKey: "00000000-0000-0000-0000-000000000001",
  site: "ignition",
  siteName: "Ignition / Bodog / Bovada",
  heroNet: -300,
  heroNetBbMilli: null,
  allIn: false,
  evNet: null,
  evNetBbMilli: null,
  hasNote: false,
  tags: [],
  heroHandClass: "AKo",
  positionalNames: true,
};

describe("the filter: the web's searches and order", () => {
  it("leaves them out of the query until they are set", () => {
    const query = toQuery(EMPTY_FILTER, NOW);
    expect(query).not.toHaveProperty("heroCards");
    expect(query).not.toHaveProperty("heroHandClasses");
    expect(query).not.toHaveProperty("board");
    expect(query).not.toHaveProperty("playerName");
    expect(query).not.toHaveProperty("showdown");
    expect(query).not.toHaveProperty("sort");
    expect(activeGroups(EMPTY_FILTER)).toBe(0);
  });

  it("reads cards and classes as the library's form did", () => {
    const filter: FilterState = { ...EMPTY_FILTER, heroCards: "AKs", board: "kd 7C x", playerName: "  Opp1 ", showdown: true, sort: "pot" };
    const query = toQuery(filter, NOW);
    expect(query.heroHandClasses).toEqual(["AKs"]);
    expect(query.heroCards).toBeUndefined();
    expect(query.board).toEqual(["Kd", "7c"]);
    expect(query.playerName).toBe("Opp1");
    expect(query.showdown).toBe(true);
    expect(query.sort).toBe("pot");
    expect(toQuery({ ...EMPTY_FILTER, heroCards: "Ah Kh" }, NOW).heroCards).toEqual(["Ah", "Kh"]);
    // The order is not a filter: "clear all" and the count of set groups leave it.
    expect(activeGroups({ ...EMPTY_FILTER, sort: "won" })).toBe(0);
    expect(activeGroups(filter)).toBe(4);
  });

  it("the range grid: its classes, narrowed by a class typed as well, saved and read back", () => {
    const range: FilterState = { ...EMPTY_FILTER, heroRange: ["AA", "AKs", "AKo", "72o"] };
    expect(toQuery(range, NOW).heroHandClasses).toEqual(["AA", "AKs", "AKo", "72o"]);
    expect(toQuery({ ...range, heroCards: "AK" }, NOW).heroHandClasses).toEqual(["AKs", "AKo"]);
    expect(toQuery({ ...range, heroCards: "Ah Kh" }, NOW).heroCards).toEqual(["Ah", "Kh"]);
    expect(activeGroups(range)).toBe(1);
    expect(fromSaved(toSaved(range))).toEqual(range);
    expect(fromSaved(JSON.stringify({ heroRange: ["AA", "ZZ", 7, "AK", "KAs"] }))?.heroRange).toEqual(["AA"]);
  });

  it("saves and reads them back, and an older saved filter still reads", () => {
    const filter: FilterState = { ...EMPTY_FILTER, positions: ["BTN"], heroCards: "TT", sort: "oldest", showdown: false };
    expect(fromSaved(toSaved(filter))).toEqual(filter);
    const old = fromSaved(JSON.stringify({ positions: ["CO"], date: "week" }));
    expect(old).toEqual({ ...EMPTY_FILTER, positions: ["CO"], date: "week" });
    expect(fromSaved(JSON.stringify({ sort: "sideways" }))?.sort).toBe("newest");
  });

  it("the library's other filters: table, minimum pot, positions, names", () => {
    const filter: FilterState = {
      ...EMPTY_FILTER,
      tableName: "  Zeta ",
      minPot: "2,5",
      showdownPositions: ["BB"],
      winnerPositions: ["BTN", "CO"],
      anonymizations: ["positional"],
    };
    const query = toQuery(filter, NOW);
    expect(query.tableName).toBe("Zeta");
    expect(query.minPot).toBe(2.5);
    expect(query.showdownPositions).toEqual(["BB"]);
    expect(query.winnerPositions).toEqual(["BTN", "CO"]);
    expect(query.anonymizations).toEqual(["positional"]);
    expect(activeGroups(filter)).toBe(5);
    expect(fromSaved(toSaved(filter))).toEqual(filter);
    // A pot that is not a positive number is no filter.
    for (const minPot of ["", "abc", "0", "-3"]) {
      expect(toQuery({ ...EMPTY_FILTER, minPot }, NOW)).not.toHaveProperty("minPot");
    }
    expect(toQuery(EMPTY_FILTER, NOW)).not.toHaveProperty("showdownPositions");
    expect(toQuery(EMPTY_FILTER, NOW)).not.toHaveProperty("anonymizations");
  });
});

describe("the groups each source gets", () => {
  it("the desktop's: tags and notes, no searches, no order, none of the library's other filters", () => {
    const groups = handGroups({ annotations: true, search: false, sorts: [], more: [] });
    expect(groups).toEqual(HAND_GROUPS);
    expect(groups).toContain("tags");
    for (const group of ["heroHand", "board", "playerName", "sort", "showdownPositions", "anonymization"]) {
      expect(groups).not.toContain(group);
    }
  });

  it("the web's: the order first, the searches, showdown and the other filters; no tags or notes", () => {
    const groups = handGroups({
      annotations: false,
      search: true,
      sorts: ["oldest", "pot"],
      more: ["tableName", "minPot", "showdownPositions", "winnerPositions", "anonymization"],
    });
    expect(groups[0]).toBe("sort");
    expect(groups[1]).toBe("date");
    expect(groups.slice(-9)).toEqual([
      "heroHand",
      "board",
      "playerName",
      "showdown",
      "tableName",
      "minPot",
      "showdownPositions",
      "winnerPositions",
      "anonymization",
    ]);
    expect(groups).not.toContain("tags");
    expect(groups).not.toContain("notes");
  });

  it("a source with only the pot gets the pot, not the card searches", () => {
    const groups = handGroups({ annotations: false, search: false, sorts: [], more: ["minPot"] });
    expect(groups).toContain("minPot");
    expect(groups).not.toContain("heroHand");
  });

  it("Reports keeps its own groups, and of the quick filters only the date's", () => {
    expect(REPORT_GROUPS).toEqual(["date", "site", "stakes", "position", "format", "variant", "limit", "size"]);
    expect(quickFor(REPORT_GROUPS).map((quick) => quick.id)).toEqual(["week"]);
  });

  it("every group lives in one pane of the builder", () => {
    const all = handGroups({
      annotations: true,
      search: true,
      sorts: [],
      more: ["tableName", "minPot", "showdownPositions", "winnerPositions", "anonymization"],
    });
    const inPanes = PANES.flatMap((section) => section.panes.flatMap((pane) => pane.groups));
    for (const group of all) expect(inPanes.filter((g) => g === group)).toHaveLength(1);
  });
});

describe("the quick filters and the set groups", () => {
  it("a quick filter switches its values on together and off together, keeping the rest", () => {
    const threeBet = QUICK_FILTERS.find((quick) => quick.id === "threeBet");
    expect(threeBet).toBeDefined();
    const on = threeBet!.toggle({ ...EMPTY_FILTER, potTypes: ["limped"] });
    expect(on.potTypes).toEqual(["limped", "3bet", "4bet+"]);
    expect(threeBet!.on(on)).toBe(true);
    expect(threeBet!.toggle(on).potTypes).toEqual(["limped"]);
  });

  it("a kind the Cash / Tournaments toggle set is no chip, and Clear all keeps it", () => {
    const both: HandFacets = {
      total: 3,
      sites: [],
      formats: [
        { value: "cash", count: 2 },
        { value: "spin", count: 1 },
      ],
      variants: [],
      limits: [],
      sizes: [],
      stakes: [],
      positions: [],
      potTypes: [],
      results: [],
      stacks: [],
      allIn: [],
      tags: [],
      noted: 0,
    };
    const cash: FilterState = { ...EMPTY_FILTER, formats: ["cash"], positions: ["BTN"] };
    expect(shownSet(HAND_GROUPS, cash, both)).toEqual(["position"]);
    expect(clearAll(cash, both)).toEqual({ ...EMPTY_FILTER, formats: ["cash"] });
    // Tournaments is every chip format the hands have: only Spin here.
    expect(shownSet(HAND_GROUPS, { ...EMPTY_FILTER, formats: ["spin"] }, both)).toEqual([]);
    // Narrowed within a kind, the Game group is a chip again.
    const narrowed = { ...EMPTY_FILTER, formats: ["sng"] };
    expect(shownSet(HAND_GROUPS, narrowed, { ...both, formats: [...both.formats, { value: "sng", count: 1 }] })).toEqual([
      "format",
    ]);
    expect(clearAll({ ...cash, sort: "pot" }, null)).toEqual({ ...EMPTY_FILTER, formats: ["cash"], sort: "pot" });
  });

  it("the Game group stays within the toggle's kind: its options, its ×, Clear all (#307)", () => {
    const mixed: HandFacets = {
      total: 4,
      sites: [],
      formats: [
        { value: "cash", count: 2 },
        { value: "sng", count: 1 },
        { value: "spin", count: 1 },
      ],
      variants: [],
      limits: [],
      sizes: [],
      stakes: [],
      positions: [],
      potTypes: [],
      results: [],
      stacks: [],
      allIn: [],
      tags: [],
      noted: 0,
    };
    const spinOnly: FilterState = { ...EMPTY_FILTER, formats: ["spin"], positions: ["BB"] };
    // × on the Game chip and Clear all go back to the whole of the kind, never to both kinds.
    expect(clearGroup("format", spinOnly, mixed).formats).toEqual(["sng", "spin"]);
    expect(clearAll(spinOnly, mixed)).toEqual({ ...EMPTY_FILTER, formats: ["sng", "spin"] });
    // The whole kind reads as "any" in the editor; a pick narrows within it.
    const whole = { ...EMPTY_FILTER, formats: ["sng", "spin"] };
    expect(selectedOf("format", whole, mixed)).toEqual([]);
    expect(withValues("format", whole, ["spin"], mixed).formats).toEqual(["spin"]);
    // A pick of the other kind replaces the choice.
    expect(withValues("format", spinOnly, ["spin", "cash"], mixed).formats).toEqual(["cash"]);
  });
});

describe("the web's source", () => {
  beforeEach(() => rpc.mockReset());

  it("asks library_page with the screen's filter, its versions and the cursor", async () => {
    const { webHandsSource } = await import("../../web/src/lib/db/handsSource.js");
    rpc.mockResolvedValueOnce({
      rows: [{ ...WEB_ROW, siteName: undefined, positionalNames: undefined, anonymization: "positional" }],
      next: { value: "2026-10-14T12:00:00+00:00", id: WEB_ROW.handKey },
    });
    const source = webHandsSource("Standard format");
    const page = await source.page(
      { sites: ["ignition"], playerName: "Opp1", tags: ["x"], hasNote: true, sort: "pot", heroCards: ["Ah"] },
      { value: 1, id: "a" },
      100,
    );
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, Record<string, unknown>>];
    expect(fn).toBe("library_page");
    expect(args.p_filter).toMatchObject({ sites: ["ignition"], player: "Opp1", sort: "pot", heroCards: ["Ah"] });
    expect(args.p_filter).toHaveProperty("statsVersion");
    expect(args.p_filter).toHaveProperty("evVersion");
    expect(args.p_filter).not.toHaveProperty("playerName");
    expect(args.p_filter).not.toHaveProperty("tags");
    expect(args.p_filter).not.toHaveProperty("hasNote");
    expect(args.p_after).toEqual({ value: 1, id: "a" });
    expect(args.p_limit).toBe(100);
    expect(page.rows[0]?.siteName).toBe("Ignition / Bodog / Bovada");
    expect(page.rows[0]?.positionalNames).toBe(true);
    expect(page.rows[0]).not.toHaveProperty("anonymization");
    expect(page.next).toEqual({ value: "2026-10-14T12:00:00+00:00", id: WEB_ROW.handKey });
  });

  it("names the rooms of the counts and has no tags or notes", async () => {
    const { webHandsSource } = await import("../../web/src/lib/db/handsSource.js");
    rpc.mockResolvedValueOnce({
      total: 3,
      library: 10,
      sites: [{ value: "pokerstars", count: 2 }, { value: "standard", count: 1 }],
      positions: [{ value: "BTN", count: 3 }],
    });
    const facets = await webHandsSource("Standard format").facets({});
    expect(facets.total).toBe(3);
    expect(facets.library).toBe(10);
    expect(facets.sites).toEqual([
      { value: "pokerstars", count: 2, name: "PokerStars" },
      { value: "standard", count: 1, name: "Standard format" },
    ]);
    expect(facets.formats).toEqual([]);
    expect(facets.anonymizations).toEqual([]);
    expect(facets.tags).toEqual([]);
    expect(facets.noted).toBe(0);
  });

  it("passes the library's other filters as they are, counts the names, and says it has them", async () => {
    const { webHandsSource } = await import("../../web/src/lib/db/handsSource.js");
    rpc.mockResolvedValueOnce({ rows: [], next: null });
    rpc.mockResolvedValueOnce({ total: 1, anonymizations: [{ value: "positional", count: 1 }] });
    const source = webHandsSource("x");
    const filter = {
      tableName: "Zeta",
      minPot: 2.5,
      showdownPositions: ["BB"],
      winnerPositions: ["BTN"],
      anonymizations: ["positional"],
    };
    await source.page(filter, null, 100);
    const facets = await source.facets(filter);
    for (const [, args] of rpc.mock.calls as [string, Record<string, Record<string, unknown>>][]) {
      expect(args.p_filter).toMatchObject(filter);
    }
    expect(facets.anonymizations).toEqual([{ value: "positional", count: 1 }]);
    expect(source.features.more).toEqual(["tableName", "minPot", "showdownPositions", "winnerPositions", "anonymization"]);
  });

  it("passes live arrivals to the list", async () => {
    const { notifyHandsChanged, webHandsSource } = await import("../../web/src/lib/db/handsSource.js");
    const listener = vi.fn();
    const stop = webHandsSource("x").onChanged?.(listener);
    notifyHandsChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    stop?.();
    notifyHandsChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("the list, rendered", () => {
  const list = (rows: HandRow[]) =>
    createElement(HandList, {
      rows,
      hasMore: true,
      loadingMore: false,
      total: 2,
      selected: rows[0]?.handKey ?? null,
      onSelect: () => undefined,
      onOpen: () => undefined,
      onLoadMore: () => undefined,
      orderLabel: "Newest first",
    });

  it("a desktop row: result in money and big blinds, the all-in EV, showdown, a note, a tag", () => {
    const html = render("en", list([APP_ROW]));
    expect(html).toContain('aria-label="Hands, newest first"');
    expect(html).toContain("PokerStars");
    expect(html).toContain("#1001");
    expect(html).toContain("$0.50/$1<");
    expect(html).toContain("+$12.50");
    expect(html).toContain("+12.5");
    expect(html).toContain("EV +8.0");
    expect(html).toContain("Showdown");
    expect(html).toContain('aria-label="Has a note"');
    expect(html).toContain(">review<");
    expect(html).toContain('aria-selected="true"');
  });

  it("a web row: no big blinds yet, the positional-names mark", () => {
    const html = render("en", list([WEB_ROW]));
    expect(html).toContain("Ignition / Bodog / Bovada");
    expect(html).toContain(">-$3<");
    expect(html).toContain(">Anon<");
    expect(html).toContain(handsUiEn.positionalNamesTitle.split("'")[0]);
    expect(html).not.toContain("EV ");
  });

  it("in Croatian: the column names and the numbers' grouping", () => {
    const html = render("hr", list([{ ...APP_ROW, heroNetBbMilli: 1234500 }]));
    expect(html).toContain("Rezultat");
    expect(html).toContain("Oznake");
    expect(html).toContain("+1.234,5");
    // The order's words are the surface's (the screen passes its own).
    expect(html).toContain('aria-label="Ruke, newest first"');
  });
});

describe("the filter row, rendered", () => {
  const facets: HandFacets = {
    total: 2,
    library: 5,
    sites: [{ value: "pokerstars", count: 2, name: "PokerStars" }],
    formats: [],
    variants: [],
    limits: [],
    sizes: [],
    stakes: [],
    positions: [{ value: "BTN", count: 2 }],
    potTypes: [],
    results: [],
    stacks: [],
    allIn: [],
    tags: [],
    noted: 0,
  };

  it("the web's row: a chip per set group, the order, the tools; no saved filters, no counts", () => {
    const html = render(
      "en",
      createElement(FilterBar, {
        filter: { ...EMPTY_FILTER, positions: ["BTN"], heroCards: "AKs", sort: "pot" },
        facets,
        onChange: () => undefined,
        groups: handGroups({ annotations: false, search: true, sorts: ["pot"], more: [] }),
        sorts: ["pot"],
      }),
    );
    expect(html).toContain("Order: Biggest pots first");
    expect(html).toContain("Position: BTN. Change");
    expect(html).toContain("Hero hand: AKs. Change");
    expect(html).toContain("Remove the position filter");
    expect(html).toContain("Add filter");
    expect(html).toContain("All filters");
    expect(html).toContain("Clear all");
    expect(html).toContain("Went to showdown");
    expect(html).not.toContain("Saved filters");
    expect(html).not.toContain("Tags");
    // A group that is not set is not in the row.
    expect(html).not.toContain("Room");
  });

  it("a range on the grid says its share of hands", () => {
    const range = ["AA", "KK", "QQ", "AKs"];
    const html = render(
      "en",
      createElement(FilterBar, {
        filter: { ...EMPTY_FILTER, heroRange: range },
        facets,
        onChange: () => undefined,
        groups: handGroups({ annotations: false, search: true, sorts: [], more: [] }),
      }),
    );
    expect(html).toContain("Hero hand: Range · 1.7%. Change");
  });

  const MORE = ["tableName", "minPot", "showdownPositions", "winnerPositions", "anonymization"] as const;
  const withNames: HandFacets = {
    ...facets,
    anonymizations: [
      { value: "none", count: 1 },
      { value: "positional", count: 1 },
    ],
  };

  for (const [locale, words] of [
    [
      "en",
      {
        table: "Table name",
        pot: "Minimum pot",
        sd: "Showdown positions",
        win: "Winning positions",
        names: "Names",
        seats: "Seat labels (Ignition)",
        change: "Change",
      },
    ],
    [
      "hr",
      {
        table: "Naziv stola",
        pot: "Najmanji pot",
        sd: "Pozicije na showdownu",
        win: "Pozicije koje su dobile",
        names: "Imena",
        seats: "Oznake mjesta (Ignition)",
        change: "Promijeni",
      },
    ],
  ] as const) {
    it(`the web's other filters as chips, ${locale}: table, pot, positions, names`, () => {
      const html = render(
        locale,
        createElement(FilterBar, {
          filter: {
            ...EMPTY_FILTER,
            tableName: "Zeta",
            minPot: "25",
            showdownPositions: ["BB"],
            winnerPositions: ["CO", "BTN"],
            anonymizations: ["positional"],
          },
          facets: withNames,
          onChange: () => undefined,
          groups: handGroups({ annotations: false, search: true, sorts: [], more: [...MORE] }),
        }),
      );
      expect(html).toContain(`${words.table}: Zeta. ${words.change}`);
      expect(html).toContain(`${words.pot}: ≥ 25. ${words.change}`);
      expect(html).toContain(`${words.sd}: BB. ${words.change}`);
      // In table order, whatever order they were picked in.
      expect(html).toContain(`${words.win}: CO, BTN. ${words.change}`);
      expect(html).toContain(`${words.names}: ${words.seats}. ${words.change}`);
    });
  }

  it("the desktop's row has none of them, and its quick filters", () => {
    const html = render(
      "en",
      createElement(FilterBar, {
        filter: EMPTY_FILTER,
        facets,
        onChange: () => undefined,
        groups: handGroups({ annotations: true, search: false, sorts: [], more: [] }),
      }),
    );
    for (const word of ["Showdown positions", "Winning positions", "Names", "Hero hand", "Went to showdown"]) {
      expect(html).not.toContain(word);
    }
    for (const word of ["3-bet pots", "All-in", "With a note", "Last 7 days"]) {
      expect(html).toContain(word);
    }
  });

  it("the desktop's row in Croatian, with saved filters", () => {
    const html = render(
      "hr",
      createElement(FilterBar, {
        filter: EMPTY_FILTER,
        facets,
        onChange: () => undefined,
        saved: { list: async () => [], save: async () => [], remove: async () => [] },
      }),
    );
    expect(html).toContain("Spremljeni filteri");
    expect(html).toContain("Dodaj filtar");
    expect(html).toContain("Svi filteri");
    expect(html).toContain("S bilješkom");
    expect(html).not.toContain("Redoslijed");
    expect(html).not.toContain("Očisti sve");
    expect(html).not.toContain("Spremi kao");
  });

  it("Reports' row: its groups only, the date's quick filter", () => {
    const html = render(
      "en",
      createElement(FilterBar, {
        filter: { ...EMPTY_FILTER, stakes: ["USD:200"] },
        facets: {
          ...facets,
          stakes: [{ value: "USD:200", count: 2, currency: "USD", currencySymbol: "$", minorUnits: 100, smallBlind: 100, bigBlind: 200 }],
        },
        onChange: () => undefined,
        groups: REPORT_GROUPS,
        screen: "reports",
      }),
    );
    expect(html).toContain("Stakes: $1/$2. Change");
    expect(html).toContain("Last 7 days");
    expect(html).not.toContain("3-bet pots");
  });
});
