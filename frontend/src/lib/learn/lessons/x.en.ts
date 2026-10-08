import type { LessonBodies } from "./types";

/**
 * Track 5 — exploits, English (Learn L4): X1 reading people, X2 the pool, X3
 * the exploit lab, X4 live and deep. Every computed number is listed in its
 * lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`.
 *
 * **The owner's rule for exploits.** A number about an opponent or "the pool"
 * comes only from the learner's own opponent statistics, read at runtime with
 * their sample size (the pool section, `lib/learn/pool.ts`), from Rail's own
 * solves (the exploit lab, at runtime; the clairvoyance toy game, worked by
 * hand here and matched by `tests/test/learnLab.test.ts`), or it is not a
 * number: theory, labelled as such. No population figure from anywhere. The
 * directions the words give ("bluff more", "bet strong hands smaller") were
 * read first from the lab over many rivers (`npm run learn:lab` from
 * `tests/`), and the deep-stack lesson's from Rail's own 200bb charts.
 */
export const xEn: LessonBodies<
  | "player-profiles"
  | "reading-hud-stats"
  | "population-exploits"
  | "exploiting-overfolders"
  | "exploiting-calling-stations"
  | "exploiting-aggressive-players"
  | "underbluffed-rivers"
  | "node-locking-in-rail"
  | "when-not-to-exploit"
  | "live-game-dynamics"
  | "straddle-preflop"
  | "straddle-postflop-low-spr"
  | "deep-stacks-200bb"
> = {
  /* ------------------------------------------------------------ X1 reading people */

  "player-profiles": {
    sections: [
      {
        heading: "Two questions about a player",
        blocks: [
          "Every label players use for each other answers two questions. How many hands does this player play? And when he plays one, does he bet and raise, or check and call? Tight or loose is the first answer, passive or aggressive the second, and the four corners are the familiar types: tight and passive, loose and passive (the calling station), tight and aggressive, loose and aggressive (the maniac, at the far end).",
          "Rail's opponents panel answers both from your own hands: how often a player puts money in and raises before the flop for the first question, and how often he bets or raises after the flop for the second. A number is only as good as the chances behind it. A player who played 40% of 100 hands could just as well be a 30% or a 50% player: the 95% interval reaches about 9.6 points either way. The next lesson does that arithmetic properly.",
          {
            widget: { id: "sample-size", share: 0.4, count: 100 },
            caption: "A stat of 40% over 100 hands. Move the hands and watch how fast the interval narrows.",
          },
        ],
      },
      {
        heading: "Each type has one main adjustment",
        blocks: [
          "A type is useful only if it changes what you do. Rail's exploit lab locks one tendency of the opponent on a river it solves and computes the best response; over many rivers the adjustments it finds are these:",
          {
            list: [
              "A player who folds too much to bets: bluff with far more of the hands that cannot win at showdown, turn weak pairs and ace-high into bluffs, and bet your strongest hands smaller.",
              "A player who calls too much: stop bluffing, bet your strong hands bigger, and bet some middle pairs you would check against the solve.",
              "A player who never raises: bet thinner, since nothing punishes a thin bet.",
              "A player who bluffs too little: fold more of your bluff-catchers.",
              "A player who bluffs too much: call down wider with your pairs and ace-high.",
            ],
          },
          {
            checkpoint: {
              question: "Against a player who calls river bets far too often, what does Rail's best response do with its missed draws?",
              options: ["Bets them big", "Checks them", "Bets them small"],
              answer: 1,
              explain:
                "A missed draw wins only when the opponent folds. Against a player who rarely folds, every bluff loses the bet most of the time, so the best response checks them and gives up — and moves the money to its value bets, which get paid more often.",
            },
          },
        ],
      },
      {
        heading: "A type is a read, not a fact",
        blocks: [
          "Putting a player in a corner is a guess about how he plays the spots you have not seen yet. Each adjustment above gives something back if the guess is wrong, and the lab measures how much (lesson X3-L1). A label made on a thin sample, or one a player has outgrown, is worse than none: the baseline is what you play while the read is unclear.",
          {
            note: {
              tone: "approximate",
              text: "The adjustments come from Rail's exploit lab: one tendency locked on a river solved on demand, the rest of the opponent's strategy kept at the solve, and the best response against it. The ranges rest on Rail's narrowing model, and a lock is a model of a player, not the player.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Ask two questions: how many hands, and how aggressively.",
        "Turn a type into one adjustment, or it is only a label.",
        "Against folders, bluff more; against callers, value bet more and bluff less.",
        "Read the sample before the number.",
      ],
      breaks: [
        "A player can be loose before the flop and tight after it: type him by the spot you are in.",
        "Players change during a session; a label from last month may be wrong tonight.",
      ],
    },
    exercises: {
      "profile-reads": "Four rivers, each with one of the five reads locked: play the hand Rail's best response plays against it.",
      "profile-quiz": "Planned: name your own opponents' types from their stats.",
    },
    checks: [{ fn: "marginOfError", args: [0.4, 100], value: 0.096 }],
  },

  "reading-hud-stats": {
    sections: [
      {
        heading: "What each number counts",
        blocks: [
          "Every stat in the opponents panel is a count over chances, and the chances are not the hands. Putting money in before the flop has a chance every hand; a 3-bet only when someone opened first; folding to a flop c-bet only when he called preflop and then faced the raiser's bet on the flop. A player you have 300 hands on may have faced a c-bet a few dozen times.",
          {
            list: [
              "Put money in and raised before the flop: a chance every hand dealt.",
              "3-bet: a chance each time someone opened before him.",
              "Folded to a 3-bet: a chance each time he raised and was 3-bet.",
              "C-bet the flop: a chance each time he raised preflop and saw the flop.",
              "Folded to a flop c-bet: a chance each time he faced one.",
              "Went to showdown and won at showdown: chances when he saw the flop, and when he reached showdown.",
              "Bet or raised after the flop: a chance at every postflop decision.",
            ],
          },
        ],
      },
      {
        heading: "How wide the truth can be",
        blocks: [
          "A stat seen p of the time over n chances can be off from the player's real frequency by about 1.96 × √(p(1 − p) / n) either way, 95 times in 100. At 30% over 50 chances that is ± 12.7 points: anything from about 17% to 43% fits. Over 500 chances it is ± 4.0.",
          "To get within ± 5 points a stat near 30% needs about 322.7 chances, call it 323. Halving the margin to ± 2.5 needs 1290.8: four times as many. Stats near the edges settle faster: 10% over 50 chances is already ± 8.3.",
          {
            widget: { id: "sample-size", share: 0.3, count: 50 },
            caption: "A stat of 30% over 50 chances. Find how many chances bring it within ± 5 points.",
          },
          {
            checkpoint: {
              question: "A player folded to 6 of the 10 flop c-bets he faced. Which is closest to the 95% interval on his folds?",
              options: ["60% ± 5 points", "60% ± 15 points", "60% ± 30 points"],
              answer: 2,
              explain: "1.96 × √(0.6 × 0.4 / 10) is about 0.30: anything from 30% to 90% fits ten chances. Ten c-bets say almost nothing.",
              math: { fn: "marginOfError", args: [0.6, 10], value: 0.304 },
            },
          },
        ],
      },
      {
        heading: "From a stat to a decision",
        blocks: [
          "A stat earns an adjustment when its whole interval sits on one side of a line that decides something. Folds to a c-bet decide whether a pure bluff of a given size profits: a half-pot bluff needs 33.3% folds. A player at 55% ± 8 is above that line; one at 40% ± 14 is not, whatever the 40% suggests.",
          "Stats that come every hand settle in a few hundred hands. Stats that need a rarer spot — folding to a 3-bet, anything on the river — need many sessions, and on one player they may never settle. The pool section below sums your own opponents, which is where rarer stats first become readable.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Count chances, not hands.",
        "Margin ≈ 1.96 × √(p(1 − p) / n); four times the chances for half the margin.",
        "Act on a stat when its whole interval clears the line that decides.",
        "Rare spots need your whole pool, not one player.",
      ],
      breaks: [
        "A stat from a different game or stake describes a different player.",
        "Players change; a big old sample can hide a recent change.",
      ],
    },
    exercises: {
      "margin-of-error": "Six sample-size questions: how wide a stat's interval is over its chances, or how many chances it needs.",
    },
    checks: [
      { fn: "marginOfError", args: [0.3, 50], value: 0.127 },
      { fn: "marginOfError", args: [0.3, 500], value: 0.04 },
      { fn: "sampleNeeded", args: [0.3, 0.05], value: 322.7 },
      { fn: "sampleNeeded", args: [0.3, 0.025], value: 1290.8 },
      { fn: "ratio", args: [1290.8, 322.7], value: 4 },
      { fn: "marginOfError", args: [0.1, 50], value: 0.083 },
      { fn: "alpha", args: [1, 0.5], value: 0.333 },
    ],
  },

  /* --------------------------------------------------------------- X2 the pool */

  "population-exploits": {
    sections: [
      {
        heading: "Start from the baseline",
        blocks: [
          "Rail's solve is the baseline: the strategy no opponent can beat by much. An exploit is a change to it against one specific mistake, and it gives up some of that safety. Without a read, the baseline is what you play: the exploit lab measures its cost against an opponent who counters it perfectly, and on the rivers Rail checked it is tiny next to what any exploit risks.",
          "So the order is fixed: baseline first, then one change, made where the evidence is.",
        ],
      },
      {
        heading: "Your pool, from your own hands",
        blocks: [
          "\"The pool\" means the players you actually meet. Rail has no figures about anybody else's pool, and this course quotes none: the section below sums your own opponents from the opponents panel, with the chances behind each stat. A read about a pool is the same arithmetic as a read about one player, over more chances.",
          "The line that decides is plain: a pure bluff of half the pot needs 33.3% folds, one of the pot 50%. If your pool's folds to a c-bet sit wholly above the first, half-pot bluffs are making money against it before anything else changes.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 10, bet: 5, share: 0.4 },
            caption: "A half-pot bluff. Set the fold rate to your own pool's number and see what the bluff earns.",
          },
        ],
      },
      {
        heading: "Follow the change through the hand",
        blocks: [
          "One read changes more than one decision. When the lab locks a river opponent to fold more to bets, the best response bluffs more — and also bets its strongest hands smaller, because the big bets that used to get paid now get folded. An adjustment you make in one place and forget in the next is half an adjustment.",
          {
            checkpoint: {
              question: "Against an opponent who folds more than the solve to every river bet size, what does Rail's best response do with its flushes and sets?",
              options: ["Bets them bigger", "Bets them smaller", "Checks them more"],
              answer: 1,
              explain:
                "The extra folds come at every size, so a big bet with the nuts gets folded more often too. The best response keeps its strong hands in the pot with smaller bets and uses the big sizes for its bluffs, which want the folds.",
            },
          },
          {
            note: {
              tone: "approximate",
              text: "From Rail's exploit lab: one tendency locked on a river solved on demand, the rest of the opponent's strategy kept at the solve. The ranges rest on Rail's narrowing model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Baseline first; change one thing, where the evidence is.",
        "A pool read is your own opponents, with their sample.",
        "Follow an adjustment to every decision it touches.",
      ],
      breaks: [
        "A different site, stake or time of day is a different pool.",
        "A regular who notices your adjustment is no longer the pool.",
      ],
    },
    exercises: {
      "pool-reads": "Four rivers, each with a read about the opponent locked: play what Rail's best response plays.",
      "your-hands": "Your own river decisions, betting first and facing bets, the costliest first.",
    },
    checks: [
      { fn: "alpha", args: [1, 0.5], value: 0.333 },
      { fn: "alpha", args: [1, 1], value: 0.5 },
    ],
  },

  "exploiting-overfolders": {
    sections: [
      {
        heading: "What a fold is worth",
        blocks: [
          "A pure bluff of b into a pot p breaks even when the opponent folds b / (p + b) of the time: a third of the pot needs 25%, half the pot 33.3%, three quarters 42.9%, the pot 50%. Every point above that line is profit. A pot-sized bluff, 10 into 10, against a player who folds 60%: 0.6 × 10 − 0.4 × 10 = 2 bb a time.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 10, bet: 10, share: 0.6 },
            caption: "A pot-sized bluff against a 60% folder. Lower the folds to 50% and the profit is gone.",
          },
        ],
      },
      {
        heading: "What Rail's best response changes",
        blocks: [
          "Lock a river opponent to fold more than the solve to every size, and the lab's best response changes three things at once. It bluffs with almost all of its hands that cannot win at showdown, and with the big sizes. It turns weak pairs and ace-high, which the solve checks, into bluffs too. And it bets its strongest hands smaller: the folds come at every size, so a big bet with the nuts would be folded more as well.",
          {
            widget: { id: "exploit-lab", preset: "overfold" },
            caption: "The lab with an over-folder locked. Move the read and run another river.",
          },
          {
            checkpoint: {
              question: "Against an over-folder, what does Rail's best response do with the weak pairs the solve checks behind?",
              options: ["Keeps checking them", "Bets many of them as bluffs", "Bets them small for value"],
              answer: 1,
              explain:
                "A weak pair wins at showdown only against air. When the opponent folds most of his hands to a bet, the pair makes more by betting and taking the pot than by showing down, so it becomes a bluff.",
            },
          },
        ],
      },
      {
        heading: "Where the folds come from, and what it costs",
        blocks: [
          "Nobody folds too much everywhere. Your own data says where: the opponents panel counts folds to a flop c-bet, and the pool section below sums them over your opponents. Bluff more where the interval clears the line, not everywhere.",
          "And count the risk. On most rivers the lab tried, the over-bluffing costs less against a player who actually plays the baseline than it gains against the folder; against a player who notices and calls it down, it costs more than it gains on almost every river. The bigger the adjustment, the more it pays to be right.",
          {
            note: {
              tone: "approximate",
              text: "From Rail's exploit lab: the read locked on a river solved on demand, the rest of the opponent's strategy kept at the solve. The ranges rest on Rail's narrowing model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A bluff of b into p needs b / (p + b) folds; everything above is profit.",
        "Against a folder, bluff with almost every hand that cannot win at showdown.",
        "Turn weak pairs and ace-high into bluffs too.",
        "Bet your strongest hands smaller: big bets get folded too.",
      ],
      breaks: [
        "A player who folds too much to small bets may call big ones: check what your data counted.",
        "Once he starts calling, go back to the baseline before the bluffs cost you.",
      ],
    },
    exercises: {
      "bluff-break-even": "Six bluffs to price: how often must the opponent fold?",
      "overfold-lock": "Four rivers against an opponent locked to fold more than the solve: play the best response's hand.",
      "your-hands": "Your own first river decisions, the costliest first.",
    },
    checks: [
      { fn: "alpha", args: [3, 1], value: 0.25 },
      { fn: "alpha", args: [2, 1], value: 0.333 },
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "alpha", args: [1, 1], value: 0.5 },
      { fn: "bluffEv", args: [10, 10, 0.6], value: 2 },
    ],
  },

  "exploiting-calling-stations": {
    sections: [
      {
        heading: "Value is the whole game",
        blocks: [
          "Against a player who calls too much, bluffs stop working and value bets work better. Bet 10 into 20 with a hand that is ahead 55% of the time it is called, against a player who calls 80%: each call wins 0.55 × 10 − 0.45 × 10 = 1 bb over checking, and 0.8 × 1 = 0.8 bb per bet. The same player folding a pot-sized bluff 25% of the time costs it 0.25 × 10 − 0.75 × 10 = −5 bb a time.",
          {
            widget: { id: "value-bet", pot: 20, bet: 10, share: 0.55 },
            caption: "A 10 bb bet into 20 bb, ahead 55% of the time when called. Lower it to 50% and the bet earns nothing.",
          },
        ],
      },
      {
        heading: "Rail's best response to a station",
        blocks: [
          "Lock a river opponent to call more than the solve at every size, and the lab's best response stops nearly all its bluffs: missed draws and hands with no pair check. Its strongest hands move to the biggest sizes, because the calls come anyway. Some middle pairs that the solve checks start to bet for value, while ace-high, which beats little that calls, checks even more.",
          {
            widget: { id: "exploit-lab", preset: "station" },
            caption: "The lab with a calling station locked.",
          },
          {
            checkpoint: {
              question: "Against a player who calls far more than the solve, which size does Rail's best response choose most with its strongest hands?",
              options: ["A third of the pot", "The pot", "All-in"],
              answer: 2,
              explain:
                "The value of a strong hand is what gets called. If the calls come whatever the size, the biggest bet collects the most, so the best response bets its nuts as big as the stacks allow.",
            },
          },
        ],
      },
      {
        heading: "A player who never raises",
        blocks: [
          "Thin value is held back by raises: every raise you must fold to costs the whole bet ([[expected-value|expected value]] counts it). Lock a river opponent to never raise, and the lab's best response bets far more of its top pairs and middle pairs: with no raise to fear, a bet that wins a little more than half the times it is called is worth making. The lesson on thin value (R1-L2) has the arithmetic.",
          {
            note: {
              tone: "approximate",
              text: "From Rail's exploit lab: the read locked on a river solved on demand, the rest of the opponent's strategy kept at the solve. The ranges rest on Rail's narrowing model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Against a station, stop bluffing.",
        "Bet your strong hands as big as the calls allow.",
        "Bet thinner for value, above all when he never raises.",
        "Check ace-high: it beats little that calls.",
      ],
      breaks: [
        "A station that folds to big bets is not a station there: check his folds by size.",
        "A player who calls the flop and turn wide may still fold the river: find which street he calls.",
      ],
    },
    exercises: {
      "station-lock": "Four rivers against an opponent locked to call more than the solve: play the best response's hand.",
      "passive-lock": "Three rivers against an opponent who never raises: play the best response's hand.",
      "value-rivers": "Four rivers in position after a check, graded by Rail's river solve: the baseline, before you adjust.",
      "your-hands": "Your own first river decisions, and the hands flagged for checking back a very strong hand.",
    },
    checks: [
      { fn: "product", args: [0.55, 10], value: 5.5 },
      { fn: "product", args: [0.45, 10], value: 4.5 },
      { fn: "sum", args: [5.5, -4.5], value: 1 },
      { fn: "product", args: [0.8, 1], value: 0.8 },
      { fn: "bluffEv", args: [10, 10, 0.25], value: -5 },
    ],
  },

  "exploiting-aggressive-players": {
    sections: [
      {
        heading: "The price of a bluff-catch",
        blocks: [
          "Facing a pot-sized river bet, 20 into 20, you call 20 to win 40: a bluff-catcher needs a third of the bets to be bluffs. Against a bettor whose bets are half bluffs, each call is worth 0.5 × 40 − 0.5 × 20 = 10 bb. Aggression that runs ahead of the hands behind it pays the players who call it.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 20, share: 0.5 },
            caption: "A pot-sized bet that is half bluffs. Move the bluffs down to a third and the call stops paying.",
          },
        ],
      },
      {
        heading: "Rail's best response to a player who bluffs too much",
        blocks: [
          "Lock a river opponent who is first to act to bet much more of his air, and the lab's best response calls far more with its middle pairs, weak pairs and ace-high: the hands that beat a bluff and nothing else. It also raises some of its own air as a bluff. The extra bets are air, and air cannot call a raise — as long as the opponent folds them, which is part of the read.",
          {
            widget: { id: "exploit-lab", preset: "maniac" },
            caption: "The lab with an over-bluffer locked.",
          },
          {
            checkpoint: {
              question: "Against an opponent who bets most of his air on the river, which of your hands gain the most calls in Rail's best response?",
              options: ["Flushes", "Middle and weak pairs", "Full houses"],
              answer: 1,
              explain:
                "Flushes and full houses call or raise against almost any bettor. The hands whose answer changes are the ones that beat only bluffs: with more bluffs in the betting range, middle and weak pairs become calls.",
            },
          },
        ],
      },
      {
        heading: "Aggression is not the same as bluffing",
        blocks: [
          "The opponents panel counts bets and raises; it cannot tell a bluff from a strong hand played fast. A player who bets a lot may simply hold a lot. The read that matters is what he shows down after betting — your own hands where you called and saw the cards — and that sample builds slowly.",
          "The turn works the same way, with one caution: Rail solves the turn with a single bet size, so the turn drills here practise calling barrels against Rail's baseline, not against a locked opponent.",
          {
            note: {
              tone: "approximate",
              text: "The lab locks the river only. Turn spots are solved with one bet size (75% of the pot) and all-in, on ranges narrowed by Rail's heuristic model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A bluff-catcher needs bluffs at the bet's price: a third of a pot-sized bet.",
        "Against an over-bluffer, call wider with pairs and ace-high.",
        "Raise some air when his extra bets are air that folds.",
        "Judge aggression by what he shows down, not by how often he bets.",
      ],
      breaks: [
        "A player who bets a lot because he holds a lot is not bluffing: check his showdowns.",
        "Against a bettor who never folds to a raise, raising air is a pure loss.",
      ],
    },
    exercises: {
      "aggro-lock": "Four rivers against an opponent locked to bet most of his air: play the best response's hand.",
      "catch-barrels": "Three turns in position facing a bet, graded by Rail's turn solve: the baseline.",
      "your-hands": "Your own turn and river decisions facing a bet, and the folds flagged as having the price to call.",
    },
    checks: [
      { fn: "requiredEquity", args: [40, 20], value: 0.333 },
      { fn: "bluffCatcherEv", args: [20, 20, 0.5], value: 10 },
    ],
  },

  "underbluffed-rivers": {
    sections: [
      {
        heading: "How many bluffs a bet needs",
        blocks: [
          "A river bet must carry enough bluffs that a bluff-catcher breaks even calling it: a third of the bets for a pot-sized bet, a quarter for a half-pot one. When a bettor carries fewer, every bluff-catcher loses by calling. Facing a pot-sized bet, 20 into 20, from a player whose bets are only 20% bluffs: 0.2 × 40 − 0.8 × 20 = −8 bb a call.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 20, share: 0.2 },
            caption: "A pot-sized bet with too few bluffs. Find the share of bluffs where calling breaks even.",
          },
        ],
      },
      {
        heading: "Rail's best response: fold more",
        blocks: [
          "Lock a river opponent to bet almost none of his air, and the lab's best response folds far more of its bluff-catchers. Middle and weak pairs fold most often of all, and even top pairs and two pairs fold more than the solve folds them. Its strongest hands keep calling and raising: they beat the value bets too.",
          {
            widget: { id: "exploit-lab", preset: "underbluff" },
            caption: "The lab with a player who rarely bluffs locked.",
          },
          {
            checkpoint: {
              question: "Against an opponent who bets almost none of his air, what happens to top pair facing his river bet in Rail's best response?",
              options: ["It calls more often", "It folds more often", "It raises more often"],
              answer: 1,
              explain:
                "Top pair beats the bluffs and some thin value. With the bluffs gone, what is left in the betting range beats it more often than the price allows, so the best response folds it more.",
            },
          },
        ],
      },
      {
        heading: "Where the evidence is",
        blocks: [
          "The opponents panel cannot see a river bluff: it counts bets, and how often a player goes to showdown and wins there, which hints at what he shows down but does not count bluffs. The direct evidence is your own hands where you called a river bet and saw the cards. Those come a few a session, so a read on one player rarely clears its interval; across your whole pool, one line can.",
          "Fold more where the evidence says so, and keep calling where a line still holds enough bluffs: folding everything turns you into the over-folder of lesson X2-L2.",
          {
            note: {
              tone: "approximate",
              text: "From Rail's exploit lab: the read locked on a river solved on demand, the rest of the opponent's strategy kept at the solve. The ranges rest on Rail's narrowing model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A pot-sized bet needs a third bluffs, a half-pot bet a quarter.",
        "Against a bettor who rarely bluffs, fold more of your pairs.",
        "Judge a river read by what you saw called down, with its sample.",
      ],
      breaks: [
        "A player who never bluffs one line may bluff another: read each line apart.",
        "Fold everything and you invite the bluffs back.",
      ],
    },
    exercises: {
      "underbluff-lock": "Four rivers against an opponent locked to bet almost none of his air: play the best response's hand.",
      "river-calls": "Four rivers in position facing a bet, graded by Rail's river solve: the baseline.",
      "your-hands": "Your own river decisions facing a bet, and the calls flagged as beating nothing.",
    },
    checks: [
      { fn: "bluffShare", args: [20, 20], value: 0.333 },
      { fn: "bluffShare", args: [20, 10], value: 0.25 },
      { fn: "bluffCatcherEv", args: [20, 20, 0.2], value: -8 },
    ],
  },

  /* ---------------------------------------------------------- X3 the exploit lab */

  "node-locking-in-rail": {
    sections: [
      {
        heading: "What a lock is",
        blocks: [
          "Rail's river solve is the baseline: both players playing as well as the solve can. A lock fixes one decision of the opponent at a number you choose — how much more or less he folds to your river bets, that he never raises, how much of his air he bets first to act — and keeps everything else he does at the solve. Rail then computes your best response: the strategy that makes the most against exactly that opponent.",
          "Keeping the rest frozen is the honest model of a read: \"I think he does this, and nothing else changes\". It is also the lab's limit. A real player who folds too much may also bluff differently; the lab does not invent that for him.",
        ],
      },
      {
        heading: "Three numbers, on a game you can check by hand",
        blocks: [
          "Take Rail's smallest test game: a pot of 10, a bet of 10, a bettor holding the nuts or nothing half the time each, and a caller with one bluff-catcher. At the baseline the caller calls half the time and the bettor bluffs half his air, worth 7.5 to him. Lock the caller to fold 75%.",
          {
            list: [
              "A bluff now earns 0.75 × 10 − 0.25 × 10 = 5, so the best response bluffs every air hand: 0.5 × 12.5 + 0.5 × 5 = 8.75.",
              "The baseline against the same caller makes 6.25 + 0.25 × 5 = 7.5, so the read gains 8.75 − 7.5 = 1.25.",
              "If the caller really plays the baseline, a bluff earns exactly nothing, and the response still makes 7.5: no cost.",
              "If the caller sees it and calls everything: 0.5 × 20 + 0.5 × −10 = 5, a cost of 7.5 − 5 = 2.5 — twice the gain.",
            ],
          },
          "Rail's lab returns exactly these numbers on this game; the tests check it.",
          {
            checkpoint: {
              question: "In that game, how much does the all-bluffs response lose against a caller who actually plays the baseline?",
              options: ["Nothing", "1.25", "2.5"],
              answer: 0,
              explain:
                "The baseline caller calls just often enough to make a bluff break even. Against him every bluff earns zero, so bluffing all the air costs nothing. The cost appears only when he adjusts — against the caller who calls everything.",
            },
          },
        ],
      },
      {
        heading: "Reading the lab on a river",
        blocks: [
          "On a real river the lab shows the same three numbers in bb per river, plus the baseline's own cost against a counter, which is small. Below them, the decisions the response changes most, hand category by hand category: what the solve plays and what the response plays. Pick a read, set its number, and run it.",
          {
            widget: { id: "exploit-lab", preset: "overfold" },
            caption: "Rail's exploit lab: a river solved in your browser, one read locked, the best response.",
          },
          {
            note: {
              tone: "approximate",
              text: "The lab works on the river: a spot dealt from the charts, ranges narrowed on the flop and turn by Rail's heuristic model, bets of 33%, 75% and 150% of the pot and all-in.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A lock is a read: one decision fixed, everything else at the solve.",
        "Read three numbers: the gain, the cost if wrong, the cost if countered.",
        "The baseline's own cost against a counter is the floor to compare with.",
      ],
      breaks: [
        "A player rarely deviates in one place only: the lab shows one read at a time.",
        "The lab covers the river; earlier streets are the baseline's.",
      ],
    },
    exercises: {
      "lock-a-node": "Six rivers, each with a read locked: play the hand Rail's best response plays against it.",
    },
    checks: [
      { fn: "product", args: [0.75, 10], value: 7.5 },
      { fn: "product", args: [0.25, 10], value: 2.5 },
      { fn: "sum", args: [7.5, -2.5], value: 5 },
      { fn: "product", args: [0.25, 10], value: 2.5 },
      { fn: "sum", args: [10, 2.5], value: 12.5 },
      { fn: "product", args: [0.5, 12.5], value: 6.25 },
      { fn: "product", args: [0.5, 5], value: 2.5 },
      { fn: "sum", args: [6.25, 2.5], value: 8.75 },
      { fn: "product", args: [0.25, 5], value: 1.25 },
      { fn: "sum", args: [6.25, 1.25], value: 7.5 },
      { fn: "sum", args: [8.75, -7.5], value: 1.25 },
      { fn: "product", args: [0.5, 20], value: 10 },
      { fn: "product", args: [0.5, -10], value: -5 },
      { fn: "sum", args: [10, -5], value: 5 },
      { fn: "sum", args: [7.5, -5], value: 2.5 },
    ],
  },

  "when-not-to-exploit": {
    sections: [
      {
        heading: "Too few chances",
        blocks: [
          "An exploit is a bet on a read, and a read on ten chances is mostly noise. Before any adjustment, put the interval on the stat and ask whether all of it sits on one side of the line that decides.",
          {
            widget: { id: "sample-size", share: 0.7, count: 10 },
            caption: "Seven folds in ten chances. Add chances until the interval clears 33%, the folds a half-pot bluff needs.",
          },
          {
            checkpoint: {
              question: "An opponent folded to 7 of the 10 c-bets he faced. Is that a read to exploit hard?",
              options: ["Yes: 70% is far above what a bluff needs", "Not yet: the interval reaches about 28 points either way"],
              answer: 1,
              explain: "1.96 × √(0.7 × 0.3 / 10) is about 0.28. Anything from about 42% to 98% fits ten chances; the read may be right, but ten chances cannot show it.",
              math: { fn: "marginOfError", args: [0.7, 10], value: 0.284 },
            },
          },
        ],
      },
      {
        heading: "The counter costs more than the gain",
        blocks: [
          "In the lab's hand-worked game (lesson X3-L1) the read gains 1.25 and a caller who notices and adjusts takes 2.5 back. On real rivers the lab finds the same shape on almost every river it tried: what an exploit loses to a counter is larger than what it gains, while the baseline's own loss to its counter is small.",
          "So an exploit pays only if the opponent is unlikely to adjust before it has paid. With those numbers, if the chance he counters is a, the read is worth (1 − a) × 1.25 − a × 2.5, which breaks even at a = 1.25 / (1.25 + 2.5), one third. Against a regular who watches you, a third is not much.",
        ],
      },
      {
        heading: "When the read is wrong",
        blocks: [
          "The other risk is a read that was never right. In the toy game a wrong read costs nothing, because the baseline caller is exactly indifferent. On real rivers the lab's best response usually loses less against the baseline opponent than it gains against the locked one — but rarely nothing, and more the further the lock is from the solve.",
          "Fall back to the baseline when the sample is thin, when the player adjusts, or when a wrong read would cost a lot. Exploit freely the players who do not adjust, on reads your own numbers support.",
          {
            note: {
              tone: "approximate",
              text: "From Rail's exploit lab: the read locked on a river solved on demand, the rest of the opponent's strategy kept at the solve; the counter is the opponent's best response to your exploit. The ranges rest on Rail's narrowing model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "No interval clear of the line, no exploit.",
        "Expect a counter to cost more than the exploit gains.",
        "Exploit hardest the players who do not adjust.",
        "When in doubt, the baseline.",
      ],
      breaks: [
        "Against a player who never adjusts, the counter never comes: lean on a good read.",
        "Some adjustments cost almost nothing if wrong: those need less certainty.",
      ],
    },
    exercises: {
      "sample-size": "Five sample-size questions: is the stat's interval narrow enough to act on?",
      "exploit-or-not": "Four rivers with a read locked: play the best response, then read what it risks.",
    },
    checks: [
      { fn: "sum", args: [1.25, 2.5], value: 3.75 },
      { fn: "ratio", args: [1.25, 3.75], value: 0.333 },
    ],
  },

  /* ----------------------------------------------------------- X4 live and deep */

  "live-game-dynamics": {
    sections: [
      {
        heading: "Bigger opens",
        blocks: [
          "Live games open bigger than online ones. An open of 5 bb into blinds of 1.5 bb risks 5 to win 1.5: on its own it needs everybody to fold 5 / 6.5 = 76.9% of the time, where an online open of 2.5 bb needs 2.5 / 4 = 62.5%. A bigger open has to win more often uncontested, or win more after the flop.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 1.5, bet: 5, share: 0.77 },
            caption: "A 5 bb open into 1.5 bb of blinds. Set it to 2.5 bb and compare.",
          },
          {
            checkpoint: {
              question: "How often must everyone fold for a 5 bb open into 1.5 bb of blinds to break even on its own?",
              options: ["62.5%", "76.9%", "50%"],
              answer: 1,
              explain: "Risk over risk plus reward: 5 / (5 + 1.5) is about 76.9%.",
              math: { fn: "ratio", args: [5, 6.5], value: 0.769 },
            },
          },
        ],
      },
      {
        heading: "Deep, uneven stacks",
        blocks: [
          "Live stacks are often deep and uneven. A 5 bb open called by the big blind with 200 bb stacks makes a pot of 5 + 5 + 0.5 = 10.5 with 195 behind: an SPR of 18.57. Online, a 2.5 bb open called at 100 bb makes 5.5 with 97.5 behind, 17.73. The bigger open keeps the SPR about where the deeper stacks would push it; always count it against the shorter of the two stacks in the hand.",
          {
            widget: { id: "spr", pot: 10.5, stack: 195 },
            caption: "The live pot: a 5 bb open called, 200 bb deep.",
          },
        ],
      },
      {
        heading: "Pace, rake, the pot and showing a bluff",
        blocks: [
          "Live play deals far fewer hands an hour, so every stat takes longer to mean anything: a stat near 30% needs about 323 chances for ± 5 points (lesson X1-L2), and live that is many sessions. Rake is set by the room; Rail's charts assume their own rake profile, so a very different rake shifts the thinnest opens and defends. Keep count of the pot in chips street by street: every price in this course starts from it.",
          "Showing a bluff is an exploit with a short life: it tells observant players something true about you, and they adjust. Against players who do not watch, it changes nothing.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Price a live open by risk over risk plus blinds.",
        "Count the SPR against the shorter stack in the hand.",
        "Live samples take sessions: trust the baseline longer.",
        "Track the pot in chips on every street.",
      ],
      breaks: [
        "A table that calls every open makes fold equity irrelevant: open for value.",
        "Players who never watch showdowns ignore what you show.",
      ],
    },
    exercises: {
      "live-spr": "Five SPRs to work out from a pot and the stacks behind.",
      "live-steal": "Five opens to price: how often must everyone fold?",
      "pot-tracking": "Planned: a live-style hand where you keep track of the pot.",
    },
    checks: [
      { fn: "ratio", args: [2.5, 4], value: 0.625 },
      { fn: "sum", args: [5, 5, 0.5], value: 10.5 },
      { fn: "spr", args: [195, 10.5], value: 18.57 },
      { fn: "spr", args: [97.5, 5.5], value: 17.73 },
      { fn: "sampleNeeded", args: [0.3, 0.05], value: 322.7 },
    ],
  },

  "straddle-preflop": {
    sections: [
      {
        heading: "What a straddle changes",
        blocks: [
          "A straddle is a voluntary blind of 2 bb posted before the cards, usually under the gun. The pot starts at 0.5 + 1 + 2 = 3.5 bb, the straddler acts last before the flop, and every stack is worth half as many of the new big blind: 100 bb is 50 straddles. The game plays like a shallower one with more dead money in the middle.",
          {
            checkpoint: {
              question: "With an under-the-gun straddle, who acts last before the flop?",
              options: ["The big blind", "The straddler", "The button"],
              answer: 1,
              explain: "The straddle is the biggest blind, so the action ends with it: the straddler acts after the big blind, like a big blind of his own.",
            },
          },
        ],
      },
      {
        heading: "Opening into a straddle",
        blocks: [
          "Opens scale with the straddle. An open to 6 bb risks 6 to win the 3.5 in the middle and needs everyone to fold 6 / 9.5 = 63.2% on its own — about what 2.5 bb into 1.5 bb needs without a straddle. The positions shift by one: the seat after the straddler is the first to open.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 3.5, bet: 6, share: 0.63 },
            caption: "A 6 bb open into a straddled pot of 3.5 bb.",
          },
        ],
      },
      {
        heading: "Defending the straddle, and the blinds",
        blocks: [
          "The straddler facing a 6 bb open with everyone else folded calls 4 to win a pot of 9.5: the call needs 4 / 13.5 = 29.6% of the pot after it. He defends like a big blind, with position on the blinds but less behind in straddles. The small blind is out of position against everyone and plays tighter; straddled games also see more callers, so more pots go multiway.",
          {
            note: {
              tone: "conceptual",
              text: "Rail has no straddle charts, so the straddled ranges are taught in words. The chart sets at shallower depths are the nearest Rail has, but they are not straddled games.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Count the stacks in straddles: 100 bb is 50.",
        "Scale the opens with the straddle and price them the same way.",
        "Defend the straddle like a big blind with less behind.",
      ],
      breaks: [
        "A table where everyone calls opens is a multiway game: value over steals.",
        "A button straddle changes who acts last again: count the positions afresh.",
      ],
    },
    exercises: {
      "straddle-steal": "Six opens into blinds and straddles: how often must everyone fold?",
      "straddle-price": "Five calls to price against a bet: how much equity do they need?",
      "straddle-charts": "Planned: paint a straddled seat's range once Rail has straddle charts.",
    },
    checks: [
      { fn: "sum", args: [0.5, 1, 2], value: 3.5 },
      { fn: "ratio", args: [100, 2], value: 50 },
      { fn: "ratio", args: [6, 9.5], value: 0.632 },
      { fn: "requiredEquity", args: [9.5, 4], value: 0.296 },
    ],
  },

  "straddle-postflop-low-spr": {
    sections: [
      {
        heading: "Pots get big before the flop",
        blocks: [
          "A straddled pot is big before the flop starts. An open to 6 bb called by the straddler and one more player puts 6 × 3 + 0.5 + 1 = 19.5 bb in the middle with 94 bb behind: an SPR of 4.82. That is the SPR of a 3-bet pot, reached without a 3-bet.",
          {
            widget: { id: "spr", pot: 19.5, stack: 94 },
            caption: "A straddled flop: 19.5 bb in the pot, 94 bb behind.",
          },
        ],
      },
      {
        heading: "Commitment at a low SPR",
        blocks: [
          "At an SPR near 5, three bets of about 60% of the pot each get the stacks in by the river; two streets need bets of about 113%. A top pair with a good kicker or an overpair plans to get the money in, because folding it later wastes the pot it built. [[equity-realisation-and-implied-odds|Implied odds]] shrink: with so little behind, a draw wins little more when it hits than the pot already offers.",
          {
            checkpoint: {
              question: "A straddled pot, SPR near 5, top pair with a good kicker on a dry flop. What is the plan?",
              options: ["Get the stacks in over the streets", "Check, and fold to a raise", "Bet once, then give up"],
              answer: 0,
              explain: "Bets of about 60% of the pot on each street put the stacks in by the river. A hand this strong at this SPR wins too often to fold after the money is in the middle.",
            },
          },
        ],
      },
      {
        heading: "Draws, and more players",
        blocks: [
          "More callers before the flop mean more multiway flops. A bluff into two players who each fold half the time succeeds 0.5 × 0.5 = 25% of the time, and a bet into two has to be defended by both: the multiway lessons (F5) price it. The river drills here use 3-bet pots, the nearest SPR Rail solves.",
          {
            note: {
              tone: "approximate",
              text: "Rail does not analyse straddled pots. The drills deal 3-bet-pot rivers, whose SPR is close; their ranges come from the charts, narrowed by Rail's heuristic model.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Count the SPR on every straddled flop; it is often a 3-bet pot's.",
        "At SPR near 5, top pair and overpairs plan to get the stacks in.",
        "Draws lose implied odds when little is behind.",
      ],
      breaks: [
        "Deep straddled games keep a higher SPR: count, do not assume.",
        "Multiway, top pair is weaker: commit less readily into two players.",
      ],
    },
    exercises: {
      "low-spr": "Six SPRs to work out from a pot and the stacks behind.",
      "low-spr-rivers": "Three 3-bet-pot rivers, the nearest SPR Rail solves, graded by Rail's river solve.",
    },
    checks: [
      { fn: "sum", args: [18, 0.5, 1], value: 19.5 },
      { fn: "spr", args: [94, 19.5], value: 4.82 },
      { fn: "geometricBet", args: [19.5, 94, 3], value: 0.6 },
      { fn: "geometricBet", args: [19.5, 94, 2], value: 1.13 },
      { fn: "allFold", args: [0.5, 2], value: 0.25 },
    ],
  },

  "deep-stacks-200bb": {
    sections: [
      {
        heading: "What deep stacks reward",
        blocks: [
          "At 200 bb a single-raised pot starts deep: a 2.5 bb open called by the big blind leaves 197.5 bb behind a pot of 5.5, an SPR of 35.9, about twice the 17.7 of 100 bb. With that much behind, the hands that can make the nuts win big pots and one pair wins small ones: a top pair that is good at 100 bb is often a hand to keep the pot small with at 200.",
          {
            widget: { id: "spr", pot: 5.5, stack: 197.5 },
            caption: "A single-raised pot at 200 bb. Halve the stack and compare.",
          },
        ],
      },
      {
        heading: "Rail's 200 bb charts",
        blocks: [
          "Rail's charts at 200 bb, solved like the 100 bb set with deeper stacks, open more hands from the early seats, and the gain is concentrated: far more suited aces and a few more suited connectors, while offsuit broadway hands barely change. From the button the opening range barely moves, and the big blind's defence against a button open is nearly the same. The chart quizzes below deal from that set.",
          {
            checkpoint: {
              question: "In Rail's charts, which hands does under the gun open much more often at 200 bb than at 100 bb?",
              options: ["Offsuit broadway hands", "Suited aces", "Offsuit aces"],
              answer: 1,
              explain:
                "A suited ace can make the nut flush, and deep stacks pay the nuts. Offsuit broadways mostly make one pair, which deep stacks do not pay more, so Rail's charts leave them about where they were.",
            },
          },
        ],
      },
      {
        heading: "Bigger bets to get the stacks in",
        blocks: [
          "Three equal bets that get 197.5 bb in over the flop, turn and river from a pot of 5.5 must each be about 159% of the pot; at 100 bb, about 116%. Deep, either the bets get bigger or the stacks do not go in: plans with the nuts start earlier and size up, and one-pair hands stop at a pot they can stand.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Count the SPR: 200 bb single-raised pots are about twice as deep.",
        "Deep stacks pay the hands that make the nuts.",
        "Keep pots with one pair small when deep.",
        "Size up early with the nuts if you want the stacks in.",
      ],
      breaks: [
        "Only the effective stack counts: a short stack at the table plays at its own depth.",
        "Against players who pay off one pair, value bets get thicker even deep.",
      ],
    },
    exercises: {
      "deep-opens": "Twelve first-in spots dealt from Rail's 200 bb charts, graded as the analysis grades them.",
      "deep-defence": "Twelve spots facing an open, dealt from Rail's 200 bb charts.",
      "spr-toggle": "Planned: sort the same flop range at 200 bb and at 100 bb, once Rail's flop library covers 200 bb.",
    },
    checks: [
      { fn: "spr", args: [197.5, 5.5], value: 35.9 },
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "geometricBet", args: [5.5, 197.5, 3], value: 1.59 },
      { fn: "geometricBet", args: [5.5, 97.5, 3], value: 1.16 },
    ],
  },
};
