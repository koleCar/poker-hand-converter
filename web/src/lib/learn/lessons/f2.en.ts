import type { LessonBodies } from "./types";

/**
 * F2 — single-raised pots, the preflop raiser out of position, English
 * (Learn L2). Numbers: plain arithmetic in `checks`, recomputed by the
 * tests; frequencies only as directions, the drills show Rail's solves.
 */
export const f2En: LessonBodies<"oop-as-the-raiser" | "facing-a-check-raise"> = {
  "oop-as-the-raiser": {
    sections: [
      {
        heading: "The same range, a worse seat",
        blocks: [
          "The small blind opens to 3 bb and the big blind calls. The pot is 3 + 3 = 6 bb with 97 bb behind, an SPR of about 16.2. The small blind raised first and has the stronger range, but it now acts first on every street.",
          "Acting first costs [[equity-realisation-and-implied-odds|equity realisation]]. Every check can be attacked, every bet can be raised with the big blind still to see what you do next, and medium hands find it hard to get to showdown cheaply. So the raiser out of position bets less often than the same range would in position, and checks more of its medium hands.",
        ],
      },
      {
        heading: "Where it still bets, and where it checks",
        blocks: [
          "In Rail's solves of the small blind against the big blind, the board decides almost everything. On king- and queen-high boards and on ace-high ones the small blind bets most of its range, mostly small. On low boards, seven-high and below, it checks nearly everything: the big blind's calling range holds more of the small pairs, two pairs and straights there.",
          "Middling boards sit in between: fewer bets, and more of them big. The pattern is the in-position one with the dial turned towards checking.",
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "btn-vs-bb", board: ["6d", "5c", "3h"] },
            caption:
              "Illustrative ranges written for teaching: the raiser's lead in strong hands on 6♦5♣3♥, compared with K♦7♣2♥. On the low board the caller holds more of the top.",
          },
          {
            checkpoint: {
              question: "Small blind against big blind, flop 6♦5♣3♥. What is the small blind's natural plan?",
              options: ["Bet small with the whole range", "Check most of the range, strong hands included", "Bet big with overpairs and check the rest"],
              answer: 1,
              explain:
                "The low board favours the big blind's range: small pairs make sets, suited connectors make straights and two pairs. Betting into that range out of position with medium hands is costly, so the small blind checks a lot, and keeps its overpairs and sets among the checks so the big blind cannot attack every check freely.",
            },
          },
        ],
      },
      {
        heading: "A checking range that defends itself",
        blocks: [
          "When you check a lot, the checks must not all be weak. If every strong hand bets, the big blind can bet any two cards after your check and you have nothing to fight back with. Keeping some strong hands in the checking range lets you check-call and check-raise, which is what makes your checks hard to attack.",
          "When you do bet out of position, the bet is a little more polarised than in position: strong hands and good draws, with fewer thin value bets. A third of the pot here is 2 bb, and a pure bluff of that size needs 2 / (6 + 2) = 25% folds.",
          {
            note: {
              tone: "approximate",
              text: "The flop drills are dealt from Rail's flop library, where the small blind against the big blind is the single-raised line with the raiser out of position. Your own hands on flops the library did not solve are read from the nearest solved flop by hand category.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Out of position, bet less often and check more medium hands than the same range would in position.",
        "Bet the high boards your range dominates; check most of the low boards that favour the caller.",
        "Keep strong hands among your checks so the caller cannot bet freely into them.",
        "When you bet out of position, lean polarised: strong hands and good draws.",
      ],
      breaks: [
        "Against a big blind that never bets when checked to, checking strong hands loses value: bet them.",
        "Against one that stabs every check, check more strong hands and let it bet.",
      ],
    },
    exercises: {
      "oop-flops": "Five flops from Rail's library, small blind against big blind, your first decision: check or bet, and how big.",
      "oop-rivers": "Three rivers as the raiser out of position, solved on demand.",
      "your-hands": "Your own flop decisions as the raiser out of position, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [3, 3], value: 6 },
      { fn: "sum", args: [100, -3], value: 97 },
      { fn: "spr", args: [97, 6], value: 16.2 },
      { fn: "alpha", args: [6, 2], value: 0.25 },
    ],
  },

  "facing-a-check-raise": {
    sections: [
      {
        heading: "The price of a check-raise",
        blocks: [
          "Button against big blind, pot 5.5 bb. You bet a third of the pot, about 1.8 bb, and the big blind raises to 6.35 bb, half the pot after its call. You now pay 4.55 bb into a pot of 5.5 + 1.8 + 6.35 = 13.65 bb: you need 4.55 / (13.65 + 4.55) = 25% equity to call, if no more money goes in.",
          "From the raiser's side, the check-raise risks 6.35 bb to win the 7.3 bb already there. As a pure bluff it needs 6.35 / (7.3 + 6.35), about 46.5% folds: that is its [[bluffing-math-alpha-mdf|alpha]], and 1 minus it, about 53.5%, is the share of your betting range that must continue so a bluff-raise does not print money.",
          {
            checkpoint: {
              question: "You face that check-raise: 4.55 bb to call into 13.65 bb. How much equity does a call need, if no more money goes in?",
              options: ["About 18%", "About 25%", "About 33%"],
              answer: 1,
              explain: "After your call the pot is 13.65 + 4.55 = 18.2 bb, of which 4.55 bb is yours: 4.55 / 18.2 = 25%. Later streets add risk for hands that cannot stand more bets, so a call needs a little more than the bare price.",
              math: { fn: "requiredEquity", args: [13.65, 4.55], value: 0.25 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 13.65, bet: 4.55, share: 0.25 },
            },
          },
        ],
      },
      {
        heading: "Which hands continue",
        blocks: [
          "Minimum defence is a soft guide, not a rule. In Rail's solves of the button against the big blind, the button continues against a check-raise more often than that minimum: much of its betting range is pairs and draws with real equity against the raise.",
          {
            list: [
              "Continue: strong made hands, top pairs, overpairs, and draws with good equity: flush draws, open-enders, gutshots with overcards.",
              "Mixed: weaker pairs with backdoor draws, and the hands that block the raiser's strongest combinations.",
              "Fold: the air that bet as a bluff and has nothing left, no pair and no draw.",
            ],
          },
          "Prefer hands with equity over thin made hands. A middle pair with no draw has few good turn cards and faces more bets; a flush draw has many.",
        ],
      },
      {
        heading: "Against real players",
        blocks: [
          "Many players check-raise the flop almost only with strong hands. Against them, minimum defence is far too much: fold your weak pairs and continue with hands that can beat a strong range or draw to the nuts. Against players who check-raise often with draws and air, keep your pairs.",
          "In Rail's flop tree the check-raise is the last raise of the street, so the drills ask one question: call or fold.",
          {
            note: {
              tone: "approximate",
              text: "The drills come from Rail's flop library, combo for combo. Your own hands on flops the library did not solve are read from the nearest solved flop by hand category, and the analysis marks them as mapped.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Price the call: the raise to call over the pot after your call.",
        "Continue with equity: draws and pairs with good outs before thin made hands.",
        "Fold the air that bet as a bluff.",
        "Treat [[bluffing-math-alpha-mdf|minimum defence]] as a soft guide.",
      ],
      breaks: [
        "Against players who check-raise only strong hands, fold more than the guide says.",
        "With deeper stacks, implied odds favour draws and hurt one-pair hands.",
      ],
    },
    exercises: {
      "flop-vs-raise": "Five flops from Rail's library where your flop bet was raised: fold or call, graded by the solve.",
      "your-hands": "Your own flop bets that were raised, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [5.5, 1.8, 1.8], value: 9.1 },
      { fn: "product", args: [0.5, 9.1], value: 4.55 },
      { fn: "sum", args: [1.8, 4.55], value: 6.35 },
      { fn: "sum", args: [5.5, 1.8, 6.35], value: 13.65 },
      { fn: "alpha", args: [7.3, 6.35], value: 0.465 },
      { fn: "mdf", args: [7.3, 6.35], value: 0.535 },
    ],
  },
};
