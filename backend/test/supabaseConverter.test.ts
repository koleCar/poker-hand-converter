import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { convertWeplayFile } from "../../supabase/functions/_shared/converter.ts";

function loadFixture(relativePath: string): string {
  const filePath = resolve(process.cwd(), relativePath);
  return readFileSync(filePath, "utf8");
}

describe("supabase converter integration", () => {
  it("extracts known cards players from dealt and shown lines", () => {
    const input = loadFixture("test/fixtures/weplay/cash-sample.txt");
    const converted = convertWeplayFile("cash-sample.txt", input);
    const knownPlayers = new Set(converted.hands.flatMap((hand) => hand.knownCards.map((entry) => entry.playerName)));
    expect(knownPlayers.has("kole1992")).toBe(true);
  });

  it("normalizes showdown token and removes utc from header", () => {
    const input = loadFixture("test/fixtures/weplay/tournament-sample.txt");
    const converted = convertWeplayFile("tournament-sample.txt", input);
    expect(converted.ggText).toContain("*** SHOWDOWN ***");
    expect(converted.ggText).not.toContain("*** SHOW DOWN ***");
    expect(converted.ggText).not.toContain("UTC");
  });

  it("rewrites SB open from WePlay chips-added to GG raise-over", () => {
    const input = loadFixture("test/fixtures/weplay/raise-sb-open.txt");
    const converted = convertWeplayFile("raise-sb-open.txt", input);
    expect(converted.ggText).toContain("antananarivo: raises $2 to $3");
    expect(converted.ggText).not.toContain("raises $2.50 to $3");
  });

  it("rewrites button open to raise-over current bet", () => {
    const input = loadFixture("test/fixtures/weplay/raise-button-open.txt");
    const converted = convertWeplayFile("raise-button-open.txt", input);
    expect(converted.ggText).toContain("antananarivo: raises $1.50 to $2.50");
    expect(converted.ggText).not.toContain("raises $2.50 to $2.50");
  });

  it("rewrites 3-bet chain with correct over amounts", () => {
    const input = loadFixture("test/fixtures/weplay/raise-3bet.txt");
    const converted = convertWeplayFile("raise-3bet.txt", input);
    expect(converted.ggText).toContain("Tone91: raises $1.50 to $2.50");
    expect(converted.ggText).toContain("kole1992: raises $9.51 to $12.01");
    expect(converted.ggText).not.toContain("raises $2.50 to $2.50");
    expect(converted.ggText).not.toContain("raises $11.01 to $12.01");
  });

  it("skips Bomb Pot ante hands without blinds", () => {
    const input = loadFixture("test/fixtures/weplay/bomb-pot-ante.txt");
    const converted = convertWeplayFile("bomb-pot-ante.txt", input);
    expect(converted.handCount).toBe(0);
    expect(converted.ggText).toBe("");
    expect(converted.warnings.some((warning) => warning.includes("Bomb Pot"))).toBe(true);
  });

  it("skips Omaha hands", () => {
    const input = loadFixture("test/fixtures/weplay/omaha-6card.txt");
    const converted = convertWeplayFile("omaha-6card.txt", input);
    expect(converted.handCount).toBe(0);
    expect(converted.ggText).toBe("");
    expect(converted.ggText).not.toContain("Omaha");
    expect(converted.warnings.some((warning) => /Omaha/i.test(warning))).toBe(true);
  });

  it("rewrites hidden ## showdown cards to doesn't show hand", () => {
    const input = loadFixture("test/fixtures/weplay/hidden-showdown-cards.txt");
    const converted = convertWeplayFile("hidden-showdown-cards.txt", input);
    expect(converted.ggText).toContain("KratkiLucky: doesn't show hand");
    expect(converted.ggText).not.toContain("##");
    expect(converted.ggText).toContain("Tone91: raises $4.50 to $5.75");
    expect(converted.ggText).toContain("KratkiLucky: raises $0.75 to $1.25");
  });

  it("skips BB-only walks without a small blind", () => {
    const input = loadFixture("test/fixtures/weplay/bb-only-walk.txt");
    const converted = convertWeplayFile("bb-only-walk.txt", input);
    expect(converted.handCount).toBe(0);
    expect(converted.warnings.some((warning) => /BB-only/i.test(warning))).toBe(true);
  });

  it("scrubs ## from SUMMARY showed lines", () => {
    const input = loadFixture("test/fixtures/weplay/summary-hidden-cards.txt");
    const converted = convertWeplayFile("summary-hidden-cards.txt", input);
    expect(converted.handCount).toBe(1);
    expect(converted.ggText).not.toContain("##");
    expect(converted.ggText).toContain("LukasFlopovski (button) folded before Flop");
    expect(converted.ggText).not.toMatch(/folded before Flop showed/);
    expect(converted.ggText).toContain("petit_blaireau (small blind) showed [Jd Tc]");  });

  it("strips phantom river boards on preflop walks", () => {
    const input = loadFixture("test/fixtures/weplay/phantom-river-walk.txt");
    const converted = convertWeplayFile("phantom-river-walk.txt", input);
    expect(converted.handCount).toBe(1);
    expect(converted.ggText).not.toContain("*** RIVER ***");
    expect(converted.ggText).not.toContain("Board [");
    expect(converted.ggText).toContain("petike21 collected $2 from pot");
  });

  it("skips hands where a $0 stack player acts", () => {
    const input = loadFixture("test/fixtures/weplay/zero-stack-actor.txt");
    const converted = convertWeplayFile("zero-stack-actor.txt", input);
    expect(converted.handCount).toBe(0);
    expect(converted.warnings.some((warning) => /zero-stack/i.test(warning))).toBe(true);
  });

  it("rewrites short covering all-in raise below current bet to call", () => {
    const input = loadFixture("test/fixtures/weplay/short-allin-raise-cover.txt");
    const converted = convertWeplayFile("short-allin-raise-cover.txt", input);
    expect(converted.handCount).toBe(1);
    expect(converted.ggText).toContain("kole1992: calls $7.40 and is all-in");
    expect(converted.ggText).not.toContain("raises $7.40 to $7.90");
  });

  it("skips ghost ante from unseated players", () => {
    const input = loadFixture("test/fixtures/weplay/ghost-ante.txt");
    const converted = convertWeplayFile("ghost-ante.txt", input);
    expect(converted.handCount).toBe(0);
    expect(converted.warnings.some((warning) => /ghost ante/i.test(warning))).toBe(true);
  });

  it("skips short all-in small blind posts", () => {
    const input = loadFixture("test/fixtures/weplay/short-sb-allin.txt");
    const converted = convertWeplayFile("short-sb-allin.txt", input);
    expect(converted.handCount).toBe(0);
    expect(converted.warnings.some((warning) => /short all-in small blind/i.test(warning))).toBe(
      true,
    );
  });
});
