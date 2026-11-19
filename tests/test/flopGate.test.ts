/**
 * The solver's flops a day on the web (the pricing round,
 * `web/src/lib/entitlements/flops.ts`): the flop key as the server writes
 * it, and `solver_open_flop`'s answer read field by field.
 */

import { describe, expect, it } from "vitest";

import { canonicalFlopKey, parseFlopOpen } from "../../web/src/lib/entitlements/flops.js";

describe("the flop key", () => {
  it("sorts by rank, high first, then suit s h d c", () => {
    expect(canonicalFlopKey("2c7dKs")).toBe("Ks7d2c");
    expect(canonicalFlopKey("Ks7d2c")).toBe("Ks7d2c");
    expect(canonicalFlopKey("AcAsAd")).toBe("AsAdAc");
    expect(canonicalFlopKey("Th9hTs")).toBe("TsTh9h");
  });

  it("is null for anything but three distinct cards", () => {
    for (const bad of ["", "Ks7d", "Ks7d2c3h", "KsKs2c", "Kx7d2c", "ks7d2c", " Ks7d2c"]) {
      expect(canonicalFlopKey(bad)).toBeNull();
    }
  });
});

describe("the server's answer", () => {
  it("reads every field; a refusal is only an explicit false", () => {
    expect(parseFlopOpen({ allowed: false, flop: "Ks7d2c", flops: ["Ks7d2c", "QhJh4s", "x"], cap: 3, resetsAt: "2026-11-20T00:00:00Z" })).toEqual({
      allowed: false,
      flops: ["Ks7d2c", "QhJh4s"],
      cap: 3,
      resetsAt: "2026-11-20T00:00:00Z",
    });
    expect(parseFlopOpen({ allowed: true, flops: [], cap: null }).allowed).toBe(true);
    expect(parseFlopOpen(null)).toEqual({ allowed: true, flops: [], cap: null, resetsAt: null });
  });
});
