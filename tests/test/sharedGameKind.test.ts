/**
 * Cash or tournaments (`packages/ui/hands/gameKind.ts`): the Hands and
 * Reports screens always show one kind, so chips and cash never meet in one
 * result or graph.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EMPTY_FILTER } from "@rail/ui/hands/filter";
import { hasBothKinds, kindCounts, kindOf, pinKind, withKind } from "@rail/ui/hands/gameKind";
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
