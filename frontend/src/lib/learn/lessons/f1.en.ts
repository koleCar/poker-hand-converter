import type { LessonBodies } from "./types";

/**
 * F1 — single-raised pots, the preflop raiser in position, English (Learn
 * L2). Every computed number is listed in its lesson's `checks` (or a
 * checkpoint's `math`) and recomputed by `tests/test/course.test.ts`. No
 * solver frequency is written into the text: the flop-bets table, the drills
 * and the splits show Rail's own solves at runtime; the words give the
 * direction.
 */
export const f1En: LessonBodies<"cbet-why-and-when" | "cbet-by-texture" | "hand-classes-on-the-flop" | "checking-back-and-delayed-cbets"> = {
  "cbet-why-and-when": {
    sections: [
      {
        heading: "A bet earns twice",
        blocks: [
          "The button opens to 2.5 bb, the big blind calls, and the flop comes. The pot is 2.5 + 2.5 + 0.5 = 5.5 bb, with 97.5 bb behind. The big blind checks. Whatever you hold, a bet now can win in two ways: the big blind folds and you take 5.5 bb at once, or it calls and your hand still wins some of the bigger pot.",
          "Put a price on the first way. A bet of a third of the pot, about 1.8 bb, risks 1.8 to win 5.5. As a pure bluff that never wins when called it breaks even when the fold rate is 1.8 / (5.5 + 1.8), about 24.7%. That is [[bluffing-math-alpha-mdf|alpha]], and it is low: small bets do not need many folds.",
          "Now add the second way. Say the big blind folds 40% of the time, and when it calls you win 35% of the time with no more betting. Folds earn 0.4 × 5.5 = 2.2 bb. Calls leave a pot of 5.5 + 1.8 + 1.8 = 9.1 bb, of which you win 35%, about 3.19 bb, minus the 1.8 you put in: 1.39 bb, earned 60% of the time, about 0.83 bb. Together the bet is worth about 3.03 bb before anyone acts again.",
          {
            checkpoint: {
              question: "A pure bluff of a third of the pot, 1.8 bb into 5.5 bb. The big blind folds exactly 25% of the time. Roughly what does the bluff earn?",
              options: ["About zero", "About +1.4 bb", "About −1.4 bb"],
              answer: 0,
              explain:
                "Folds win 0.25 × 5.5 = 1.375 bb; calls lose 0.75 × 1.8 = 1.35 bb. The difference is about 0.03 bb: 25% is right at alpha for this size, so a hand with no equity breaks even. Every bit of equity it has when called is profit on top.",
              math: { fn: "bluffEv", args: [5.5, 1.8, 0.25], value: 0.025, tolerance: 0.001 },
              reveal: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 1.8, share: 0.25 },
            },
          },
        ],
      },
      {
        heading: "Why the raiser bets so often",
        blocks: [
          "The raiser's range is the stronger one on most flops: it holds the big pairs and the best broadway hands, which the big blind would have 3-bet or folded. That is [[range-advantage|range advantage]], and it is why a raiser can bet many hands that are not strong themselves. They borrow the strength of the range: the big blind cannot call with everything, so they win the pot often enough.",
          "But do not read how often to bet from equity alone. Two ranges can be close in equity and still play very differently once a bet is called, because the hands that call are the better part of the defender's range. The question to ask is whether your betting hands are still in good shape against the hands that call, not whether the whole range is ahead before anyone acts.",
          "A third reason is what a check gives away. Behind your check the big blind sees a free turn with every overcard, gutshot and backdoor draw it holds. A small bet charges those hands or folds them out: that is denial, and it is part of what the bet earns even when no one ever says so.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Kd", "7c", "2h"] },
            caption:
              "Illustrative ranges written for teaching, not Rail's charts: a button open against a big-blind call on K♦7♣2♥. Change the board to 8♥7♥6♣ and watch the raiser's lead shrink.",
          },
        ],
      },
      {
        heading: "Small and often, or big and selective",
        blocks: [
          "How big to bet follows what your range holds at the top. Where both players hold about as many of the very best hands, and most of the raiser's edge is in the middle, a small bet with many hands works: each hand gains a little from folds and from denial. Where the raiser holds clearly more of the very best hands, it can bet bigger, and a bigger bet must then be polarised: strong hands, plus hands that can improve to beat what calls.",
          "Rail's library solves every flop with two sizes, a third and three quarters of the pot. When the solve uses both with a hand, their EVs are close and Rail grades either as a good choice; what costs real money is a plan that does not fit the board.",
          {
            checkpoint: {
              question: "On a king-high, dry, rainbow flop, which plan fits the raiser's range best?",
              options: ["A small bet with a wide range", "A big bet with only the strongest hands", "Check almost everything"],
              answer: 0,
              explain:
                "The raiser holds more of the strong kings and big pairs, but the big blind still has some two pairs and sets, so the edge is spread over many hands rather than concentrated at the very top. A small bet lets most of the range bet: value hands get called by worse pairs, and the rest win the pot or deny cheap equity.",
            },
          },
        ],
      },
      {
        heading: "Checking is part of the plan",
        blocks: [
          "Checking back is not giving up. Medium-strength hands that beat the big blind's bluffs but fold to a raise often do better checking: they keep the pot small and still win at showdown. Some of your strong hands check too, so that a turn bet from the big blind does not run into a range of only weak hands.",
          "Out of position the arithmetic is the same, but realising equity is harder and checking is more attractive. That case has its own lesson in F2.",
          {
            note: {
              tone: "approximate",
              text: "The drills below are dealt from Rail's flop library, combo for combo. Your own hands on flops the library did not solve are read from the nearest solved flop by hand category, and the analysis marks those grades as mapped.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A bet earns from folds and from equity when called; add both before you decide.",
        "A third-pot bluff needs about a quarter of folds; check it with [[bluffing-math-alpha-mdf|alpha]], bet ÷ (pot + bet).",
        "Ask how your betting hands do against the hands that call, not only how the whole range compares.",
        "Bet small and often where your edge is spread through the range; bet bigger and polarised where you hold more of the very best hands.",
      ],
      breaks: [
        "Against a big blind that calls every flop with any pair or draw, bet fewer pure bluffs and more thin value.",
        "Against one that folds too much to a first bet, bet even more often, whatever your hand.",
      ],
    },
    exercises: {
      "flop-cbets":
        "Six flops from Rail's library: you opened, the big blind called and checked. Check, bet a third or bet three quarters of the pot, graded by the library's solve of that flop.",
      "your-hands": "Your own single-raised pots where you raised preflop and were checked to on the flop, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [2.5, 2.5, 0.5], value: 5.5 },
      { fn: "sum", args: [100, -2.5], value: 97.5 },
      { fn: "alpha", args: [5.5, 1.8], value: 0.247 },
      { fn: "product", args: [0.4, 5.5], value: 2.2 },
      { fn: "sum", args: [5.5, 1.8, 1.8], value: 9.1 },
      { fn: "product", args: [0.35, 9.1], value: 3.19, tolerance: 0.005 },
      { fn: "sum", args: [3.185, -1.8], value: 1.39, tolerance: 0.005 },
      { fn: "product", args: [0.6, 1.385], value: 0.83, tolerance: 0.005 },
      { fn: "sum", args: [2.2, 0.831], value: 3.03, tolerance: 0.005 },
      { fn: "product", args: [0.25, 5.5], value: 1.375 },
      { fn: "product", args: [0.75, 1.8], value: 1.35 },
    ],
  },

  "cbet-by-texture": {
    sections: [
      {
        heading: "Two advantages, two questions",
        blocks: [
          "Every flop asks the raiser two questions. How often can I bet? That follows [[range-advantage|range advantage]]: whose range is ahead, and by how much, on this board. How big can I bet? That follows [[nut-advantage|nut advantage]]: who holds more of the hands at the very top, the sets, two pairs and straights that win big pots.",
          "The two can point different ways. On a king-high dry board the raiser is ahead overall but holds only a few more of the strongest hands: bet often and small. On a middling connected board the big blind's suited connectors and small pairs make many of the strong hands, and the raiser's lead overall is thin: bet less often, and when you bet, more of it is big.",
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "btn-vs-bb", board: ["Ts", "9s", "6d"] },
            caption:
              "Illustrative ranges written for teaching: who holds the strongest hands on T♠9♠6♦. Switch to A♦K♣4♥ to see the top of the ranges move to the raiser.",
          },
        ],
      },
      {
        heading: "Board by board, from Rail's library",
        blocks: [
          "The table below is Rail's own flop library: for three common lines, how much of the raiser's range bets at its first flop decision, averaged over the solved flops in each board group. Read it as directions, not targets to memorise.",
          {
            widget: { id: "flop-bets", preset: "btn-bb" },
            caption:
              "Rail's solves of the 6-max 100bb chart ranges. Switch the line to under the gun against the big blind, or to the big blind's 3-bet pot, and compare which groups bet most and which bet big.",
          },
          {
            list: [
              "High and dry boards, king- or queen-high: the raiser bets most often, mostly small.",
              "Paired boards: frequent and almost always small; few strong hands exist, so there is nothing to build a big pot with.",
              "Low boards, seven-high and below, and middling connected ones: the big blind hits them, so the raiser checks more; what bets is more often big.",
              "Monotone boards: small bets and more checks; big bets are rare, because one card of the suit turns a strong hand into a second-best one.",
              "Ace-high boards are their own case: the raiser holds more aces, but ace-low boards with wheel cards give the big blind straights and two pairs.",
            ],
          },
        ],
      },
      {
        heading: "Protection and the next card",
        blocks: [
          "On a static board, where few turn cards change who is ahead, a medium hand loses little by checking: there is not much to protect. On a dynamic board, where many turns complete straights and flushes, the same hand prefers to bet, both for value now and to charge the draws. That is the protection part of a bet, and it grows with how dynamic the board is.",
          {
            widget: { id: "board-texture", focus: "dynamism", board: ["9h", "8h", "6c"] },
            caption: "9♥8♥6♣ against K♠7♦2♣: compare how many turn cards change the best hand.",
          },
          {
            checkpoint: {
              question: "The raiser holds an overpair on 9♥8♥6♣. Why does it lean towards a bigger bet here than on K♠7♦2♣?",
              options: [
                "Because the big blind never has a strong hand here",
                "Because many turn cards hurt it, so it wants the money in now and the draws to pay",
                "Because a big bet always gets more folds",
              ],
              answer: 1,
              explain:
                "On 9♥8♥6♣ hearts, sevens, tens and fives all change the board. An overpair is ahead now but vulnerable, so it builds the pot while it is ahead and makes the many draws pay a real price. On K♠7♦2♣ almost no turn card hurts it, so it can bet small or check without losing much.",
            },
          },
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "The split exercise gives you the raiser's whole range on one of the library's flops after the big blind checks, sorted by hand class. You decide for each class whether it mostly checks, bets small or bets big, and Rail grades each class against its own solve of that flop.",
          {
            note: {
              tone: "approximate",
              text: "The range and nut advantage items use the concept library's hand-written teaching ranges, not Rail's charts, and say so. The split and the table come from Rail's flop library; your own hands on flops it did not solve are read from the nearest solved flop.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "[[range-advantage|Range advantage]] sets how often you bet; [[nut-advantage|nut advantage]] sets how big.",
        "High dry and paired boards: bet often, bet small.",
        "Low and middling connected boards: check more; bet bigger when you do.",
        "Monotone boards: small bets and plenty of checks.",
        "The more dynamic the board, the more your medium-strong hands want to bet now.",
      ],
      breaks: [
        "A big blind that never check-raises lets you bet thinner and more often on the boards where you would usually check.",
        "Deeper stacks favour checking more and betting bigger: the strong hands gain value and one pair loses some.",
      ],
    },
    exercises: {
      "split-three-flops":
        "Three flops from Rail's library, you in position as the raiser after a check: put each hand class into check, small bet or big bet, graded class by class against the solve.",
      "who-is-ahead": "Six boards: whose illustrative range is ahead overall, or is it close? Read by Rail's equity calculator.",
      "who-has-the-nuts": "Six boards: who holds more of the strongest hands on the illustrative ranges?",
      "your-hands": "Your own c-bet decisions in position in single-raised pots, the costliest first.",
    },
    checks: [],
  },

  "hand-classes-on-the-flop": {
    sections: [
      {
        heading: "Sort the range before the hand",
        blocks: [
          "When the big blind checks to you, every hand in your range falls into one of a few classes, and each class has a job. Deciding the job first makes the action obvious far more often than thinking about the one hand you hold.",
          {
            list: [
              "Strong made hands, top pair with a good kicker and better: value; they want calls from worse.",
              "Medium made hands, weak top pairs, middle pairs and pocket pairs below the top card: they win at showdown often and gain little from a bet that only better hands call.",
              "Draws, from backdoors to open-enders and flush draws: they can win the pot now or improve when called.",
              "Air, no pair and no real draw: it wins only when the other player folds.",
            ],
          },
        ],
      },
      {
        heading: "Who bets, who checks",
        blocks: [
          "In Rail's solves of the button against the big blind, the clearest pattern is at the ends. The strongest hands bet almost always, and sets and the best top pairs often bet big. Air bets surprisingly often too, mostly small, because it has nothing to win at showdown and the big blind folds enough.",
          "The class that checks most is the middle: second pairs, pocket pairs below the top card and weak top pairs. They are ahead of the big blind's bluffs and behind its calls, so a bet gains little and a check-raise would leave them stuck.",
          "Draws mostly bet: they have two ways to win. The ones that check are often the weakest draws with some showdown value, such as ace-high with a backdoor.",
          {
            checkpoint: {
              question: "Button against big blind, flop K♣8♦3♠, checked to you. Which hand is the most natural check?",
              options: ["A♠K♦", "8♥8♣ (a set)", "9♣9♥", "Q♥J♥"],
              answer: 2,
              explain:
                "A♠K♦ and the set want value. Q♥J♥ has no pair and a backdoor flush draw: it gains a lot from folds. Nines beat the big blind's bluffs but lose to any king or eight that calls, so betting turns them into a bluff-catcher facing a raise. Checking keeps them in the hand cheaply. Rail's solve may still bet such a hand some of the time; the class is what matters.",
            },
          },
        ],
      },
      {
        heading: "When to trap",
        blocks: [
          "Slowplaying a very strong hand on the flop sounds clever, but in position it is rarely the solver's choice: in Rail's solves of the button against the big blind, sets and two pairs almost never check the flop. A bet already gets called by the many pairs and draws the big blind continues with, and it builds the pot for two more streets.",
          "Two reasons to check a strong hand: the board is so dry that a bet folds out everything worse, or your checking range needs some protection against a turn attack. Neither says check every set.",
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "Name the class first, then decide. The split exercise shows you the solve's own mix for each class on one of the library's flops, so you see where the classes really go.",
          {
            note: {
              tone: "approximate",
              text: "The split and the flop drills come from Rail's flop library. Your own hands on other flops are read from the nearest solved flop by hand category, and the analysis marks those grades as mapped.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Strong hands bet; the very best often bet big on dynamic boards.",
        "Air bets more than you would think: it has no other way to win.",
        "Medium hands check most: they beat bluffs and lose to calls.",
        "Draws bet: fold equity now, equity when called.",
      ],
      breaks: [
        "Against a player who calls with anything, medium hands become thin value bets and air should check more.",
        "Against a player who check-raises a lot, check more medium hands and bet your strongest hands to be raised.",
      ],
    },
    exercises: {
      "name-the-hand": "Eight hands on a flop: name each one's class, read by Rail's hand reader.",
      "split-one-flop": "Two flops from Rail's library: sort the raiser's hand classes into check, small bet and big bet, graded class by class.",
      "your-hands": "Your own flop decisions as the preflop raiser when it was your turn to bet or check, the costliest first.",
    },
    checks: [],
  },

  "checking-back-and-delayed-cbets": {
    sections: [
      {
        heading: "The checking range",
        blocks: [
          "When the raiser checks back the flop in position, it is not a give-up; it is the other half of the plan. The checking range holds medium hands that want showdown, weak hands with some equity that would rather see a free card, and a few strong hands, so that a turn bet from the big blind does not find you with nothing.",
          "Checking back has two costs: you give a free card, and you let the big blind see a turn without paying. On static boards those costs are small; on dynamic boards they are bigger, which is why the checking range shrinks there.",
          {
            checkpoint: {
              question: "Button against big blind on Q♠7♦2♣, checked to you. Which hand benefits most from checking back?",
              options: ["Q♥J♥", "7♠6♠", "A♣Q♦"],
              answer: 1,
              explain:
                "A♣Q♦ is clear value, and Q♥J♥ is happy to bet for value and protection. 7♠6♠ is a middle pair: it beats the big blind's bluffs but few worse hands call a bet, and a check-raise would force it to fold. Checking keeps the pot small and lets it win at showdown.",
            },
          },
        ],
      },
      {
        heading: "Betting the turn after a check",
        blocks: [
          "When you check back and the big blind checks again on the turn, its range is capped: the strong hands it holds would often have bet. Your checked range still holds some strong hands and many medium ones, so a turn bet does well: thin value from the medium hands that improved or are still ahead, and bluffs from the hands that missed.",
          "That is the delayed c-bet. The turn card matters: a card that helps the raiser's range, such as an overcard to the board, is a good one to bet; a card that completes the big blind's draws calls for more care.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 4.1, share: 0.45 },
            caption: "A turn bet of three quarters of the pot into 5.5 bb needs about 43% folds as a pure bluff. Move the fold rate to see where it profits.",
          },
        ],
      },
      {
        heading: "Fast or slow with strong hands",
        blocks: [
          "A strong hand that checks back the flop gives up a street of value. It pays back when the big blind bets the turn into a capped-looking range, or when its own range needs protecting. Against players who rarely bet when checked to, that pay-back never comes: bet your strong hands on the flop.",
          {
            note: {
              tone: "approximate",
              text: "The flop drills come from Rail's flop library; the turn drills are solved on demand from ranges Rail narrows through the flop. Your own hands on flops the library did not solve are read from the nearest solved flop.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Check back the hands that win at showdown but cannot stand a raise.",
        "Keep a few strong hands in the checking range.",
        "After the flop checks through, bet the turn often when the big blind checks again: its range is capped.",
        "Against opponents who never bet when checked to, bet your strong hands on the flop.",
      ],
      breaks: [
        "On very dynamic boards, checking back gives away too much; bet more medium hands for protection.",
        "Against opponents who stab every turn after a check, check back more strong hands and let them bet.",
      ],
    },
    exercises: {
      "check-back-flops":
        "Four flops from Rail's library, you in position as the raiser after a check, dealt hands where the solve mixes: bet or check?",
      "delayed-turns": "Three turns after you checked back the flop and the big blind checked again, solved on demand.",
      "your-hands": "Your own hands flagged for checking back a very strong hand, the costliest first.",
    },
    checks: [
      { fn: "alpha", args: [5.5, 4.1], value: 0.427 },
    ],
  },
};
