/**
 * Several hands chosen in a hand list (`packages/ui/hands/useHandSelection`,
 * the desktop's Hands and Live lists): the choosing rules as a file list has
 * them, and the list's markup with hands chosen.
 *
 * Clicking, the right-click menu and the replayer window's list of hands
 * are checked in the app by hand.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HandList } from "@rail/ui/hands/HandList";
import type { HandRow } from "@rail/ui/hands/model";
import {
  NO_HANDS,
  chooseAll,
  chooseOnly,
  chooseRun,
  chooseToggle,
  chosenIn,
  menuHands,
  type HandSelection,
} from "@rail/ui/hands/useHandSelection";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";

const ORDER = ["a", "b", "c", "d", "e"];

describe("choosing hands", () => {
  it("a click chooses one; Cmd/Ctrl + click adds and takes out", () => {
    let state = chooseOnly("b");
    expect([...state.checked]).toEqual(["b"]);
    state = chooseToggle(state, "d");
    expect([...state.checked].sort()).toEqual(["b", "d"]);
    state = chooseToggle(state, "b");
    expect([...state.checked]).toEqual(["d"]);
    expect(state.anchor).toBe("b");
  });

  it("Shift + click takes the run from the anchor, either way, and keeps the anchor", () => {
    let state = chooseOnly("b");
    state = chooseRun(state, ORDER, "d", false);
    expect([...state.checked]).toEqual(["b", "c", "d"]);
    state = chooseRun(state, ORDER, "a", false);
    expect([...state.checked]).toEqual(["a", "b"]);
    expect(state.anchor).toBe("b");
  });

  it("Cmd/Ctrl + Shift + click adds the run to what is chosen", () => {
    let state = chooseToggle(chooseOnly("a"), "d");
    state = chooseRun(state, ORDER, "e", true);
    expect([...state.checked].sort()).toEqual(["a", "d", "e"]);
  });

  it("Shift + click with nothing chosen yet chooses that hand", () => {
    expect([...chooseRun(NO_HANDS, ORDER, "c", false).checked]).toEqual(["c"]);
  });

  it("Cmd/Ctrl + A takes every loaded hand", () => {
    expect(chooseAll(NO_HANDS, ORDER).checked.size).toBe(5);
  });

  it("a right click acts on every chosen hand in the list's order, or on the one clicked", () => {
    const state = chooseToggle(chooseToggle(chooseOnly("d"), "a"), "c");
    expect(menuHands(state, ORDER, "c")).toEqual(["a", "c", "d"]);
    expect(menuHands(state, ORDER, "b")).toBeNull();
  });

  it("hands gone from the list (another filter) are let go; more pages keep them", () => {
    const state = chooseRun(chooseOnly("b"), ORDER, "d", false);
    expect(chosenIn(state, [...ORDER, "f", "g"])).toBe(state);
    const filtered = chosenIn(state, ["c", "x"]);
    expect([...filtered.checked]).toEqual(["c"]);
    expect(filtered.anchor).toBeNull();
  });
});

describe("the list with hands chosen", () => {
  const row = (handKey: string): HandRow =>
    ({
      handKey,
      site: "pokerstars",
      siteName: "PokerStars",
      siteHandId: handKey,
      playedAt: "2026-10-14T12:00:00.000Z",
      gameFormat: "cash",
      currency: "USD",
      currencySymbol: "$",
      smallBlind: 50,
      bigBlind: 100,
      totalPot: 1000,
      heroPosition: "BTN",
      heroCards: ["As", "Kd"],
      board: [],
      heroNet: 100,
      heroNetBbMilli: 1000,
      allIn: false,
      evNet: null,
      evNetBbMilli: null,
      evPending: false,
      hasNote: false,
      tags: [],
      positionalNames: false,
    }) as unknown as HandRow;

  const selection = (keys: string[]): HandSelection => ({
    checked: new Set(keys),
    size: keys.length,
    only: () => undefined,
    toggle: () => undefined,
    extendTo: () => undefined,
    all: () => undefined,
    clear: () => undefined,
    click: () => false,
    forMenu: () => keys,
  });

  const render = (locale: "en" | "hr", chosen: string[]) =>
    renderToStaticMarkup(
      createElement(
        UiStringsProvider,
        {
          strings: {
            intlLocale: locale === "en" ? "en-GB" : "hr-HR",
            hands: locale === "en" ? handsUiEn : handsUiHr,
            replayer: locale === "en" ? replayerEn : replayerHr,
          } as unknown as UiStrings,
        },
        createElement(HandList, {
          rows: ["h1", "h2", "h3"].map(row),
          hasMore: false,
          loadingMore: false,
          total: 3,
          selected: "h1",
          onSelect: () => undefined,
          onOpen: () => undefined,
          onLoadMore: () => undefined,
          orderLabel: "Newest first",
          selection: selection(chosen),
          onRowsMenu: () => undefined,
        }),
      ),
    );

  it("says it is multi-select and marks the chosen rows, not the open one", () => {
    const html = render("en", ["h2", "h3"]);
    expect(html).toContain('aria-multiselectable="true"');
    expect(html.match(/aria-selected="true"/g)?.length).toBe(2);
    expect(html).toMatch(/aria-selected="false"[^>]*data-key="h1"/);
  });

  it("with nothing chosen, the open hand is the selected row", () => {
    const html = render("en", []);
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-selected="true"[^>]*data-key="h1"/);
  });

  it("the count's words for several chosen hands, in both languages", () => {
    expect(handsUiEn.chosen(3)).toBe("3 selected");
    expect(handsUiHr.chosen(1)).toBe("1 odabrana");
    expect(handsUiHr.chosen(3)).toBe("3 odabrane");
    expect(handsUiHr.chosen(12)).toBe("12 odabranih");
  });
});
