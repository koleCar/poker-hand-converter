/**
 * Cash or tournaments (`packages/ui/hands/gameKind.ts`): the Hands and
 * Reports screens always show one kind, so chips and cash never meet in one
 * result or graph.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EMPTY_FILTER } from "@rail/ui/hands/filter";
import {
  defaultKind,
  hasBothKinds,
  isKindFormats,
  isWholeKind,
  kindCounts,
  kindFormats,
  kindOf,
  pinFormats,
  pinKind,
  withFormats,
  withKind,
} from "@rail/ui/hands/gameKind";
import { KindSwitch } from "@rail/ui/hands/KindSwitch";
import { KindToggle } from "@rail/ui/hands/KindToggle";
import type { HandFacets } from "@rail/ui/hands/model";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";

const facets = (formats: Record<string, number>): HandFacets => ({
  total: Object.values(formats).reduce((a, b) => a + b, 0),
  sites: [],
  formats: Object.entries(formats).map(([value, count]) => ({ value, count })),
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
});

describe("the Game chip, kept to one kind", () => {
  const both = facets({ cash: 10, tournament: 5, sng: 3 });
  const chips = { ...EMPTY_FILTER, formats: ["tournament", "sng"] };

  it("a format of the other kind replaces the choice; never both kinds", () => {
    expect(withFormats(chips, ["tournament", "sng", "cash"], both).formats).toEqual(["cash"]);
    expect(withFormats({ ...EMPTY_FILTER, formats: ["cash"] }, ["cash", "spin"], both).formats).toEqual(["spin"]);
    expect(withFormats(chips, ["sng"], both).formats).toEqual(["sng"]);
  });

  it("Any is the whole of the kind shown", () => {
    expect(withFormats({ ...EMPTY_FILTER, formats: ["sng"] }, [], both).formats).toEqual(["tournament", "sng"]);
    expect(withFormats({ ...EMPTY_FILTER, formats: ["cash"] }, [], both).formats).toEqual(["cash"]);
    expect(withFormats(EMPTY_FILTER, [], both).formats).toEqual([]);
  });

  it("knows the toggle's whole kind from a narrowed one", () => {
    expect(isWholeKind(chips, both)).toBe(true);
    expect(isWholeKind({ ...EMPTY_FILTER, formats: ["sng"] }, both)).toBe(false);
    expect(isWholeKind({ ...EMPTY_FILTER, formats: ["cash"] }, both)).toBe(true);
    expect(isWholeKind(EMPTY_FILTER, both)).toBe(false);
  });
});

describe("game kind", () => {
  it("reads one kind from the chosen formats, none from both or nothing", () => {
    expect(kindOf(["cash"])).toBe("cash");
    expect(kindOf(["tournament", "spin"])).toBe("tournament");
    expect(kindOf(["cash", "sng"])).toBeNull();
    expect(kindOf([])).toBeNull();
  });

  it("counts chip formats together", () => {
    const both = facets({ cash: 10, tournament: 20, spin: 15, "": 3 });
    expect(kindCounts(both)).toEqual({ cash: 10, tournament: 35 });
    expect(hasBothKinds(both)).toBe(true);
    expect(hasBothKinds(facets({ tournament: 5, sng: 5, cash: 0 }))).toBe(false);
  });

  it("switches to a kind with the formats the hands have", () => {
    const both = facets({ cash: 10, tournament: 20, spin: 15, sng: 0 });
    expect(withKind({ ...EMPTY_FILTER, positions: ["BTN"] }, "tournament", both)).toMatchObject({
      formats: ["tournament", "spin"],
      positions: ["BTN"],
    });
    expect(withKind(EMPTY_FILTER, "cash", both).formats).toEqual(["cash"]);
  });

  it("opens a library with both on the kind with more hands, and says so", () => {
    const pinned = pinKind(EMPTY_FILTER, facets({ cash: 50, tournament: 20, spin: 15 }));
    expect(pinned).toEqual({ filter: { ...EMPTY_FILTER, formats: ["cash"] }, defaulted: "cash" });
    expect(pinKind(EMPTY_FILTER, facets({ cash: 30, tournament: 20, spin: 15 })).filter.formats).toEqual([
      "tournament",
      "spin",
    ]);
  });

  it("keeps a filter that picks one kind, or a library with one", () => {
    const both = facets({ cash: 50, tournament: 20 });
    const chips = { ...EMPTY_FILTER, formats: ["tournament"] };
    expect(pinKind(chips, both)).toEqual({ filter: chips, defaulted: null });
    expect(pinKind(EMPTY_FILTER, facets({ cash: 50 }))).toEqual({ filter: EMPTY_FILTER, defaulted: null });
    expect(pinKind(EMPTY_FILTER, null)).toEqual({ filter: EMPTY_FILTER, defaulted: null });
  });

  it("narrows formats chosen across both kinds to the bigger one among them", () => {
    const both = facets({ cash: 50, tournament: 20, spin: 40 });
    expect(pinKind({ ...EMPTY_FILTER, formats: ["cash", "tournament", "spin"] }, both)).toEqual({
      filter: { ...EMPTY_FILTER, formats: ["tournament", "spin"] },
      defaulted: "tournament",
    });
  });
});

describe("the Cash / Tournaments toggle, rendered", () => {
  const render = (locale: "en" | "hr", formats: string[], counts: HandFacets | null) =>
    renderToStaticMarkup(
      createElement(
        UiStringsProvider,
        { strings: { hands: locale === "en" ? handsUiEn : handsUiHr } as unknown as UiStrings },
        createElement(KindToggle, { filter: { ...EMPTY_FILTER, formats }, facets: counts, onChange: () => undefined }),
      ),
    );

  for (const locale of ["en", "hr"] as const) {
    it(`marks the kind shown, ${locale}`, () => {
      const t = (locale === "en" ? handsUiEn : handsUiHr).kinds;
      const html = render(locale, ["tournament"], facets({ cash: 10, tournament: 20 }));
      expect(html).toContain(`aria-label="${t.label}"`);
      expect(html).toContain(`aria-pressed="false"`);
      expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${t.tournament}<`));
    });
  }

  it("is not there for a library with one kind and none chosen, and greys out an empty kind once chosen", () => {
    expect(render("en", [], facets({ cash: 10 }))).toBe("");
    expect(render("en", [], null)).toBe("");
    expect(render("en", ["cash"], facets({ cash: 10 }))).toMatch(/disabled=""[^>]*>Tournaments</);
  });
});

describe("a screen's own kind (Analysis, Top leaks, Session review, Live)", () => {
  it("opens on the kind with more hands, cash on a tie", () => {
    expect(defaultKind({ cash: 10, tournament: 20 })).toBe("tournament");
    expect(defaultKind({ cash: 20, tournament: 10 })).toBe("cash");
    expect(defaultKind({ cash: 0, tournament: 0 })).toBe("cash");
  });

  it("names a kind's whole formats, and knows them", () => {
    expect(kindFormats("cash")).toEqual(["cash"]);
    expect(kindFormats("tournament")).toEqual(["tournament", "sng", "spin"]);
    expect(isKindFormats(["spin", "tournament", "sng"])).toBe(true);
    expect(isKindFormats(["sng"])).toBe(false);
    expect(isKindFormats(["cash", "sng"])).toBe(false);
    expect(isKindFormats(undefined)).toBe(false);
  });

  it("holds formats to a kind: a narrower choice within it stays, anything else is the kind's whole", () => {
    expect(pinFormats(["sng"], "tournament")).toEqual(["sng"]);
    expect(pinFormats(["cash", "sng"], "tournament")).toEqual(["tournament", "sng", "spin"]);
    expect(pinFormats(undefined, "cash")).toEqual(["cash"]);
    expect(pinFormats([], "tournament")).toEqual(["tournament", "sng", "spin"]);
  });

  const render = (kind: "cash" | "tournament" | null, counts: Record<"cash" | "tournament", number> | null) =>
    renderToStaticMarkup(
      createElement(
        UiStringsProvider,
        { strings: { hands: handsUiEn } as unknown as UiStrings },
        createElement(KindSwitch, { kind, counts, onChange: () => undefined }),
      ),
    );

  it("renders the switch: the kind shown pressed, an empty kind greyed out, nothing pressed while deciding", () => {
    expect(render("cash", { cash: 5, tournament: 0 })).toMatch(/aria-pressed="true"[^>]*>Cash</);
    expect(render("cash", { cash: 5, tournament: 0 })).toMatch(/disabled=""[^>]*>Tournaments</);
    expect(render(null, null)).not.toContain('aria-pressed="true"');
    expect(render("tournament", null)).not.toContain("disabled");
  });
});
