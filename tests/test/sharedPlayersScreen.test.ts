/**
 * The shared Players screen (`packages/ui/players/`, R4.5c): one screen, two
 * data sources - the desktop app's local store and the web's opponent
 * summaries.
 *
 * - The web's source (`web/src/lib/db/playersSource.ts`) against a faked
 *   `rpc`: what it asks `players_list`, `player_profile` and `player_sites`
 *   for, and what it hands the screen - an opponent's statistics as
 *   `showStat` of the shipped definitions over the server's sums with the
 *   desktop's rule (the hero-only all-in EV and money withheld), rows and
 *   rooms named, a stake's symbol; no colours and no labels (declared, and
 *   refused if asked); a note saved with the tags it already had.
 * - "Hands with this player" on the web: the opponent parked for the
 *   library (`library/playerHandoff.ts`), once, never in the address.
 * - The screen's first render, the list and a profile rendered to markup
 *   (React from the web's install), on a source that keeps colours and
 *   labels (the app's) and one that does not (the web's), in English and
 *   Croatian.
 *
 * The screen's behaviour in a browser (selecting, typing a note, a phone's
 * layout) is checked by hand and by `packages/ui/screens/responsive.mjs`:
 * `docs/RAIL-PLAN.md` R4.5c.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import { ProfileBody } from "@rail/ui/players/PlayerProfile";
import { PlayersScreen } from "@rail/ui/players/PlayersScreen";
import { PlayerTable } from "@rail/ui/players/PlayerTable";
import type { PlayerProfile, PlayerRow, PlayersSource } from "@rail/ui/players/model";
import { BREAKDOWN_COLUMNS, type StatGroup } from "@rail/ui/reports/model";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { playersUiEn } from "@rail/ui/strings/players.en";
import { playersUiHr } from "@rail/ui/strings/players.hr";
import { reportsUiEn } from "@rail/ui/strings/reports.en";
import { reportsUiHr } from "@rail/ui/strings/reports.hr";
import { statsUiEn } from "@rail/ui/strings/stats.en";
import { statsUiHr } from "@rail/ui/strings/stats.hr";

import { parkPlayerFilter, takePlayerFilter } from "../../web/src/components/library/playerHandoff.js";
import { webPlayersSource } from "../../web/src/lib/db/playersSource.js";
import { WEB_DEFINITIONS } from "../../web/src/lib/db/reportSource.js";
import { STANDARD_STATS, emptyCounters, emptyMoney, showStat } from "../../web/src/lib/stats/index.js";

const rpc = vi.fn();
vi.mock("../../web/src/lib/db/client.js", () => ({ rpc: (...args: unknown[]) => rpc(...args) }));

function strings(locale: "en" | "hr"): UiStrings {
  // Only what the list, the profile and the screen's first render read.
  const stats = locale === "en" ? statsUiEn : statsUiHr;
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    closeNamed: (what: string) => what,
    hands: locale === "en" ? handsUiEn : handsUiHr,
    reports: locale === "en" ? reportsUiEn : reportsUiHr,
    players: locale === "en" ? playersUiEn : playersUiHr,
    statTile: stats.tile,
    statTable: { ...stats.table, sampleOnly: stats.sampleOnly },
  } as unknown as UiStrings;
}

function render(locale: "en" | "hr", node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node));
}

const LIST = {
  statsVersion: "stats/2",
  rows: [
    {
      site: "pokerstars",
      player: "villain_one",
      hands: 120,
      netBbMilli: -15500,
      moneyHands: 118,
      firstPlayedAt: "2026-09-01T10:00:00+00:00",
      lastPlayedAt: "2026-10-01T10:00:00+00:00",
      hasNote: true,
    },
    { site: "winamax", player: "villain_two", hands: 40, netBbMilli: null, moneyHands: 40, firstPlayedAt: null, lastPlayedAt: null, hasNote: false },
  ],
  matching: 2,
  players: 9,
  cashHands: 300,
  chipsHands: 0,
  mixedKind: false,
  hiddenHands: 77,
};

/** A group's sums as `player_profile` sends them. */
function sums(key: string, hands: number): Record<string, unknown> {
  return { key, hands, money_hands: hands, vpip_opp: hands, vpip: Math.round(hands * 0.4), pfr_opp: hands, pfr: Math.round(hands * 0.1), net_bb_milli: -3000 };
}

const PROFILE = {
  statsVersion: "stats/2",
  site: "pokerstars",
  player: "villain_one",
  seen: {
    hands: 150,
    firstPlayedAt: "2026-09-01T10:00:00+00:00",
    lastPlayedAt: "2026-10-01T10:00:00+00:00",
    cash: { hands: 120, moneyHands: 118, netBbMilli: -15500 },
    chips: { hands: 0, moneyHands: 0, netBbMilli: 0 },
  },
  notes: { note: "Calls too much.", tags: ["station"] },
  mixedKind: false,
  total: { hands: 120, money_hands: 118, vpip_opp: 120, vpip: 48, pfr_opp: 120, pfr: 12, net_bb_milli: -3000 },
  groups: {
    position: [sums("BTN", 30), sums("", 2)],
    stake: [sums("USD:200", 120)],
    size: [sums("6max", 120)],
    format: [sums("cash", 120)],
  },
  stakes: [{ key: "USD:200", currency: "USD", minorUnits: 100, smallBlind: 100, bigBlind: 200 }],
  lastPlayedAt: "2026-10-01T10:00:00+00:00",
};

beforeEach(() => rpc.mockReset());

describe("the web's PlayersSource over the opponent summaries", () => {
  it("asks players_list for the query and the version; rows named, no colours or labels", async () => {
    rpc.mockResolvedValueOnce(LIST);
    const source = webPlayersSource("Standard format");
    const list = await source.list({ search: "vil", site: null, kind: "cash", noted: true, limit: 200, colours: ["red"], labels: ["fish"] });
    expect(rpc).toHaveBeenCalledWith("players_list", {
      p_query: { search: "vil", site: null, kind: "cash", noted: true, limit: 200, statsVersion: "stats/2" },
    });
    expect(source.features).toEqual({ colours: false, labels: false });
    expect(list.rows[0]).toMatchObject({ siteName: "PokerStars", player: "villain_one", hands: 120, netBbMilli: -15500, colour: null, labels: [], hasNote: true });
    expect(list.rows[1]?.netBbMilli).toBeNull();
    expect(list).toMatchObject({ matching: 2, players: 9, hiddenHands: 77, mixedKind: false });
  });

  it("a profile: every statistic showStat over their sums, the hero's own and money withheld", async () => {
    rpc.mockResolvedValueOnce(PROFILE);
    const profile = await webPlayersSource("Standard format").profile("pokerstars", "villain_one", "cash");
    expect(rpc).toHaveBeenCalledWith("player_profile", {
      p_site: "pokerstars",
      p_player: "villain_one",
      p_kind: "cash",
      p_stats_version: "stats/2",
    });
    expect(profile.stats).toHaveLength(STANDARD_STATS.length);
    const counters = { ...emptyCounters(), hands: 120, vpip_opp: 120, vpip: 48, pfr_opp: 120, pfr: 12 };
    const money = { ...emptyMoney(), won: Number.NaN, contributed: Number.NaN, net: Number.NaN, rake_paid: Number.NaN, out_of_pot: Number.NaN, cashout_risk: Number.NaN, net_bb_milli: -3000 };
    STANDARD_STATS.forEach((stat, index) => {
      const shown = profile.stats[index];
      if (stat.def.players === "hero" || stat.def.format.unit === "money") {
        expect(shown?.value, stat.def.id).toBeNull();
      } else {
        expect(shown, stat.def.id).toEqual(showStat(stat, { counters, money, moneyHands: 118, evNetBbMilli: null }, null));
      }
    });
    const byId = (id: string) => profile.stats[STANDARD_STATS.findIndex((stat) => stat.def.id === id)];
    expect(byId("vpip")?.value).toBeCloseTo(40);
    expect(byId("allin_ev_bb_per_100")?.value).toBeNull();
    expect(byId("rake_per_100")?.value).toBeNull();
    expect(byId("bb_per_100")?.value).not.toBeNull();
    expect(profile.columns).toEqual([...BREAKDOWN_COLUMNS]);
    expect(profile.byPosition.map((row) => row.key)).toEqual(["BTN", ""]);
    expect(profile.stakes[0]).toMatchObject({ key: "USD:200", currencySymbol: "$", bigBlind: 200 });
    expect(profile.notes).toEqual({ colour: null, note: "Calls too much.", labels: [] });
    expect(profile.seen?.cash.netBbMilli).toBe(-15500);
  });

  it("a name that is no opponent has no profile", async () => {
    rpc.mockResolvedValueOnce({ ...PROFILE, seen: null, total: {}, groups: {}, stakes: [], notes: { note: "", tags: [] } });
    const profile = await webPlayersSource("Standard format").profile("pokerstars", "nobody", "all");
    expect(profile.seen).toBeNull();
    expect(profile.byPosition).toEqual([]);
  });

  it("a note is saved with the tags it had (written in the opponents panel)", async () => {
    const source = webPlayersSource("Standard format");
    rpc.mockResolvedValueOnce(PROFILE);
    await source.profile("pokerstars", "villain_one", "all");
    rpc.mockResolvedValueOnce({ site: "pokerstars", player: "villain_one", note: "Folds to 3-bets.", tags: ["station"] });
    const saved = await source.setNote("pokerstars", "villain_one", "Folds to 3-bets.");
    expect(rpc).toHaveBeenLastCalledWith("set_player_note", {
      p_site: "pokerstars",
      p_player: "villain_one",
      p_note: "Folds to 3-bets.",
      p_tags: ["station"],
    });
    expect(saved).toEqual({ colour: null, note: "Folds to 3-bets.", labels: [] });
    // Cleared: the row goes (`set_player_note` answers null).
    rpc.mockResolvedValueOnce(null);
    expect((await source.setNote("winamax", "villain_two", "")).note).toBe("");
    expect(rpc).toHaveBeenLastCalledWith("set_player_note", { p_site: "winamax", p_player: "villain_two", p_note: "", p_tags: [] });
  });

  it("rooms by name; no labels; colours and labels refused", async () => {
    rpc.mockResolvedValueOnce(["winamax", "pokerstars"]);
    const source = webPlayersSource("Standard format");
    expect(await source.sites()).toEqual([
      { value: "pokerstars", name: "PokerStars" },
      { value: "winamax", name: "Winamax" },
    ]);
    expect(await source.labels()).toEqual([]);
    await expect(source.setColour("pokerstars", "villain_one", "red")).rejects.toThrow();
    await expect(source.addLabel("pokerstars", "villain_one", "fish")).rejects.toThrow();
  });
});

describe("hands with this player, on the web", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parks the opponent for the library, which opens on their room and name, once", () => {
    expect(parkPlayerFilter({ site: "pokerstars", player: "villain_one" })).toBe(true);
    const filter = takePlayerFilter();
    expect(filter?.sites).toEqual(["pokerstars"]);
    expect(filter?.playerName).toBe("villain_one");
    expect(filter?.player).toBeNull();
    expect(takePlayerFilter()).toBeNull();
  });

  it("an old hand-off is ignored", () => {
    store.set("rail.library.playerFilter", JSON.stringify({ site: "pokerstars", player: "x", at: "2026-01-01T00:00:00Z" }));
    expect(takePlayerFilter()).toBeNull();
  });
});

const APP_FEATURES = { colours: true, labels: true };
const WEB_FEATURES = { colours: false, labels: false };

function fakeSource(features: { colours: boolean; labels: boolean }): PlayersSource {
  const never = () => new Promise<never>(() => undefined);
  return {
    features,
    list: never,
    profile: never,
    sites: never,
    labels: never,
    setNote: never,
    setColour: never,
    addLabel: never,
    removeLabel: never,
  };
}

function group(key: string, hands: number): StatGroup {
  const shown = showStat(STANDARD_STATS[0]!, { counters: { ...emptyCounters(), hands }, money: emptyMoney(), moneyHands: hands, evNetBbMilli: null });
  return { key, label: null, hands, moneyHands: hands, net: null, netBbMilli: 1000, stats: BREAKDOWN_COLUMNS.map(() => shown) };
}

const APP_PROFILE: PlayerProfile = {
  site: "pokerstars",
  siteName: "PokerStars",
  player: "villain_one",
  seen: {
    hands: 150,
    firstPlayedAt: "2026-09-01T10:00:00Z",
    lastPlayedAt: "2026-10-01T10:00:00Z",
    cash: { hands: 120, moneyHands: 118, netBbMilli: -15500 },
    chips: { hands: 6, moneyHands: 6, netBbMilli: 2000 },
  },
  notes: { colour: "red", note: "Calls too much.", labels: ["station"] },
  mixedKind: false,
  stats: STANDARD_STATS.map((stat) => showStat(stat, { counters: { ...emptyCounters(), hands: 120, vpip_opp: 120, vpip: 48 }, money: emptyMoney(), moneyHands: 120, evNetBbMilli: null })),
  columns: [...BREAKDOWN_COLUMNS],
  byPosition: [group("BTN", 30), group("", 2)],
  byStake: [group("USD:200", 120)],
  bySize: [group("6max", 120)],
  byFormat: [group("cash", 120)],
  stakes: [{ key: "USD:200", currency: "USD", currencySymbol: "$", minorUnits: 100, smallBlind: 100, bigBlind: 200 }],
  lastPlayedAt: null,
};

const ROWS: PlayerRow[] = [
  {
    site: "pokerstars",
    siteName: "PokerStars",
    player: "villain_one",
    hands: 120,
    netBbMilli: -15500,
    moneyHands: 118,
    firstPlayedAt: null,
    lastPlayedAt: "2026-10-01T10:00:00Z",
    colour: "red",
    labels: ["station"],
    hasNote: true,
  },
];

describe("the screen, rendered", () => {
  for (const locale of ["en", "hr"] as const) {
    const p = locale === "en" ? playersUiEn : playersUiHr;
    for (const [name, features] of [["the app's", APP_FEATURES], ["the web's", WEB_FEATURES]] as const) {
      it(`first render on ${name} source, ${locale}: the title, the filters it keeps, the loading state`, () => {
        const html = render(
          locale,
          createElement(PlayersScreen, {
            source: fakeSource(features),
            definitions: WEB_DEFINITIONS,
            selected: null,
            onSelect: () => undefined,
            onHandsWith: () => undefined,
            title: "Players",
            emptyText: "No opponents",
            notesFootnote: null,
            renderState: (kind: string, text: string) => createElement("p", { "data-state": kind }, text),
          }),
        );
        expect(html).toContain(">Players<");
        expect(html).toContain(`data-state="loading"`);
        expect(html).toContain(p.loading);
        expect(html).toContain(p.searchPlaceholder);
        expect(html).toContain(p.kinds.cash);
        expect(html).toContain(p.anyRoom);
        expect(html).toContain(p.noted);
        expect(html.includes(`aria-label="${p.colourFilter}"`)).toBe(features.colours);
      });

      it(`a profile on ${name} source, ${locale}: the facts, the words it keeps, the statistics, the breakdown`, () => {
        const html = render(
          locale,
          createElement(ProfileBody, {
            source: fakeSource(features),
            profile: APP_PROFILE,
            definitions: WEB_DEFINITIONS,
            notesFootnote: "Where the words are kept.",
            onHandsWith: () => undefined,
            onNotes: () => undefined,
          }),
        );
        const t = p.profile;
        expect(html).toContain(t.together);
        expect(html).toContain(t.resultCash);
        expect(html).toContain(t.resultChips);
        expect(html).toContain(t.handsWith(126));
        expect(html).toContain("Calls too much.");
        expect(html).toContain("Where the words are kept.");
        expect(html.includes(`role="radiogroup"`)).toBe(features.colours);
        expect(html.includes(t.addLabel)).toBe(features.labels);
        expect(html).toContain(t.stats);
        expect(html).toContain((locale === "en" ? reportsUiEn : reportsUiHr).stats.groups.preflop);
        for (const tab of Object.values(t.tabs)) expect(html).toContain(tab);
        expect(html).toContain(t.noPosition);
        // All-in EV is the hero's: not in an opponent's statistics.
        const allIn = STANDARD_STATS.find((stat) => stat.def.id === "allin_ev_bb_per_100")!.def;
        expect(html).not.toContain(`>${allIn.name[locale]}<`);
        const vpip = STANDARD_STATS.find((stat) => stat.def.id === "vpip")!.def;
        expect(html).toContain(`>${vpip.name[locale]}<`);
      });

      it(`the list on ${name} source, ${locale}: names, a note's mark, colours only where kept`, () => {
        const html = render(
          locale,
          createElement(PlayerTable, {
            rows: ROWS,
            selected: { site: "pokerstars", player: "villain_one" },
            showColours: features.colours,
            onSelect: () => undefined,
            onOpen: () => undefined,
            more: false,
            onMore: () => undefined,
          }),
        );
        expect(html).toContain("villain_one");
        expect(html).toContain(p.columns.hands);
        expect(html).toContain(`aria-label="${p.hasNote}"`);
        expect(html).toContain(`aria-selected="true"`);
        expect(html.includes(`aria-label="${p.colourOf(p.colours.red)}"`)).toBe(features.colours);
      });
    }
  }
});
