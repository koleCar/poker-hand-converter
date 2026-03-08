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
});
