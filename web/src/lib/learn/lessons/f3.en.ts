import type { LessonBodies } from "./types";

/**
 * F3 — single-raised pots, the caller, English (Learn L2). Numbers: plain
 * arithmetic in `checks`, recomputed by the tests; frequencies only as
 * directions, the drills and splits show Rail's solves.
 */
export const f3En: LessonBodies<"defending-vs-cbets" | "check-raising" | "floating-and-stabbing-ip" | "probes-and-donk-bets" | "bb-vs-btn-blueprint"> = {
  "defending-vs-cbets": {
    sections: [
      {
        heading: "Alpha and MDF, where they decide",
        blocks: [
          "The button bets into your big blind. Two numbers frame the decision. [[bluffing-math-alpha-mdf|Alpha]], bet ÷ (pot + bet), is how often a pure bluff must work. MDF, 1 − alpha, is how much of your range must continue for that bluff to stop profiting.",
          {
            list: [
              "A bet of a third of the pot, 1 into 3: alpha 1 / 4 = 25%, MDF 75%. Your call is 1 to win 4: you need 1 / 5 = 20% equity.",
              "A bet of three quarters, 3 into 4: alpha 3 / 7, about 42.9%, MDF about 57.1%. Your call needs 3 / 10 = 30%.",
            ],
          },
          "So small bets ask you to continue with much more of your range, and give you a much better price to do it with.",
          {
            checkpoint: {
              question: "The button bets a third of the pot. What share of your range does minimum defence say must continue?",
              options: ["About 57%", "75%", "80%"],
              answer: 1,
              explain: "A third of the pot is 1 into 3: alpha is 1 / (3 + 1) = 25%, so minimum defence is the other 75%.",
              math: { fn: "mdf", args: [3, 1], value: 0.75 },
              reveal: { id: "bet-math", focus: "mdf", pot: 3, bet: 1, share: 0.75 },
            },
          },
        ],
      },
      {
        heading: "Why the big blind folds more than that",
        blocks: [
          "In Rail's solves of the big blind against the button, the big blind folds more than minimum defence says, against small bets most of all. That is not a contradiction. Minimum defence is the point at which a bet with no equity stops profiting; a defender whose range holds many hands with almost no equity cannot reach it without calling with those hands, and calling with them loses more than the bluffs win.",
          "It also explains the other side: because the big blind cannot defend enough, the button profits from betting a lot of hands. Treat minimum defence as a warning light, not a target. If you fold far more than it, ask whether your folds are hands that really had nothing.",
        ],
      },
      {
        heading: "What continues against a small bet",
        blocks: [
          {
            list: [
              "Most pairs continue, mostly by calling; the weakest fold more on boards that favour the raiser, such as ace-high ones. The best top pairs, two pairs and sets often raise.",
              "Every real draw continues: flush draws and open-enders call or raise, gutshots mostly continue.",
              "Ace-high continues sometimes, more often with a backdoor draw or a gutshot.",
              "No pair, no draw: fold. Backdoor draws alone rarely carry a hand; they decide the close ones.",
            ],
          },
          "Against a big bet the same order holds with the line moved up: the weakest pairs and the weaker ace-highs drop out first.",
          {
            checkpoint: {
              question: "Big blind against the button's small bet on K♠8♦4♣. Which hand is the clearest fold?",
              options: ["5♥5♦", "7♦6♦", "Q♥3♥"],
              answer: 2,
              explain:
                "Fives are a pair: they beat the button's bluffs and continue. 7♦6♦ has a gutshot to a five and a backdoor diamond draw. Q♥3♥ has no pair and no draw at all, not even a backdoor: it rarely wins when it calls and cannot stand another bet.",
            },
          },
        ],
      },
      {
        heading: "Price and realisation",
        blocks: [
          "A call needs more than the bare price. Out of position you will not always see the river, and some of your equity is in hands that will fold to later bets. That is [[equity-realisation-and-implied-odds|realisation]]: a hand with 20% equity against a third-pot bet is not automatically a call if it can rarely get to showdown.",
          {
            note: {
              tone: "approximate",
              text: "The drills are dealt from Rail's flop library, combo for combo. Your own hands on flops the library did not solve are read from the nearest solved flop by hand category, and the analysis marks them as mapped.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Work out [[bluffing-math-alpha-mdf|alpha and MDF]] for the size you face: smaller bets demand wider defence.",
        "Against a small bet, continue with most pairs and every real draw.",
        "Fold no-pair hands without a draw; let backdoors decide only the close ones.",
        "Price is not enough out of position: count how much of your equity you will realise.",
      ],
      breaks: [
        "Against players who bet only strong hands, fold far more than any defence guide.",
        "Against players who bet every flop, call wider with ace-high and pairs.",
      ],
    },
    exercises: {
      "sizing-quiz": "Eight bet sizes: work out alpha or minimum defence before the calculator shows it.",
      "flop-defence": "Six flops from Rail's library facing the raiser's bet: fold, call or raise, graded by the solve.",
      "your-hands": "Your own flop decisions facing a bet, and your hands flagged for calling without odds or folding with them.",
    },
    checks: [
      { fn: "alpha", args: [3, 1], value: 0.25 },
      { fn: "requiredEquity", args: [4, 1], value: 0.2 },
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "mdf", args: [4, 3], value: 0.571 },
      { fn: "requiredEquity", args: [7, 3], value: 0.3 },
    ],
  },

  "check-raising": {
    sections: [
      {
        heading: "What a check-raise is for",
        blocks: [
          "A check-raise does two jobs at once. It builds a big pot with your strongest hands, and it takes the pot away from a wide betting range with hands that have equity when called. Without the first kind it is a bluff anyone can call down; without the second it is a sign that says you hold the nuts.",
          "In Rail's flop tree the raise is half the pot after the call: against a third-pot bet of about 1.8 bb into 5.5 bb, a raise to about 6.35 bb. As a bluff it needs about 46.5% folds, so the hands that raise as bluffs want equity for when they are called.",
        ],
      },
      {
        heading: "Which hands raise",
        blocks: [
          {
            list: [
              "Value: sets, two pairs, straights, and often the best top pairs.",
              "Draws: open-enders, combo draws and the strongest flush draws raise a lot; gutshots raise some of the time.",
              "Not: weak top pairs and middle pairs, which call; and no-pair hands without a draw, which fold.",
            ],
          },
          {
            checkpoint: {
              question: "Big blind on 8♥7♣3♦ facing a small bet. Which hand is the most natural check-raise that is not already strong?",
              options: ["K♣Q♣", "T♦9♦", "A♠8♦"],
              answer: 1,
              explain:
                "T♦9♦ is an open-ender: when called it still has plenty of equity, and when the bet folds it wins now. A♠8♦ is top pair with the best kicker, strong enough to raise for value but also happy to call. K♣Q♣ has two overcards and a backdoor flush draw: too little equity to raise.",
            },
          },
        ],
      },
      {
        heading: "Which boards",
        blocks: [
          "In Rail's solves the big blind check-raises most on low boards, paired boards and middling connected ones, and least on ace-high and monotone boards. The reason is the top of the ranges: on low and connected boards the big blind holds many of the sets, two pairs and straights; on ace-high boards the button holds more of the strong aces, and on monotone boards a raise folds out little and gets called by better flushes.",
          "Against small bets the big blind raises more often than against big ones: a small bet leaves more weak hands in the button's range to punish.",
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "btn-vs-bb", board: ["8h", "7c", "3d"] },
            caption: "Illustrative ranges written for teaching: who holds the strongest hands on 8♥7♣3♦.",
          },
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "The split puts your whole big-blind range facing a small bet on one of the library's flops: put each class into fold, call or raise. Then the drills deal single hands from the same spot, chosen where the solve mixes.",
          {
            note: {
              tone: "approximate",
              text: "The split and the drills come from Rail's flop library. Your own hands on flops it did not solve are read from the nearest solved flop by hand category.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Raise strong hands for value and good draws as bluffs; call the middle.",
        "Raise more on low, paired and connected boards; less on ace-high and monotone ones.",
        "Raise more against small bets than against big ones.",
        "A raise bluff wants equity when called.",
      ],
      breaks: [
        "Against players who fold too much to raises, raise more of the weaker draws.",
        "Against players who never fold an overpair, raise fewer bluffs and more thin value.",
      ],
    },
    exercises: {
      "fold-call-raise": "Three flops from Rail's library facing a small bet: sort your hand classes into fold, call and raise.",
      "raise-or-not": "Four single hands from the same spot, dealt where the solve mixes: fold, call or raise?",
      "your-hands": "Your own big-blind decisions facing a flop bet, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [1.8, 4.55], value: 6.35 },
      { fn: "alpha", args: [7.3, 6.35], value: 0.465 },
    ],
  },

  "floating-and-stabbing-ip": {
    sections: [
      {
        heading: "Calling in position",
        blocks: [
          "When you call in position, the flop is not the last chance to win the pot. You see the raiser's turn action before you decide, so hands that will often win later can call now: pairs, draws, and overcards with a backdoor. That is the value of position, paid out over the turn and river.",
          "Price it the same way. The small blind bets 2 bb into 6 bb, a third of the pot; you call 2 to win 8, and need 2 / (8 + 2) = 20% equity, before counting what position adds.",
        ],
      },
      {
        heading: "Betting when the raiser checks",
        blocks: [
          "When the raiser checks to you, its range has fewer of the hands that bet for value, but not none: out of position it checks some strong hands to protect its checks. What decides how often you bet is mostly the board.",
          "In Rail's solves of the big blind in position against the small blind's check, the big blind bets most often on low boards, where its range is strongest, and least on ace-high ones, where the small blind's checks still hold many aces. The check tells you something; the board tells you more.",
          {
            checkpoint: {
              question: "Small blind against big blind. On which flop should the big blind bet most often after the small blind checks?",
              options: ["A♠J♦4♣", "6♦5♣3♥", "K♠Q♦9♥"],
              answer: 1,
              explain:
                "The small blind checks almost everything on 6♦5♣3♥, and the big blind's range holds more of the sets, two pairs and straights there, so it can bet often. On the high boards the small blind's checks still hide many strong aces and kings, and the big blind bets less.",
            },
          },
        ],
      },
      {
        heading: "Keeping your stabs honest",
        blocks: [
          "If you only bet when you have nothing, a raiser who check-raises your stabs wins every time. Bet some strong hands too, and let some weak hands check behind and take a free card. A stab that is small and frequent on the boards that suit you, with strong hands in it, is hard to play against.",
          {
            note: {
              tone: "approximate",
              text: "The flop drills come from Rail's flop library, where the big blind in position against the small blind is the single-raised line with the caller in position. The turn drills are solved on demand from ranges narrowed through the flop.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Call in position with hands that win later: pairs, draws, overcards with backdoors.",
        "After the raiser checks, let the board decide how often you bet.",
        "Bet small and often on the boards that favour your range.",
        "Put strong hands in your stabs, so a check-raise does not beat them all.",
      ],
      breaks: [
        "Against raisers who never check strong hands, bet almost every time they check.",
        "Against raisers who check-raise a lot, stab less with nothing and more with hands that can call a raise.",
      ],
    },
    exercises: {
      "float-flops": "Three flops from Rail's library in position facing the raiser's bet: fold, call or raise.",
      "stab-flops": "Three flops in position after the raiser checks: check or bet, and how big.",
      "stab-turns": "Three turns in position after the raiser checks, solved on demand.",
      "your-hands": "Your own decisions in position as the caller, on the flop and turn, the costliest first.",
    },
    checks: [{ fn: "requiredEquity", args: [8, 2], value: 0.2 }],
  },

  "probes-and-donk-bets": {
    sections: [
      {
        heading: "Leading into the raiser",
        blocks: [
          "Leading the flop out of position as the caller is rare in Rail's solves: on most boards the big blind checks its whole range to the raiser. The raiser's range is usually stronger, and checking lets it bet its wide range into you, which you can then defend against.",
          "Where leads appear is where the board moves the top of the ranges to the caller: low boards, seven-high and below, and some paired and monotone ones. There the big blind holds more of the strong hands, and a lead can take the initiative with a mix of them and of draws.",
          {
            checkpoint: {
              question: "Big blind against the button. On which flop is a lead most likely to be part of Rail's strategy?",
              options: ["K♠Q♦4♣", "5♠4♦2♣", "A♥J♣7♦"],
              answer: 1,
              explain:
                "On 5♠4♦2♣ the big blind's suited aces, small connectors and small pairs make straights, two pairs and sets that the button rarely has. On the two high boards the button holds the stronger hands, and the big blind checks almost everything.",
            },
          },
        ],
      },
      {
        heading: "Probing the turn",
        blocks: [
          "The more common lead comes a street later. When the raiser checks back the flop, its range is capped: most of its strong hands would have bet. On the turn the big blind can bet into that capped range: value with the hands that are ahead, bluffs with draws and hands that missed.",
          "Turn cards that help the caller's range, low cards and cards that complete its draws, are the best ones to probe. Overcards that help the raiser are worse.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 4.1, share: 0.45 },
            caption: "A turn probe of three quarters of the pot into 5.5 bb: about 43% folds needed as a pure bluff.",
          },
        ],
      },
      {
        heading: "In Rail",
        blocks: [
          "The flop drill deals your first decision as the big blind: check or lead, graded by the library's solve, where leading is usually the mistake. The turn drill deals probes after a checked flop.",
          {
            note: {
              tone: "approximate",
              text: "The flop drills are from Rail's flop library; the turn drills are solved on demand from ranges narrowed through the flop. Your own hands on flops the library did not solve are read from the nearest solved flop.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Check the flop to the raiser on most boards.",
        "Lead only where the board gives you more of the strong hands: low and some paired flops.",
        "Probe the turn after the raiser checks back the flop, on cards that help your range.",
      ],
      breaks: [
        "Against raisers who check back too much, probe more turns and bigger.",
        "Against raisers who c-bet every flop, checking to them is already a fine way to take the initiative with a check-raise.",
      ],
    },
    exercises: {
      "lead-or-check": "Four flops from Rail's library, your first decision as the caller out of position: check or lead?",
      "probe-turns": "Three turns out of position as the caller, solved on demand.",
      "your-hands": "Your own first decisions as the caller out of position on the flop and turn, the costliest first.",
    },
    checks: [{ fn: "alpha", args: [5.5, 4.1], value: 0.427 }],
  },

  "bb-vs-btn-blueprint": {
    sections: [
      {
        heading: "The most common pot",
        blocks: [
          "Button opens to 2.5 bb, big blind calls: pot 5.5 bb, 97.5 bb behind. This single line is a large share of every online player's postflop hands, and everything in this module meets in it.",
          "The SPR is about 17.7. Getting all the chips in over three streets with equal bets would take bets of about 116% of the pot each time. That is why one pair rarely plays for stacks in a single-raised pot: the money goes in only when one side holds a very strong hand or the other side keeps paying.",
        ],
      },
      {
        heading: "Flop, turn, river",
        blocks: [
          {
            list: [
              "Flop: check your range. Defend against small bets with most pairs and every real draw; raise your strongest hands and best draws, more on low and connected boards.",
              "Turn after you call: keep calling with hands that improved or kept good outs; fold the weakest pairs to big bets.",
              "Turn after the button checks back: its range is capped, so probe with value and with draws.",
              "River: bluff-catch with hands that beat the button's bluffs when the price is right, and fold the ones that do not.",
            ],
          },
          {
            checkpoint: {
              question: "Big blind against the button, 97.5 bb behind a 5.5 bb pot. Roughly what equal bet on each of three streets gets all the chips in?",
              options: ["About 33% of the pot", "About 75% of the pot", "About 116% of the pot"],
              answer: 2,
              explain:
                "Each pot-sized-ish bet grows the pot by the bet twice over. With an SPR near 17.7, it takes bets a little over the pot on every street to get there, which is why a single-raised pot rarely goes all-in with one pair.",
              math: { fn: "geometricBet", args: [5.5, 97.5, 3], value: 1.16, tolerance: 0.005 },
              reveal: { id: "spr", pot: 5.5, stack: 97.5 },
            },
          },
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "The flop drill deals the big blind facing the button's bet on the library's flops; the turn and river drills come from single-raised pots solved on demand.",
          {
            note: {
              tone: "approximate",
              text: "Flop spots come from Rail's flop library; turn and river spots rest on ranges Rail narrows through the earlier streets. Your own hands on flops the library did not solve are read from the nearest solved flop.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Check the flop, defend wide against small bets, raise strong hands and good draws.",
        "Fold the weakest pairs to big turn bets; keep hands that improved or have good outs.",
        "Probe turns after the button checks back.",
        "In a single-raised pot, one pair rarely plays for stacks.",
      ],
      breaks: [
        "Against a button that opens and c-bets almost every hand, defend wider and raise more.",
        "Against a passive button that only bets strong hands, fold more to big turn and river bets.",
      ],
    },
    exercises: {
      "bb-flops": "Five flops from Rail's library, big blind against the button's bet: fold, call or raise.",
      "mixed-turns": "Three turns from single-raised pots, solved on demand.",
      "mixed-rivers": "Three rivers from single-raised pots, solved on demand.",
      "your-hands": "Your own hands as the preflop caller in single-raised pots, on any street, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [2.5, 2.5, 0.5], value: 5.5 },
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "geometricBet", args: [5.5, 97.5, 3], value: 1.16, tolerance: 0.005 },
    ],
  },
};
