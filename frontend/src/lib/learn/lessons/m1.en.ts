import type { LessonBodies } from "./types";

/**
 * Reference pages since L1.1 (`/learn/reference/<id>`, `REFERENCE_IDS`):
 * L1's M1 — poker maths, out of the course map, kept read-only.
 *
 * M1 — poker maths, English. Every computed number in a section is listed in
 * its lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`.
 */
export const m1En: LessonBodies<
  "pot-odds" | "equity-and-outs" | "expected-value" | "combos-and-card-removal" | "bluffing-math-alpha-mdf" | "equity-realisation-and-implied-odds"
> = {
  "pot-odds": {
    sections: [
      {
        heading: "The question every call answers",
        blocks: [
          "When you call a bet you are paying for a share of the pot. The call is worth it if your hand wins that pot often enough to pay back what you put in. Pot odds turn that into one number: the share of the time you need to win for the call to break even.",
          "That number depends only on two amounts, the pot and the price. It does not care about your cards. Your cards decide how often you actually win; the pot odds decide how often you need to.",
          {
            checkpoint: {
              question: "Before any maths: who decides how much equity a call needs?",
              options: ["Your cards", "The size of the bet compared with the pot", "Your opponent's style"],
              answer: 1,
              explain:
                "The price is set by the money alone. Your cards and your read on the opponent tell you how often you win; the pot and the bet tell you how often you have to.",
            },
          },
        ],
      },
      {
        heading: "Two steps: the final pot, then your share of it",
        blocks: [
          "Step one: add up the pot you are playing for if you call. That is everything already in the middle, the bet you face, and your call on top. Step two: divide your call by that total. The result is the equity you need.",
          {
            formula: {
              name: "Equity needed",
              expression: { frac: ["call", "pot before the bet + bet + call"] },
              spoken: "Equity needed equals your call divided by the pot before the bet plus the bet plus your call.",
            },
          },
          "Say the pot is 30 bb and your opponent bets 15 bb. If you call, the pot becomes 30 + 15 + 15 = 60 bb, and 15 of those 60 are yours. You need to win 15 / 60 = 25% of the time.",
          "The most common slip is to leave your own call out and divide 15 by 45. That gives 33%, which makes every call look worse than it is. The call is part of the pot you win, so it belongs in the total.",
          {
            checkpoint: {
              question: "The pot is 20 bb and the bet is 10 bb. How much equity does a call need?",
              options: ["25%", "33%", "50%"],
              answer: 0,
              explain: "The final pot is 20 + 10 + 10 = 40 bb and your call is 10 of it: 10 / 40 = 25%. Half-pot bets always ask for a quarter.",
              math: { fn: "requiredEquity", args: [30, 10], value: 0.25 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 30, bet: 10, share: 0.25 },
            },
          },
        ],
      },
      {
        heading: "Ratios without the trap",
        blocks: [
          "Players often say pot odds as a ratio: \"I am getting 3 to 1.\" That means the pot you can win, before your call, is three times your call. In the example above you call 15 to win the 45 already there: 45 to 15 is 3 to 1.",
          "To turn a ratio into the equity you need, add the two sides and take your side as the share: 3 to 1 is 1 out of 4, which is 25%. Same number, two spellings. The percentage is easier to compare with your equity, which is why Rail always leads with it.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 45, bet: 15, share: 0.25 },
            caption: "Set the pot (including the bet you face) and the call. The marker on the bar is the equity you need; slide your equity across it and watch the call's EV change sign there.",
          },
        ],
      },
      {
        heading: "Sizes worth knowing by heart",
        blocks: [
          "Because only the ratio of bet to pot matters, every bet size has a fixed price. These are worth memorising, because they come up in every session:",
          {
            list: [
              "A quarter of the pot: about 17%.",
              "A third of the pot: 20%.",
              "Half the pot: 25%.",
              "Two thirds of the pot: about 29%.",
              "Three quarters of the pot: 30%.",
              "The size of the pot: about 33%.",
              "Twice the pot: 40%.",
            ],
          },
          "Notice how slowly the price grows. Doubling the bet from half pot to pot only moves the equity you need from 25% to about 33%. Small bets are cheap to call, and even huge bets never ask for more than half.",
          {
            checkpoint: {
              question: "Your opponent shoves for twice the pot. Roughly how often must your call win?",
              options: ["About 40%", "About 50%", "About 67%"],
              answer: 0,
              explain:
                "With the pot at 1, the bet is 2 and the call is 2: the final pot is 1 + 2 + 2 = 5, and 2 of it is yours. 2 / 5 = 40%.",
              math: { fn: "requiredEquity", args: [3, 2], value: 0.4 },
            },
          },
        ],
      },
      {
        heading: "When the price is not the whole answer",
        blocks: [
          "Pot odds are exact when nothing happens after your call: on the river, or when someone is all in. Before that, more betting can follow, and the real price moves.",
          {
            list: [
              "Money you can win later when you hit makes a call better than its price says. That is implied odds.",
              "Money you can lose later when you hit a second-best hand, or bets that push you off your draw before it comes in, make it worse. That is reverse implied odds.",
              "Your equity has to be measured against the hands that actually bet like this, not against every hand the opponent could hold.",
            ],
          },
          "So the price is the starting point of every call, not the end of it. The [[equity-and-outs|equity and outs]] and [[equity-realisation-and-implied-odds|realisation]] pages add the rest on top of it.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Equity needed = call ÷ (pot before the bet + bet + call). Your own call is always in the total.",
        "Half pot asks for 25%, pot asks for about 33%, twice the pot asks for 40%.",
        "Compare the price with your equity against the betting range, not against a random hand.",
      ],
      breaks: [
        "With cards still to come, more bets change the real price in both directions: implied and reverse implied odds.",
        "Against players who almost never bluff a big bet, your real equity is lower than a range chart suggests, so the price alone overstates a call.",
      ],
    },
    exercises: {
      "price-drill":
        "Ten spots with a pot and a bet. Work out the equity a call needs before the calculator shows it. Within one and a half percentage points counts as right.",
      "your-hands":
        "Your own decisions where the analysis flagged a call without the price or a fold with it, the costliest first. Decide before you see what you did.",
    },
    checks: [
      { fn: "requiredEquity", args: [45, 15], value: 0.25 },
      { fn: "ratio", args: [15, 45], value: 0.333 },
      { fn: "potOddsRatio", args: [45, 15], value: 3 },
      { fn: "requiredEquity", args: [1.25, 0.25], value: 0.167 },
      { fn: "requiredEquity", args: [1.333333, 0.333333], value: 0.2 },
      { fn: "requiredEquity", args: [1.5, 0.5], value: 0.25 },
      { fn: "requiredEquity", args: [1.666667, 0.666667], value: 0.286, tolerance: 0.006 },
      { fn: "requiredEquity", args: [1.75, 0.75], value: 0.3 },
      { fn: "requiredEquity", args: [2, 1], value: 0.333 },
      { fn: "requiredEquity", args: [3, 2], value: 0.4 },
    ],
  },

  "equity-and-outs": {
    sections: [
      {
        heading: "Equity: your share if the cards ran out now",
        blocks: [
          "Your equity is the share of the pot your hand would win on average if every remaining card were dealt now, with no more betting. A tie counts as half a win.",
          "Against a range it is the average over every combo your opponent could hold. Pot odds tell you how much equity a call needs; this lesson is about estimating how much you have, quickly and without a computer.",
          {
            widget: { id: "equity", focus: "range", hand: ["9h", "8h"], preset: "open-btn" },
            caption: "Pick a hand and an opponent's range, then add a flop. Put two hearts on it and compare the draw's equity with what a pair has on the same board.",
          },
        ],
      },
      {
        heading: "Counting outs",
        blocks: [
          "An out is an unseen card that should give you the best hand. Most draws come in a few standard shapes, and each has a count worth knowing:",
          {
            list: [
              "Flush draw: the suit has 13 cards and you can see 4 of them, two in your hand and two on the board. 13 − 4 = 9 outs.",
              "Open-ended straight draw: four cards complete it at each end. 4 × 2 = 8 outs.",
              "Gutshot: one rank, four cards. 4 outs.",
              "Two overcards: three of each rank are left. 3 × 2 = 6 outs, but only if pairing one really puts you ahead.",
            ],
          },
          "When you hold two draws at once, do not count a card twice. A flush draw with an open-ended straight draw has 9 flush cards and 8 straight cards, but two of the straight cards are of your suit and already counted.",
          {
            checkpoint: {
              question: "You hold a flush draw and an open-ended straight draw. How many outs?",
              options: ["17", "15", "13"],
              answer: 1,
              explain: "9 flush cards plus 8 straight cards, minus the 2 straight cards that are also of your suit: 9 + 8 − 2 = 15.",
              math: { fn: "sum", args: [9, 8, -2], value: 15 },
            },
          },
        ],
      },
      {
        heading: "Dirty outs",
        blocks: [
          "Some outs complete your draw and still lose. Before you count a card, ask what it does for the hands your opponent is likely to hold.",
          {
            list: [
              "A flush card that pairs the board can give a set a full house.",
              "A straight card that also puts a third or fourth card of one suit on the board can make someone else a flush.",
              "Overcard outs are worth little against two pair or a set, because pairing your card does not win.",
            ],
          },
          "Count such cards as half an out, or leave them out, depending on how likely the hand that beats you is. A rough discount is better than a precise count of the wrong thing.",
        ],
      },
      {
        heading: "From outs to equity: ×2 and ×4",
        blocks: [
          "On the flop you can see five cards, so 52 − 5 = 47 are unseen. With 9 outs the turn hits 9 / 47 of the time, about 19.1%. On the turn 46 cards are unseen, and the river hits 9 / 46, about 19.6%.",
          "With both cards to come, it is easier to count the misses. You miss the turn with 38 of 47 cards and then the river with 37 of 46: 38 × 37 = 1,406 out of 47 × 46 = 2,162 runouts, about 0.65. So you hit about 35% of the time.",
          "Nobody does that at the table. The shortcut: multiply your outs by 2 for each card to come. One card: 9 × 2 = 18%. Two cards: 9 × 4 = 36%. Both land within a point or two of the exact numbers, which is close enough to decide.",
          "The ×4 rule runs high with big draws. With 15 outs it says 15 × 4 = 60%, but the exact miss chance is 32 × 31 = 992 out of 2,162, about 0.459, so you hit about 54%. Take a few points off when you have more than about 8 outs.",
          {
            checkpoint: {
              question: "On the turn you have an open-ended straight draw, 8 clean outs. Roughly what is your equity for the river?",
              options: ["About 8%", "About 16%", "About 32%"],
              answer: 1,
              explain: "One card to come, so ×2: 8 × 2 = 16%. The exact figure is 8 / 46, a shade higher.",
              math: { fn: "product", args: [8, 2], value: 16 },
            },
          },
        ],
      },
      {
        heading: "Does ×4 ignore the next bet?",
        blocks: [
          "Yes, and that is the point to remember. The ×4 number is your equity if you see the turn and the river for the price of one call. That only happens when someone is all in, or when you are sure the turn will check through.",
          "Say the pot is 20 bb and your opponent bets 10 bb on the flop. The final pot is 20 + 10 + 10 = 40 bb, so a call needs 10 / 40 = 25%. With a flush draw, ×4 says 36%, a comfortable call. But if a second bet is coming on the turn when you miss, your call only buys one card, and ×2 says 18%: short of the price.",
          "So use ×4 when no more money can go in, and ×2 when it can. The gap between them has to be paid for by what you win later when you hit. That is implied odds, the subject of the [[equity-realisation-and-implied-odds|realisation and implied odds]] page.",
          {
            checkpoint: {
              question: "Your opponent moves all in on the flop and you hold a flush draw. Which estimate fits?",
              options: ["×2: one card at a time", "×4: you will see both the turn and the river"],
              answer: 1,
              explain: "Nobody can bet again, so your call buys both cards. ×4 is the right estimate here, and pot odds are exact.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Flush draw 9 outs, open-ended 8, gutshot 4, two overcards up to 6.",
        "Outs × 2 per card to come: ×2 with one card left, ×4 with two.",
        "Use ×4 only when no more betting can happen; otherwise use ×2 and price the rest as implied odds.",
        "Discount outs that also improve the hands likely to beat you.",
      ],
      breaks: [
        "×4 overstates big draws: with more than about 8 outs, take a few points off.",
        "Outs assume you know what you are drawing against. Against a range, some of your outs are clean against one hand and dead against another.",
      ],
    },
    exercises: {
      "draw-equity":
        "Six flops with a drawing hand against a made hand. Estimate the draw's equity to the river; within five percentage points counts. Rail then shows the exact figure from every turn and river, the outs against that hand, and the ×2 and ×4 estimates.",
      "your-hands":
        "Your own flop and turn calls that the analysis flagged as calling without the price, the costliest first. Count your outs before you see what you did.",
    },
    checks: [
      { fn: "sum", args: [13, -4], value: 9 },
      { fn: "product", args: [4, 2], value: 8 },
      { fn: "product", args: [3, 2], value: 6 },
      { fn: "sum", args: [52, -5], value: 47 },
      { fn: "ratio", args: [9, 47], value: 0.191 },
      { fn: "sum", args: [52, -6], value: 46 },
      { fn: "ratio", args: [9, 46], value: 0.196 },
      { fn: "sum", args: [47, -9], value: 38 },
      { fn: "product", args: [38, 37], value: 1406 },
      { fn: "product", args: [47, 46], value: 2162 },
      { fn: "ratio", args: [1406, 2162], value: 0.65 },
      { fn: "sum", args: [1, -0.65], value: 0.35 },
      { fn: "product", args: [9, 2], value: 18 },
      { fn: "product", args: [9, 4], value: 36 },
      { fn: "product", args: [15, 4], value: 60 },
      { fn: "sum", args: [47, -15], value: 32 },
      { fn: "product", args: [32, 31], value: 992 },
      { fn: "ratio", args: [992, 2162], value: 0.459 },
      { fn: "sum", args: [1, -0.459], value: 0.541 },
      { fn: "sum", args: [20, 10, 10], value: 40 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
    ],
  },

  "expected-value": {
    sections: [
      {
        heading: "The average over everything that can happen",
        blocks: [
          "Expected value is what a decision wins or loses on average, if you could make it many times. Take each way the hand can go, multiply what it pays by how often it happens, and add the results up.",
          {
            formula: {
              name: "EV",
              expression: ["Σ (probability × result)"],
              spoken: "EV equals the sum, over every outcome, of its probability times its result.",
              where: [["result", "what you win or lose from this point on, in big blinds"]],
            },
          },
          "Count from where you stand now. Chips you put in earlier are part of the pot, not yours, so folding is always worth exactly 0. Every other option is measured against that.",
        ],
      },
      {
        heading: "The EV of a call",
        blocks: [
          "On the river the pot is 20 bb and your opponent bets 10 bb. You think your hand wins 30% of the time. Calling has two outcomes: 30% of the time you win the 30 bb in the middle, and 70% of the time you lose your 10 bb.",
          "EV = 0.3 × 30 − 0.7 × 10 = 9 − 7 = +2 bb. The pot-odds shortcut gives the same answer in one line: equity × final pot − call = 0.3 × 40 − 10 = 12 − 10 = +2 bb.",
          {
            checkpoint: {
              question: "Same bet, but now you win only 20% of the time. What is the call worth?",
              options: ["+2 bb", "0 bb", "−2 bb"],
              answer: 2,
              explain: "0.2 × 40 − 10 = 8 − 10 = −2 bb. The call needs 25% to break even, and 20% falls short, so folding (worth 0) is better.",
              math: { fn: "callEv", args: [30, 10, 0.2], value: -2 },
            },
          },
        ],
      },
      {
        heading: "Bets that can win two ways",
        blocks: [
          "A bet wins in two ways: your opponent folds and you take the pot now, or he calls and you play on with your equity. Its EV adds the two branches together.",
          {
            formula: {
              name: "EV of a bet",
              expression: ["fold share × pot + call share × EV when called"],
              spoken: "The EV of a bet equals how often they fold times the pot, plus how often they call times the bet's EV when called.",
            },
          },
          "On the turn the pot is 20 bb and you bet 10 bb with a draw. Say he folds 40% of the time, and when he calls you have 25% equity with no more betting. When called, the bet is worth 0.25 × 40 − 10 = 0. So the bet is worth 0.4 × 20 + 0.6 × 0 = +8 bb.",
          "Now make it a pure bluff that never wins when called. The called branch costs 10 bb: 0.4 × 20 − 0.6 × 10 = 8 − 6 = +2 bb. The draw's equity is worth 8 − 2 = 6 bb here.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 20, bet: 10, share: 0.4 },
            caption: "The pure-bluff view: the pot before your bet, the bet, and how often they fold. It breaks even at 10 / 30, about 33% folds; at 40% the bluff is worth +2 bb.",
          },
          {
            checkpoint: {
              question: "Same pot and bet, but he folds only 30% of the time. What is a pure bluff worth?",
              options: ["+6 bb", "−1 bb", "−7 bb"],
              answer: 1,
              explain:
                "0.3 × 20 − 0.7 × 10 = 6 − 7 = −1 bb: below the 33% it needs. With the draw's 25% equity, the called branch is worth 0 instead of −10, and the bet earns 0.3 × 20 = +6 bb.",
              math: { fn: "bluffEv", args: [20, 10, 0.3], value: -1 },
            },
          },
        ],
      },
      {
        heading: "Winning pots is not the goal",
        blocks: [
          "The +2 bb call above loses 7 times out of 10. A player who only calls when he is ahead wins more of the pots he plays, and less money. The bluff that works 40% of the time loses more often than it wins, and still earns.",
          "So count EV in big blinds, never pots won. Many of the best plays in poker lose most of the time; they just win more than they lose when they work.",
        ],
      },
      {
        heading: "EV loss: the gap to the best option",
        blocks: [
          "Every option in a spot has an EV, and the best one sets the bar. Rail's EV loss is the best option's EV minus the EV of the one you chose. In the 30% river spot, calling is worth +2 bb and folding 0, so a fold loses 2 bb. At 20%, folding is best and the call loses 2 bb.",
          "Two of Rail's checks are pure EV logic. Folding when you could check for free always loses, because checking keeps your share of the pot at no cost. And folding the best possible hand gives up everything it would have won.",
          {
            widget: { id: "grading" },
            caption: "Give each option an EV and see how the EV loss of your choice turns into a grade.",
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "EV = the sum of probability × result over every outcome, counted from now.",
        "Folding is worth 0; every other option is measured against it.",
        "A bet's EV = fold share × pot + call share × EV when called.",
        "Judge plays by EV in big blinds, not by how often they win the pot.",
      ],
      breaks: [
        "These trees assume no more betting after a call. With streets still to come, what happens later changes the EV of the called branch in both directions.",
        "The inputs are estimates. A tree built on a wrong fold rate or equity gives a precise-looking wrong answer.",
      ],
    },
    exercises: {
      "ev-trees":
        "Six semi-bluffs: the pot, your bet, how often they fold and your equity when called. Work out the bet's EV as fold share × pot + call share × EV when called, assuming no more betting after a call; within a quarter of a big blind, or 8% of the answer, counts.",
      "river-ev":
        "Three river spots from Rail's solver. Choose your action, then read the EV of every option and the EV loss of yours.",
    },
    checks: [
      { fn: "product", args: [0.3, 30], value: 9 },
      { fn: "product", args: [0.7, 10], value: 7 },
      { fn: "sum", args: [9, -7], value: 2 },
      { fn: "sum", args: [20, 10, 10], value: 40 },
      { fn: "product", args: [0.3, 40], value: 12 },
      { fn: "callEv", args: [30, 10, 0.3], value: 2 },
      { fn: "product", args: [0.2, 40], value: 8 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
      { fn: "callEv", args: [30, 10, 0.25], value: 0, tolerance: 0.001 },
      { fn: "product", args: [0.4, 20], value: 8 },
      { fn: "product", args: [0.6, 10], value: 6 },
      { fn: "bluffEv", args: [20, 10, 0.4], value: 2 },
      { fn: "sum", args: [8, -2], value: 6 },
      { fn: "alpha", args: [20, 10], value: 0.333 },
      { fn: "product", args: [0.3, 20], value: 6 },
      { fn: "sum", args: [6, -7], value: -1 },
    ],
  },

  "combos-and-card-removal": {
    sections: [
      {
        heading: "Not every hand is equally likely",
        blocks: [
          "A range is written as hand classes, AA or AK, but the classes are not equally likely. Some can be dealt in more ways than others. Each specific way, such as A♠K♥, is a combo, and counting combos is how you weigh one part of a range against another.",
        ],
      },
      {
        heading: "Six, four, twelve",
        blocks: [
          "Three counts cover every starting hand:",
          {
            list: [
              "A pair: four cards of the rank, and any two of them. 4 × 3 = 12 ordered pairs, and each is counted twice, so 12 / 2 = 6 combos.",
              "A suited hand: one per suit, so 4 combos.",
              "An offsuit hand: 4 × 4 = 16 ways to pair the two ranks, minus the 4 suited ones: 16 − 4 = 12 combos.",
            ],
          },
          "An unpaired hand like AK therefore has 4 + 12 = 16 combos, against 6 for a pair. In a range of AA, KK and AK, AK is 16 of the 6 + 6 + 16 = 28 combos: more than half of it.",
          {
            checkpoint: {
              question: "How many combos of AK are there in total, suited and offsuit together?",
              options: ["4", "12", "16"],
              answer: 2,
              explain: "Any of 4 aces with any of 4 kings: 4 × 4 = 16, of which 4 are suited and 12 offsuit.",
              math: { fn: "product", args: [4, 4], value: 16 },
            },
          },
        ],
      },
      {
        heading: "Card removal",
        blocks: [
          "A card you can see, on the board or in your hand, cannot be in your opponent's hand. Every card you see removes combos.",
          "For a pair, count the cards of the rank that are left. With one seen, 3 are left: 3 × 2 = 6, halved, is 3 combos. With two seen, 2 are left: 2 × 1 = 2, halved, is 1 combo. For an unpaired hand, multiply the cards left of each rank: with one ace seen, AK has 3 × 4 = 12 combos.",
          "On K♦7♣2♥, each set has 3 combos left, so there are 3 + 3 + 3 = 9 sets in total.",
          {
            widget: { id: "combos", hand: ["Ah", "Qd"], preset: "sets-k72" },
            caption: "Put K♦7♣2♥ on the board and the three sets fall from 6 combos each to 3. Then put a king in your hand and watch KK drop again.",
          },
          {
            checkpoint: {
              question: "The board is K♦7♣2♥ and you hold A♠K♠. How many combos of AK can your opponent have?",
              options: ["6", "9", "12"],
              answer: 0,
              explain: "Three aces are left (you hold one), and two kings (one is in your hand, one on the board): 3 × 2 = 6 combos.",
              math: { fn: "product", args: [3, 2], value: 6 },
            },
          },
        ],
      },
      {
        heading: "How often is he bluffing? Count two groups",
        blocks: [
          "Counting a whole range feels overwhelming, and you rarely need to. When your opponent bets, sort his likely hands into two groups, value and bluffs, and count each roughly.",
          "Say his value hands come to 18 combos and his bluffs to 6. Then 6 of his 18 + 6 = 24 betting combos are bluffs: 6 / 24 = 25%. If he bet half the pot, your call needs 25%, so a hand that beats only his bluffs breaks even.",
          {
            checkpoint: {
              question:
                "You hold a hand that beats his bluffs and nothing else. He bets the size of the pot, so you need about 33%. You count 20 value combos and 5 bluffs. Call or fold?",
              options: ["Call: five bluffs is plenty", "Fold: bluffs are only 20% of his bets"],
              answer: 1,
              explain: "5 of 25 combos are bluffs: 5 / 25 = 20%, short of the 33% the price asks for. Fold, unless you have a reason to think he bluffs more than you counted.",
              math: { fn: "ratio", args: [5, 25], value: 0.2 },
            },
          },
        ],
      },
      {
        heading: "The doorway to blockers",
        blocks: [
          "Your own cards change those counts. Holding a card that his value hands need lowers the value count and raises the share of bluffs; holding a card his bluffs need does the opposite.",
          "Counting is how you measure the effect. On K♦7♣2♥, a king in your hand takes KK from 3 combos to 1, removing 3 − 1 = 2 of them. That is the idea behind blockers, which the ranges module builds on.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "A pair has 6 combos, a suited hand 4, an offsuit hand 12, an unpaired hand 16 in all.",
        "Every card you see removes combos: multiply the cards left of each rank.",
        "To ask how often he is bluffing, count two groups, value and bluffs, and compare the bluff share with your price.",
      ],
      breaks: [
        "Combos only count what is possible. Real players do not play every possible combo the same way, so a count is only as good as the range behind it.",
        "Rough counts are fine for decisions, but a single removed card matters most when the groups are small.",
      ],
    },
    exercises: {
      "count-combos":
        "Eight boards with your hand dealt, and a hand to count: a pair, a suited hand, or a hand suited and offsuit together. Count the combos your opponent can still hold once the board and your cards are removed; only the exact number counts.",
    },
    checks: [
      { fn: "product", args: [4, 3], value: 12 },
      { fn: "ratio", args: [12, 2], value: 6 },
      { fn: "product", args: [4, 4], value: 16 },
      { fn: "sum", args: [16, -4], value: 12 },
      { fn: "sum", args: [4, 12], value: 16 },
      { fn: "sum", args: [6, 6, 16], value: 28 },
      { fn: "product", args: [3, 2], value: 6 },
      { fn: "ratio", args: [6, 2], value: 3 },
      { fn: "product", args: [2, 1], value: 2 },
      { fn: "ratio", args: [2, 2], value: 1 },
      { fn: "product", args: [3, 4], value: 12 },
      { fn: "sum", args: [3, 3, 3], value: 9 },
      { fn: "sum", args: [18, 6], value: 24 },
      { fn: "ratio", args: [6, 24], value: 0.25 },
      { fn: "requiredEquity", args: [1.5, 0.5], value: 0.25 },
      { fn: "requiredEquity", args: [2, 1], value: 0.333 },
      { fn: "sum", args: [20, 5], value: 25 },
      { fn: "sum", args: [3, -1], value: 2 },
    ],
  },

  "bluffing-math-alpha-mdf": {
    sections: [
      {
        heading: "How often a bluff must work",
        blocks: [
          "A pure bluff wins the pot when your opponent folds and loses the bet when he calls. It breaks even when the two balance out, and that fold rate has a name: alpha.",
          {
            formula: {
              name: "Alpha",
              expression: { frac: ["bet", "pot + bet"] },
              spoken: "Alpha equals the bet divided by the pot plus the bet.",
              where: [["pot", "the pot before your bet"]],
            },
          },
          "Bet 10 bb into 20 bb and you risk 10 to win 20: the bluff needs folds 10 / 30 of the time, about 33%. If he folds more, any two cards profit from betting; if he folds less, the pure bluff loses.",
          {
            checkpoint: {
              question: "You bet the size of the pot as a pure bluff. How often must your opponent fold?",
              options: ["33%", "50%", "67%"],
              answer: 1,
              explain: "With the pot at 1, you risk 1 to win 1: 1 / (1 + 1) = 50%.",
              math: { fn: "alpha", args: [1, 1], value: 0.5 },
            },
          },
        ],
      },
      {
        heading: "The defender's side: MDF",
        blocks: [
          "Turn it around. If you fold more often than alpha, your opponent can bet any two cards and profit. To stop that, a defender has to continue, by calling or raising, with at least the rest of the range: the minimum defence frequency.",
          {
            formula: {
              name: "MDF",
              expression: ["1 − alpha = ", { frac: ["pot", "pot + bet"] }],
              spoken: "MDF equals one minus alpha, which is the pot divided by the pot plus the bet.",
            },
          },
          "Against a half-pot bet of 10 bb into 20 bb, MDF is 20 / 30, about 67%. That is not the caller's price: the call needs 25% equity, as the pot-odds lesson showed. Alpha and MDF answer \"how often\", pot odds answer \"with what\".",
          {
            widget: { id: "bet-math", focus: "mdf", pot: 20, bet: 10 },
            caption: "Set the pot before the bet and the bet. Alpha and MDF always add up to 100%; watch both move as the bet grows.",
          },
        ],
      },
      {
        heading: "Sizes worth knowing",
        blocks: [
          "Like pot odds, alpha and MDF depend only on the bet as a share of the pot:",
          {
            list: [
              "A third of the pot: alpha 25%, MDF 75%.",
              "Half the pot: alpha about 33%, MDF about 67%.",
              "Two thirds of the pot: alpha 40%, MDF 60%.",
              "The size of the pot: alpha 50%, MDF 50%.",
              "Twice the pot: alpha about 67%, MDF about 33%.",
            ],
          },
          {
            checkpoint: {
              question: "Your opponent bets three quarters of the pot. Roughly how much of your range must continue?",
              options: ["About 43%", "About 57%", "About 75%"],
              answer: 1,
              explain: "With the pot at 4 and the bet at 3, MDF is 4 / (4 + 3) = 4 / 7, about 57%. Alpha is the other 43%.",
              math: { fn: "mdf", args: [4, 3], value: 0.571 },
            },
          },
        ],
      },
      {
        heading: "How many bluffs to bet",
        blocks: [
          "From the bettor's side, the question is how many bluffs to put with your value bets on the river. With the right mix, a hand that beats only bluffs gains nothing by calling or folding. That share of bluffs is the bet divided by the pot plus twice the bet.",
          "For a pot-sized bet that is 1 / (1 + 2), about 33%: one bluff for every two value hands. For a half-pot bet, 10 / (20 + 20) = 25%: one bluff for every three.",
          "If you feel you bluff too much, count. Add up your value combos first, using the last lesson's counting, then allow bluffs in that ratio. Against players who call too much, use fewer.",
        ],
      },
      {
        heading: "Where the baselines stop",
        blocks: [
          "Alpha and MDF are exact only for pure bluffs on the river, against an opponent you know nothing about. Everywhere else they are guides.",
          {
            list: [
              "Before the river, bluffs have equity, so they need fewer folds, and defending hands can be pushed off later.",
              "Against a player who rarely bluffs big, defending to MDF just pays off value. Fold more.",
              "Against a player who bluffs too much, defend more than MDF.",
              "MDF counts calls and raises together, and with several players left the defence is shared between them.",
            ],
          },
          {
            checkpoint: {
              question: "A player who almost never bluffs the river bets the pot. You hold a hand that beats only bluffs. What does MDF tell you to do?",
              options: ["Defend 50% of your range, as MDF says", "Fold more than MDF says"],
              answer: 1,
              explain:
                "MDF protects you against an opponent who could bluff any two cards. This one does not, so calling to keep him honest just pays off his value bets.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Alpha = bet ÷ (pot + bet): how often a pure bluff must work.",
        "MDF = pot ÷ (pot + bet): how much of a range must continue against a bet.",
        "Half pot: alpha about 33%, MDF about 67%. Pot: 50% each.",
        "On the river, bluff in the ratio bet ÷ (pot + 2 × bet) of your bets.",
      ],
      breaks: [
        "Against players who under-bluff, fold more than MDF; against over-bluffers, defend more.",
        "Before the river both sides have equity still to come, so the numbers are a starting point, not an answer.",
      ],
    },
    exercises: {
      "sizing-quiz":
        "Eight bet sizes, given as a share of the pot. For each, give alpha (how often a pure bluff must work) or MDF (how much of a range must continue), as the question asks; within one and a half percentage points counts.",
      "your-hands":
        "Your own river folds that the analysis flagged as folding with the price, the costliest first. Decide before you see what you did.",
    },
    checks: [
      { fn: "alpha", args: [20, 10], value: 0.333 },
      { fn: "mdf", args: [20, 10], value: 0.667 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
      { fn: "alpha", args: [3, 1], value: 0.25 },
      { fn: "mdf", args: [3, 1], value: 0.75 },
      { fn: "alpha", args: [2, 1], value: 0.333 },
      { fn: "mdf", args: [2, 1], value: 0.667 },
      { fn: "alpha", args: [3, 2], value: 0.4 },
      { fn: "mdf", args: [3, 2], value: 0.6 },
      { fn: "mdf", args: [1, 1], value: 0.5 },
      { fn: "alpha", args: [1, 2], value: 0.667 },
      { fn: "mdf", args: [1, 2], value: 0.333 },
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "bluffShare", args: [1, 1], value: 0.333 },
      { fn: "product", args: [2, 10], value: 20 },
      { fn: "bluffShare", args: [20, 10], value: 0.25 },
    ],
  },

  "equity-realisation-and-implied-odds": {
    sections: [
      {
        heading: "Equity assumes a free ride",
        blocks: [
          "Raw equity assumes every card gets dealt with no more betting. Real hands do not get that. Bets come on later streets, and some of them push you off a hand that would have won, or make you pay to see the cards you need.",
          "Equity realisation is the share of your raw equity that you actually turn into pot share once the betting is played out. A hand with 40% equity that realises 80% of it behaves, in money, like a hand with 0.4 × 0.8 = 32%.",
          {
            formula: {
              name: "Realised equity",
              expression: ["equity × R"],
              spoken: "Realised equity equals raw equity times R, the realisation factor.",
              where: [["R", "the share of its equity a hand turns into pot share; above 1 when it wins more than its share"]],
            },
          },
        ],
      },
      {
        heading: "What helps a hand realise",
        blocks: [
          "The same raw equity can be worth very different amounts, depending on how easy the hand is to play:",
          {
            list: [
              "Position: acting last, you see what your opponent does first and can take free cards or bet when he shows weakness.",
              "Playability: suited and connected hands make strong hands that are easy to continue with; offsuit hands with a weak kicker mostly make one pair that is often second best.",
              "Initiative: the player who bet last can often win the pot with a bet when nobody has much.",
              "Stack depth: deeper stacks mean more bets to face, which hurts hands that cannot stand pressure.",
            ],
          },
          {
            widget: { id: "equity", focus: "realisation", hand: ["Js", "9s"], preset: "open-btn", share: 0.9 },
            caption: "Your hand against a button opening range. Move the realisation factor and watch where realised equity crosses the price. Try an offsuit hand with a lower factor next to it.",
          },
          {
            checkpoint: {
              question: "Two hands have the same raw equity against an open. One is suited and connected, the other offsuit with a weak kicker. Out of position, which is the better defence?",
              options: ["The suited, connected hand", "The offsuit hand", "They are the same: equity is equity"],
              answer: 0,
              explain:
                "The suited, connected hand makes straights, flushes and two pair it can keep betting, so it realises more of its equity. The offsuit hand mostly makes weak pairs it has to fold to later bets.",
            },
          },
        ],
      },
      {
        heading: "The big blind against the button",
        blocks: [
          "The button opens to 2.5 bb and the small blind folds. The pot holds 2.5 + 0.5 + 1 = 4 bb, and the big blind calls 1.5 bb more: it needs 1.5 / 5.5, about 27.3%. That is a great price, so the big blind defends wide.",
          "But it plays the rest of the hand out of position, so it realises less than its raw equity. Hands that clear the price comfortably and play well defend; hands that clear it only on paper, mostly offsuit and easily dominated, do not.",
          {
            checkpoint: {
              question:
                "A hand has 35% raw equity against the button's open and, for illustration, realises 70% of it out of position. Does it clear the 27.3% price?",
              options: ["Yes, easily", "No: it realises about 24.5%"],
              answer: 1,
              explain: "0.35 × 0.7 = 0.245, so about 24.5%, below the 27.3% the call needs. On raw equity it looked like a call; once realisation is counted, it is a fold.",
              math: { fn: "product", args: [0.35, 0.7], value: 0.245 },
            },
          },
          "The realisation factors in this lesson are illustrations, not solved numbers. Rail's preflop charts already include realisation; the big blind's defence drills in the course show where that puts the borderline hands.",
        ],
      },
      {
        heading: "Implied odds: being paid later",
        blocks: [
          "Sometimes a call below the price is still right, because you win more than the current pot when you hit. That extra is implied odds.",
          "On the turn the pot is 20 bb and your opponent bets 10 bb: the call needs 25%. You hold an open-ended straight draw, 8 outs, and hit 8 / 46 of the time, about 17.4%. To break even, the pot you win when you hit must average 10 ÷ (8 / 46) = 57.5 bb. The pot after your call is 20 + 10 + 10 = 40 bb, so you need to win 57.5 − 40 = 17.5 bb more on the river when you hit.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 30, bet: 10, share: 0.174 },
            caption: "Your draw's equity sits below the price, so the call loses on its own. Implied odds have to make up the gap with money won later.",
          },
          {
            checkpoint: {
              question: "Same spot, but your opponent has only 12 bb left behind after this bet. Can implied odds rescue the call?",
              options: ["Yes", "No"],
              answer: 1,
              explain: "You need 17.5 bb more on average when you hit, and he can never pay more than the 12 bb he has left. Short stacks behind kill implied odds.",
            },
          },
          "Implied odds need three things: money behind to win, a hand your opponent will not see coming, and an opponent who pays when you hit.",
        ],
      },
      {
        heading: "Reverse implied odds",
        blocks: [
          "The opposite also happens: you hit and lose more, because your improved hand is still second best. Dominated hands are the usual culprits.",
          {
            list: [
              "Top pair with a weak kicker against a range full of better kickers.",
              "A low flush draw when a higher flush is possible.",
              "The low end of a straight that a higher straight beats.",
            ],
          },
          "These hands win small pots and lose big ones. Out of position and with deep stacks, the damage grows, which is one more reason the big blind folds offsuit hands that look playable.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Realised equity = raw equity × R. Compare that, not raw equity, with the price.",
        "Position, suitedness, connectedness and initiative raise R; being out of position and dominated lowers it.",
        "Implied odds need money behind, a disguised hand and an opponent who pays.",
        "Hands that make second-best hands carry reverse implied odds: they win small and lose big.",
      ],
      breaks: [
        "Realisation is not a property of the hand alone; the same hand realises more in position or with less money behind.",
        "Implied odds are easy to overestimate. Against short stacks or cautious players, use the plain price.",
      ],
    },
    exercises: {
      "bb-vs-btn":
        "Twelve big-blind decisions against a button open at 100 big blinds, 6-max, dealt towards the close hands. Fold, call or 3-bet, and Rail's chart grades it. Notice which suited and offsuit hands with similar raw equity land on opposite sides.",
    },
    checks: [
      { fn: "product", args: [0.4, 0.8], value: 0.32 },
      { fn: "sum", args: [2.5, 0.5, 1], value: 4 },
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
      { fn: "ratio", args: [8, 46], value: 0.174 },
      { fn: "ratio", args: [460, 8], value: 57.5 },
      { fn: "sum", args: [20, 10, 10], value: 40 },
      { fn: "sum", args: [57.5, -40], value: 17.5 },
    ],
  },
};
