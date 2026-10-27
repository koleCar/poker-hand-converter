import type { LessonBodies } from "./types";

/**
 * F5 — multiway flops, English (Learn L2). Rail's flop library is heads-up,
 * so these lessons rest on arithmetic (`checks`, recomputed by the tests)
 * and the analysis' multiway reading (A9), and say so.
 */
export const f5En: LessonBodies<"multiway-principles" | "multiway-as-the-raiser" | "multiway-defence"> = {
  "multiway-principles": {
    sections: [
      {
        heading: "Every extra player is another chance of a strong hand",
        blocks: [
          "Heads-up, a bluff works if one player folds. With two opponents both must fold; with three, all three. If each folds half the time on their own, both fold 0.5 × 0.5 = 25% of the time and all three only 12.5%.",
          "The same arithmetic runs the other way for strong hands. The more players see the flop, the more likely someone holds two pair, a set or a strong draw, and the more a medium hand is up against.",
          {
            widget: { id: "multiway", pot: 9, bet: 3, share: 0.5, opponents: 2 },
            caption: "A third-pot bet into two players who each fold half the time. Add a third opponent and watch the folds you can count on shrink.",
          },
        ],
      },
      {
        heading: "Defence is shared",
        blocks: [
          "Minimum defence is about the whole table, not each player. Against a third-pot bet, 25% folds by everyone together is the most the defenders can allow. With two of them, each continuing with half its range already makes everyone-folds 0.5 × 0.5 = 25%: each defends 50%, where a lone defender would need 75%.",
          {
            checkpoint: {
              question: "A bet of a third of the pot faces three players. How much of its range must each defend, sharing the job equally?",
              options: ["About 25%", "About 37%", "About 75%"],
              answer: 1,
              explain: "Everyone folds at most 25% of the time: each player folds at most the cube root of 25%, about 63%, so each defends about 37%.",
              math: { fn: "mdfSplit", args: [3, 1, 3], value: 0.37 },
              reveal: { id: "multiway", pot: 3, bet: 1, share: 0.37, opponents: 3 },
            },
          },
        ],
      },
      {
        heading: "What it changes",
        blocks: [
          {
            list: [
              "Bluff less, and with hands that can still improve.",
              "Value-bet a little tighter and a little smaller.",
              "Prefer hands that make the nuts over draws to second-best hands.",
              "Slowplay less: every free card is a free card for several players.",
            ],
          },
          {
            note: {
              tone: "approximate",
              text: "Rail's flop library is heads-up. Multiway flops are read by the analysis' heuristic and the MDF split, with facts and flags but no solver grade; this lesson's practice is the arithmetic and your own flagged hands.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Multiply the folds: a bluff needs every opponent to fold.",
        "Share the defence: each player defends less than heads-up.",
        "Bet tighter and smaller; slowplay less.",
        "Prefer draws to the nuts over draws to second best.",
      ],
      breaks: [
        "Passive multiway tables that call too much reward thin value and punish bluffs even more.",
        "With a short stack behind, commitment comes faster, multiway or not.",
      ],
    },
    exercises: {
      "multiway-maths": "Six sums: how often everyone folds, and how much each player must defend.",
      "your-hands": "Your own hands flagged for bluffing into a crowd, slowplaying multiway or calling with a dominated draw.",
    },
    checks: [
      { fn: "allFold", args: [0.5, 2], value: 0.25 },
      { fn: "allFold", args: [0.5, 3], value: 0.125 },
      { fn: "mdfSplit", args: [3, 1, 2], value: 0.5 },
    ],
  },

  "multiway-as-the-raiser": {
    sections: [
      {
        heading: "Betting into two",
        blocks: [
          "You raised preflop and two players called. The flop comes, and both check to you. Your range is still the strongest, but a bet now has to get through two players, and the one behind the first has more information.",
          "A pure bluff of a third of the pot needs 25% folds from both together. If each folds 60% of the time, both fold only 0.6 × 0.6 = 36%; at 50% each, exactly 25%. Bluffs need far more folding per player than heads-up.",
          {
            checkpoint: {
              question: "Both opponents fold 45% of the time each. Does a pure bluff of a third of the pot profit?",
              options: ["Yes", "No, both fold only about 20% of the time", "Only on dry boards"],
              answer: 1,
              explain: "0.45 × 0.45 is about 20%, short of the 25% a third-pot bluff needs. It loses unless it has equity when called.",
              math: { fn: "allFold", args: [0.45, 2], value: 0.2025 },
              reveal: { id: "multiway", pot: 3, bet: 1, share: 0.45, opponents: 2 },
            },
          },
        ],
      },
      {
        heading: "What bets",
        blocks: [
          {
            list: [
              "Strong hands, top pair with a good kicker and better: they get called by more hands multiway, so value is easier.",
              "Strong draws: they have fold equity and plenty of equity when called.",
              "Not medium hands: with two players to beat, a middle pair is behind more often and gains little from a bet.",
              "Few pure bluffs, and those with backdoors or overcards to improve.",
            ],
          },
          "Size smaller than heads-up: a small bet builds the pot with your value hands without asking two players' ranges to fold much.",
        ],
      },
      {
        heading: "In Rail",
        blocks: [
          "Multiway flops are not in the flop library, so your own hands here carry the analysis' multiway facts and flags rather than a solver grade.",
          {
            note: {
              tone: "approximate",
              text: "Rail's flop library is heads-up. Multiway flops are read by the heuristic, with facts and flags but no solver grade.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A bluff into two needs both to fold: multiply the folds.",
        "Bet strong hands and strong draws; check most medium hands.",
        "Bet smaller than heads-up.",
      ],
      breaks: [
        "Against two very tight players who fold too much, bluff more.",
        "When one player is very short, play the pot as if against the deeper one.",
      ],
    },
    exercises: {
      "bluff-into-two": "Five sums: how often several opponents all fold, and how much each must defend.",
      "your-hands": "Your own multiway flops as the preflop raiser, the costliest first.",
    },
    checks: [
      { fn: "allFold", args: [0.6, 2], value: 0.36 },
      { fn: "allFold", args: [0.5, 2], value: 0.25 },
    ],
  },

  "multiway-defence": {
    sections: [
      {
        heading: "Players behind you",
        blocks: [
          "Facing a bet with another player still to act behind you is harder than closing the action. A call can be raised behind you, and a hand that is ahead of the bettor can still be behind the player who has not acted. So defend tighter when someone can still act after you, and wider when you are last.",
          "The defence is shared. Against a bet of three quarters of the pot, 3 into 4, alpha is 3 / 7, about 42.9%. Two defenders sharing it equally each defend about 34.5%, much less than the 57.1% one defender would need.",
          {
            checkpoint: {
              question: "A bet of three quarters of the pot faces two players. Sharing the defence equally, how much must each defend?",
              options: ["About 21%", "About 34.5%", "About 57%"],
              answer: 1,
              explain: "Everyone folds at most 3 / 7, about 42.9%, of the time. Each player folds at most the square root of that, about 65.5%, so each defends about 34.5%.",
              math: { fn: "mdfSplit", args: [4, 3, 2], value: 0.345 },
              reveal: { id: "multiway", pot: 4, bet: 3, share: 0.345, opponents: 2 },
            },
          },
        ],
      },
      {
        heading: "Leading into the field",
        blocks: [
          "Out of position in a multiway pot, a lead can make sense where the board hits your range hard: low and connected boards when you defended from the blinds. Lead with strong hands and strong draws, and check the rest to the raiser.",
        ],
      },
      {
        heading: "In Rail",
        blocks: [
          "Your own multiway hands carry the analysis' multiway facts: each opponent's narrowed range, your equity against the field, the MDF split and the flags. The sums below drill the split itself.",
          {
            note: {
              tone: "approximate",
              text: "Rail's flop library is heads-up. Multiway flops are read by the heuristic and the MDF split, with facts and flags but no solver grade.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Defend tighter with players still to act behind you.",
        "Call wider when you close the action.",
        "Share the defence: each player defends less than heads-up.",
        "Lead only with strong hands and strong draws on boards that favour your range.",
      ],
      breaks: [
        "Against a bettor who only bets strong hands into a crowd, fold more.",
        "When the player behind is very passive, defend almost as if you closed the action.",
      ],
    },
    exercises: {
      "mdf-split": "Six sums: how much each player must defend against bets of different sizes.",
      "your-hands": "Your own multiway decisions facing a bet, on any street, the costliest first.",
    },
    checks: [
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "mdf", args: [4, 3], value: 0.571 },
    ],
  },
};
