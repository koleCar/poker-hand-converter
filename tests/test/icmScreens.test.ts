/**
 * R5.5c: a tournament push/fold grade on screen - the web's ICM panel in the
 * hand's analysis sheet (`components/analysis/IcmPanel.tsx`) and the app's
 * block in its hand analysis (`screens/analysis/IcmBlock.tsx`), in English
 * and Croatian, from grades the library gave scripted hands; and the leak
 * finder's words for the push/fold spots.
 */
import "./support/appWindow";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DictProvider } from "../../app/src/i18n/index";
import { HandAnalysisView } from "../../app/src/screens/analysis/HandAnalysis";
import { analyzeHand, type DecisionAnalysis, type HandAnalysis } from "../../web/src/lib/analysis/index";
import { parseStandardHand } from "../../web/src/lib/phf/serialize";
import type { PhfHand } from "../../web/src/lib/phf/types";
import { reviewUiEn } from "../../packages/ui/strings/review.en";
import { reviewUiHr } from "../../packages/ui/strings/review.hr";

const { I18nProvider } = await import("../../web/src/lib/i18n/client.js");
const { IcmPanel } = await import("../../web/src/components/analysis/IcmPanel.js");
const { leaksEn } = await import("../../web/src/lib/i18n/ns/analysisLeaks.en.js");
const { leaksHr } = await import("../../web/src/lib/i18n/ns/analysisLeaks.hr.js");

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function hand(name: string, seats: Array<[number, string, number]>, lines: string[]): PhfHand {
  const text = [
    `Poker Hand #IS1: Tournament (${name})#777, $5+$0.50 Hold'em No Limit - Level V (50/100) - 2026/02/10 17:01:27`,
    `Table '777 1' 9-max Seat #1 is the button`,
    ...seats.map(([seat, who, stack]) => `Seat ${seat}: ${who} (${stack} in chips)`),
    ...seats.map(([, who]) => `${who}: posts the ante 10`),
    `${seats[1][1]}: posts small blind 50`,
    `${seats[2][1]}: posts big blind 100`,
    "*** HOLE CARDS ***",
    "Dealt to Hero [Ah Td]",
    ...lines,
    "*** SUMMARY ***",
    "Total pot 190 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0",
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

const SEATS: Array<[number, string, number]> = [
  [1, "Hero", 1000],
  [2, "Sb", 1500],
  [3, "Bb", 1200],
  [9, "Co", 800],
];
const PUSH = ["Co: folds", "Hero: raises 890 to 990 and is all-in", "Sb: folds", "Bb: folds"];
const sngHand = hand("$5 Regular 9-Max", SEATS, PUSH);
const mttHand = hand("ILWP series", SEATS, PUSH);
const sng: HandAnalysis = analyzeHand(structuredClone(sngHand));
const mtt: HandAnalysis = analyzeHand(structuredClone(mttHand));
const graded = (a: HandAnalysis): DecisionAnalysis => a.decisions.find((d) => d.source === "icm")!;

const web = (locale: "en" | "hr", decision: DecisionAnalysis, readOnly = false) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale }, createElement(IcmPanel, { decision, hand: sngHand, readOnly })));

describe("the web's ICM panel", () => {
  it("shows the model, the stacks, the payouts, the prize equities and the matchups, in both languages", () => {
    const d = graded(sng);
    const en = web("en", d);
    expect(en).toContain("Tournament (push/fold)");
    expect(en).toContain("Prize equity (ICM)");
    expect(en).toContain("50 / 30 / 20");
    expect(en).toContain("Bubble factor");
    expect(en).toContain("Risk premium");
    expect(en).toContain("Payouts and players left");
    // The prize pool is the buy-ins of nine: the hero's equity in dollars too.
    expect(en).toMatch(/\$\d+\.\d{2}/);
    const hr = web("hr", d);
    expect(hr).toContain("Udio u nagradama (ICM)");
    expect(hr).toContain("Bubble faktor");
    expect(hr).toContain("Isplate i preostali igrači");
    for (const html of [en, hr]) expect(html).not.toMatch(/undefined|NaN|\[object/);
  });

  it("says why a multi-table hand is measured in chips, and a shared hand has no settings", () => {
    const d = graded(mtt);
    expect(web("en", d)).toContain("Chip EV");
    expect(web("en", d)).toContain("the hand does not say how many players are left");
    expect(web("hr", d)).toContain("ruka ne kaže koliko je igrača ostalo");
    expect(web("en", graded(sng), true)).not.toContain("Payouts and players left");
  });
});

describe("the app's hand analysis", () => {
  const render = (locale: "en" | "hr", analysis: HandAnalysis) =>
    renderToStaticMarkup(
      createElement(
        DictProvider,
        { locale },
        createElement(HandAnalysisView, {
          handKey: "standard:IS1",
          actionIndex: graded(analysis).actionIndex,
          back: null,
          loaded: { status: "ready", analysis, stored: true, playedAt: sngHand.playedAt },
        }),
      ),
    );

  it("shows the push/fold block under the decision, in both languages", () => {
    const en = render("en", sng);
    expect(en).toContain("Tournament (push/fold)");
    expect(en).toContain("The push/fold game (tournament)");
    expect(en).toContain("Prize equity (ICM)");
    expect(en).toContain("Bubble factor");
    const hr = render("hr", sng);
    expect(hr).toContain("Turnir (push/fold)");
    expect(hr).toContain("Bubble faktor");
    expect(render("en", mtt)).toContain("Chip EV");
    for (const html of [en, hr]) expect(html).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe("the push/fold spots in words", () => {
  it("names them in the session review and the leak finder, apart from a cash open", () => {
    expect(reviewUiEn.preflopSpots["push-fold"]).toBe("Push or fold (tournament)");
    expect(reviewUiHr.preflopSpots["push-fold-call"]).toBe("Protiv pusha (turnir)");
    const push = { street: "preflop", scenario: "push-fold", family: "push-fold", hero: "BTN", villain: "*", table: undefined };
    const call = { ...push, scenario: "push-fold-call", family: "push-fold-call", hero: "BB" };
    expect(leaksEn.context(push)).toBe("BTN push or fold (tournament)");
    expect(leaksEn.title("raise-too-wide", push)).toBe("Pushing too wide");
    expect(leaksEn.title("fold-too-much", push)).toBe("Pushing too tight");
    expect(leaksEn.context(call)).toBe("BB vs a push (tournament)");
    expect(leaksHr.context(push)).toBe("BTN push ili fold (turnir)");
    expect(leaksHr.title("raise-too-wide", push)).toBe("Pushaš preširoko");
  });
});
