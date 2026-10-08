import type { LessonBodies } from "./types";

/**
 * F4 — 3-bet and 4-bet pots, English (Learn L2), apart from the range
 * split in position, which is M6-L4's (`m6.en.ts`). Numbers: plain
 * arithmetic in `checks`, recomputed by the tests; frequencies only as
 * directions, the drills show Rail's solves.
 */
export const f4En: LessonBodies<"spr-and-commitment" | "cbetting-as-the-3bettor" | "playing-3bp-as-the-caller" | "four-bet-pots"> = {
  "spr-and-commitment": {
    sections: [
      {
        heading: "SPR sets how strong a hand must be",
        blocks: [
          "The stack-to-pot ratio on the flop is the effective stack divided by the pot. It tells you how many pot-sized steps are left before everything is in, and so how strong a hand must be before it is happy to get there.",
          {
            list: [
              "Button against big blind in a single-raised pot: 97.5 / 5.5, about 17.7.",
              "The big blind 3-bets the button to 10 bb and is called: 90 / 20.5, about 4.4.",
              "A 4-bet to 22 bb, called: 78 / 44.5, about 1.8.",
            ],
          },
          "At 17.7 one pair is a hand to control the pot with; at 4.4 a good top pair or an overpair is often happy to put it all in; at 1.8 almost any pair with a good kicker is.",
          {
            widget: { id: "spr", pot: 20.5, stack: 90 },
            caption: "The 3-bet pot. Set the streets to two or three to see the bet that gets the stacks in, then try the 5.5 bb single-raised pot.",
          },
        ],
      },
      {
        heading: "How a flop bet commits you",
        blocks: [
          "In the 3-bet pot, a flop bet of a third of the pot is about 6.8 bb. Called, the pot is 20.5 + 6.8 + 6.8 = 34.1 bb with 83.2 bb behind: the SPR falls to about 2.4. One more pot-sized bet and a shove cover what is left.",
          "So the first bet is a decision about the whole hand. Before you bet or call the flop at a low SPR, ask whether you will be happy to get the rest in on most turns. If not, check or fold now rather than paying twice.",
          {
            checkpoint: {
              question: "After that flop bet and call, the big blind shoves 83.2 bb into 34.1 bb. What equity does your call need?",
              options: ["About 29%", "About 41.5%", "About 50%"],
              answer: 1,
              explain:
                "The pot after the shove is 34.1 + 83.2 = 117.3 bb, and you call 83.2: 83.2 / (117.3 + 83.2) is about 41.5%. An overpair or a strong top pair often has that against a range that shoves.",
              math: { fn: "requiredEquity", args: [117.3, 83.2], value: 0.415 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 117.3, bet: 83.2, share: 0.415 },
            },
          },
        ],
      },
      {
        heading: "Folding after you are committed",
        blocks: [
          "The costliest mistake at a low SPR is to put in a third of your stack and then fold for the rest at a good price. Rail flags it in your own hands. If the hand was worth putting that much in, it is usually worth the last bit; if it was not, the mistake was earlier.",
          "Deeper stacks do the opposite: at 200bb the same 3-bet pot has an SPR around nine, and one pair is back to being a hand that controls the pot.",
          {
            note: {
              tone: "approximate",
              text: "The flop drills come from Rail's flop library, at 6-max 100bb. Your own hands on flops it did not solve, or at other depths, are read from the nearest solved flop or by the heuristic.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Work out the SPR on the flop before you bet or call.",
        "Low SPR: decide on the flop whether you will play for stacks.",
        "At an SPR around four, overpairs and good top pairs usually do.",
        "Do not fold for a small last bet after putting in most of your stack.",
      ],
      breaks: [
        "Against a range that only shoves the nuts, even a committed-looking hand can fold.",
        "Deep stacks raise the SPR: one pair goes back to pot control.",
      ],
    },
    exercises: {
      "spr-drill": "Six flop pots and stacks: work out the SPR before the calculator shows it.",
      "3bp-commit": "Four flops from Rail's library in 3-bet pots, facing a bet: fold, call or raise.",
      "your-hands": "Your own hands flagged for folding after committing, or betting with too little behind.",
    },
    checks: [
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "spr", args: [90, 20.5], value: 4.4 },
      { fn: "sum", args: [22, 22, 0.5], value: 44.5 },
      { fn: "sum", args: [100, -22], value: 78 },
      { fn: "spr", args: [78, 44.5], value: 1.8, tolerance: 0.05 },
      { fn: "product", args: [20.5, 0.33], value: 6.8, tolerance: 0.05 },
      { fn: "sum", args: [20.5, 6.8, 6.8], value: 34.1 },
      { fn: "sum", args: [90, -6.8], value: 83.2 },
      { fn: "spr", args: [83.2, 34.1], value: 2.4, tolerance: 0.05 },
      { fn: "sum", args: [34.1, 83.2], value: 117.3 },
      { fn: "spr", args: [190, 20.5], value: 9.3 },
    ],
  },

  "cbetting-as-the-3bettor": {
    sections: [
      {
        heading: "A stronger range, a smaller pot to stack",
        blocks: [
          "The 3-bettor's range is narrow and strong: big pairs, strong aces and kings, a few suited bluffs. The caller's range is capped: it would have 4-bet many of its best hands. On most flops that gives the 3-bettor both the [[range-advantage|range advantage]] and a good share of the strongest hands, at an SPR around four to six.",
          "So the 3-bettor bets often. In Rail's solves this holds in position and out of position alike, which is different from single-raised pots, where the out-of-position raiser checks much more.",
        ],
      },
      {
        heading: "In position: small and frequent",
        blocks: [
          "When the caller checks to the in-position 3-bettor, Rail's solves bet small with most of the range, on almost every board. Big bets are rare. The checks are mostly medium hands, second pairs and weaker top pairs, and they grow on monotone and ace-high boards, where the caller's range holds more of the hands that can fight back.",
        ],
      },
      {
        heading: "Out of position: still betting, sometimes big",
        blocks: [
          "Out of position the 3-bettor bets most flops too, most of all on king- and queen-high and paired boards, and least on jack-high and ace-low ones. What changes is the size: overpairs and top pair with a top kicker often bet big, because at a low SPR a big flop bet sets up the stacks for two more streets.",
          {
            widget: { id: "flop-bets", preset: "btn-bb-3bet" },
            caption:
              "Rail's flop library: the big blind 3-bets the button and is first to act. Compare its betting by board group with the button's single-raised pot.",
          },
          {
            checkpoint: {
              question: "Big blind 3-bet the button and was called. Flop Q♠8♦4♣, you hold K♥K♣. Which plan fits Rail's solves best?",
              options: ["Check to trap", "Bet, often big", "Bet small only"],
              answer: 1,
              explain:
                "An overpair at an SPR around 4.4 is a hand that wants the stacks in. A big flop bet makes that easy over two more streets and charges the caller's pairs and draws. Rail's solve mixes sizes with overpairs, leaning big.",
            },
          },
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "The drills deal 3-bet pots from the library, in and out of position, then rivers in 3-bet pots solved on demand.",
          {
            note: {
              tone: "approximate",
              text: "Flop spots come from Rail's flop library, which covers five 3-bet-pot lines at 6-max 100bb; your own 3-bet pots on other lines, flops or depths are read from the nearest solved flop or by the heuristic.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "As the 3-bettor, bet often: your range is stronger and the caller's is capped.",
        "In position, bet small with most of the range; check medium pairs, more on monotone and ace-high boards.",
        "Out of position, still bet most flops; let overpairs and top pair with a top kicker bet big.",
        "At a low SPR, plan the stacks from the flop.",
      ],
      breaks: [
        "Against callers who flat their strongest hands, take more care on low and connected boards.",
        "Against callers who fold too much to small bets, bet small even more often.",
      ],
    },
    exercises: {
      "3bp-flops": "Six flops from Rail's library as the 3-bettor, your first decision: check or bet, and how big.",
      "3bp-rivers": "Three rivers as the 3-bettor, solved on demand.",
      "your-hands": "Your own first flop decisions as the 3-bettor, the costliest first.",
    },
    checks: [],
  },

  "playing-3bp-as-the-caller": {
    sections: [
      {
        heading: "What your calling range holds",
        blocks: [
          "When you call a 3-bet, your range is middling: pocket pairs, suited broadways, suited connectors and some strong aces that chose not to 4-bet. Its top is capped, but it is dense in the middle, and it makes sets, two pairs and straights on the boards the 3-bettor's big cards miss.",
          "At an SPR of four to six, every call on the flop is a big share of what is left, so defend with hands that can keep going.",
        ],
      },
      {
        heading: "Facing a small c-bet",
        blocks: [
          "In Rail's solves the caller continues against a small 3-bet-pot c-bet with most of its range, and folds much more against a big one. The price explains it: a third of the pot needs 20% equity, three quarters 30%.",
          {
            list: [
              "Call: pairs, draws, and overcards with a backdoor on boards that suit you.",
              "Raise: sets, two pairs and strong draws, more on middling, connected and low boards, less on ace-high and monotone ones.",
              "Fold: hands with no pair and no draw on boards that favour the 3-bettor.",
            ],
          },
          {
            checkpoint: {
              question: "You called the big blind's 3-bet on the button. Flop 9♥8♥4♣, it bets a third of the pot. Which hand raises most naturally?",
              options: ["A♣Q♦", "7♥6♥", "J♠J♦"],
              answer: 1,
              explain:
                "7♥6♥ has an open-ender and a flush draw: plenty of equity when called, and a raise can take the pot now. J♠J♦ is an overpair that is happy to call and keep the bluffs in. A♣Q♦ has two overcards with a backdoor and calls at most.",
            },
          },
        ],
      },
      {
        heading: "When the 3-bettor checks, and the river",
        blocks: [
          "When the 3-bettor checks to you in position, bet small with your strongest hands and some air, and check back most medium pairs: they win at showdown and hate a check-raise with so little behind. That split has its own lesson in this module.",
          "On the river, the capped line favours bluff-catching. A 3-bettor who checks one street and bets big later holds fewer of the very best hands than it seems; count what it can have before you fold a good pair.",
          {
            note: {
              tone: "approximate",
              text: "Flop spots come from Rail's flop library, combo for combo; river spots are solved on demand from ranges narrowed through the earlier streets. Your own hands on other flops or lines are read from the nearest solved flop or by the heuristic.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Against small 3-bet-pot c-bets, continue with most of your range.",
        "Raise sets, two pairs and strong draws, more on low and connected boards.",
        "Check back medium pairs when the 3-bettor checks.",
        "On the river, count the 3-bettor's value before folding a good pair.",
      ],
      breaks: [
        "Against 3-bettors who bet only strong hands, fold more of your weak pairs.",
        "Against ones who barrel every street, call down wider.",
      ],
    },
    exercises: {
      "3bp-defence": "Five flops from Rail's library in 3-bet pots, facing the 3-bettor's bet: fold, call or raise.",
      "3bp-caller-rivers": "Three rivers as the caller in 3-bet pots, solved on demand.",
      "your-hands": "Your own decisions as the caller in 3-bet pots on the flop, the costliest first.",
    },
    checks: [
      { fn: "requiredEquity", args: [4, 1], value: 0.2 },
      { fn: "requiredEquity", args: [7, 3], value: 0.3 },
    ],
  },

  "four-bet-pots": {
    sections: [
      {
        heading: "Almost no room left",
        blocks: [
          "A 4-bet to 22 bb at 100bb, called: the pot is 22 + 22 + 0.5 = 44.5 bb with 78 bb behind, an SPR of about 1.8. One bet of about half the pot, called, and the rest is less than the pot. The flop is the last street with real choices.",
          "Both ranges are narrow and strong: big pairs, ace-king, a few suited aces. Overpairs and top pairs are rarely folded, and many flops are played as all-in or check.",
          {
            checkpoint: {
              question: "In that 4-bet pot, you bet 15 bb into 44.5 bb and are called. What is left behind, and what is the new pot?",
              options: ["63 bb behind, 74.5 bb pot", "63 bb behind, 59.5 bb pot", "78 bb behind, 74.5 bb pot"],
              answer: 0,
              explain:
                "You put in 15 of your 78: 63 bb left. The pot grows by both bets: 44.5 + 15 + 15 = 74.5 bb. The SPR is now under one, so any turn bet is all-in.",
              math: { fn: "sum", args: [44.5, 15, 15], value: 74.5 },
            },
          },
        ],
      },
      {
        heading: "Small bets, shoves and folds",
        blocks: [
          "With so little behind, a small flop bet does the work of a big one: it commits both players' strong hands and makes the turn an easy all-in. Rail has no solve of these pots to show, so take the usual reasoning as a guide, not a measurement: the 4-bettor bets small often on boards with high cards, and checks more on low connected boards, where the caller's pairs make sets and two pairs.",
          "Calling a 4-bet out of position is costly: you play the whole hand at a low SPR without the initiative. That is why ranges that face 4-bets mostly fold or 5-bet all-in, and call only with hands that play well for stacks.",
        ],
      },
      {
        heading: "What Rail can and cannot grade here",
        blocks: [
          "The preflop part is graded by Rail's charts: the drill below deals hands facing 4-bets. The flop of a 4-bet pot is not in the flop library, so the postflop part is taught here in words, and Rail grades your own 4-bet pots after the flop by the heuristic.",
          {
            note: {
              tone: "conceptual",
              text: "4-bet pots are not in Rail's flop library, so their flops are read by the analysis' heuristic, without a solver grade. The chart quiz and the SPR sums are graded as usual.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Work out the SPR: in a 4-bet pot at 100bb it is around two or less.",
        "Bet small on high boards: it is enough to get the stacks in.",
        "Decide your all-in hands on the flop.",
        "Call 4-bets only with hands that play well for stacks.",
      ],
      breaks: [
        "Deep stacks turn a 4-bet pot back into a pot with room to play.",
        "Against players who 4-bet only the strongest pairs, fold more on the flop.",
      ],
    },
    exercises: {
      "vs-4bet": "Eight hands facing a 4-bet, dealt from Rail's charts: fold, call or 5-bet all-in.",
      "4bp-spr": "Five pots and stacks from 4-bet pots: work out the SPR.",
      "your-hands": "Your own 4-bet pots after the flop, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [22, 22, 0.5], value: 44.5 },
      { fn: "sum", args: [100, -22], value: 78 },
      { fn: "spr", args: [78, 44.5], value: 1.8, tolerance: 0.05 },
      { fn: "sum", args: [78, -15], value: 63 },
    ],
  },
};
