import type { ConceptTexts } from "./types";

/** Foundations, English. Every number in an example is checked in `tests/test/learn.test.ts`. */
export const foundationsEn: ConceptTexts<"pot-odds" | "equity-realisation" | "ev-and-grading" | "gto-vs-exploitative" | "position"> = {
  "pot-odds": {
    summary: "The share of the final pot a call costs — and so the equity a call needs to break even.",
    definition: [
      "Pot odds compare what a call costs with what it can win. Facing a bet, the pot already holds everything that went in before, plus the bet itself; your call adds the last piece. The price of the call as a share of that final pot is the equity you need to break even.",
      "Players say it two ways: as a ratio (\"three to one\": the pot is three times the call) or as a percentage (25%: the call is a quarter of the pot it makes). They are the same number.",
    ],
    why: [
      "Every call is a bet that your hand wins often enough. Pot odds turn \"is this a good call?\" into a comparison: your equity against the price. If your hand wins more often than the price asks, the call makes money on average; if not, it loses.",
      "Bigger bets ask for more. A third-pot bet needs 20% equity to call, a pot-sized bet 33%, a double-pot overbet 40%. Knowing these by heart is the fastest maths at the table.",
      "Pot odds are exact only when nothing else happens after the call — the river, or an all-in. With cards and bets to come, money you win later (implied odds) and money you lose later or cannot win (reverse implied odds) change the real price.",
    ],
    formulas: [
      {
        name: "Required equity",
        expression: { frac: ["call", "pot + call"] },
        spoken: "Required equity equals the call divided by the pot plus the call, where the pot includes the bet you face.",
        where: [
          ["pot", "everything in the middle, including the bet you face"],
          ["call", "what it costs you to continue"],
        ],
      },
      {
        name: "EV of calling",
        expression: ["equity × (pot + call) − call"],
        spoken: "The EV of calling equals your equity times the pot plus the call, minus the call.",
      },
    ],
    example: {
      title: "A flush draw on the turn",
      setup: "The pot is 12 bb on the turn and your opponent bets 6 bb. You hold a flush draw: 9 outs among the 46 cards you cannot see.",
      steps: [
        "The pot you can win is 12 + 6 = 18 bb, and the call is 6 bb.",
        "Required equity: 6 / (18 + 6) = 6 / 24 = 25%. As a ratio, 18 to 6 is 3 to 1.",
        "Your equity: 9 / 46 ≈ 19.6% to hit on the river.",
        "EV of calling: 0.196 × 24 − 6 ≈ −1.3 bb.",
        "To break even you would need to win about 6.7 bb more, on average, on the rivers where you hit.",
      ],
      takeaway: "On price alone this is a fold. It becomes a call only if you expect to be paid enough on the river when the flush comes — that is what implied odds mean.",
    },
    mistakes: [
      "Dividing by the pot before the bet. 6 into 12 is not 50%: the bet is part of what you win.",
      "Comparing the price with your equity against every hand your opponent could hold, rather than against the hands that actually bet like this.",
      "Treating pot odds as the whole answer with cards to come. On the flop, bets on later streets change what a call really costs.",
      "Counting outs that also improve the opponent — a flush card that pairs the board can give them a full house.",
    ],
    tryIt: "Move the bet and watch the required equity: a small bet needs a little, an overbet needs a lot. Then set your equity and see the EV of the call cross zero exactly at the required equity.",
  },

  "equity-realisation": {
    summary: "Equity is your share of the pot if every card were dealt now; realisation is how much of it you actually collect.",
    definition: [
      "Your equity is how often you would win (counting ties as half) if the remaining cards were dealt with no more betting. Real hands do not go to showdown for free: there are bets on later streets, and some of them push you off a hand that would have won.",
      "Equity realisation is the share of that raw equity you turn into pot share once the betting is played out. A hand that realises 80% of its 40% equity behaves, in money terms, like a 32% hand. It can go above 100%: a hand in position that wins pots it would lose at showdown, by betting when the opponent checks, realises more than its equity.",
    ],
    why: [
      "It is why raw equity is not enough to call. Preflop, a hand can have the equity the price asks and still lose money, because it will often fold on the flop before that equity is cashed.",
      "Realisation is higher in position, with hands that make strong hands (suited, connected, pairs), with the betting initiative, and with shallower stacks. It is lower out of position, with offsuit hands that make weak top pairs, and deep.",
      "It also explains why the big blind can defend wide but not everything: it is getting a great price, but it plays the hand out of position.",
    ],
    formulas: [
      {
        name: "Realised equity",
        expression: ["equity × R"],
        spoken: "Realised equity equals equity times R, the realisation factor.",
        where: [["R", "the share of equity a hand turns into pot share; 1 means all of it"]],
      },
    ],
    example: {
      title: "Two hands with the same equity in the big blind",
      setup: "The button opens to 2.5 bb and the small blind folds. In the big blind the call costs 1.5 bb into a pot of 4 bb, so it needs 1.5 / 5.5 ≈ 27.3% equity. Against a wide button range, 7♥6♥ has about 39.5% and K♦4♣ about 40.3%.",
      steps: [
        "Raw equity says both are easy calls: about 40% against 27.3% needed.",
        "Suppose, for illustration, that 7♥6♥ realises 90% of its equity: it makes straights, flushes and two pairs, and can keep betting when it hits.",
        "Suppose K♦4♣ realises 65%: it mostly makes one pair with a weak kicker, and out of position it often folds to the second bet.",
        "Realised: 0.395 × 0.9 ≈ 35.5% for 7♥6♥ and 0.403 × 0.65 ≈ 26.2% for K♦4♣.",
      ],
      takeaway: "Same raw equity, opposite answers: 7♥6♥ clears the 27.3% comfortably, K♦4♣ falls just short. The realisation factors here are assumptions for the example; real ones come from solving the whole hand.",
    },
    mistakes: [
      "Calling preflop because an equity calculator says the hand is \"ahead of the range\". Equity at showdown is not money in your stack.",
      "Treating realisation as a property of the hand alone. The same hand realises more in position, with the initiative, or with less money behind.",
      "Forgetting the other side: hands that realise poorly can still be fine raises, because a raise can win the pot right away.",
    ],
    tryIt: "Pick a hand and a range to see its raw equity, then slide the realisation factor and watch where it crosses the price.",
  },

  "ev-and-grading": {
    summary: "Expected value is a decision's average result; Rail grades a decision by how much EV it gave up against a reference strategy.",
    definition: [
      "The expected value (EV) of an action is what it wins or loses on average, over every way the hand can continue, in big blinds. Folding is worth 0 from the moment you fold; every other action is measured against that.",
      "EV loss is the gap between the best option and the one you chose: max EV − EV of your choice. Zero means you chose an option as good as the best; it is never negative.",
      "Rail grades a decision by comparing it with a reference strategy — preflop charts, and later a solver. The reference gives every option at the spot a frequency (how often it plays that option with your exact hand) and an EV. Where there is no reference, Rail does not grade: it shows flags, notes about checks that hold whatever the strategy, and never calls a flag worse than Inaccurate.",
    ],
    why: [
      "Results lie in the short run. Winning a pot with a bad call does not make the call good; EV is how you tell the decision from the luck.",
      "Rail measures EV loss as a share of the pot, not in big blinds, because the same 2 bb is a disaster in a 4 bb pot and noise in a 100 bb pot.",
      "Strategies mix. When the reference calls 52% and raises 48%, both are right, so Rail treats every option within 5 percentage points of the most frequent one as Perfect. A player who always picks the 48% option is not wrong in any single hand; that pattern shows up in reports, never as a grade.",
      "Each move also gets a score from 0 to 100, for averages: 100 minus 1,000 times the EV loss as a share of the pot, so losing 3% of the pot scores 70 and losing 10% or more scores 0. When the loss is negligible, the score is the option's frequency against the most frequent one's.",
      "The grades, in order — Perfect: within 5 points of the most frequent option, or losing at most 0.1% of the pot. Good: the reference plays it at least 3.5% of the time. Inaccurate: rarer than that, losing at most 2% of the pot. Mistake: losing at most 8%. Blunder: anything more.",
    ],
    formulas: [
      {
        name: "EV loss",
        expression: ["max EV − EV(chosen)"],
        spoken: "EV loss equals the highest EV among the options minus the EV of the option you chose.",
      },
      {
        name: "EV loss, % of pot",
        expression: { frac: ["EV loss", "pot"] },
        spoken: "EV loss as a share of the pot equals the EV loss divided by the pot before the decision.",
      },
      {
        name: "Move score",
        expression: ["max(0, 100 − 1000 × EV loss % of pot)"],
        spoken: "The move score equals 100 minus 1000 times the EV loss as a share of the pot, and never less than zero.",
      },
    ],
    example: {
      title: "Grading one flop decision",
      setup: "The pot is 10 bb and you face a bet. The reference with your hand: fold 0% (EV 0), call 52% (EV 1.20 bb), raise 48% (EV 1.17 bb).",
      steps: [
        "You raise. 48% is within 5 points of 52%, so it is Perfect. The EV loss is 0.03 bb, 0.3% of the pot, so the move scores 100 − 1000 × 0.003 = 97.",
        "You fold instead. The reference never folds, and the EV loss is 1.20 bb, 12% of the pot: a Blunder, scoring 0.",
        "Change the spot: the reference raises only 2% of the time, with EV 1.05 bb. Raising now loses 0.15 bb, 1.5% of the pot, and is rarer than 3.5%: Inaccurate, scoring 85.",
      ],
      takeaway: "The grade follows how much a choice costs and how often the reference makes it — never whether the hand was won.",
    },
    mistakes: [
      "Judging a decision by the result of the hand.",
      "Reading \"Good\" as \"wrong\". Good is a choice the reference makes too, just not the most often.",
      "Comparing big-blind losses across pots of different sizes instead of the share of the pot.",
      "Treating a heuristic flag as a grade. A flag says a check failed; only a reference strategy can say how much it cost.",
    ],
    tryIt: "Set the reference frequencies and EVs, pick the option you played, and watch the grade and score change.",
  },

  "gto-vs-exploitative": {
    summary: "An equilibrium strategy cannot be beaten; an exploitative one beats a particular opponent harder, and can be beaten back.",
    definition: [
      "A game-theory-optimal (GTO) strategy is one half of an equilibrium: a pair of strategies where neither player can gain by changing theirs. Against it, the best an opponent can do is lose nothing — any deviation from equilibrium can only cost them or break even.",
      "An exploitative strategy deviates on purpose to win more from a specific opponent's mistakes — calling more against someone who bluffs too much, folding more against someone who never does. It earns more against that opponent and is open to being exploited in turn.",
    ],
    why: [
      "The reference Rail grades against is equilibrium-like, because it is the only standard that does not depend on who you played. A grade measures distance from that reference, not from the most profitable play against your actual opponent.",
      "So a deliberate exploit can grade as Inaccurate and still be right. Make that call when you have a real read; the grade tells you what you gave up if the read is wrong.",
      "Equilibrium play is also the best default against opponents you know nothing about: it cannot lose to anyone, and it profits from every mistake that equilibrium never makes.",
    ],
    formulas: [
      {
        name: "Indifferent bluff share",
        expression: { frac: ["bet", "pot + 2 × bet"] },
        spoken: "The bluff share that makes a bluff-catcher indifferent equals the bet divided by the pot plus twice the bet.",
      },
    ],
    example: {
      title: "A river bluff-catcher against three opponents",
      setup: "The pot is 10 bb and your opponent bets 7.5 bb on the river. You hold a hand that beats every bluff and loses to every value bet.",
      steps: [
        "The call risks 7.5 bb to win 17.5 bb. At equilibrium the bettor bluffs 7.5 / (10 + 15) = 30% of the time, and calling earns exactly 0: 0.30 × 17.5 − 0.70 × 7.5 = 0.",
        "Against someone who bluffs only 15%: 0.15 × 17.5 − 0.85 × 7.5 = −3.75 bb. Fold every bluff-catcher.",
        "Against someone who bluffs 45%: 0.45 × 17.5 − 0.55 × 7.5 = +3.75 bb. Call every bluff-catcher.",
      ],
      takeaway: "Equilibrium makes your opponent indifferent; exploiting is choosing a side when they are not. The read has to be good, because the same deviation loses just as much against the opposite mistake.",
    },
    mistakes: [
      "Thinking GTO means the most profitable play. It is the safest; against a weak opponent, a good exploit earns more.",
      "Exploiting on a tiny sample. Two big bluffs are a story, not a frequency.",
      "Assuming a mixed strategy means acting at random. The mix is a property of the whole range; each hand has its reasons.",
      "Treating every opponent pool as the same. The mistakes worth exploiting differ by stake and by room.",
    ],
    tryIt: "Move the opponent's bluff share and watch the EV of calling cross zero exactly at the indifferent share.",
  },

  position: {
    summary: "Acting last after the flop is worth money: you see what your opponent does before you decide.",
    definition: [
      "After the flop the player closest to the button's left acts first, and the button acts last. The player who acts last on every street is in position (IP); the other is out of position (OOP). Before the flop the order is different — the blinds act last — but the blinds are out of position for the rest of the hand against everyone.",
      "Position is relative. The cutoff is in position against the hijack and out of position against the button.",
    ],
    why: [
      "In position you decide with more information: you have seen a check or a bet before you choose. You can take a free card, check back a hand that wants a showdown, or bet when your opponent shows weakness.",
      "That information is why hands realise more of their equity in position, and why the same hand is a raise from the button and a fold from under the gun.",
      "There are also fewer players behind you to wake up with a hand. From the button only the blinds can still act; from under the gun, five players can.",
    ],
    formulas: [
      {
        name: "Chance everyone behind folds",
        expression: ["(1 − p)", { sup: "n" }],
        spoken: "The chance that every player behind folds equals one minus p, to the power n.",
        where: [
          ["p", "how often each player behind continues"],
          ["n", "how many players are still to act"],
        ],
      },
    ],
    example: {
      title: "The same steal from two seats",
      setup: "You open to 2.5 bb to win the 1.5 bb in the blinds, with a hand that has no equity worth counting if you are called. Say each player behind you continues 10% of the time.",
      steps: [
        "The steal breaks even when everyone folds 2.5 / (2.5 + 1.5) = 62.5% of the time.",
        "From under the gun, five players are behind: 0.9⁵ ≈ 59% that all fold. Short of 62.5% — a losing steal.",
        "From the button, two players are behind: 0.9² = 81%. Comfortably above 62.5%.",
      ],
      takeaway: "Same hand, same size, same opponents: the seat alone turns a losing steal into a winning one. That is why opening ranges widen towards the button.",
    },
    mistakes: [
      "Playing the same range from every seat.",
      "Calling raises out of position with hands that need position to realise their equity.",
      "Forgetting that position is relative: the cutoff opening is out of position against the button.",
    ],
    tryIt: "Pick a hand against a range and move the realisation factor: in position it goes up, out of position it goes down.",
  },
};
