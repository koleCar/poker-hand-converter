import type { LessonBodies } from "./types";

/**
 * Track 3 — the turn, English (Learn L3): T1 betting again, T2 defending the
 * turn, T3 the turn in 3-bet pots. Every computed number is listed in its
 * lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`. No solver frequency is written into the text:
 * the drills and splits show Rail's own turn solves at runtime, and every
 * direction the words give was read first from those solves
 * (`tests/scripts/learn-directions`, `npm run learn:directions`).
 */
export const tEn: LessonBodies<
  | "turn-card-classes"
  | "double-barreling"
  | "turn-sizing-and-overbets"
  | "turn-after-flop-checks-through"
  | "facing-turn-barrels"
  | "turn-check-raise-and-probe"
  | "3bp-turn"
> = {
  "turn-card-classes": {
    sections: [
      {
        heading: "Four kinds of turn card",
        blocks: [
          "The flop has been bet and called, and a fourth card comes. Before you think about your own hand, ask what the card does to the two ranges. Most turn cards fall into one of four kinds.",
          {
            list: [
              "An overcard: higher than every flop card. The preflop raiser holds more of the big cards, so it usually helps the raiser.",
              "A card that completes a draw: the third card of a suit, or the card that fills the obvious straight. It helps whoever holds more of the draws that called the flop, usually the caller.",
              "A pairing card: it pairs one of the flop cards. Few new strong hands appear, and the hands that were ahead mostly stay ahead.",
              "A low blank: below the board and connected to nothing. Little changes, and the flop's story goes on.",
            ],
          },
          "The words are for the ranges, not for your hand. A completing card can be a fine card for you if you hold the flush; it is still a bad card for the raiser's range, and the caller knows it.",
        ],
      },
      {
        heading: "What Rail's turn solves do with them",
        blocks: [
          "Rail solved the button's turn after its flop bet was called and the big blind checked, on many boards. The pattern is clear: the button bets most often when the turn pairs the board or brings an overcard, and least often when it puts a third card of a suit on the board. On that card even many top pairs check: one more card of the suit makes the caller's flushes, and the bet would be called by them and fold out the rest.",
          "Hands with nothing at all bet a lot on the good cards: an overcard that the big blind cannot hold often, or a pairing card that changes nothing, lets a bluff represent the strong part of the raiser's range.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Kd", "8c", "3d", "As"] },
            caption:
              "Illustrative ranges written for teaching, not Rail's charts: K♦8♣3♦ with the A♠ turn. Change the turn to the 5♦ and watch the raiser's lead shrink.",
          },
          {
            checkpoint: {
              question: "The button bet K♠8♦3♦ and the big blind called. Which turn does the button bet least often when checked to?",
              options: ["A♣", "3♣", "5♦", "2♠"],
              answer: 2,
              explain:
                "The 5♦ puts three diamonds on the board. The big blind's calling range holds many diamond draws that just got there, while the button's range has more big cards and pairs, which the ace and the pairing three favour. A blank deuce changes little.",
            },
          },
        ],
      },
      {
        heading: "Count what the card makes",
        blocks: [
          "Nut advantage moves faster than range advantage on the turn. A completing card turns draws into the best hands at once, and you can count how many.",
          "After a flop with two diamonds, ten diamonds are left in the deck. Any two of them make a flush once a third diamond lands: 10 × 9 / 2 = 45 combinations before ranges are applied. The caller's range keeps far more of those suited hands than an opener's range throws away, which is why the card is good for the caller.",
          "A pairing card works the other way: it makes trips or full houses only for the few hands that hold that rank, and the raiser's overpairs and top pairs stay where they were.",
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "Sort turn cards first on the teaching ranges, then play the button's turn on real solves and see where Rail keeps betting.",
          {
            note: {
              tone: "approximate",
              text: "The card sorting uses the concept library's hand-written teaching ranges. The turn drills are solved on demand from the charts' ranges narrowed through the flop by Rail's heuristic model, with one turn bet size, three quarters of the pot.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Name the card's kind before your hand's: overcard, completing card, pairing card or blank.",
        "As the raiser, keep betting most on overcards and pairing cards; slow down on the card that completes the obvious draw.",
        "On a completing card, even good one-pair hands often check.",
        "Hands with no showdown value make the best bluffs on cards that favour your range.",
      ],
      breaks: [
        "When your own hand holds the card that completes the draw, the range rule gives way: value-bet it.",
        "Against a caller who never draws to flushes, a third suited card is closer to a blank.",
      ],
    },
    exercises: {
      "turn-cards": "Eight turns on the teaching ranges: does the card help the raiser, the caller, or neither? Read by Rail's equity calculator.",
      "barrel-by-card": "Four turns where you bet the flop, were called and are checked to: bet or check, graded by Rail's turn solve.",
      "your-hands": "Your own first decisions on the turn, the costliest first.",
    },
    checks: [
      { fn: "product", args: [10, 9], value: 90 },
      { fn: "ratio", args: [90, 2], value: 45 },
    ],
  },

  "double-barreling": {
    sections: [
      {
        heading: "What a second barrel costs",
        blocks: [
          "The button opened to 2.5 bb, the big blind called, the button bet 1.8 bb on the flop and was called. The turn pot is 5.5 + 1.8 + 1.8 = 9.1 bb, with 100 − 2.5 − 1.8 = 95.7 bb behind.",
          "A turn bet of three quarters of the pot is about 6.8 bb. As a pure bluff it needs folds 6.8 / (9.1 + 6.8), about 42.8% of the time: [[bluffing-math-alpha-mdf|alpha]] again, and much more than the quarter or so a small flop bet needed. The big blind's range is also stronger now: its weakest hands folded on the flop.",
          "So the turn bet must earn more than folds. Value hands want calls from worse; bluffs need either cards that favour your range or equity of their own when called.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 9.1, bet: 6.8, share: 0.45 },
            caption: "A 6.8 bb turn bet into 9.1 bb. Move the fold rate to see where a bluff with no equity starts to profit.",
          },
        ],
      },
      {
        heading: "Which hands keep betting",
        blocks: [
          "In Rail's solves of the button's turn after a called flop bet, the classes split cleanly.",
          {
            list: [
              "Sets and other strong hands bet most of the time, unless the card completes the caller's draws: they want the pot to grow before the river.",
              "Draws bet often: they win when the big blind folds and still improve when it calls.",
              "Hands with no pair and no draw bet a lot on cards that favour the button, and give up on the cards that do not.",
              "Middle pairs and weak top pairs check most: they beat the bluffs that would call and lose to the hands that would.",
            ],
          },
          {
            checkpoint: {
              question: "The button bet Q♠7♦3♣ and was called. The turn is the 2♥ and the big blind checks. Which hand is the most natural check?",
              options: ["Q♣Q♥", "J♠T♠", "7♠6♠", "A♦K♦"],
              answer: 2,
              explain:
                "Queens want value. J♠T♠ has no pair and no draw, so it can only win by betting. A♦K♦ has no pair but two overcards and a little showdown value: Rail mixes it. 7♠6♠ is a middle pair: a bet is called by better pairs and folds out the hands it beats, so it checks and tries to reach showdown.",
            },
          },
        ],
      },
      {
        heading: "Plan the river before you bet",
        blocks: [
          "A second barrel is the start of a plan, not the end of one. Before betting, know which rivers you will bet again and which you will give up on. A bluff that cannot continue on most rivers has only one street of folds to win, and the price above says it needs a lot of them.",
          "Blockers help choose between bluffs that look alike: a hand holding a card the big blind needs for its best calls removes some of them. Lesson R1 counts that properly; on the turn it is a tie-breaker, not a reason.",
        ],
      },
      {
        heading: "Practising it",
        blocks: [
          "The split shows the button's whole range on one turn, after its flop bet was called and the big blind checked, by hand category. The drills then deal single hands where Rail's solve mixes.",
          {
            note: {
              tone: "approximate",
              text: "Turn solves on demand: the charts' ranges narrowed through the flop by Rail's heuristic model, with one turn bet size (three quarters of the pot) and all-in when the stacks are short.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "A turn bluff of three quarters of the pot needs about 43% folds; give it equity or a good card.",
        "Bet the turn with strong hands and draws; give up most middle pairs.",
        "Air bets the cards that favour your range and checks the ones that favour the caller.",
        "Decide which rivers you will bet before you bet the turn.",
      ],
      breaks: [
        "Against a big blind who calls the turn with any pair, bet fewer bluffs and more thin value.",
        "Against one who folds too much to a second bet, barrel more of your air on any card.",
      ],
    },
    exercises: {
      "barrel-split": "Two turns after your flop bet was called and the big blind checked: put each hand class into check or bet, graded class by class.",
      "barrel-turns": "Five turns where you are checked to after a called flop bet, dealt hands where Rail's solve mixes: bet or check?",
      "your-hands": "Your own first turn decisions as the preflop raiser in single-raised pots, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [5.5, 1.8, 1.8], value: 9.1 },
      { fn: "sum", args: [100, -2.5, -1.8], value: 95.7 },
      { fn: "product", args: [0.75, 9.1], value: 6.8, tolerance: 0.03 },
      { fn: "alpha", args: [9.1, 6.8], value: 0.428 },
    ],
  },

  "turn-sizing-and-overbets": {
    sections: [
      {
        heading: "The size that gets the stacks in",
        blocks: [
          "Size has a job: to get the right amount of money in by the river. With 9.1 bb in the pot and 95.7 bb behind, as in the last lesson, how big must two equal bets be to get everything in by the river? Each called bet of f times the pot makes the pot 1 + 2f times bigger, so two of them need (1 + 2f)² = 1 + 2 × 95.7 / 9.1. That is about 1.85 times the pot on each street.",
          "So in a single-raised pot at 100 bb, three-quarter-pot bets do not get the stacks in by the river. Only overbets do. A range that wants to play for stacks — the nuts and the bluffs that go with them — needs big sizes; a range of medium hands does not want stacks in at all.",
          {
            widget: { id: "spr", pot: 9.1, stack: 95.7 },
            caption: "The turn of a single-raised pot. Set the streets to two to see the bet that gets the stacks in by the river, then try the 3-bet pot of lesson T3.",
          },
        ],
      },
      {
        heading: "When an overbet fits",
        blocks: [
          "An overbet asks a lot of the other player and gives a lot of odds to nobody: it works when your range holds hands theirs cannot, so their bluff-catchers face the nuts and must fold or pay. That happens when their range is capped, after they checked or called small on earlier streets, and the card or the line left you with the strongest hands.",
          "Rail's river solve has a size above the pot, and it shows the pattern: in position after a check it overbets noticeably more often than out of position as the first to act, and the hands it overbets are the very strongest and the bluffs, not the medium ones.",
          {
            checkpoint: {
              question: "Where does Rail's river solve overbet more often?",
              options: ["In position, after the other player checks", "Out of position, first to act", "About equally in both"],
              answer: 0,
              explain:
                "A check caps the range that made it: it holds fewer of the strongest hands, because many of those would have bet. The player in position then holds more of the nuts relative to the range facing it, which is what an overbet needs.",
            },
          },
          "Pick overbet bluffs the same way: hands that hold cards of the other player's best calls, and none of the cards their folding hands need.",
        ],
      },
      {
        heading: "Medium hands check",
        blocks: [
          "The other side of a polarised turn is the check. Middle pairs and weak top pairs gain little from a big bet: better hands call it, worse ones fold. In Rail's turn solves they are among the classes that check most, which keeps the pot small and their showdown value alive.",
          {
            note: {
              tone: "approximate",
              text: "Rail's turn tree has one bet size, three quarters of the pot, plus all-in when the stacks are short, so turn overbets are taught here with the arithmetic and with the river solve, which has a 150% size. The river split below is graded with that size as its own group.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Size for the stacks: count how big the bets must be to get them in by the river.",
        "Overbet when the other range is capped and yours holds the nuts.",
        "Overbet bluffs hold cards of the hands that would call.",
        "Medium hands check, keeping the pot small.",
      ],
      breaks: [
        "Against a player who never folds a pair, overbet only for value.",
        "With stacks already short, the overbet is just the all-in: there is no size left to choose.",
      ],
    },
    exercises: {
      "size-the-turn": "Four turns after a called flop bet, checked to you: check, bet three quarters of the pot or go all-in, graded by Rail's turn solve.",
      "overbet-split": "Two rivers in position after a check: put each hand class into check, small, big or overbet, graded by Rail's river solve.",
      "your-hands": "Your own turn decisions where Rail would have bet, the costliest first.",
    },
    checks: [
      { fn: "geometricBet", args: [9.1, 95.7, 2], value: 1.85, tolerance: 0.005 },
    ],
  },

  "turn-after-flop-checks-through": {
    sections: [
      {
        heading: "Two capped ranges",
        blocks: [
          "When the big blind checks and the button checks back, both ranges have lost something. The button bets most of its strong hands on the flop, so its checking range holds fewer of them. The big blind checked first with everything, so its range is wide, but it did not lead with its best hands either.",
          "Who gains from that depends on the next card, and on what each range still hides. The button's checks still hold some strong hands kept back on purpose; the big blind's range is uncapped but full of weak hands.",
        ],
      },
      {
        heading: "Betting in position after the check",
        blocks: [
          "When the big blind checks again on the turn, Rail's solve has the button bet often: more often than on many turns after a called flop bet. Its range is capped, but the big blind's has shown two checks and holds a lot of hands that cannot stand a bet.",
          "The price is the flop's: a bet of three quarters of the 5.5 bb pot is about 4.1 bb, and as a pure bluff it needs about 42.7% folds. Against a range that checked twice, it often gets them.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 4.1, share: 0.45 },
            caption: "A 4.1 bb turn bet into 5.5 bb after the flop checked through. Move the fold rate to see where it profits.",
          },
        ],
      },
      {
        heading: "Leading out of position",
        blocks: [
          "A lead on the turn after the flop checks through is called a probe. In Rail's turn solves, the big blind leads rarely, even here: the hands that lead most often are made straights and strong draws, and the rest of its range checks and lets the button bet.",
          {
            checkpoint: {
              question: "The flop checked through. In Rail's turn solve, what does most of the big blind's range do first on the turn?",
              options: ["Leads three quarters of the pot", "Checks", "Goes all-in"],
              answer: 1,
              explain:
                "The button bets often when checked to, so the big blind's weak and medium hands lose little by checking and can call or fold after. Leading is kept for the hands that want to build a pot at once.",
            },
          },
          "Facing the button's bet, the big blind defends as usual: against 4.1 bb into 5.5 bb, [[bluffing-math-alpha-mdf|minimum defence]] is 5.5 / 9.6, about 57%, of the range that checked.",
          {
            note: {
              tone: "approximate",
              text: "Rail's turn tree has one bet size, three quarters of the pot. Smaller probes, which many players use, are not in it, so the solve's choice to lead rarely is a choice between checking and a big lead.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "After the flop checks through, bet the turn in position often when checked to again.",
        "A bluff of three quarters of the pot still needs about 43% folds; two checks often supply them.",
        "Out of position, lead only with hands that want a big pot now; check the rest.",
        "Defend a turn bet with at least the share minimum defence asks.",
      ],
      breaks: [
        "Against a big blind who check-raises the turn a lot, check back more medium hands.",
        "Against a button who never bets when checked to twice, lead your thin value yourself.",
      ],
    },
    exercises: {
      "delayed-bets": "Four turns after the flop checked through and the big blind checked again: bet or check, graded by Rail's turn solve.",
      "probe-split": "Two turns as the big blind after the flop checked through: put each hand class into check or bet, graded class by class.",
      "your-hands": "Your own first turn decisions after a checked flop in single-raised pots, the costliest first.",
    },
    checks: [
      { fn: "product", args: [0.75, 5.5], value: 4.1, tolerance: 0.03 },
      { fn: "alpha", args: [5.5, 4.1], value: 0.427 },
      { fn: "mdf", args: [5.5, 4.1], value: 0.57, tolerance: 0.005 },
      { fn: "sum", args: [5.5, 4.1], value: 9.6 },
    ],
  },

  "facing-turn-barrels": {
    sections: [
      {
        heading: "The price of a second barrel",
        blocks: [
          "You called a flop bet; the turn pot is 9.1 bb, and the raiser bets three quarters of it, 6.8 bb. Calling puts in 6.8 to win a pot of 9.1 + 6.8 + 6.8 = 22.7 bb: you need [[pot-odds|pot odds]] of 6.8 / 22.7, about 30% equity, if no more money goes in.",
          "Minimum defence is 9.1 / 15.9, about 57%: the share of your range that must continue so a pure bluff cannot profit. It is a guide, not a rule. The raiser's turn range is not all bluffs, and the river is still to come, where position decides how much of your equity you keep.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 15.9, bet: 6.8 },
            caption: "A 6.8 bb call into a pot of 15.9 bb with the bet in it. Change the bet size to see the price move.",
          },
        ],
      },
      {
        heading: "Which hands keep calling",
        blocks: [
          "In Rail's turn solves, against a bet of three quarters of the pot, the classes defend in a clear order: top pairs call nearly always, middle pairs often, weak pairs fold more often than they call, gutshots mostly fold, and hands with no pair fold. The most interesting line is the draws.",
          {
            checkpoint: {
              question: "Out of position against a turn bet of three quarters of the pot, which hand does Rail's solve fold most often?",
              options: ["A flush draw", "A middle pair", "A top pair"],
              answer: 0,
              explain:
                "With one card to come a flush draw has 9 outs among 46 cards, about 19.6%, short of the 30% the price asks. In position it can still call more often, because it bets when it hits and checks when it misses; out of position it pays the price and often gets no more when it hits.",
              math: { fn: "ratio", args: [9, 46], value: 0.196 },
            },
          },
          "That is equity realisation on the turn: the same draw is a call in position and often a fold out of position.",
        ],
      },
      {
        heading: "Capped ranges make small pairs calls",
        blocks: [
          "Who bets the turn matters as much as the size. A raiser who checked the flop and bets the turn holds fewer strong hands than one who bet twice; against that capped range, low pairs gain in value as bluff-catchers. Read the line, then the size, then your hand.",
          {
            note: {
              tone: "approximate",
              text: "Turn solves on demand: the charts' ranges narrowed through the flop by Rail's heuristic model, with one turn bet size, three quarters of the pot, and all-in when the stacks are short.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Against three quarters of the pot you need about 30% equity, and about 57% of your range must continue.",
        "Top pairs call; middle pairs mix; weak pairs and no pair mostly fold.",
        "Draws call more in position than out of position.",
        "Read who bet and how before you count your hand: capped lines make small pairs calls.",
      ],
      breaks: [
        "Against a player who barrels only with strong hands, fold more of the middle.",
        "Against one who barrels every turn, call more of the middle and some of the weak pairs.",
      ],
    },
    exercises: {
      "defend-split": "Two turns out of position after you called a flop bet and the turn is bet: put each hand class into fold, call or raise, graded class by class.",
      "turn-barrels": "Five turns in position facing a bet as the preflop caller: fold, call or raise, graded by Rail's turn solve.",
      "your-hands": "Your own turn decisions facing a bet, the costliest first, and turns flagged for calls without the odds.",
    },
    checks: [
      { fn: "sum", args: [9.1, 6.8, 6.8], value: 22.7 },
      { fn: "requiredEquity", args: [15.9, 6.8], value: 0.2996, tolerance: 0.005 },
      { fn: "mdf", args: [9.1, 6.8], value: 0.57, tolerance: 0.005 },
      { fn: "sum", args: [9.1, 6.8], value: 15.9 },
    ],
  },

  "turn-check-raise-and-probe": {
    sections: [
      {
        heading: "Check-raising the turn",
        blocks: [
          "Out of position against a turn bet, the strongest move is the check-raise. It is also the most expensive one, and Rail's solves keep it narrow: the big blind raises mostly with straights, sets and two pairs, and only a few strong draws join them.",
          "The reason is the stacks. A turn raise in a single-raised pot sets up a river all-in; a draw that raises and misses has to give up a big pot or bluff the rest. Strong made hands raise because they want all the money in, and they still win when called.",
          {
            checkpoint: {
              question: "Out of position against a turn bet of three quarters of the pot, which hand does Rail's solve raise most often?",
              options: ["A straight", "A flush draw", "A top pair"],
              answer: 0,
              explain:
                "The straight wants to get the stacks in and is rarely behind. The flush draw mostly calls or folds out of position, and the top pair calls: it beats the bluffs and the worse pairs, and a raise would only be called by better.",
            },
          },
        ],
      },
      {
        heading: "Leading the turn",
        blocks: [
          "Leading into the raiser on the turn — after calling the flop, or after the flop checked through — is a small part of a sound strategy. In Rail's solves it is rare in both lines, and the hands that lead are the ones that want a big pot at once: strong made hands that improved, and the strongest draws.",
          "Everything else checks: the raiser bets often enough to do the work, and your medium hands keep their showdown value.",
        ],
      },
      {
        heading: "Size for the stacks behind",
        blocks: [
          "When you lead or raise to build a pot, size it so the stacks go in by the river. Say there are 20 bb in the pot and 40 bb behind. Two equal bets of f times the pot get it all in when (1 + 2f)² = 1 + 2 × 40 / 20 = 5, which is about 62% of the pot on each street.",
          "The same count, with deeper stacks, says why a turn raise in a single-raised pot is so big a commitment: with nearly 100 bb behind, it is the only street left to grow the pot before the river shove.",
          {
            widget: { id: "spr", pot: 20, stack: 40 },
            caption: "20 bb in the pot and 40 bb behind. Set the streets to two to see the bet that gets the stacks in.",
          },
          {
            note: {
              tone: "approximate",
              text: "Rail's turn tree has one bet size and one raise size, three quarters of the pot each, plus all-in. Smaller leads and raises are taught here in words.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Check-raise the turn mostly with strong made hands, plus a few of the strongest draws.",
        "Lead the turn rarely: only hands that want a big pot now.",
        "Check-call your medium hands; let the raiser bet.",
        "Size leads and raises so the stacks go in by the river.",
      ],
      breaks: [
        "Against a raiser who barrels every turn, check-raise a few more draws.",
        "Against one who checks back too much, lead more of your thin value.",
      ],
    },
    exercises: {
      "turn-fold-call-raise": "Two turns out of position facing a bet: put each hand class into fold, call or raise, graded class by class against Rail's turn solve.",
      "probe-or-check": "Four turns out of position as the preflop caller, first to act, dealt hands where the solve mixes: bet or check?",
      "your-hands": "Your own turn decisions out of position as the preflop caller, the costliest first.",
    },
    checks: [
      { fn: "geometricBet", args: [20, 40, 2], value: 0.62, tolerance: 0.005 },
    ],
  },

  "3bp-turn": {
    sections: [
      {
        heading: "Little behind, big pot",
        blocks: [
          "The big blind 3-bets the button to 10 bb and is called: 20.5 bb in the pot, 90 bb behind, an SPR of about 4.4. A third-pot flop bet of 6.8 bb is called. The turn pot is 34.1 bb with 83.2 bb behind: an SPR of about 2.4.",
          "Now a turn bet of three quarters of the pot is about 25.6 bb. If it is called, the river pot is 85.3 bb with 57.6 bb behind, an SPR of about 0.68: the river bet is all-in at less than the pot. The turn decision is the decision about the stacks.",
          {
            widget: { id: "spr", pot: 34.1, stack: 83.2 },
            caption: "The 3-bet pot on the turn. Set the streets to two: the bet that gets the stacks in is not far from three quarters of the pot.",
          },
        ],
      },
      {
        heading: "Barrel or give up",
        blocks: [
          "Rail's solves of the 3-bettor's turn show the same split as in single-raised pots, sharper. Top pairs and better bet more often than they check; hands with no pair and no showdown value bet a lot; middle pairs check most of the time. With so little behind, a medium hand that bets and is raised has nowhere to go.",
          {
            checkpoint: {
              question: "The 3-bettor is checked to on the turn with about 2.4 times the pot behind. Which hand is the most natural check?",
              options: ["An overpair", "A middle pair", "Ace-king with no pair and no draw"],
              answer: 1,
              explain:
                "The overpair wants the stacks in and gets there with a turn bet and a river shove. Ace-king has no showdown value but two overcards: it can bet and win the pot, or improve. The middle pair beats bluffs only and cannot stand a raise with the stacks this short, so it checks.",
            },
          },
        ],
      },
      {
        heading: "Defending the turn as the caller",
        blocks: [
          "Against a turn bet of 25.6 bb into 34.1 bb, minimum defence is 34.1 / 59.7, about 57%. Rail's solves defend with the top pairs and the strong draws, raise the strongest hands, and fold most middle and weak pairs: with the river all-in to come, a call now is often a call for the stacks.",
          {
            note: {
              tone: "approximate",
              text: "Turn solves on demand: the charts' 3-bet and calling ranges narrowed through the flop by Rail's heuristic model, with one turn bet size, three quarters of the pot, and all-in when the stacks are short.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "In a 3-bet pot, count the SPR on the turn: near 2, a turn bet sets up the river all-in.",
        "Barrel strong hands and air; check middle pairs.",
        "Defend with top pairs and strong draws; most middle pairs fold.",
        "Decide on the turn whether you are playing for the stacks.",
      ],
      breaks: [
        "Deeper stacks (a 3-bet pot at 150 bb or more) leave room for a third street and more checking.",
        "Against a caller who never folds the turn, bet fewer bluffs and more medium value.",
      ],
    },
    exercises: {
      "3bp-turn-split": "Two turns in a 3-bet pot, you the in-position 3-bettor after a check: put each hand class into check or bet, graded class by class.",
      "3bp-turns": "Five turns in 3-bet pots, either role, graded by Rail's turn solve.",
      "your-hands": "Your own turn decisions in 3-bet pots, the costliest first.",
    },
    checks: [
      { fn: "sum", args: [10, 10, 0.5], value: 20.5 },
      { fn: "spr", args: [90, 20.5], value: 4.4, tolerance: 0.05 },
      { fn: "product", args: [0.33, 20.5], value: 6.8, tolerance: 0.05 },
      { fn: "sum", args: [20.5, 6.8, 6.8], value: 34.1 },
      { fn: "sum", args: [90, -6.8], value: 83.2 },
      { fn: "spr", args: [83.2, 34.1], value: 2.4, tolerance: 0.05 },
      { fn: "product", args: [0.75, 34.1], value: 25.6, tolerance: 0.03 },
      { fn: "sum", args: [34.1, 25.6, 25.6], value: 85.3 },
      { fn: "sum", args: [83.2, -25.6], value: 57.6 },
      { fn: "spr", args: [57.6, 85.3], value: 0.68, tolerance: 0.005 },
      { fn: "sum", args: [34.1, 25.6], value: 59.7 },
      { fn: "mdf", args: [34.1, 25.6], value: 0.57, tolerance: 0.005 },
    ],
  },
};
