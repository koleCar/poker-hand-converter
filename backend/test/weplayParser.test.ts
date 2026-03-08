import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatHandsAsGg } from "../src/formatters/ggFormatter.js";
import { parseWeplayText } from "../src/parsers/weplayParser.js";

function loadFixture(relativePath: string): string {
  const filePath = resolve(process.cwd(), relativePath);
  return readFileSync(filePath, "utf8");
}

describe("weplayParser", () => {
  it("converts cash hand to expected GG output", () => {
    const input = loadFixture("test/fixtures/weplay/cash-sample.txt");
    const expected = loadFixture("test/fixtures/gg/cash-sample.gg.txt");

    const hands = parseWeplayText(input);
    const output = formatHandsAsGg(hands);

    expect(hands.length).toBe(1);
    expect(output.trim()).toBe(expected.trim());
  });

  it("converts tournament hand to expected GG output", () => {
    const input = loadFixture("test/fixtures/weplay/tournament-sample.txt");
    const expected = loadFixture("test/fixtures/gg/tournament-sample.gg.txt");

    const hands = parseWeplayText(input);
    const output = formatHandsAsGg(hands);

    expect(hands.length).toBe(1);
    expect(output.trim()).toBe(expected.trim());
  });
});
