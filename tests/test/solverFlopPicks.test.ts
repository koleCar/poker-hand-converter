/**
 * The flop picker's list (`flopsForPicks`, Solver library): picked cards keep
 * the solved flops that hold their ranks, suits aside, and spell each in
 * suits that show the picked cards as picked; the spelling is the same solve
 * (its canonical key does not change).
 */

import { describe, expect, it } from "vitest";

import { flopsForPicks, pickedFlop } from "../../web/src/lib/solver/index.js";

const SOLVED = ["AsKs4h", "AsJh6d", "KsJs7h", "JhJs5s", "Js9h3d", "8s7h2d", "Ks6h3d"];

describe("flopsForPicks", () => {
  it("lists every flop as filed with no picks", () => {
    expect(flopsForPicks(SOLVED, []).map((f) => f.cards.join(""))).toEqual(SOLVED);
  });

  it("keeps the flops with the picked rank, shown in the picked suit", () => {
    const listed = flopsForPicks(SOLVED, ["Jd"]);
    expect(listed.map((f) => f.key)).toEqual(["AsJh6d", "KsJs7h", "JhJs5s", "Js9h3d"]);
    for (const flop of listed) expect(flop.cards).toContain("Jd");
  });

  it("needs both cards of a picked pair", () => {
    expect(flopsForPicks(SOLVED, ["Jd", "Jc"]).map((f) => f.key)).toEqual(["JhJs5s"]);
    expect(flopsForPicks(SOLVED, ["Jd", "Jc"])[0].cards).toEqual(expect.arrayContaining(["Jd", "Jc"]));
  });

  it("shows a rainbow flop in the picked suits", () => {
    const [flop] = flopsForPicks(SOLVED, ["As", "Js", "6c"]);
    expect(flop.key).toBe("AsJh6d");
    // A♠J♠6♣ is two-tone, the solve is rainbow: two of the three picks show.
    expect(flop.cards.filter((c) => ["As", "Js", "6c"].includes(c))).toHaveLength(2);
    expect(flopsForPicks(SOLVED, ["Ad", "Jc", "6h"])[0].cards.sort()).toEqual(["6h", "Ad", "Jc"]);
  });

  it("spells the same solve", () => {
    for (const picks of [["Jd"], ["Kh", "7d"], ["8c", "2c"], ["3h"]]) {
      for (const flop of flopsForPicks(SOLVED, picks)) expect(pickedFlop(flop.cards).key).toBe(flop.key);
    }
  });
});
