/**
 * The Trainer's sessions (`web/src/components/trainer/sessions.ts`,
 * `docs/TRAINER.md` §7): what makes two answers the same spot, that a spot's
 * deal gives it again, which spot comes back, a session's figures, its name
 * from the settings, when two settings train the same, and the device store.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { dealPreflop } from "../../web/src/lib/training/preflop.js";
import { trainerEn } from "../../web/src/lib/i18n/ns/trainer.en.js";
import { trainerHr } from "../../web/src/lib/i18n/ns/trainer.hr.js";
import { DEFAULT_SETTINGS, parseSettings, settingsFields, type TrainerSettings } from "../../web/src/components/trainer/settings.js";
import {
  cardsOf,
  defaultName,
  earlierOn,
  figuresOf,
  handType,
  localSessionStore,
  pickRepeat,
  sameTraining,
  sessionTotals,
  spotKey,
  todayOf,
  type SessionAnswer,
} from "../../web/src/components/trainer/sessions.js";
import { fullLibrary } from "./charts/support.js";

const library = fullLibrary();

function answer(over: Partial<SessionAnswer>): SessionAnswer {
  return {
    at: "2026-11-16T08:00:00.000Z",
    street: "preflop",
    cards: "Kd9c",
    board: "",
    spotKey: "k",
    position: "BB",
    handClass: "K9o",
    move: "Call",
    best: "Call",
    grade: "perfect",
    evLoss: 0,
    score: 100,
    ref: { request: { kind: "preflop", options: { set: DEFAULT_CHART_SET, family: "vs-open", seat: "BB", vs: "BTN", bias: "range" } }, seed: 1 },
    ...over,
  };
}

describe("a spot's key and its deal", () => {
  it("deals the very spot again from its request and seed, with the same key", () => {
    const options = { set: DEFAULT_CHART_SET, family: "vs-open" as const, seat: "BB" as const, vs: "BTN" as const, bias: "range" as const };
    const first = dealPreflop(library, options, 1234)!;
    const again = dealPreflop(library, options, 1234)!;
    expect(first).not.toBeNull();
    expect(spotKey(again)).toBe(spotKey(first));
    expect(again.cards).toEqual(first.cards);
  });

  it("tells spots apart by node and cards, not by the order the cards came in", () => {
    const options = { set: DEFAULT_CHART_SET, family: "vs-open" as const, seat: "BB" as const, vs: "BTN" as const, bias: "range" as const };
    const a = dealPreflop(library, options, 1)!;
    const swapped = { ...a, cards: [a.cards[1], a.cards[0]] as [string, string] };
    expect(spotKey(swapped)).toBe(spotKey(a));
    const other = { ...a, line: `${a.line}x` };
    expect(spotKey(other)).not.toBe(spotKey(a));
  });

  it("splits a card string back into cards", () => {
    expect(cardsOf("KdTc")).toEqual(["Kd", "Tc"]);
    expect(cardsOf("")).toEqual([]);
  });
});

describe("spots dealt again", () => {
  const history = [
    answer({ spotKey: "a", grade: "perfect" }),
    answer({ spotKey: "b", grade: "mistake" }),
    answer({ spotKey: "c", grade: "good" }),
    ...Array.from({ length: 12 }, (_, i) => answer({ spotKey: `n${i}` })),
  ];

  it("never with repeats off, and only on the roll's share otherwise", () => {
    expect(pickRepeat(history, "off", 0, 0)).toBeNull();
    expect(pickRepeat(history, "some", 0.5, 0)).toBeNull();
    expect(pickRepeat(history, "often", 0.5, 0)).toBeNull();
    expect(pickRepeat(history, "some", 0.1, 0)).not.toBeNull();
    expect(pickRepeat(history, "often", 0.3, 0)).not.toBeNull();
  });

  it("mistakes first, and never a spot answered in the last few deals", () => {
    expect(pickRepeat(history, "often", 0, 0.99)?.spotKey).toBe("b");
    const recent = [...history, answer({ spotKey: "b", grade: "mistake" })];
    expect(pickRepeat(recent, "often", 0, 0)?.spotKey).not.toBe("b");
  });

  it("goes by the latest answer on a spot: a spot answered right since is no longer a mistake", () => {
    const fixed = [answer({ spotKey: "b", grade: "mistake" }), answer({ spotKey: "b", grade: "perfect" }), answer({ spotKey: "d", grade: "blunder" }), ...history.slice(3)];
    expect(pickRepeat(fixed, "often", 0, 0)?.spotKey).toBe("d");
  });

  it("not a whole hand's decision (no deal to give it again)", () => {
    const hands = [answer({ spotKey: "h", grade: "blunder", ref: null }), ...history.slice(3)];
    expect(pickRepeat(hands, "often", 0, 0)).toBeNull();
  });

  it("finds every earlier answer on a spot, oldest first", () => {
    const list = [answer({ spotKey: "x", at: "1" }), answer({ spotKey: "y" }), answer({ spotKey: "x", at: "2" })];
    expect(earlierOn(list, "x").map((a) => a.at)).toEqual(["1", "2"]);
  });
});

describe("a session's figures", () => {
  it("counts hands, the mean score, EV lost, grades, the best streak and spots played again", () => {
    const list = [
      answer({ spotKey: "a", grade: "perfect", score: 100 }),
      answer({ spotKey: "b", grade: "mistake", score: 40, evLoss: 0.5 }),
      answer({ spotKey: "a", grade: "good", score: 90, evLoss: 0.02 }),
      answer({ spotKey: "c", grade: "perfect", score: 100 }),
      answer({ spotKey: "b", grade: "blunder", score: 0, evLoss: 1 }),
    ];
    const f = figuresOf(list);
    expect(f.hands).toBe(5);
    expect(f.score).toBeCloseTo(66);
    expect(f.evLoss).toBeCloseTo(1.52);
    expect(f.counts).toEqual({ perfect: 2, good: 1, inaccurate: 0, mistake: 1, blunder: 1 });
    expect(f.bestStreak).toBe(2);
    expect(f.repeated).toBe(2);
    expect(f.repeatedRight).toBe(1);
    expect(figuresOf([]).score).toBeNull();
  });

  it("keeps today's answers apart", () => {
    const now = new Date(2026, 10, 16, 12);
    const list = [answer({ at: new Date(2026, 10, 15, 23).toISOString() }), answer({ at: new Date(2026, 10, 16, 8).toISOString() })];
    expect(todayOf(list, now)).toHaveLength(1);
    expect(sessionTotals(list, now).today).toBe(1);
    expect(sessionTotals(list, now).hands).toBe(2);
  });

  it("groups preflop hands by kind", () => {
    expect(["AA", "AKs", "KQo", "T9s", "72o", null].map(handType)).toEqual(["pairs", "aces", "broadway", "suited", "other", "other"]);
  });
});

describe("a session's settings and name", () => {
  const bbDefence: TrainerSettings = { ...DEFAULT_SETTINGS, mode: "preflop", family: "vs-open", seat: "BB", vs: "BTN" };

  it("is named from its settings, in both languages", () => {
    expect(defaultName(bbDefence, trainerEn)).toBe("BB vs BTN open");
    expect(defaultName({ ...bbDefence, family: "vs-3bet" }, trainerEn)).toBe("BB vs BTN 3-bet");
    expect(defaultName({ ...bbDefence, family: "rfi", vs: null }, trainerEn)).toBe("BB first in");
    expect(defaultName({ ...DEFAULT_SETTINGS }, trainerEn)).toBe("For you");
    expect(defaultName({ ...bbDefence, mode: "flop", pot: "srp", facing: "bet" }, trainerEn)).toBe("Flop · BB · single-raised · facing bet");
    expect(defaultName({ ...bbDefence, play: "hand" }, trainerEn)).toBe("BB vs BTN open · whole hand");
    expect(defaultName(bbDefence, trainerHr)).toBe("BB protiv BTN opena");
  });

  it("trains the same whatever panels it shows, and not when anything dealt changes", () => {
    expect(sameTraining(bbDefence, { ...bbDefence, strategy: false, facts: false, range: "strategy" })).toBe(true);
    expect(sameTraining(bbDefence, { ...bbDefence, vs: "CO" })).toBe(false);
    expect(sameTraining(bbDefence, { ...bbDefence, repeat: "off" })).toBe(false);
  });

  it("keeps the repeat choice with the other settings", () => {
    expect(DEFAULT_SETTINGS.repeat).toBe("some");
    expect(parseSettings({ repeat: "often" }).repeat).toBe("often");
    expect(parseSettings({ repeat: "always" }).repeat).toBe("some");
    expect(settingsFields({ ...DEFAULT_SETTINGS, repeat: "off" })).toEqual({ repeat: "off" });
  });

  it("has the same words in English and Croatian", () => {
    const shape = (value: unknown): unknown =>
      typeof value === "function" ? "fn" : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape((value as Record<string, unknown>)[k])])) : typeof value;
    expect(shape(trainerHr.sessions)).toEqual(shape(trainerEn.sessions));
  });
});

describe("sessions on this device", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      },
    };
  });

  it("keeps sessions and their answers, last played first, with their figures", async () => {
    const store = localSessionStore();
    await store.save({ id: "s1", name: "BB defence", fields: { mode: "preflop" }, archived: false });
    await store.save({ id: "s2", name: "Flop", fields: { mode: "flop" }, archived: false });
    store.record("s1", answer({ at: new Date(Date.now() + 1000).toISOString(), score: 80, grade: "good" }));
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(list[0].hands).toBe(1);
    expect(list[0].scoreSum).toBe(80);
    expect((await store.answers("s1")).map((a) => a.grade)).toEqual(["good"]);
    await store.save({ id: "s1", name: "Renamed", fields: { mode: "preflop" }, archived: true });
    const again = await store.list();
    expect(again.find((s) => s.id === "s1")).toMatchObject({ name: "Renamed", archived: true, hands: 1 });
  });

  it("works without storage, for the visit", async () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    };
    const store = localSessionStore();
    await store.save({ id: "s1", name: "One", fields: {}, archived: false });
    store.record("s1", answer({}));
    expect((await store.list()).map((s) => s.name)).toEqual(["One"]);
    expect(await store.answers("s1")).toHaveLength(1);
  });
});
