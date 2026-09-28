/**
 * The last surviving piece of the old Express backend: the legacy WePlay → GG
 * text converter (`parsers/weplayParser.ts` + `formatters/ggFormatter.ts`),
 * kept only because `test/weplayParser.test.ts` pins its byte-for-byte output
 * against the `test/fixtures/gg/` goldens. Nothing at runtime imports it — the
 * live converter is `frontend/src/lib/parsers/`.
 */

export type GameType = "cash" | "tournament";

export interface ParsedHand {
  handId: string;
  gameType: GameType;
  originalHeader: string;
  convertedHeader: string;
  lines: string[];
  warnings: string[];
}
