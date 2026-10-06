import type { LessonBodies } from "./types";

/**
 * M2 — thinking in ranges, English. Every computed number in a section is
 * listed in its lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`. Range equities and nut shares are never quoted:
 * a `range-vs-range` widget shows Rail's own number on the board discussed.
 */
export const m2En: LessonBodies<
  "thinking-in-ranges" | "range-advantage" | "nut-advantage" | "board-texture" | "who-the-next-card-helps" | "range-narrowing"
> = {
  "thinking-in-ranges": {
    sections: [
      {
        heading: "One hand is a guess, a range is a list",
        blocks: [
          "When an opponent bets, it is tempting to ask what they have. That question has no answer you can use: they could hold dozens of different hands, and you will rarely find out which. A better question is which hands they would play this way.",
          "That list of hands is a range. Each hand in it carries a weight: some are always there, some only part of the time. Every decision you make is really made against the whole list.",
          {
            checkpoint: {
              question: "You hold J♥J♦ and a player who has been tight all evening 3-bets you. Which question leads to a better decision?",
              options: [
                "Do they have AK or QQ right now?",
                "Which hands does this player 3-bet with, and how do my jacks do against all of them?",
                "Did they look confident when they raised?",
              ],
              answer: 1,
              explain:
                "The first asks for one hand you can never see, and the third is a read you can add later. The second is the one you can actually work through: list the hands they 3-bet, count them, and weigh your jacks against the whole list.",
            },
          },
        ],
      },
      {
        heading: "Counting a range in combos",
        blocks: [
          "Ranges are counted in combos, the individual two-card holdings. Before any card is seen there are 52 × 51 / 2 = 1,326 of them, grouped into 169 classes such as QQ, AKs and AKo.",
          "The classes are not the same size. An offsuit hand like AKo has 4 × 3 = 12 combos: any of the four aces with any of the three kings of another suit. A suited hand has 4, one per suit. A pair has 6: there are 12 ordered ways to pick two of the four queens, and each combo is counted twice, so 12 / 2 = 6.",
          "So a range written as \"TT+, AK\" holds five pairs at 6 combos each, 5 × 6 = 30, plus 16 combos of AK: 46 in all, or 46 / 1,326, about 3.5% of all starting hands.",
          {
            checkpoint: {
              question: "How many combos of AQ are there, suited and offsuit together?",
              options: ["4", "12", "16"],
              answer: 2,
              explain:
                "4 suited plus 12 offsuit makes 16. Unpaired hands are the bulk of most ranges: AQ alone holds more combos than AA and KK put together.",
              math: { fn: "sum", args: [4, 12], value: 16 },
            },
          },
        ],
      },
      {
        heading: "Reading the grid",
        blocks: [
          "Ranges are drawn on a 13 × 13 grid, one cell per class. The pairs run down the diagonal from AA in the top-left corner to 22 in the bottom-right; suited hands sit above the diagonal and offsuit hands below it.",
          "Shorthand writes the same thing in one line. \"77+\" is sevens and every bigger pair, \"ATs+\" is AT suited up to AK suited, and \"T9s-76s\" is the suited connectors from T9 down to 76.",
          "Shape matters as much as size. A range that runs solidly from the strongest hands downwards is linear. One with its top removed is capped, and one missing both its top and its bottom is condensed, which is what a preflop call usually looks like.",
          {
            widget: { id: "equity", focus: "range", preset: "open-utg", hand: ["Kh", "Qd"] },
            caption:
              "K♥Q♦ against an illustrative under-the-gun opening range, written by hand for teaching. Switch the range to the button's open and watch the same hand's equity rise: the wider range holds far more hands that KQ beats.",
          },
        ],
      },
      {
        heading: "Every action is a filter",
        blocks: [
          "A range starts at the seat and narrows with every action. Position makes the first cut: a player under the gun, with the whole table still to act, opens far fewer hands than the same player on the button.",
          {
            list: [
              "Opening removes the hands too weak to play from that seat.",
              "Calling a raise removes most of the best hands, which would have re-raised, and the worst, which would have folded.",
              "A 3-bet keeps the strongest hands and a handful of chosen bluffs.",
              "Every bet, call and check after the flop cuts again; the last lesson of this module follows that street by street.",
            ],
          },
          "This is also where \"initiative\" comes from. The preflop raiser still holds the biggest pairs and the best aces; the caller gave most of those away by not re-raising. Who can bet first on the flop follows from that difference, not from a rule about who raised.",
          {
            checkpoint: {
              question: "A player calls a raise from the big blind instead of 3-betting. Which hands become much less likely?",
              options: ["AA and KK", "Small suited connectors", "Suited kings like K9s"],
              answer: 0,
              explain:
                "Most players re-raise their biggest pairs. A call keeps the middle of the range, so AA and KK drop sharply while the suited connectors and suited kings stay.",
            },
          },
        ],
      },
      {
        heading: "Ranges against players who are not rational",
        blocks: [
          "A common objection: ranges assume opponents think, and many do not. But a player who calls too much still has a range. It is wider, and it is shaped by habit instead of a chart.",
          "Build it from what you see. A player who limps and calls with almost anything has a huge, weak range until they raise; when that player suddenly raises the river, the range has shrunk to strong hands. A player who never folds a pair to one bet still has every pair on the turn.",
          "The method stays the same: start from the hands this person plays, remove the ones that would have acted differently, and decide against what is left. Only the starting list changes.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Ask which hands would play this way, not which hand they have.",
        "Count in combos: a pair has 6, a suited hand 4, an offsuit hand 12. One unpaired class outweighs two pairs.",
        "A call removes the top and the bottom of a range; a raise keeps the top and some bluffs.",
        "Against unusual players, change the starting range, not the method.",
      ],
      breaks: [
        "Early in a hand, a very loose player's range is so wide that narrowing tells you little until later streets.",
        "A reliable tell can outweigh the range for a single decision, but treat it as the exception, not the habit.",
      ],
    },
    exercises: {
      "paint-an-open":
        "Coming soon: paint an opening range on the 13 × 13 grid from memory and see how much of it overlaps Rail's 9-max chart.",
      "full-ring-opens":
        "Twelve hands from Rail's 9-max 100bb opening charts, dealt as they come, from changing seats: open or fold. Match a play the chart makes in seven hands out of ten to pass.",
    },
    checks: [
      { fn: "product", args: [52, 51], value: 2652 },
      { fn: "ratio", args: [2652, 2], value: 1326 },
      { fn: "sum", args: [13, 78, 78], value: 169 },
      { fn: "product", args: [4, 3], value: 12 },
      { fn: "ratio", args: [12, 2], value: 6 },
      { fn: "product", args: [5, 6], value: 30 },
      { fn: "sum", args: [30, 16], value: 46 },
      { fn: "ratio", args: [46, 1326], value: 0.035 },
    ],
  },

  "range-advantage": {
    sections: [
      {
        heading: "Two ranges, one board",
        blocks: [
          "Range advantage compares whole ranges, not hands. Deal a flop and ask: if every hand in my range played every hand in yours to the river, how often would mine win? The answer is the range's equity, an average over every combo.",
          "It is the first thing to read on any flop, because it tells you who can bet a lot of their hands and who should mostly check. It says nothing yet about the hand you are holding.",
        ],
      },
      {
        heading: "Why the raiser usually starts ahead",
        blocks: [
          "Take the ranges Rail uses for teaching: a button open against a big-blind call. The big blind would 3-bet AA, KK, QQ and AK, so none of them are in its calling range. That is 6 + 6 + 6 + 16 = 34 combos of the strongest starting hands that only the button can hold.",
          "The big blind keeps more small pairs, suited connectors and weak suited hands. So boards with an ace or a king, and dry boards in general, favour the button. This is what players mean by \"initiative\": not a privilege earned by raising, but the shape two ranges have after the preflop betting.",
          {
            note: {
              tone: "approximate",
              text: "The ranges in these widgets are written by hand for teaching, not Rail's solved charts, so treat each number as an illustration. The direction is what matters: which boards favour the opener and which bring the caller back.",
            },
          },
          {
            checkpoint: {
              question: "Button open against a big-blind call, flop A♠8♦3♣. Whose range is ahead?",
              options: ["The button's", "The big blind's", "Neither: it is even"],
              answer: 0,
              explain:
                "The ace is the big card the button holds more of, and the big blind's best aces went into its 3-bets. Nothing on the board connects with the big blind's small suited hands. The widget shows the button's range clearly ahead.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["As", "8d", "3c"] },
            },
          },
        ],
      },
      {
        heading: "Where the gap closes",
        blocks: [
          "Middling connected boards are where the caller catches up. On 8♥7♥6♣ the big blind's suited connectors and small pairs make straights, two pairs, sets and strong draws, while the button's big pairs are just one pair.",
          {
            checkpoint: {
              question: "With the same two ranges, which of these flops is closest to even?",
              options: ["A♦K♣4♥", "Q♣5♦5♥", "8♥7♥6♣"],
              answer: 2,
              explain:
                "Big cards and paired boards keep the button ahead. The middling connected board brings the big blind level: the widget puts it at almost exactly even. Try T♥9♥8♣ too, where the caller is even slightly ahead.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["8h", "7h", "6c"] },
            },
          },
          "The caller is never far behind on boards like these, and on a few it is ahead. That is why a raiser who bets every flop by habit loses money on exactly these textures.",
        ],
      },
      {
        heading: "What the advantage tells you to do",
        blocks: [
          "The player who is ahead on the board can bet often, usually small. Most of the range is ahead or has enough equity to keep going, and a small bet is enough to make the weakest hands pay or fold.",
          "The player who is behind checks more and defends with care. Betting first into the stronger range rarely pays, because the hands that continue are the ones that beat you.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "utg-vs-bb", board: ["8h", "7h", "6c"] },
            caption:
              "An under-the-gun open against the big blind on the same 8♥7♥6♣. The tighter the opening range, the further ahead it stays, even on boards that suit the caller. Switch to the button matchup to compare.",
          },
          "Range advantage sets how often you bet. How big you bet depends on who holds more of the very strongest hands, which is the next lesson.",
        ],
      },
      {
        heading: "What it does not tell you",
        blocks: [
          "It is an average. A button range that is ahead on A♠8♦3♣ still holds plenty of hands that missed, and a big blind behind on average still has its sets. Range advantage frames the decision; where your hand sits in your range makes it.",
          "And it moves. Every turn and river card shifts the balance, sometimes a lot, and a later lesson in this module measures how.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "High cards and dry boards favour the preflop raiser; middling connected boards bring the caller back.",
        "The tighter the opening range, the bigger its advantage on almost every flop.",
        "Range advantage tells you how often to bet, not how big.",
      ],
      breaks: [
        "Against a caller who never 3-bets, the big pairs stay in the calling range and the raiser's edge on high boards shrinks.",
        "Multiway, every extra caller adds hands that hit the board, so the raiser's average edge counts for less.",
      ],
    },
    exercises: {
      "who-is-ahead":
        "Eight flops, button open against big-blind call with the illustrative ranges. Say whether the button is clearly ahead (53.5% range equity or more) or the spot is close (50.5% or less); the range-vs-range widget then shows the split.",
    },
    checks: [{ fn: "sum", args: [6, 6, 6, 16], value: 34 }],
  },

  "nut-advantage": {
    sections: [
      {
        heading: "The top of the range",
        blocks: [
          "Range advantage averages everything. Nut advantage looks only at the top: of the strongest hands possible on this board, whose range holds more of them?",
          "Rail measures it the same way everywhere. After a flop, 49 × 48 / 2 = 1,176 two-card holdings are left. Rank them by what they make, keep the strongest tenth, about 118 of them, and ask what share of each player's range lands in that group.",
          {
            note: {
              tone: "approximate",
              text: "The ranges behind these numbers are written by hand for teaching, not Rail's solved charts. Read the widgets for direction: who holds more of the top, and roughly by how much.",
            },
          },
        ],
      },
      {
        heading: "Ahead on average, level at the top",
        blocks: [
          "The two measures can disagree. An under-the-gun open is full of big pairs and big aces, so it stays ahead on average on almost every flop. But a board like J♠T♠9♠ is made of exactly the cards the big blind's suited connectors and suited broadways need.",
          {
            checkpoint: {
              question: "Under-the-gun open against a big-blind call on J♠T♠9♠. The opener is ahead on average. Is its share of the strongest hands also clearly bigger?",
              options: ["Yes, clearly bigger", "No, about the same as the caller's"],
              answer: 1,
              explain:
                "The opener's range equity is ahead, but flushes, straights and sets are spread across both ranges, and the two shares at the top come out about level. Being ahead on average is not the same as being ahead at the top.",
              reveal: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board: ["Js", "Ts", "9s"] },
            },
          },
        ],
      },
      {
        heading: "Nut advantage sets the size",
        blocks: [
          "Range advantage says how often to bet; nut advantage says how big. A big bet or an overbet puts a lot of money in, and it only works if enough of the betting range is still ahead when called. That takes strong hands, and only the range with more of them can afford it.",
          {
            list: [
              "Both advantages: bet often, and big bets are available.",
              "Range advantage only: bet often but small. The opponent has as many strong hands as you, and big bets run into them.",
              "Nut advantage only: bet less often but bigger, with the strong hands and some bluffs, and check the middle.",
              "Neither: check much more and let the opponent bet.",
            ],
          },
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board: ["As", "8d", "3c"] },
            caption:
              "Under-the-gun open against the big blind on A♠8♦3♣: compare the two shares in the top 10%. Here the opener has both advantages, the textbook spot for bigger bets. Change the board and watch the gap at the top close.",
          },
        ],
      },
      {
        heading: "Where the caller catches up at the top",
        blocks: [
          "Low connected boards are the opener's weakest spot. The big blind defends small pairs and suited connectors; the opener's big pairs become one pair on a board full of straights and two pairs.",
          {
            checkpoint: {
              question: "Same matchup on 6♠5♦4♣. Is the opener's lead in the top 10% big (14 points or more) or small (8.5 points or less)?",
              options: ["Big", "Small"],
              answer: 1,
              explain:
                "The opener is still ahead on average, but its lead at the top shrinks to single figures: the big blind holds the 8-7 straights, more of the small sets and the two pairs. Big bets from the opener would run into exactly those hands.",
              reveal: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board: ["6s", "5d", "4c"] },
            },
          },
        ],
      },
      {
        heading: "Reading it at the table",
        blocks: [
          "You will not count combos in the middle of a hand. Ask two questions instead: which of this board's strongest hands could each of us hold, given how we got here? And did either of us remove those hands preflop?",
          "A big-blind caller rarely has AA or KK, so on A♠8♦3♣ the set of aces belongs to the opener, and so does A-K, the best top pair. On 6♠5♦4♣ the straights and small sets come from hands the opener mostly folded, which is why the top is shared.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Range advantage sets how often you bet; nut advantage sets how big.",
        "Big bets need more strong hands than the opponent has, not just more equity.",
        "Low connected boards are where the caller's share of the strongest hands catches up.",
        "With range advantage but no nut advantage, bet small.",
      ],
      breaks: [
        "Against opponents who call big bets with any pair, big value bets work even without a clear nut advantage.",
        "Later in the hand both ranges have been narrowed, and the shares of the starting ranges no longer apply.",
      ],
    },
    exercises: {
      "who-has-the-nuts":
        "Eight flops, under-the-gun open against big-blind call with the illustrative ranges. Decide whether the opener's lead in the top 10% of hands is big (14 points or more) or small (8.5 points or less); the widget then shows both shares.",
    },
    checks: [
      { fn: "product", args: [49, 48], value: 2352 },
      { fn: "ratio", args: [2352, 2], value: 1176 },
      { fn: "product", args: [1176, 0.1], value: 118 },
    ],
  },

  "board-texture": {
    sections: [
      {
        heading: "Four words for a flop",
        blocks: [
          "Before you think about either range, describe the board. Rail uses four plain properties, the same ones its analysis uses for your hands:",
          {
            list: [
              "Suits: rainbow (three suits), two-tone (two of one suit, so a flush draw is possible) or monotone (one suit, so a flush is already possible).",
              "Pairing: paired or unpaired.",
              "Connectedness: how many two-card holdings make a straight right now. None is disconnected, one or two is semi-connected, three or more is connected.",
              "High card: ace, broadway (T to K), middle (7 to 9) or low (6 and below).",
            ],
          },
          {
            widget: { id: "board-texture", focus: "texture", board: ["Qh", "Jh", "4c"] },
            caption:
              "Q♥J♥4♣: two-tone, unpaired, broadway, and by Rail's count disconnected, because no two cards make a straight yet. Change one card at a time and watch which words change.",
          },
        ],
      },
      {
        heading: "Connected means straights now, not draws",
        blocks: [
          "Connectedness counts straights that are already made. On 9♣8♦5♠ only 7-6 makes one, so the board is semi-connected. On 9♣8♦7♠ three holdings do, J-T, T-6 and 6-5, so it is connected.",
          "Draws are a different question. A board can have no made straight at all and still be full of open-enders, gutshots and flush draws. That is what the next property measures.",
          {
            checkpoint: {
              question: "How does Rail class the connectedness of J♠T♠4♦?",
              options: ["Disconnected", "Semi-connected", "Connected"],
              answer: 0,
              explain:
                "A straight needs three board cards within five ranks of each other, and the 4 is too far from the J and T. So no holding makes a straight yet, and the board is disconnected, even though it is full of draws.",
              reveal: { id: "board-texture", focus: "texture", board: ["Js", "Ts", "4d"] },
            },
          },
        ],
      },
      {
        heading: "Static or dynamic",
        blocks: [
          "Dynamism asks how much the next card is likely to change. Rail looks at every unseen card and counts the ones that would change the board: a third card of a suit, a card that adds two or more new straight holdings, or an overcard, which counts half. That share is the board's volatility.",
          "Below 25% the board is static, from 45% it is dynamic, and in between it is medium. On K♦7♣2♥ only the four aces change anything, and as overcards they count half: 2 of 49 unseen cards, about 4%. Static.",
          {
            widget: { id: "board-texture", focus: "dynamism", board: ["Js", "Ts", "4d"] },
            caption:
              "J♠T♠4♦ with volatility in front: the disconnected board from the question above is dynamic. Compare it with K♦7♣2♥, then add a turn card and watch the number move.",
          },
          {
            checkpoint: {
              question: "Q♣5♦5♥: static, medium or dynamic?",
              options: ["Static", "Medium", "Dynamic"],
              answer: 0,
              explain:
                "No flush can come on the turn, and the pair leaves too few ranks for new straights. Only the kings and aces change anything, and as overcards they count half: 4 of 49 unseen cards, about 8%. Well under 25%, so static.",
              math: { fn: "ratio", args: [4, 49], value: 0.082 },
              reveal: { id: "board-texture", focus: "dynamism", board: ["Qc", "5d", "5h"] },
            },
          },
        ],
      },
      {
        heading: "What texture does to the hand",
        blocks: [
          {
            list: [
              "It decides who the board favours: high and paired boards lean towards the preflop raiser, middling connected boards towards the caller.",
              "On static boards a small bet does most of the work, because the turn rarely changes who is ahead.",
              "On dynamic boards made hands want protection and draws should pay to see the next card, so bets get bigger, and hands that cannot bet big often check.",
              "Thin value and pot control are worth more on static boards; passive play with vulnerable hands costs more on dynamic ones.",
            ],
          },
        ],
      },
      {
        heading: "A habit for every flop",
        blocks: [
          "Say the four words, then static or dynamic, before you look back at your own cards. Q♥J♥4♣ becomes \"two-tone, unpaired, disconnected, broadway, medium\" in a couple of seconds.",
          "Then ask who the board favours, and only then where your hand sits. The order matters: texture shapes both ranges first, and your hand is one combo inside one of them.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Describe the board before you think about ranges: suits, pairing, connectedness, high card.",
        "Connectedness counts made straights; volatility counts how much the next card changes things.",
        "Static boards suit small bets, thin value and pot control; dynamic boards suit bigger bets or checks.",
      ],
      breaks: [
        "Texture describes the cards, not whose range they hit: a static board can still favour the caller.",
        "The river has no next card, so dynamism stops mattering there and only what is made counts.",
      ],
    },
    exercises: {
      "read-the-flop":
        "Twelve random flops, one property each: suits, pairing, connectedness or high card. Answer before the explorer opens; it uses the same rules as the analysis of your hands.",
      "static-or-dynamic":
        "Eight flops to sort into static, medium or dynamic. Static means fewer than 25% of the next cards change the board; dynamic means 45% or more.",
    },
    checks: [
      { fn: "product", args: [4, 0.5], value: 2 },
      { fn: "ratio", args: [2, 49], value: 0.041 },
      { fn: "product", args: [8, 0.5], value: 4 },
    ],
  },

  "who-the-next-card-helps": {
    sections: [
      {
        heading: "Every card redraws the ranges",
        blocks: [
          "The flop sets up range and nut advantage; the turn reshuffles them. Each new card makes some hands better and others worse, and because the two ranges are built from different hands, most cards help one range more than the other.",
          "You can measure it: read the range equity on the flop, add the turn card, and see which way it moves. A card that moves it towards you is a good card for your range; one that moves it away is a bad one.",
          {
            note: {
              tone: "approximate",
              text: "The ranges here are the concept library's illustrative ones, written by hand for teaching rather than taken from Rail's solved charts. How far a card moves the number is approximate; which way it moves is the lesson.",
            },
          },
        ],
      },
      {
        heading: "One flop, three turns",
        blocks: [
          "Take T♦6♣2♠ with a button open against a big-blind call. The flop is close, with the button a little ahead. Read the button's number in the widget, then add each turn card below in turn.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Td", "6c", "2s"] },
            caption: "The flop alone. Add A♠, then 4♠, then 9♠ as the turn, and compare each with this number.",
          },
          {
            list: [
              "A♠: an overcard the button holds far more of. The button's range equity jumps.",
              "4♠: a low card that connects with almost nothing. The number barely moves.",
            ],
          },
          {
            checkpoint: {
              question: "Same flop, and the turn is the 9♠. Who does it help?",
              options: ["The button", "Neither", "The big blind"],
              answer: 2,
              explain:
                "The 9 connects with the middling hands the big blind defends, such as 8-7, 9-8, 9-7 and T-9: new pairs, two pairs, straights and straight draws. The widget shows the button's range equity clearly lower than on the flop.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Td", "6c", "2s", "9s"] },
            },
          },
        ],
      },
      {
        heading: "Which cards help whom",
        blocks: [
          {
            list: [
              "Overcards to the board, especially aces and kings, usually help the preflop raiser, whose range holds more of them.",
              "Low and middling cards that connect with the board usually help the caller, who defends more suited connectors and small pairs.",
              "A card that completes a draw helps whichever range holds more of that draw.",
              "Low cards that connect with nothing tend to change little for either side.",
            ],
          },
          {
            checkpoint: {
              question: "Flop K♦7♣2♥, button open against big-blind call. Which turn helps the button most?",
              options: ["A♠", "8♠", "3♠"],
              answer: 0,
              explain:
                "The ace is the card the button's range holds far more of, so its range equity rises the most. The 8 connects with the big blind's middling hands, and the 3 changes very little. Compare the widget with the flop by removing the turn card.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Kd", "7c", "2h", "As"] },
            },
          },
        ],
      },
      {
        heading: "Barrel, slow down, or play your hand",
        blocks: [
          "As the preflop raiser, the turn card is a big part of whether you keep betting. On good cards for your range you can bet again with more of it; on bad cards you check more, and the bets you do make come from hands that still want money in.",
          "As the caller, a good card for your range is where leads and raises become possible; a bad card means defending with more care.",
          "Sometimes a card is bad for your range but great for your hand: the 9♠ that hurts the button's range gives the button's 8-7 a straight. Against strong players, think about the range and keep some strong hands among your checks. Against players who call too much, simply bet the hand.",
          "The river works the same way, with one difference: no more cards are coming. Draws that missed become bluffs or give up, and the only question is who holds more of the hands that now win.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Judge a card by how it moves range equity, not only by what it does to your own hand.",
        "Overcards, especially aces and kings, usually help the preflop raiser.",
        "Low and middling cards that connect with the board usually help the caller.",
        "Bet more of your range on good cards and slow down on bad ones.",
      ],
      breaks: [
        "Against players who call too much, a card that is bad for your range but great for your hand is a card to bet, not to balance.",
        "Against a caller with an unusual range, such as one who defends every suited hand, the usual good and bad cards shift.",
      ],
    },
    exercises: {
      "whose-card":
        "Eight turns, each on a fresh flop, button open against big-blind call with the illustrative ranges. Decide whether the card helps the button (its range equity rises by 2 points or more), neither (it moves by half a point or less), or the big blind (it falls by 2 points or more); the widget then shows the turn.",
    },
    checks: [],
  },

  "range-narrowing": {
    sections: [
      {
        heading: "Start wide, cut on every street",
        blocks: [
          "A range is never fixed. It starts with the hands a player brings from that seat and loses some with every action. By the river, a player who opened, bet the flop and bet the turn holds a much shorter list than the one they started with.",
          "Narrowing means following that process on purpose. It is most of what players mean by reading a hand, and it is what makes river decisions possible.",
        ],
      },
      {
        heading: "Three questions for every action",
        blocks: [
          {
            list: [
              "What would have raised? Those hands leave when a player only calls or checks.",
              "What would have folded? Those leave when a player calls or bets.",
              "What would have taken the other action? A bet removes many of the hands that check; a check removes many of the hands that bet.",
            ],
          },
          "Answer them street by street and the range shrinks to something you can reason about. You do not need exact weights: sorting hands into \"almost always here\", \"sometimes\" and \"almost never\" is enough.",
          {
            checkpoint: {
              question: "Your opponent bet the flop and then checked the turn on a quiet card. Which hands become less likely?",
              options: ["Their strongest hands, which usually keep betting", "Missed draws and weak pairs", "Nothing changes: one check means little"],
              answer: 0,
              explain:
                "Strong hands want money in and usually keep betting on a quiet turn, so a check moves weight away from them. Missed draws and weak pairs often give up, and a few strong hands check to trap, so the strong hands become less likely, not impossible.",
            },
          },
        ],
      },
      {
        heading: "A worked walk",
        blocks: [
          "You defend the big blind against a button open. The board runs K♦7♣2♥, then 4♠, then 9♥. You check and call a small bet on the flop, both players check the turn, and on the river the button bets 5 bb into 10 bb.",
          {
            list: [
              "Preflop: you only called, so the button kept its whole opening range.",
              "Flop: a small bet on this board comes from a large part of that range, so little is removed yet.",
              "Turn: the button checked back. Most of its strong kings and sets would have bet again, so their weight drops; hands that want a cheap showdown, and hands that gave up, stay.",
              "River: the bet comes from what is left. A few strong hands that trapped or improved on the 9, and hands that gave up on the turn and now try to win the pot.",
            ],
          },
          "Say that leaves 9 combos of value and 6 of bluffs, 15 in all. To call you pay 5 bb to win a pot of 10 + 5 + 5 = 20 bb, so you need 5 / 20 = 25%.",
          {
            checkpoint: {
              question: "Your hand beats every bluff and loses to every value hand. How often does it win against that betting range?",
              options: ["25%", "40%", "60%"],
              answer: 1,
              explain:
                "It wins against the 6 bluffs out of 15 combos: 6 / 15 = 40%. That is well above the 25% the price asks for, so the call makes money, as long as the count of bluffs is honest.",
              math: { fn: "ratio", args: [6, 15], value: 0.4 },
            },
          },
          {
            widget: { id: "bluff-catcher", pot: 10, bet: 5, share: 0.4 },
            caption: "A bluff-catcher against a half-pot river bet, with bluffs at 40% of the betting range. Slide the bluff share down to find where the call stops paying.",
          },
        ],
      },
      {
        heading: "Rail narrows ranges too",
        blocks: [
          "Rail's analysis walks both ranges through every hand you upload in the same way, street by street, with a model of which hands bet, check, call and raise. The river trainer starts from those narrowed ranges.",
          {
            note: {
              tone: "approximate",
              text: "That narrowing is a heuristic model, not a solve: the ranges that reach the river are Rail's estimate of how players continue on earlier streets, and the analysis labels them that way. Treat a close grade as close.",
            },
          },
          "A range-walk exercise is coming: you will guess a villain's range at each street of one of your own hands and compare it with the range Rail arrives at.",
        ],
      },
      {
        heading: "When opponents are not rational",
        blocks: [
          "Narrowing can feel hopeless against players who do odd things, and too slow at a live table. Three habits help:",
          {
            list: [
              "Narrow by player, not by chart: a passive player's river bet or raise is mostly value, whatever a balanced range would hold.",
              "Notice capped lines: a player who checked back a street rarely holds the very best hands, which makes your big bets and your bluff-catches easier.",
              "Do the work away from the table: replay your river decisions in Rail and narrow at leisure, so the patterns come quickly in game.",
            ],
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "For every action ask what would have raised, what would have folded, and what would have done the opposite.",
        "Sort hands into \"almost always\", \"sometimes\" and \"almost never\" instead of chasing exact weights.",
        "A check after a bet moves weight away from the strongest hands; it does not remove them.",
        "Count value and bluffs at the end, then compare the bluff share with the price.",
      ],
      breaks: [
        "Against players who never bluff the river, the count is mostly value whatever the line looked like: fold more than the price suggests.",
        "Players who slowplay a lot keep strong hands in their checks, so a check narrows their range less than usual.",
      ],
    },
    exercises: {
      "range-walk":
        "Coming soon: replay one of your own hands, guess the villain's range on each street, and compare it with the range Rail's analysis narrows to.",
      "river-calls":
        "Four river spots in position, facing a bet, solved by Rail on demand. Narrow the bettor's range in your head, then call, fold or raise; graded the way the analysis grades a real hand.",
      "your-hands":
        "Your own river decisions facing a bet where the analysis flagged a call that beats nothing, the costliest first. Narrow the range before you see what you did.",
    },
    checks: [
      { fn: "sum", args: [9, 6], value: 15 },
      { fn: "sum", args: [10, 5, 5], value: 20 },
      { fn: "requiredEquity", args: [15, 5], value: 0.25 },
    ],
  },
};
