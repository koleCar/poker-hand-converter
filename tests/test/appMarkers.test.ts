/**
 * The hand lists' "Mark" menu (`app/src/components/markers.ts`): the presets
 * first, the user's own markers after them, one marker whatever its case,
 * and a typed marker kept the way the store keeps tags.
 */
import { describe, expect, it } from "vitest";

import { offeredMarkers, PRESET_MARKERS, REVIEW, sameMarker, typedMarker } from "../../app/src/components/markers.js";

describe("hand markers", () => {
  it("lists the presets first, Review on top, then the tags in use in their order", () => {
    expect(PRESET_MARKERS[0]).toBe(REVIEW);
    expect(offeredMarkers(["river spot", "Cooler", "3bet pot"], "")).toEqual([...PRESET_MARKERS, "river spot", "3bet pot"]);
  });

  it("does not list a tag twice when it is a preset in another case", () => {
    expect(offeredMarkers(["review", "HERO CALL"], "")).toEqual([...PRESET_MARKERS]);
  });

  it("narrows to the markers containing what was typed, ignoring case", () => {
    expect(offeredMarkers(["Overbet bluff", "river spot"], "BLUFF")).toEqual(["Bluff", "Overbet bluff"]);
    expect(offeredMarkers([], "   ")).toEqual([...PRESET_MARKERS]);
  });

  it("keeps a typed marker as the store keeps tags", () => {
    expect(typedMarker("  Overbet \t  bluff ")).toBe("Overbet bluff");
    expect(typedMarker("   ")).toBe("");
    expect(sameMarker("Review", "rEVIEW")).toBe(true);
    expect(sameMarker("Review", "Reviewed")).toBe(false);
  });
});
