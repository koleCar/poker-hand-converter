import type { LessonBodies } from "./types";

/**
 * M3 — preflop, English. Every computed number in a section is listed in its
 * lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`. No chart or solver frequency is quoted: the
 * drills deal from Rail's own charts and show them.
 */
export const m3En: LessonBodies<
  | "positions-and-opening-ranges"
  | "open-sizing"
  | "facing-an-open"
  | "three-betting"
  | "facing-3bets-and-4bets"
  | "blind-play-and-bvb"
  | "squeezes-and-multiway-preflop"
  | "limpers-and-isolation"
> = {
  "positions-and-opening-ranges": {
    sections: [
      {
        heading: "Every seat has a name",
        blocks: [
          "Seats are named by where they sit relative to the button. At a six-handed table they are UTG (under the gun), HJ (hijack), CO (cutoff), BTN (button), SB (small blind) and BB (big blind). The first player to act preflop is UTG; the button acts last on every street after the flop.",
          "A full-ring table adds three seats at the front: UTG, UTG+1, UTG+2, LJ (lojack), HJ, CO, BTN, SB and BB. Rail names a seat by its distance from the button, so the last six seats of a nine-handed table carry the same names as a six-handed one.",
          {
            checkpoint: {
              question: "At a nine-handed table, which seat has exactly as many players behind it as UTG at a six-handed table?",
              options: ["UTG+1", "LJ", "HJ"],
              answer: 1,
              explain:
                "Six-max UTG has five players behind: HJ, CO, BTN, SB and BB. At nine-handed the lojack has the same five behind it. Once the three early seats have folded, the lojack faces the same table that six-max UTG does.",
            },
          },
        ],
      },
      {
        heading: "The players behind you set the risk",
        blocks: [
          "When you open, you win the blinds at once only if everyone still to act folds. Each extra player behind you is one more chance that somebody holds a hand good enough to call or re-raise.",
          "A made-up number shows how fast this adds up. Say every player behind you, on any given hand, holds something worth continuing with 10% of the time. Everyone folds 0.9 × 0.9 × … once per player: with two players behind that is 81%, with five about 59%, with eight about 43%.",
          "So the same hand that opens happily from the button can be a fold from under the gun. Nothing about the cards changed; the number of people who can wake up behind you did.",
        ],
      },
      {
        heading: "Position after the flop",
        blocks: [
          "The second reason is position. An open from the cutoff or button is usually played in position after the flop, because only the blinds act after you and they act first on every later street. An open from UTG is often called by a player who will act after you on every street.",
          "Acting last lets you see what the opponent does before you decide, take free cards, and bet when they show weakness. Hands that need help from the board, such as suited connectors and small pairs, gain the most from that. This is why [[thinking-in-ranges|opening ranges]] get wider with every seat closer to the button.",
        ],
      },
      {
        heading: "Why the button opens so many hands",
        blocks: [
          "From the late seats an open is partly a steal: you risk the open to win the 1.5 bb already in the middle. A 2.5 bb open breaks even if everyone folds 2.5 / (2.5 + 1.5) = 62.5% of the time, even if it never wins when called.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 1.5, bet: 2.5, share: 0.6 },
            caption: "Set the blinds and the open. The lead number is how often everyone must fold for a steal that never wins when called to break even; slide the fold rate across it to see the EV turn.",
          },
          "In practice a called steal still has equity, and from the button it keeps position, so the real break-even is lower. Only two players are left to beat, which is why the button opens far more hands than any earlier seat. The small blind is its own case: one player left, but out of position to that player for the whole hand.",
          {
            checkpoint: {
              question: "You open the button to 2 bb instead of 2.5 bb. How often must the blinds fold for a steal that never wins when called?",
              options: ["About 50%", "About 57%", "About 67%"],
              answer: 1,
              explain: "You risk 2 bb to win 1.5 bb: 2 / (2 + 1.5) ≈ 57.1%. A smaller open needs fewer folds, which is part of why late seats open small.",
              math: { fn: "alpha", args: [1.5, 2], value: 0.571 },
              reveal: { id: "bet-math", focus: "steal", pot: 1.5, bet: 2, share: 0.57 },
            },
          },
        ],
      },
      {
        heading: "Six-max and full ring",
        blocks: [
          "The seat names line up, and so does the logic. From the lojack onward a nine-handed table plays much like a six-handed one, because the same number of players is left behind. The difference is the three seats in front: UTG, UTG+1 and UTG+2 at full ring have six, seven and eight players behind, so they open much tighter than six-max UTG.",
          "Online cash games are mostly six-handed; live games are mostly eight to ten-handed. If you play live, the early seats are where most of your discipline is needed. Rail has charts for both, and the drills below deal from them seat by seat.",
          {
            list: [
              "Count the players behind you before you look at your cards.",
              "The first three seats at full ring are the tightest seats in poker.",
              "From the lojack to the button, think six-max.",
            ],
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "The fewer players behind you, the wider you open: each seat closer to the button adds hands.",
        "At full ring, UTG to UTG+2 are tighter than six-max UTG; from the lojack on, the seats play like six-max.",
        "A 2.5 bb steal into 1.5 bb of blinds breaks even at 62.5% folds before counting the equity it keeps when called.",
        "Open or fold first in; leave limping to the small blind, where the charts use it.",
      ],
      breaks: [
        "Blinds who defend and 3-bet a lot make late-seat steals worse; blinds who fold too much make them better.",
        "Antes, straddles and short stacks change the price and the hands that play well, so the 100 bb no-ante picture shifts.",
      ],
    },
    exercises: {
      "opens-6max":
        "Twelve unopened spots at a six-handed table, dealt from Rail's 100 bb charts and biased toward the close hands. Open or fold before the chart shows its answer.",
      "opens-9max":
        "The same drill at a nine-handed table. Watch how much tighter the first three seats are than anything at six-max.",
      "paint-a-seat":
        "Paint one seat's opening range on the grid, then compare it with Rail's chart cell by cell. Coming soon.",
    },
    checks: [
      { fn: "allFold", args: [0.9, 2], value: 0.81 },
      { fn: "allFold", args: [0.9, 5], value: 0.59 },
      { fn: "allFold", args: [0.9, 8], value: 0.43 },
      { fn: "alpha", args: [1.5, 2.5], value: 0.625 },
    ],
  },

  "open-sizing": {
    sections: [
      {
        heading: "Three things the size changes",
        blocks: [
          "The size of your open is not just a habit. It sets three numbers at once: how often your open has to win the blinds straight away, what price the big blind gets to call, and how big the pot is when the flop comes.",
          "Each of them pulls in a different direction, which is why there is no single right size for every table. What there is, is a clear trade-off you can work out on a napkin.",
        ],
      },
      {
        heading: "Your side: bigger opens need more folds",
        blocks: [
          "An open risks its size to win the 1.5 bb of blinds. The break-even fold rate is the open divided by the open plus the blinds:",
          {
            list: [
              "2 bb: 2 / 3.5 ≈ 57.1%.",
              "2.5 bb: 2.5 / 4 = 62.5%.",
              "3 bb: 3 / 4.5 ≈ 66.7%.",
              "4 bb: 4 / 5.5 ≈ 72.7%.",
            ],
          },
          "Doubling the open from 2 bb to 4 bb does not double what you win when they fold; it is still 1.5 bb. It only raises what you lose every time someone plays back.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 1.5, bet: 2.5, share: 0.6 },
            caption: "Move the open size and watch the break-even fold rate climb. Add antes to the blinds and watch it fall.",
          },
        ],
      },
      {
        heading: "The big blind's side: bigger opens give a worse price",
        blocks: [
          "When the small blind folds, the big blind calls the open minus the 1 bb it already posted, into a pot of the open plus 1.5 bb. Against 2 bb it calls 1 into 3.5 and needs 1 / 4.5 ≈ 22.2%. Against 2.5 bb it calls 1.5 into 4 and needs about 27.3%. Against 4 bb it calls 3 into 5.5 and needs about 35.3%.",
          "So a bigger open folds out more of the blinds' weak hands. That is the case for it. The case against is that the hands which continue are stronger, and you have paid more to find out.",
          {
            checkpoint: {
              question: "You open to 3 bb and the small blind folds. How much equity does the big blind need to call?",
              options: ["About 25%", "About 31%", "About 40%"],
              answer: 1,
              explain: "The pot is 3 + 0.5 + 1 = 4.5 bb and the call is 3 − 1 = 2 bb. The final pot is 6.5 bb, and 2 of it is the big blind's: 2 / 6.5 ≈ 30.8%.",
              math: { fn: "requiredEquity", args: [4.5, 2], value: 0.308 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 4.5, bet: 2, share: 0.308 },
            },
          },
        ],
      },
      {
        heading: "\"I open 12 bb and nobody calls\"",
        blocks: [
          "A 12 bb open has to win the blinds 12 / 13.5 ≈ 88.9% of the time to break even as a steal. When everyone folds you win 1.5 bb. When someone continues, they hold a hand that is happy to play a big pot, and your weaker opens are in trouble.",
          "That is the problem with huge opens: you win small when they fold and lose big when they do not. If nobody ever calls, the size is not working; it is just making every mistake expensive.",
          {
            checkpoint: {
              question: "At a table where most players fold to big opens, who calls your 12 bb open?",
              options: ["Mostly hands that are ahead of your range", "Any two cards, because the pot is big", "The same hands that call a 2.5 bb open"],
              answer: 0,
              explain: "A big price filters the callers. Only hands strong enough to like the price continue, so your opening range is up against the top of theirs every time it is called.",
            },
          },
        ],
      },
      {
        heading: "The pot you take to the flop",
        blocks: [
          "Size also sets the stack-to-pot ratio. Open 2.5 bb at 100 bb and the big blind calls: the pot is 2.5 + 2.5 + 0.5 = 5.5 bb with 97.5 bb behind, an SPR of about 17.7. Open 4 bb instead and the pot is 8.5 bb with 96 bb behind, an SPR of about 11.3.",
          {
            widget: { id: "spr", pot: 5.5, stack: 97.5 },
            caption: "Change the pot to see how the open size moves the SPR, and how many pot-sized bets it takes to get the stacks in.",
          },
          "A lower SPR makes one strong pair easier to play for stacks. That suits a range full of big cards, which is one reason players with value-heavy ranges like larger opens.",
        ],
      },
      {
        heading: "Online, live, and when to change",
        blocks: [
          "Rail's charts open to 2.5 bb from UTG to the button and 3 bb from the small blind at 100 bb, and 2.2 bb at 40 bb. Those are sound defaults for raked online games, where the blinds fight back.",
          "Live pools call far more often. Against players who call almost any open, a bigger size with a range weighted toward strong hands wins more when called. A 5 bb open needs 5 / 6.5 ≈ 76.9% folds as a pure steal, but against players who call too much you are not stealing; you are charging them.",
          {
            list: [
              "Behind limpers, add about 1 bb for each limper. That is an isolation raise, and it has its own lesson.",
              "Antes add dead money: the same open needs fewer folds, so you can open smaller and wider.",
              "A straddle doubles the big blind; scale every size with it. Rail does not analyse straddled pots yet.",
            ],
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bigger opens need more folds and give the big blind a worse price: 2.5 bb needs 62.5% folds and gives the big blind about 27.3%.",
        "When nobody calls your opens, the size is too big, not perfect.",
        "Bigger opens lower the SPR, which suits value-heavy ranges.",
        "Live, against players who call too much, size up with a stronger range rather than steal wide.",
      ],
      breaks: [
        "With antes or a straddle the dead money changes, so the online defaults no longer fit as they are.",
        "Against blinds who 3-bet a lot, a smaller open loses less each time it is attacked.",
      ],
    },
    exercises: {
      "steal-price":
        "Six opens of different sizes into 1.5 bb of blinds. Work out how often everyone must fold for a pure steal to break even before the calculator shows it.",
      "blind-price":
        "Six opens, the small blind folds. Work out the equity the big blind needs to call before the calculator shows it.",
      "your-hands":
        "Your own unopened decisions where the analysis found the costliest mistakes. Decide before you see what you did.",
    },
    checks: [
      { fn: "alpha", args: [1.5, 2], value: 0.571 },
      { fn: "alpha", args: [1.5, 2.5], value: 0.625 },
      { fn: "alpha", args: [1.5, 3], value: 0.667 },
      { fn: "alpha", args: [1.5, 4], value: 0.727 },
      { fn: "requiredEquity", args: [3.5, 1], value: 0.222 },
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "requiredEquity", args: [5.5, 3], value: 0.353 },
      { fn: "alpha", args: [1.5, 12], value: 0.889 },
      { fn: "sum", args: [2.5, 2.5, 0.5], value: 5.5 },
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "sum", args: [4, 4, 0.5], value: 8.5 },
      { fn: "spr", args: [96, 8.5], value: 11.3 },
      { fn: "alpha", args: [1.5, 5], value: 0.769 },
    ],
  },

  "facing-an-open": {
    sections: [
      {
        heading: "Three answers, three costs",
        blocks: [
          "When someone opens in front of you, you can fold, call or 3-bet. Folding costs nothing more. Calling keeps the pot small and lets you see a flop. A 3-bet risks more but can win the pot at once and takes the lead.",
          "Start from the opener's range, not your cards. An UTG open at full ring is a narrow, strong range; a button open is a wide one. The same hand can be a 3-bet against the button and a fold against UTG.",
        ],
      },
      {
        heading: "Dominated hands",
        blocks: [
          "A hand is dominated when the opener often holds the same high card with a better kicker. KJ against an early open is the classic case: when you pair your king you can be against AK or KQ, and you lose a big pot with the second-best pair.",
          "[[combos-and-card-removal|Card removal]] shows why it matters which cards you hold. With A♠J♦, the opener's AK drops from 16 combos to 3 × 4 = 12, and so does AQ, but KQ keeps all 16. You block some of the hands that dominate you, not all of them.",
          {
            widget: { id: "combos", preset: "broadway", hand: ["As", "Jd"] },
            caption: "Pick your hand and see how many combos of each strong broadway hand are left. Try K♣J♦ and Q♥J♥ as well.",
          },
          "Pairs and suited connectors do not have this problem: they make sets, straights and flushes, hands that win big pots instead of losing them.",
          {
            checkpoint: {
              question: "Against a tight early-position open, which hand is in more danger of being dominated?",
              options: ["K♣J♦", "7♥6♥", "5♠5♦"],
              answer: 0,
              explain:
                "KJ offsuit makes top pair that a tight range often beats with a better kicker. 76 suited and 55 rarely make the same hand as the opener; when they hit, they make something different and strong.",
            },
          },
        ],
      },
      {
        heading: "In position or out of position",
        blocks: [
          "Two ideas price every call here. [[pot-odds|Pot odds]]: the equity a call needs is the call divided by the pot after you call, the opener's raise included. [[equity-realisation-and-implied-odds|Realisation]]: the share of that equity a hand turns into winnings, higher in position and for hands that make strong hands, lower out of position.",
          "Calling in position, say on the button against a cutoff open, is the easiest call in poker: you act last on every street and realise more of your equity. Only the blinds are left behind you to squeeze.",
          "Calling out of position is worse. The small blind is out of position to the opener and still has the big blind behind it. Against a 2.5 bb button open, the small blind calls 2 bb into a pot of 4 bb, while the big blind would call 1.5 bb into the same pot and needs only about 27.3%.",
          {
            checkpoint: {
              question: "The button opens to 2.5 bb. How much equity does the small blind need to call, before thinking about position or the big blind behind?",
              options: ["About 27%", "About 33%", "About 40%"],
              answer: 1,
              explain: "The pot is 2.5 + 0.5 + 1 = 4 bb and the call is 2.5 − 0.5 = 2 bb: 2 / 6 ≈ 33.3%. A worse price than the big blind's, out of position, without closing the action. That is why the small blind leans towards 3-bet or fold.",
              math: { fn: "requiredEquity", args: [4, 2], value: 0.333 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 4, bet: 2, share: 0.333 },
            },
          },
        ],
      },
      {
        heading: "Rake taxes the flop",
        blocks: [
          "Rail's charts assume 5% rake capped at 3 bb, taken only when the hand sees a flop. A 3-bet that wins preflop pays no rake; a call that goes to the flop always does.",
          "Small pots pay the full 5%: a pot that ends at 20 bb pays 1 bb. The cap only starts to help in pots over 60 bb, because 5% of 60 bb is the 3 bb cap. Single-raised pots rarely get there, so marginal calls lose more in raked games than a no-rake chart suggests. That pushes some calls into 3-bets and others into folds.",
        ],
      },
      {
        heading: "Putting it together",
        blocks: [
          {
            list: [
              "Narrow your continuing range as the opener's seat gets earlier.",
              "Fold dominated offsuit hands against strong ranges; keep pairs and suited hands that make strong hands.",
              "Call more in position, especially on the button; from the small blind, prefer 3-bet or fold.",
              "In raked games, every marginal call costs a little more than it looks.",
            ],
          },
          "Which hands Rail's charts flat and which they 3-bet changes with every seat pair. The drill deals the close ones; that is where the lesson sticks.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "The earlier the opener's seat, the tighter you continue.",
        "Offsuit hands that share a high card with the opener's range are the first to fold.",
        "Call in position; from the small blind, 3-bet or fold most of the time.",
        "Rake falls on hands that see a flop, so it punishes calls more than 3-bets.",
      ],
      breaks: [
        "Against openers who fold too much to 3-bets, more of your calls should become 3-bets.",
        "With no rake, or very deep stacks, speculative calls in position gain value.",
      ],
    },
    exercises: {
      "call-3bet-fold":
        "Twelve spots facing an open, dealt from Rail's charts and biased toward the close decisions. Fold, call or 3-bet before the chart shows its answer.",
      "your-hands":
        "Your own decisions facing an open from UTG+1 to the button, the costliest first. Decide before you see what you did.",
    },
    checks: [
      { fn: "product", args: [4, 4], value: 16 },
      { fn: "product", args: [3, 4], value: 12 },
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "product", args: [20, 0.05], value: 1 },
      { fn: "ratio", args: [3, 0.05], value: 60 },
    ],
  },

  "three-betting": {
    sections: [
      {
        heading: "Two ways a 3-bet wins",
        blocks: [
          "A 3-bet wins in two ways: everyone folds and you take the pot now, or you are called and your hand plays a bigger pot well. Strong hands 3-bet mostly for the second reason, bluffs mostly for the first.",
          "Rail's charts 3-bet to three times the open in position and four times out of position. Against a 2.5 bb cutoff open, a button 3-bet goes to 2.5 × 3 = 7.5 bb into a pot of 2.5 + 0.5 + 1 = 4 bb.",
          {
            checkpoint: {
              question: "The cutoff opens to 2.5 bb and you 3-bet the button to 7.5 bb with a hand that never wins when called. How often must everyone fold?",
              options: ["About 50%", "About 65%", "About 75%"],
              answer: 1,
              explain: "You risk 7.5 bb to win the 4 bb in the middle: 7.5 / (7.5 + 4) ≈ 65.2%. The cutoff and both blinds all have to fold.",
              math: { fn: "alpha", args: [4, 7.5], value: 0.652 },
              reveal: { id: "bet-math", focus: "alpha", pot: 4, bet: 7.5, share: 0.65 },
            },
          },
        ],
      },
      {
        heading: "Linear or polarised",
        blocks: [
          "A linear 3-bet range is built from the top down: the best hands, then the next best, with nothing weak mixed in. A polarised range takes the strongest hands and some bluffs, and calls with the hands in between.",
          "Which shape fits depends on how good calling is. When calling is attractive, as in position against a late open, the middle of your range can call and the 3-bet becomes polarised. When calling is poor, as from the small blind with the big blind behind, or where rake punishes flats, the middle hands move into the 3-bet and the range becomes more linear.",
          "Against an opener who calls 3-bets too often, bluffs lose value and the range should lean linear. Against one who folds too often, bluffs gain.",
        ],
      },
      {
        heading: "Choosing bluffs: blockers and playability",
        blocks: [
          "Good 3-bet bluffs do two jobs. They remove some of the hands that would 4-bet you, and they play well when called. Small suited aces do both: the ace blocks AA and AK, and the hand makes nut flushes and wheel straights.",
          "The illustrative premium range here, AA, KK, QQ, AKs and AKo, has 6 + 6 + 6 + 4 + 12 = 34 combos. Hold A♥4♥ and it shrinks to 3 + 6 + 6 + 3 + 9 = 27: 7 of the 34, about 21%, are gone.",
          {
            widget: { id: "combos", preset: "premium", hand: ["Ah", "4h"] },
            caption: "Change your hand and watch how many premium combos are left. Compare A♥4♥ with 7♥6♥, which blocks none of them.",
          },
          {
            checkpoint: {
              question: "You hold A♥4♥. How many combos of AA can the opener have?",
              options: ["6", "4", "3"],
              answer: 2,
              explain: "A pair has 6 combos: 4 × 3 / 2. With one ace in your hand only three aces are left, and they pair up 3 × 2 / 2 = 3 ways.",
              math: { fn: "product", args: [3, 2, 0.5], value: 3 },
            },
          },
        ],
      },
      {
        heading: "Sizing the 3-bet",
        blocks: [
          "Out of position you size up, to about four times the open: a 2.5 bb open becomes a 10 bb 3-bet. The bigger price makes calls in position less attractive, and the lower SPR makes the hand easier to play from out of position.",
          "Size up again against bigger opens. The rule is a multiple of the open, not a fixed number: against a 5 bb live open, three times is 15 bb in position and four times is 20 bb out of position. A 9 bb 3-bet against a 5 bb open gives the opener a great price to call.",
          "In position the 3-bet pot is already shallow. A 7.5 bb 3-bet called by the opener makes a pot of 7.5 + 7.5 + 1.5 = 16.5 bb with 92.5 bb behind, an SPR of about 5.6. That is why strong one-pair hands often play for stacks in 3-bet pots.",
          {
            checkpoint: {
              question: "Which hand is the better 3-bet bluff against an opener who 4-bets only strong hands?",
              options: ["A5 suited", "7♣6♣", "Q♠9♦"],
              answer: 0,
              explain: "A5s blocks AA and AK, so the 4-bet comes less often, and it makes nut flushes and wheels when called. 76s plays well but blocks nothing. Q9 offsuit blocks little and plays badly when called.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Three times the open in position, four times out of position: always a multiple of the open.",
        "Polarise when calling is a good option; go linear when calling is poor.",
        "Choose bluffs that block the 4-bet range and still make strong hands: small suited aces first.",
        "Against callers who never fold, drop bluffs and 3-bet for value.",
      ],
      breaks: [
        "Against players who fold too much to 3-bets, almost any hand with some playability becomes a profitable 3-bet.",
        "Short-stacked, a 3-bet can commit you, so the bluffs shrink and the 3-bet becomes a shove or a fold.",
      ],
    },
    exercises: {
      "three-bet-or-not":
        "Twelve spots on the button facing an open, biased toward the hands Rail's charts find close. Decide whether to 3-bet, call or fold.",
      "your-hands":
        "Your own spots where the chart's best play was a 3-bet, the costliest first. Decide before you see what you did.",
    },
    checks: [
      { fn: "product", args: [2.5, 3], value: 7.5 },
      { fn: "sum", args: [2.5, 0.5, 1], value: 4 },
      { fn: "sum", args: [6, 6, 6, 4, 12], value: 34 },
      { fn: "sum", args: [3, 6, 6, 3, 9], value: 27 },
      { fn: "ratio", args: [7, 34], value: 0.21 },
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "product", args: [5, 3], value: 15 },
      { fn: "product", args: [5, 4], value: 20 },
      { fn: "sum", args: [7.5, 7.5, 1.5], value: 16.5 },
      { fn: "spr", args: [92.5, 16.5], value: 5.6 },
    ],
  },

  "facing-3bets-and-4bets": {
    sections: [
      {
        heading: "The price of continuing",
        blocks: [
          "You open the cutoff to 2.5 bb and the button 3-bets to 7.5 bb. The pot, including the 3-bet, is 2.5 + 7.5 + 1.5 = 11.5 bb, and calling costs 5 bb more.",
          {
            checkpoint: {
              question: "How much equity does that call need?",
              options: ["About 25%", "About 30%", "About 40%"],
              answer: 1,
              explain: "The final pot is 11.5 + 5 = 16.5 bb and 5 of it is your call: 5 / 16.5 ≈ 30.3%. A good price, but you will play the hand out of position.",
              math: { fn: "requiredEquity", args: [11.5, 5], value: 0.303 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 11.5, bet: 5, share: 0.303 },
            },
          },
          "Now turn it around: you open the button to 2.5 bb and the big blind 3-bets to 10 bb. The pot is 2.5 + 10 + 0.5 = 13 bb and the call is 7.5 bb, so you need 7.5 / 20.5 ≈ 36.6%. A worse price, but you have position. The out-of-position 3-bet is bigger precisely to make that trade fair.",
        ],
      },
      {
        heading: "Position decides how wide you go on",
        blocks: [
          "In position you can call 3-bets with more hands, because you will realise their equity. Out of position, calling with medium hands is expensive: you face bets on every street without seeing your opponent act first. There the answer leans towards 4-bet or fold.",
          "Your own opening range matters too. An early-seat open is strong, so it continues with a larger share of its hands. A button open is wide, so most of it has to fold to a 3-bet, and that is fine: the hands you fold were opened to win the blinds, not to play a big pot.",
          "The hands that suffer most are offsuit hands that are dominated by the 3-betting range, such as KJ or AT, called out of position.",
        ],
      },
      {
        heading: "4-bets, 5-bets and a short SPR",
        blocks: [
          "Rail's charts 4-bet to 2.2 times the 3-bet in position of the 3-bettor and 2.5 times out of position, and at 100 bb the 5-bet is all in. Against that 10 bb big-blind 3-bet, a button 4-bet goes to 10 × 2.2 = 22 bb, leaving 100 − 22 = 78 bb behind.",
          "If the big blind calls, the pot is 22 + 22 + 0.5 = 44.5 bb with 78 bb behind: an SPR of about 1.8. Almost any pair or good draw on the flop is then played for stacks. That is why the real decision facing a 4-bet is usually fold or all in, and calls are kept for hands that play well in position.",
          {
            widget: { id: "spr", pot: 44.5, stack: 78 },
            caption: "A 4-bet pot at 100 bb. Compare it with the single-raised pot's SPR from the open-sizing lesson.",
          },
          {
            checkpoint: {
              question: "After a 22 bb 4-bet is called at 100 bb, the SPR is about…",
              options: ["1.8", "6", "13"],
              answer: 0,
              explain: "Each player has 78 bb behind and the pot is 22 + 22 + 0.5 = 44.5 bb. 78 / 44.5 ≈ 1.8: less than two pot-sized bets left.",
              math: { fn: "spr", args: [78, 44.5], value: 1.8 },
            },
          },
        ],
      },
      {
        heading: "What the 4-bettor can hold",
        blocks: [
          "The illustrative 4-bet range here is KK+, AK, A5s and A4s: 6 + 6 + 16 = 28 value combos and 8 bluff combos. Holding AK changes that a lot: AA and KK drop to 3 combos each and AK to 3 × 3 = 9, so the value part shrinks from 28 to 15 combos.",
          "That is why AK and suited aces are popular 5-bet hands: they remove the hands that are strongest against them. QQ blocks none of AA, KK or AK.",
          {
            widget: { id: "equity", preset: "4bet", hand: ["Qs", "Qh"] },
            caption: "QQ against the illustrative 4-bet range. The bluffs are a big part of why QQ does well; imagine the range without them.",
          },
        ],
      },
      {
        heading: "\"Am I a nit?\" — folding to live 4-bets",
        blocks: [
          "In many live games a 4-bet means AA or KK and very little else. Against that range, QQ only wins when it improves, and AK is behind both pairs. Folding them is not weakness; it is reading the range.",
          {
            checkpoint: {
              question: "A live player only ever 4-bets AA and KK. You hold A♦K♣. How many combos of his range are left?",
              options: ["12", "9", "6"],
              answer: 2,
              explain: "AA and KK have 6 combos each, 12 in all. Your ace leaves 3 combos of AA, your king leaves 3 combos of KK: 3 + 3 = 6.",
              math: { fn: "sum", args: [3, 3], value: 6 },
            },
          },
          "Rail's drill grades against Rail's charts, which assume an opponent who 4-bets with bluffs too. Folding QQ there can be graded as a mistake. The live fold is an exploit you make on a read, and the drill shows you what you are deviating from.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Facing a 3-bet in position, call more; out of position, lean towards 4-bet or fold.",
        "Wide openers fold most of their range to 3-bets; that is how it should be.",
        "4-bet pots have an SPR of about two at 100 bb: decide before the flop whether you are willing to get it in.",
        "Hands that block AA, KK and AK make the best 5-bets and 4-bet bluffs.",
      ],
      breaks: [
        "Against players who 4-bet only the nuts, fold more of your strong hands than the chart does.",
        "Deep-stacked, calls gain and 4-bet bluffs become riskier, because the 5-bet is no longer a shove.",
      ],
    },
    exercises: {
      "vs-3bet":
        "Ten spots facing a 3-bet, dealt from Rail's charts and biased toward the close hands. Fold, call or 4-bet.",
      "vs-4bet":
        "Six spots facing a 4-bet. Fold, call or go all in. Remember that the chart assumes a balanced 4-bettor.",
    },
    checks: [
      { fn: "sum", args: [2.5, 7.5, 1.5], value: 11.5 },
      { fn: "sum", args: [2.5, 10, 0.5], value: 13 },
      { fn: "requiredEquity", args: [13, 7.5], value: 0.366 },
      { fn: "product", args: [10, 2.2], value: 22 },
      { fn: "sum", args: [100, -22], value: 78 },
      { fn: "sum", args: [22, 22, 0.5], value: 44.5 },
      { fn: "spr", args: [78, 44.5], value: 1.8 },
      { fn: "sum", args: [6, 6, 16], value: 28 },
      { fn: "product", args: [3, 3], value: 9 },
      { fn: "sum", args: [3, 3, 9], value: 15 },
      { fn: "sum", args: [6, 6], value: 12 },
    ],
  },

  "blind-play-and-bvb": {
    sections: [
      {
        heading: "The big blind's discount",
        blocks: [
          "The big blind has already paid 1 bb and is the last to act preflop. When the small blind folds, it calls the open minus that 1 bb into a pot that already holds everything. Against a 2.5 bb open that is 1.5 bb into 4 bb: it needs about 27.3%. Against 2 bb it needs about 22.2%, against 3 bb about 30.8%.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 4, bet: 1.5, share: 0.273 },
            caption: "The big blind against a 2.5 bb open. Change the pot and the call to try other open sizes.",
          },
          "No other seat gets that price, and no one can raise behind the big blind. That is why it defends more hands than any other seat calls.",
        ],
      },
      {
        heading: "Equity has to be realised",
        blocks: [
          "The price is not the whole story. The big blind plays every street out of position, so its hands realise less equity than they hold. Hands that make strong hands, such as suited and connected cards, realise more; offsuit hands with weak kickers realise less.",
          "The opener's seat matters as well. Against an early-seat open the big blind defends far fewer hands than against a button open, even at the same price. Against wide late opens it also 3-bets more, to about four times the open: 10 bb against 2.5 bb.",
        ],
      },
      {
        heading: "The small blind: raise or fold",
        blocks: [
          "The small blind is out of position to everyone, including the big blind still to act behind it. Facing an open it gets a worse price than the big blind and does not close the action, so most of its continuing hands 3-bet rather than call.",
          {
            checkpoint: {
              question: "The button and the big blind get the same open. Why does the small blind call less than the big blind?",
              options: [
                "It pays more to call, plays out of position and can still be squeezed by the big blind",
                "Its cards are worse on average",
                "It has already lost its blind",
              ],
              answer: 0,
              explain: "Against a 2.5 bb open the small blind calls 2 bb, the big blind 1.5 bb. The small blind is also out of position after the flop and has the big blind behind it. All three point away from calling.",
            },
          },
        ],
      },
      {
        heading: "Blind versus blind",
        blocks: [
          "When everyone folds to the small blind, only the big blind is left. Rail's charts give the small blind three options here: fold, complete for 0.5 bb, or raise to 3 bb. The big blind behind a completion can check or raise to 4 bb.",
          "The raise risks 2.5 bb more to win the 1.5 bb in the middle, so it needs 2.5 / 4 = 62.5% folds as a pure steal, the same as a 2.5 bb button open. The completion costs 0.5 bb into a pot of 1.5 bb, a price of 0.5 / 2 = 25%, but it lets the big blind act last with position.",
          {
            checkpoint: {
              question: "The small blind raises to 3 bb. How much equity does the big blind need to call?",
              options: ["About 27%", "About 33%", "About 40%"],
              answer: 1,
              explain: "The pot is 3 + 1 = 4 bb and the call is 2 bb: 2 / 6 ≈ 33.3%. A worse price than against a button open, but the big blind has position after the flop, which is worth a lot.",
              math: { fn: "requiredEquity", args: [4, 2], value: 0.333 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 4, bet: 2, share: 0.333 },
            },
          },
          "Both ranges are wide in blind versus blind, so hands that would be easy folds against an early open become playable. The big blind's position makes it the more comfortable seat after the flop.",
        ],
      },
      {
        heading: "Equal blinds",
        blocks: [
          "Some live games use equal blinds: the small blind posts as much as the big blind. That removes the small blind's discount and gives the table more to steal. With 1 bb in each blind, a 2.5 bb button open risks 2.5 to win 2.",
          {
            checkpoint: {
              question: "Both blinds post 1 bb. How often must they fold for a 2.5 bb button steal that never wins when called?",
              options: ["About 50%", "About 56%", "About 63%"],
              answer: 1,
              explain: "There is 2 bb in the middle: 2.5 / (2.5 + 2) ≈ 55.6%. More dead money, fewer folds needed, so steals widen.",
              math: { fn: "alpha", args: [2, 2.5], value: 0.556 },
              reveal: { id: "bet-math", focus: "steal", pot: 2, bet: 2.5, share: 0.56 },
            },
          },
          "The small blind now defends like a second big blind: against a 3 bb open it calls 2 bb into 5 bb, needing 2 / 7 ≈ 28.6%. Rail's charts are built for 0.5/1 blinds, so this game is not in the drills; adjust by the price.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "The big blind defends wide because of the price: about 27.3% against a 2.5 bb open.",
        "Defend tighter against early opens than late ones, even at the same price.",
        "From the small blind, facing an open, 3-bet or fold most of the time.",
        "Blind versus blind, both ranges are wide and the big blind has position.",
        "With equal blinds there is more to steal and the small blind defends like a big blind.",
      ],
      breaks: [
        "Against openers who barrel relentlessly, the big blind realises even less; tighten the bottom of the defence.",
        "Against a small blind who completes and then plays passively, the big blind can raise its completions more.",
      ],
    },
    exercises: {
      "blind-vs-blind":
        "Ten blind-versus-blind spots from Rail's charts, biased toward the close hands: the small blind's open, complete or fold, and the big blind's answers.",
      "big-blind-defence":
        "Ten spots in the big blind facing an open. Fold, call or 3-bet, and notice how the opener's seat moves the bottom of your range.",
    },
    checks: [
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "requiredEquity", args: [3.5, 1], value: 0.222 },
      { fn: "requiredEquity", args: [4.5, 2], value: 0.308 },
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "alpha", args: [1.5, 2.5], value: 0.625 },
      { fn: "requiredEquity", args: [1.5, 0.5], value: 0.25 },
      { fn: "requiredEquity", args: [5, 2], value: 0.286 },
    ],
  },

  "squeezes-and-multiway-preflop": {
    sections: [
      {
        heading: "What a squeeze is",
        blocks: [
          "A squeeze is a 3-bet after an open and at least one call. Two things make it work. The caller's chips are dead money you can win. And the caller's range is usually capped: with their best hands most players would have 3-bet themselves.",
          "The opener is in an awkward spot too: caught between your raise and a caller who still has to act behind them.",
        ],
      },
      {
        heading: "The price",
        blocks: [
          "The hijack opens to 2.5 bb, the cutoff calls, and you are on the button. Rail's charts size a squeeze at the 3-bet's multiple plus one open for each caller: three times plus one in position, so 2.5 × 4 = 10 bb. The pot before you act is 2.5 + 2.5 + 1.5 = 6.5 bb.",
          {
            checkpoint: {
              question: "How often must everyone fold for that 10 bb squeeze to break even if it never wins when called?",
              options: ["About 55%", "About 61%", "About 70%"],
              answer: 1,
              explain: "You risk 10 bb to win 6.5 bb: 10 / 16.5 ≈ 60.6%. A plain 7.5 bb 3-bet against a lone 2.5 bb open needs about 65.2%. More dead money, fewer folds needed, even though the squeeze is bigger.",
              math: { fn: "alpha", args: [6.5, 10], value: 0.606 },
            },
          },
          "But now two players have to fold, not one. If each folds 75% of the time, both fold only about 56%: short of the price. If the capped caller folds 85% and the opener 75%, both fold about 64%, comfortably above it. The squeeze lives on the caller's weakness.",
          {
            widget: { id: "multiway", pot: 6.5, bet: 10, share: 0.75, opponents: 2 },
            caption: "The squeeze against two players. Change how often each folds and see whether everyone folds often enough.",
          },
        ],
      },
      {
        heading: "Size up for every caller",
        blocks: [
          "Each extra caller adds dead money and one more player who has to fold, so the squeeze gets bigger. In position with two callers, Rail's rule gives five opens: 2.5 × 5 = 12.5 bb. Out of position it starts from four times and adds the callers on top.",
          {
            checkpoint: {
              question: "The hijack opens to 2.5 bb, the cutoff and the button call. Using Rail's rule, how big is your squeeze from the small blind?",
              options: ["10 bb", "12.5 bb", "15 bb"],
              answer: 2,
              explain: "Out of position the base is four opens, plus one for each of the two callers: 4 + 2 = 6 opens, 2.5 × 6 = 15 bb.",
              math: { fn: "product", args: [2.5, 6], value: 15 },
            },
          },
          "Out of position you want hands that keep value when called: strong hands, and bluffs with blockers and playability, such as suited aces. Against a caller who likes to flat big hands, squeeze much tighter.",
        ],
      },
      {
        heading: "Overcalling instead",
        blocks: [
          "The other option is to call behind the caller. The price is good: on the button behind a 2.5 bb open and a call, you pay 2.5 bb into 6.5 bb and need 2.5 / 9 ≈ 27.8%.",
          "But a three-way pot changes what that equity is worth. Even with an average hand, your fair share of a three-way pot is only a third, and your equity is split between two opponents. Top pair with a weak kicker loses value fast multiway; sets, straights and flushes do not.",
          {
            checkpoint: {
              question: "Which hand prefers an overcall to a squeeze behind an open and a call?",
              options: ["6♦6♣", "K♠J♦", "A♣2♦"],
              answer: 0,
              explain: "A small pair wants a cheap flop with several players in, to win a big pot when it makes a set. KJ and A2 offsuit make top pairs that are often dominated in a multiway pot.",
            },
          },
        ],
      },
      {
        heading: "When to do which",
        blocks: [
          {
            list: [
              "Squeeze when the caller is capped and folds a lot, and when your hand blocks strong hands or plays well heads-up.",
              "Overcall with pairs and suited hands that make strong hands, especially in position.",
              "Fold offsuit hands that only make one pair; they do badly both as squeezes and as overcalls.",
            ],
          },
          "Rail's charts allow at most four players into a pot. The drill deals squeeze spots from them, biased toward the close decisions.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "A squeeze adds one open for every caller on top of the normal 3-bet multiple.",
        "Dead money lowers the fold rate you need, but two players must fold: it works because the caller is weak.",
        "Overcall with pairs and suited hands; fold offsuit hands that only make one pair.",
      ],
      breaks: [
        "Against callers who flat strong hands, squeeze only for value.",
        "Against openers who rarely fold to 3-bets, the squeeze loses its fold equity; bluff less.",
      ],
    },
    exercises: {
      "squeeze-spots":
        "Ten spots behind an open and a call, dealt from Rail's charts and biased toward the close hands. Squeeze, call or fold.",
    },
    checks: [
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "sum", args: [2.5, 2.5, 1.5], value: 6.5 },
      { fn: "alpha", args: [4, 7.5], value: 0.652 },
      { fn: "allFold", args: [0.75, 2], value: 0.56 },
      { fn: "product", args: [0.75, 0.85], value: 0.64 },
      { fn: "product", args: [2.5, 5], value: 12.5 },
      { fn: "requiredEquity", args: [6.5, 2.5], value: 0.278 },
      { fn: "ratio", args: [1, 3], value: 0.333 },
    ],
  },

  "limpers-and-isolation": {
    sections: [
      {
        heading: "Why limpers are worth attacking",
        blocks: [
          "A limper has called the big blind instead of raising. Most players raise their strong hands, so a limping range is usually capped: plenty of weak and medium hands, few big ones. Their 1 bb is dead money.",
          "An isolation raise attacks that. It aims to win the pot at once or to play heads-up, in position, against a weaker range. The name says what it wants: to get the limper alone.",
          {
            note: {
              tone: "approximate",
              text: "Rail's charts model a limper who can hold any hand, through a small built-in tremble that lets every hand limp now and then. Isolation is graded against that limper, who folds to it often. Real limpers' ranges differ from player to player, and the river drill's ranges rest on Rail's own narrowing model.",
            },
          },
        ],
      },
      {
        heading: "How big to isolate",
        blocks: [
          "Rail's charts isolate to 4 bb over one limper when you have position on him, add 1 bb for each extra limper, and add 1 bb more when you are out of position, as when a blind isolates. The button over an UTG limp goes to 4 bb; over two limpers to 5 bb; a blind over a button limp to 5 bb; the big blind over three limpers to 7 bb.",
          "The button's 4 bb over one limper risks 4 bb to win 1 + 1.5 = 2.5 bb, so it needs 4 / 6.5 ≈ 61.5% folds as a pure steal. Over two limpers, 5 bb into 3.5 bb needs about 58.8%, but now three players have to fold.",
          {
            checkpoint: {
              question: "Two players limp and you are in the big blind. What is Rail's isolation size?",
              options: ["5 bb", "6 bb", "7 bb"],
              answer: 1,
              explain: "4 bb for one limper, 1 bb for the second limper and 1 bb for being out of position: 4 + 1 + 1 = 6 bb.",
              math: { fn: "sum", args: [4, 1, 1], value: 6 },
            },
          },
          "Live limpers often call isolation raises, and many players go bigger still. The trade-off is the same as with opens: a bigger raise gets you heads-up more often but risks more when it does not.",
        ],
      },
      {
        heading: "With which hands",
        blocks: [
          "Isolate with hands that do well heads-up against a capped range: big cards that make top pair with a good kicker, pairs, and suited broadways. You will often be called, so these hands win by value, not only by folds.",
          "Against a limper who calls everything, drop the bluffs and isolate for value. Against one who limps and folds to raises, widen. Against a limper who sometimes traps with strong hands, keep the range tight and be ready to fold to a re-raise.",
        ],
      },
      {
        heading: "Overlimping and the big blind",
        blocks: [
          "Overlimping, calling 1 bb behind a limper, is cheap: you pay 1 bb into 2.5 bb and need 1 / 3.5 ≈ 28.6%. The catch is that more players usually come along and your equity is split between them. Overlimp with hands that make strong hands, small pairs and suited connectors, not with offsuit hands that make one pair.",
          "The big blind in a limped pot can check for free or isolate. Checking keeps every hand in a pot it has not paid more for; isolating takes the initiative but out of position, which is why the size is larger.",
          {
            checkpoint: {
              question: "After one limp, the small blind completes and the big blind checks. At 100 bb, what is the SPR on the flop?",
              options: ["About 10", "About 20", "About 33"],
              answer: 2,
              explain: "Three players each put in 1 bb, so the pot is 3 bb and each has 99 bb behind: 99 / 3 = 33. Limped pots are deep, and every range is wide.",
              math: { fn: "spr", args: [99, 3], value: 33 },
              reveal: { id: "spr", pot: 3, stack: 99 },
            },
          },
        ],
      },
      {
        heading: "After the flop in limped pots",
        blocks: [
          "Every range in a limped pot is wide, and the stacks are deep compared with the pot. Big bluffs have little to win; value hands can build a pot over three streets.",
          {
            list: [
              "Bet your strong hands and draws; check your weak ones more than in raised pots.",
              "A pair that would be strong in a heads-up raised pot is only medium in a limped multiway pot.",
              "In a pot you isolated, the limper's range is still capped, so your strong hands get paid on more streets.",
            ],
          },
          "The river drill puts you in limped pots solved by Rail's engine, so you can see how these ranges play to the end.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Isolate to 4 bb over one limper in position, plus 1 bb per extra limper, plus 1 bb out of position.",
        "Isolate with hands that win by value against a capped range; against calling stations, drop the bluffs.",
        "Overlimp with pairs and suited connectors, not with offsuit one-pair hands.",
        "Limped pots are deep: build pots with value, not with big bluffs.",
      ],
      breaks: [
        "Against limpers who trap with strong hands, isolate tighter and respect the re-raise.",
        "In live games where limpers call almost every raise, size up further or isolate only for value.",
      ],
    },
    exercises: {
      "facing-limpers":
        "Ten spots behind one or more limpers, from Rail's limped-pot charts, biased toward the close hands. Fold, overlimp or isolate.",
      "limped-rivers":
        "Three river spots in limped pots, graded by Rail's solver. Decide before the answer is shown.",
    },
    checks: [
      { fn: "sum", args: [4, 1, 1, 1], value: 7 },
      { fn: "sum", args: [1, 1.5], value: 2.5 },
      { fn: "alpha", args: [2.5, 4], value: 0.615 },
      { fn: "alpha", args: [3.5, 5], value: 0.588 },
      { fn: "requiredEquity", args: [2.5, 1], value: 0.286 },
    ],
  },
};
