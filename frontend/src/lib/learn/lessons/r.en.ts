import type { LessonBodies } from "./types";

/**
 * Track 4 — the river, English (Learn L3): R1 betting the river, R2 facing
 * river bets, R3 the river in 3-bet pots. Every computed number is listed in
 * its lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`. No solver frequency is written into the text:
 * the splits, paints and drills show Rail's own river solves at runtime, and
 * every direction the words give was read first from those solves
 * (`tests/scripts/learn-directions`, `npm run learn:directions`).
 */
export const rEn: LessonBodies<
  "river-polarisation" | "thin-value" | "choosing-bluffs-blockers" | "river-sizing" | "bluff-catching" | "facing-river-raises" | "3bp-river"
> = {
  "river-polarisation": {
    sections: [
      {
        heading: "A value bet must be called by worse",
        blocks: [
          "On the river no card is left to come. A bet can only win more than a check in two ways: a worse hand calls, or a better hand folds. Compare it with checking down. Say you bet 10 bb into 20 bb and are called. When you are ahead you win 10 bb more than a check would; when you are behind you lose 10 bb more.",
          "If you are ahead 60% of the times you are called, each call earns 0.6 × 10 − 0.4 × 10 = 6 − 4 = 2 bb over checking. At 50% it earns nothing, and below 50% the bet loses. A value bet has to win more than half the time it is called — against the hands that call, not against the whole range.",
          {
            widget: { id: "value-bet", pot: 20, bet: 10, share: 0.5 },
            caption: "A 10 bb bet into 20 bb. Move how often you win when called past 50% and back.",
          },
        ],
      },
      {
        heading: "Why river ranges split",
        blocks: [
          "Put that together across a range and it splits in three. Strong hands bet: worse hands call them. Hands with no showdown value bet some of the time: checking never wins with them, so they are the bluffs. The middle — second pairs, weak pairs, ace-high — checks: a bet would be called only by better and fold out only worse.",
          "Rail's river solves show exactly that shape. In position after a check, the strongest classes bet most of the time, middle and weak pairs check most often of all, ace-high checks far more than hands with no pair, and missed draws and no-pair hands bet a large share.",
          {
            checkpoint: {
              question: "In position on the river, checked to, which class does Rail's solve check most often?",
              options: ["A flush", "A second pair", "A missed straight draw with no pair"],
              answer: 1,
              explain:
                "The flush bets for value. The missed draw can only win by betting, so it bluffs part of the time. The second pair beats the bluffs that would call and loses to the value that would, so a bet gains nothing: it checks and wins at showdown when it is ahead.",
            },
          },
        ],
      },
      {
        heading: "How many bluffs",
        blocks: [
          "A polarised range needs bluffs, or nobody calls its value. How many? Enough that a hand which beats only the bluffs breaks even calling. For a bet of the pot, 20 into 20, the caller risks 20 to win 40, so bluffs must be 20 / (20 + 40), about a third of the bets. For half the pot, 10 into 20, it is 10 / (20 + 20) = 25%.",
          "Bigger bets carry more bluffs; smaller ones fewer. That is the bridge to sizing, lesson R1-L4.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 20, share: 0.33 },
            caption: "A pot-sized river bet. Change the bluff share to see where a bluff-catcher's call turns from losing to winning.",
          },
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' preflop ranges narrowed on the flop and turn by Rail's heuristic model, solved with bets of 33%, 75% and 150% of the pot and all-in. The split, the paint and the drills read the same solve that grades the analysis' rivers.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bet for value only when you win more than half the time you are called.",
        "Bet the strong, check the middle, bluff with hands that cannot win by checking.",
        "Ace-high and weak pairs check far more often than hands with no pair at all.",
        "Bigger bets need more bluffs: a pot-sized bet about one in three.",
      ],
      breaks: [
        "Against a player who calls with any pair, the middle becomes thin value and bluffs shrink.",
        "Against one who folds too much, bluff more of the hands that cannot win by checking.",
      ],
    },
    exercises: {
      "river-split": "Three rivers in position after a check: put each hand class into check, small, big or overbet, graded class by class.",
      "paint-the-bets": "Two rivers in position after a check: paint the hands of your range that Rail's solve bets, graded hand by hand.",
      "river-basics": "Five river decisions of any kind, graded by Rail's river solve.",
      "your-hands": "Your own first river decisions, the costliest first.",
    },
    checks: [
      { fn: "product", args: [0.6, 10], value: 6 },
      { fn: "product", args: [0.4, 10], value: 4 },
      { fn: "sum", args: [6, -4], value: 2 },
      { fn: "bluffShare", args: [20, 20], value: 0.333 },
      { fn: "bluffShare", args: [20, 10], value: 0.25 },
    ],
  },

  "thin-value": {
    sections: [
      {
        heading: "What thin means",
        blocks: [
          "A thin value bet is one that wins only a little more than half the time it is called. It is worth making, because a little edge on every call adds up, and missing it is a quiet leak: checking back a hand that would have been paid shows up in no single hand as a loss.",
          "Count it. You bet 7 bb into 20 bb with a top pair. The opponent calls 60% of the time and you are ahead of 60% of the calls. Per call you win 7 bb six times in ten and lose it four: 0.6 − 0.4 = 0.2 of the bet, 1.4 bb. Called 60% of the time, that is 0.6 × 1.4 = 0.84 bb per bet over checking.",
          {
            widget: { id: "value-bet", pot: 20, bet: 7, share: 0.6 },
            caption: "A 7 bb bet into 20 bb, called 60% of the time. Move how often you are ahead of the calls.",
          },
        ],
      },
      {
        heading: "Size it small",
        blocks: [
          "The thinner the value, the smaller the bet. A small bet is called by more of the hands you beat, and costs less when it runs into better. Rail's solves agree: in position after a check its top pairs bet about half the time, and the small size is a far larger share of their bets than of its strongest hands'; out of position, as the first to act, it bets its top pairs mostly small.",
          {
            checkpoint: {
              question: "Out of position on the river, first to act with a top pair, which size does Rail's solve choose most often when it bets?",
              options: ["A third of the pot", "Three quarters of the pot", "One and a half pots"],
              answer: 0,
              explain:
                "A top pair is ahead of many hands that call a small bet and of few that call a big one. Out of position it also cannot be sure of a bet behind, so it bets small to be called by worse pairs, and checks the rest.",
            },
          },
        ],
      },
      {
        heading: "When a raise makes it too thin",
        blocks: [
          "Every raise you must fold to costs the bet. If the opponent in the example also raises 5% of the time and you fold, each raise costs at least the 7 bb: 0.05 × 7 = 0.35 bb, which leaves 0.84 − 0.35 = 0.49 bb. Raise more often, or call more rarely, and the thin bet turns into a loss.",
          "That is why thin value goes thinner against passive players and less thin against players who raise the river: the same hand is a bet against one and a check against the other.",
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' ranges narrowed on the flop and turn by Rail's heuristic model, with bets of 33%, 75% and 150% of the pot and all-in. The drills deal hands where Rail's solve mixes, which is where thin value lives.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bet whenever you win more than half the times you are called, even by a little.",
        "Thin value bets small.",
        "Every raise you must fold to costs the whole bet: count it.",
        "Do not check back a strong hand that would be paid.",
      ],
      breaks: [
        "Against a passive caller, bet thinner and a little bigger.",
        "Against a frequent river raiser, check more of your thinnest bets.",
      ],
    },
    exercises: {
      "thin-rivers": "Five rivers in position after a check, dealt hands where Rail's solve mixes: check, or which size?",
      "thin-first": "Three rivers out of position, first to act, dealt hands where the solve mixes.",
      "your-hands": "Your own first river decisions, and the hands flagged for checking back a very strong hand, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [0.6, -0.4], value: 0.2 },
      { fn: "product", args: [0.2, 7], value: 1.4 },
      { fn: "product", args: [0.6, 1.4], value: 0.84 },
      { fn: "product", args: [0.05, 7], value: 0.35 },
      { fn: "sum", args: [0.84, -0.35], value: 0.49 },
    ],
  },

  "choosing-bluffs-blockers": {
    sections: [
      {
        heading: "Bluff with what cannot win by checking",
        blocks: [
          "The first question about a bluff is what the hand loses by not checking. Ace-high and small pairs sometimes win at showdown; a hand with no pair at all never does. So the hands with the least showdown value make the first bluffs, and the hands with some keep checking.",
          "Rail's river solves say the same. In position after a check, and even more out of position, ace-high checks far more often than hands with no pair, which make up most of the bluffs.",
          {
            checkpoint: {
              question: "In position on the river, checked to, which does Rail's solve bluff with more often?",
              options: ["Ace-high", "King-high with no pair and no draw"],
              answer: 1,
              explain:
                "Ace-high wins some showdowns against the missed draws and weak hands that checked to it; checking keeps those wins. King-high almost never wins by checking, so betting costs it nothing it had.",
            },
          },
        ],
      },
      {
        heading: "Counting combinations",
        blocks: [
          "To choose among bluffs you need to count hands, and [[combos-and-card-removal|combinations and card removal]] are how. A pair has 6 combinations, a suited hand 4, an offsuit hand 12. Ace-king, suited and offsuit, is 4 × 4 = 16.",
          "Every card you can see removes the combinations that need it. Hold one ace and only 3 × 4 = 12 ace-kings are left. On a king-high board three kings are left, and any two make a set: 3 × 2 / 2 = 3 combinations; hold a king yourself and only 2 × 1 / 2 = 1 is left.",
          {
            widget: { id: "combos", preset: "sets-k72", hand: ["Kh", "Qd"] },
            caption: "Sets on K♦7♣2♥ with K♥Q♦ in your hand: watch the kings' combinations drop.",
          },
        ],
      },
      {
        heading: "Block the calls, leave the folds",
        blocks: [
          "A bluff works when the other player folds. So the best bluffs hold cards from the hands that would call — removing some of them — and none from the hands that would fold. A bluff holding a card of the top pair the opponent would call with makes that call less likely; a bluff holding a card of the missed draws that would fold makes the folds less likely.",
          "Card removal is one effect among several, and the solve weighs them all at once: showdown value, what the hand blocks, and what the line says. Two hands that look alike can play differently for that reason; the drills deal you those hands.",
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' ranges narrowed on the flop and turn by Rail's heuristic model, with bets of 33%, 75% and 150% of the pot and all-in.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bluff first with hands that cannot win by checking.",
        "Count combinations: 6 for a pair, 4 suited, 12 offsuit; every visible card removes some.",
        "Prefer bluffs that hold cards of the hands that call.",
        "Avoid bluffs that hold cards of the hands that fold.",
      ],
      breaks: [
        "Against a player who never folds a pair, stop bluffing whatever you hold.",
        "Against one who folds everything but the nuts, any hand with no showdown value will do.",
      ],
    },
    exercises: {
      "count-combos": "Six counts of how many combinations of a hand your opponent can still hold, with the cards you can see removed.",
      "bluff-rivers": "Five rivers in position after a check, dealt hands where Rail's solve mixes: bluff or check?",
      "your-hands": "Your own first river decisions, the costliest first.",
    },
    checks: [
      { fn: "product", args: [4, 4], value: 16 },
      { fn: "product", args: [3, 4], value: 12 },
      { fn: "product", args: [3, 2], value: 6 },
      { fn: "ratio", args: [6, 2], value: 3 },
      { fn: "product", args: [2, 1], value: 2 },
      { fn: "ratio", args: [2, 2], value: 1 },
    ],
  },

  "river-sizing": {
    sections: [
      {
        heading: "Size follows the shape of the range",
        blocks: [
          "A river bet size is a choice about which range you bet with. A polarised range — the strongest hands and bluffs — wants a big bet: the strong hands are paid more, and a bluff-catcher facing it has to decide for a lot. A range of thinner value hands wants a small one: it is called by the worse hands it beats.",
          "Rail's river solves, which can bet a third, three quarters or one and a half pots or go all-in, sort the classes that way. The strongest hands use the big sizes and the overbet most; for top pairs and two pairs the small size is a far larger share of their bets; the bluffs bet big alongside the nuts.",
        ],
      },
      {
        heading: "The price of each size",
        blocks: [
          "A bluff of a third of the pot, 6.6 bb into 20 bb, needs folds about 24.8% of the time. An overbet of 30 bb into 20 bb needs 30 / 50 = 60%, and the caller must defend only 20 / 50 = 40% of its range to stop it.",
          "So an overbet only works where the caller's range is full of hands that must fold to it: when it is capped. In position after a check is the usual place, and Rail's solve overbets there noticeably more often than out of position as the first to act.",
          {
            widget: { id: "bet-math", focus: "mdf", pot: 20, bet: 30 },
            caption: "An overbet of 30 bb into 20 bb. Try a third of the pot, then the pot, and see how the defence asked of the caller moves.",
          },
        ],
      },
      {
        heading: "Why the nuts sometimes bet small",
        blocks: [
          "If every small bet were thin value, the opponent could raise it every time. Rail's solve keeps some of its strongest hands in the small size for that reason: the small bet carries a few hands that are happy to be raised.",
          {
            checkpoint: {
              question: "Why does Rail's river solve bet some of its strongest hands small?",
              options: [
                "Because small bets win more from strong hands",
                "So that the small-bet range is not only thin value that a raise would punish",
                "Because the solve cannot bet them big",
              ],
              answer: 1,
              explain:
                "Most of the strongest hands do bet big. A few in the small size protect it: a raise against a small bet now sometimes runs into the nuts, so the opponent cannot raise it freely.",
            },
          },
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' ranges narrowed on the flop and turn by Rail's heuristic model, with bets of 33%, 75% and 150% of the pot and all-in. The split groups them as small (up to half the pot), big (up to the pot) and overbet.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Polarised range, big bet; thin value, small bet.",
        "Overbet when the other range is capped and yours holds the nuts.",
        "A third-pot bluff needs about a quarter of folds; an overbet of one and a half pots needs 60%.",
        "Keep a few strong hands in the small size.",
      ],
      breaks: [
        "Against a player who calls any size with any pair, size up your value and stop overbet bluffs.",
        "Against one who folds to big bets and calls small ones, bluff big and value-bet small.",
      ],
    },
    exercises: {
      "sizing-split": "Three rivers in position after a check: put each hand class into check, small, big or overbet, graded class by class.",
      "sizing-rivers": "Five river decisions, dealt hands where Rail's solve mixes its sizes.",
      "your-hands": "Your own first river decisions, the costliest first.",
    },
    checks: [
      { fn: "alpha", args: [20, 6.6], value: 0.248 },
      { fn: "alpha", args: [20, 30], value: 0.6 },
      { fn: "mdf", args: [20, 30], value: 0.4 },
      { fn: "sum", args: [20, 30], value: 50 },
    ],
  },

  "bluff-catching": {
    sections: [
      {
        heading: "The price of a call",
        blocks: [
          "A bluff-catcher beats every bluff and loses to every value bet. Whether it calls is a question about the betting range, and the price tells you how many bluffs it must hold. Facing 15 bb into 20 bb, you call 15 to win 35: you need to win 15 / (35 + 15) = 30% of the time.",
          "Bigger bets ask more: 30 bb into 20 bb asks for 30 / 80, 37.5%. Smaller ones less: a third of the pot, 6.6 bb into 20 bb, about 19.9%.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 35, bet: 15 },
            caption: "Calling 15 bb into a pot of 35 bb. Move the bet to a third of the pot and to an overbet.",
          },
        ],
      },
      {
        heading: "Count value and bluffs",
        blocks: [
          "Then count the line. Say the hands that bet the river this way are 10 combinations of value and 5 of bluffs: a third bluffs, more than the 30% the price asks. Calling 15 into 20 wins 35 a third of the time and loses 15 two thirds: about +1.67 bb a call.",
          "Your own cards change the count. Holding a card of the opponent's value hands removes some of them and makes the call better; holding a card of the missed draws they bluff with removes bluffs and makes it worse. Minimum defence, here 20 / 35, about 57%, says how much of your whole range must continue; it does not say which hands.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 15, share: 0.33 },
            caption: "15 bb into 20 bb. Change the bluff share and see where the call starts to win.",
          },
        ],
      },
      {
        heading: "Bigger bets, more folds",
        blocks: [
          "Rail's river solves fold more of the middle as the bet grows. Against a third of the pot most middle pairs call; against three quarters most of them fold; against one and a half pots more still, and the strong hands carry most of the defence.",
          {
            checkpoint: {
              question: "In position on the river facing a bet, which size makes Rail's solve fold its middle pairs most often?",
              options: ["A third of the pot", "Three quarters of the pot", "One and a half pots"],
              answer: 2,
              explain:
                "An overbet asks for 37.5% equity against a range that holds the nuts more often. The bettor's range is polarised, so a middle pair beats only the bluffs, and there are not enough of them for its price.",
            },
          },
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' ranges narrowed on the flop and turn by Rail's heuristic model, with bets of 33%, 75% and 150% of the pot and all-in. The paint asks for the hands that call or raise.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Price first: the call divided by the pot after it.",
        "Count the line's value and bluffs, then adjust for the cards you hold.",
        "Minimum defence is how much of the range continues, not which hands.",
        "The bigger the bet, the more of your middle folds.",
      ],
      breaks: [
        "Against a player who never bluffs the river, fold every bluff-catcher.",
        "Against one who bluffs every missed draw, call more of the middle.",
      ],
    },
    exercises: {
      "price-the-call": "Five river prices to work out before the calculator shows them.",
      "paint-the-calls": "Two rivers facing a bet: paint the hands of your range that Rail's solve calls or raises, graded hand by hand.",
      "catch-rivers": "Five rivers in position facing a bet: fold, call or raise, graded by Rail's river solve.",
      "your-hands": "Your own river decisions facing a bet, the costliest first, and hands flagged for calls or folds the analysis questioned.",
    },
    checks: [
      { fn: "requiredEquity", args: [35, 15], value: 0.3 },
      { fn: "requiredEquity", args: [50, 30], value: 0.375 },
      { fn: "requiredEquity", args: [26.6, 6.6], value: 0.199 },
      { fn: "bluffCatcherEv", args: [20, 15, 0.3333], value: 1.67, tolerance: 0.01 },
      { fn: "mdf", args: [20, 15], value: 0.57, tolerance: 0.005 },
    ],
  },

  "facing-river-raises": {
    sections: [
      {
        heading: "A raise is strong",
        blocks: [
          "When your river bet is raised, the opponent is telling you their range has narrowed to hands that beat the ones you bet for value, plus whatever bluffs they choose. In Rail's river solves the raising range is mostly strong made hands, and the answer to it is folding: when its own bet is raised, the solve folds about two thirds of its top pairs and two pairs.",
          "The price looks tempting. You bet 15 bb into 20 bb and are raised to 52.5 bb. The pot is 20 + 15 + 52.5 = 87.5 bb and you must call 52.5 − 15 = 37.5 bb more: you need 37.5 / 125 = 30%. But a call needs that much against a range that is mostly better, and one pair rarely has it.",
        ],
      },
      {
        heading: "Which hands continue",
        blocks: [
          "The hands that continue are the ones that beat some of the raising range: straights and flushes continue more often than they fold, and the very top — full houses and better — re-raise a good part of the time.",
          "The size you bet matters too. A small bet invites raises: Rail's solve raises small river bets much more often than big ones, and its raises against small bets include more bluffs. Against an overbet, a raise is close to the nuts.",
          {
            checkpoint: {
              question: "Against which of your river bet sizes does Rail's solve raise most often?",
              options: ["A third of the pot", "Three quarters of the pot", "One and a half pots"],
              answer: 0,
              explain:
                "A small bet holds many thin value hands that cannot stand a raise, and the raise is cheap relative to the pot. Against a big bet the range is polarised and strong, and raising it takes the nuts.",
            },
          },
        ],
      },
      {
        heading: "Folding is not weakness",
        blocks: [
          "The price alone never decides a call against a raise: the range does. When the line says the raise is value, fold your one-pair hands without regret, and keep calling with the hands that beat its value as well as its bluffs.",
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' ranges narrowed on the flop and turn by Rail's heuristic model, with bets of 33%, 75% and 150% of the pot, raises of three quarters of the pot and all-in, at most two raises.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Read a river raise as strong: fold most one-pair hands.",
        "Continue with hands that beat part of the value, not just the bluffs.",
        "Re-raise only the very top.",
        "Small bets are raised more often, and with more bluffs, than big ones.",
      ],
      breaks: [
        "Against a player who raises every river as a bluff, call down more.",
        "Against one who never raises without the nuts, fold even strong hands.",
      ],
    },
    exercises: {
      "vs-raise-split": "Three rivers where your bet is raised: put each hand class into fold, call or raise, graded class by class against Rail's river solve.",
      "your-hands": "Your own river decisions facing a raise, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [20, 15, 52.5], value: 87.5 },
      { fn: "sum", args: [52.5, -15], value: 37.5 },
      { fn: "requiredEquity", args: [87.5, 37.5], value: 0.3 },
    ],
  },

  "3bp-river": {
    sections: [
      {
        heading: "The stack is the only size",
        blocks: [
          "Follow the 3-bet pot of lesson T3 to the river: 85.3 bb in the pot and 57.6 bb behind. The all-in is about 0.68 of the pot. There is no room left for small value bets and big bluffs as separate sizes; most of the betting is the shove.",
          "As a pure bluff, the shove needs folds 57.6 / (85.3 + 57.6), about 40.3% of the time. Calling it needs 57.6 / (142.9 + 57.6), about 28.7%, and minimum defence is 85.3 / 142.9, about 60%.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 85.3, bet: 57.6, share: 0.4 },
            caption: "A 57.6 bb shove into 85.3 bb. Move the fold rate to see where a bluff starts to profit.",
          },
        ],
      },
      {
        heading: "Polarised all-ins",
        blocks: [
          "In Rail's solves of the 3-bettor in position after a check, the all-in is the most common bet. Sets, two pairs, straights and flushes shove more often than they do anything else; middle pairs check most of the time; and hands with no pair shove part of the time as the bluffs.",
          {
            checkpoint: {
              question: "In position on the river of a 3-bet pot, checked to, with about two thirds of the pot behind: which bet does Rail's solve choose most often?",
              options: ["A third of the pot", "Three quarters of the pot", "All-in"],
              answer: 2,
              explain:
                "With so little behind, a value hand loses money by betting less than it could, and a bluff gains nothing by risking less, because the caller's decision is the same. The shove is both the value bet and the bluff.",
            },
          },
          "Pick the bluffs the way R1 does: hands with no showdown value first, and among them those that hold cards of the hands that would call.",
        ],
      },
      {
        heading: "Catching bluffs against capped ranges",
        blocks: [
          "As the caller, the price is good: under 30% against the shove. Rail's solves call with most top pairs and fold more middle pairs than they call. The line decides the rest: a 3-bettor who checked the turn has fewer of the hands that shove for value, and your bluff-catchers gain.",
          {
            note: {
              tone: "approximate",
              text: "River solves on demand: the charts' 3-bet and calling ranges narrowed on the flop and turn by Rail's heuristic model, with bets of 33%, 75% and 150% of the pot and all-in.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "In a 3-bet pot the river bet is usually the stack: shove the strong hands and the bluffs, check the middle.",
        "The shove of about two thirds of the pot needs about 40% folds as a bluff and about 29% equity to call.",
        "Call with top pairs; fold more middle pairs than you call.",
        "A 3-bettor who checked the turn shoves less for value: catch more.",
      ],
      breaks: [
        "Deeper 3-bet pots leave room for a smaller river bet again.",
        "Against a caller who never folds top pair, shove fewer bluffs.",
      ],
    },
    exercises: {
      "3bp-river-split": "Two rivers in a 3-bet pot, in position after a check: put each hand class into check, small, big or overbet, graded class by class.",
      "3bp-rivers": "Five river decisions in 3-bet pots, either role, graded by Rail's river solve.",
      "your-hands": "Your own river decisions in 3-bet pots, the costliest first.",
    },
    checks: [
      { fn: "ratio", args: [57.6, 85.3], value: 0.68, tolerance: 0.005 },
      { fn: "alpha", args: [85.3, 57.6], value: 0.403 },
      { fn: "sum", args: [85.3, 57.6], value: 142.9 },
      { fn: "requiredEquity", args: [142.9, 57.6], value: 0.287 },
      { fn: "mdf", args: [85.3, 57.6], value: 0.6, tolerance: 0.005 },
    ],
  },
};
