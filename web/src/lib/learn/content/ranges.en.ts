import type { ConceptTexts } from "./types";

/** Ranges and boards, English. Every number in an example is checked in `tests/test/learn.test.ts`. */
export const rangesEn: ConceptTexts<"ranges" | "range-advantage" | "nut-advantage" | "board-texture" | "dynamic-boards" | "blockers"> = {
  ranges: {
    summary: "Nobody holds \"a hand\" — they hold every hand they would have played this way, and you decide against all of them.",
    definition: [
      "A range is the set of hands a player can have, given everything they have done so far, each with a weight for how likely it is. A button open might be 40% of all hands; the same player's 4-bet a few percent.",
      "Ranges are counted in combos. There are 1,326 two-card starting hands, grouped into 169 classes: a pair (QQ) has 6 combos, a suited hand (AKs) 4, an offsuit hand (AKo) 12. Shorthand like \"77+\" (sevens and every bigger pair) or \"ATs+\" (AT suited up to AK suited) writes a range in one line.",
    ],
    why: [
      "You never see your opponent's cards, so a decision is only ever good or bad against the hands they could have. Putting someone on one exact hand is a guess; a range is the honest version of that guess.",
      "Every action narrows a range. A call preflop removes the hands that would have raised; a check-raise on the river removes most of the hands that would have just called. Following that narrowing street by street is most of hand reading.",
      "Your own range matters as much. If you only ever bet the river with the nuts, a thinking opponent folds everything else — your hand is read through your range.",
    ],
    formulas: [
      {
        name: "Combos",
        expression: ["pair 6 · suited 4 · offsuit 12"],
        spoken: "A pocket pair has 6 combos, a suited hand 4, and an offsuit hand 12.",
      },
      {
        name: "Range share",
        expression: { frac: ["combos in the range", "1,326"] },
        spoken: "A range's share of all starting hands equals its combos divided by 1,326.",
      },
    ],
    example: {
      title: "J♥J♦ against a 3-bet",
      setup: "You open with J♥J♦ and an opponent 3-bets. Say they 3-bet only QQ+ and AK.",
      steps: [
        "Count the range: AA, KK and QQ are 6 combos each, AK is 16 (4 suited, 12 offsuit). 34 combos in all.",
        "Against QQ+, your jacks have about 18.4% equity. Against AK, about 56.1%.",
        "Weighted by combos: (18 × 18.4% + 16 × 56.1%) / 34 ≈ 36.2%.",
      ],
      takeaway: "\"Am I ahead of AK?\" is the wrong question. Against the whole range the jacks have about 36% — and a wider 3-bet range with some bluffs in it changes that number fast.",
    },
    mistakes: [
      "Putting an opponent on one exact hand and playing against that.",
      "Not narrowing: treating a player who bet three streets as if they could still hold every hand they opened.",
      "Counting classes instead of combos — AK is not one hand, it is 16, and twice as common as any pair.",
      "Forgetting your own range: what your line says about you to someone who is paying attention.",
    ],
    tryIt: "Choose a hand and an illustrative range; the equity is against every combo in the range, with your own cards and the board removed.",
  },

  "range-advantage": {
    summary: "On a given board, whose whole range has more equity — which decides who can bet often.",
    definition: [
      "Range advantage compares two ranges, not two hands: on this board, how much equity does each player's whole range have against the other's? It is the average of every hand's equity, weighted by combos.",
      "Preflop ranges meet the board differently. A button open has more big cards than a big-blind call; the big blind has more small and middling suited hands. So a king-high dry flop favours the opener, and a low connected one narrows the gap or flips it.",
    ],
    why: [
      "The player with the range advantage can bet a lot of their range, often small: most of their hands are ahead, and the rest have enough equity to come along.",
      "The player without it checks more and defends carefully; leading into the stronger range rarely pays.",
      "It is the first question in almost every postflop spot, because it shapes both players' frequencies before a single hand is looked at.",
    ],
    formulas: [
      {
        name: "Range equity",
        expression: { frac: ["Σ combos × equity", "Σ combos"] },
        spoken: "A range's equity equals the sum over its hands of combos times equity, divided by the total combos.",
      },
    ],
    example: {
      title: "Button open against a big-blind call",
      setup: "Using the illustrative ranges in the widget below: a button opening range against a big-blind calling range, on two flops.",
      steps: [
        "On K♦7♣2♥ the button's range has about 53% equity against the big blind's.",
        "On 8♥7♥6♣ the same ranges are nearly even — the button has about 49%.",
        "An under-the-gun open against the big blind is further ahead on both: about 59% on K♦7♣2♥ and 53% on 8♥7♥6♣.",
      ],
      takeaway: "The tighter the opening range, the bigger its advantage — and the low connected board pulls every matchup back towards even.",
    },
    mistakes: [
      "Judging the spot by your own hand alone.",
      "Assuming the preflop raiser always has the advantage. On some boards the caller does.",
      "Confusing range advantage (who is ahead on average) with nut advantage (who has more of the very best hands).",
    ],
    tryIt: "Switch the matchup and the board and watch the equity split move. The ranges are written by hand for teaching, not solved.",
  },

  "nut-advantage": {
    summary: "Who holds more of the very strongest hands on this board — which decides who can bet big.",
    definition: [
      "Nut advantage asks a narrower question than range advantage: of all the hands that are near the top on this board, whose range holds more of them?",
      "Rail measures it the same way everywhere: rank every two-card holding the board leaves by what it makes, take the strongest 10%, and count what share of each range is in that group.",
    ],
    why: [
      "Range advantage tells you how often to bet; nut advantage tells you how big. Big bets and overbets need the nuts behind them, because only a range with more very strong hands can put in a lot of money and still have value when called.",
      "A player can have one without the other. The preflop raiser may be ahead on average but hold fewer sets and straights on a low connected board than a caller who defended all the suited connectors.",
      "Check-raises come from nut advantage, too: the player with more strong hands in the region can raise big and have the hands to back it.",
    ],
    formulas: [
      {
        name: "Nut share",
        expression: { frac: ["combos in the top 10% of hands on this board", "combos in the range"] },
        spoken: "A range's nut share equals its combos among the strongest 10% of hands on this board, divided by all its combos.",
      },
    ],
    example: {
      title: "Two flops, two leaders",
      setup: "With the widget's illustrative ranges, look at the top 10% of hands on each board.",
      steps: [
        "Under-the-gun open against a big-blind call on A♠8♦3♣: about 35% of the opener's range is in the top 10%, against about 19% of the caller's. A big advantage at the top.",
        "Button open against a big-blind call on J♠T♠9♠: the button has about 48% range equity, and only about 18% of its range in the top 10% — the big blind has about 24%.",
      ],
      takeaway: "On A♠8♦3♣ the opener can bet big. On J♠T♠9♠ the caller has both advantages, and big bets from the opener run into the hands that beat them.",
    },
    mistakes: [
      "Overbetting because you are ahead on average, without the strong hands that make an overbet work.",
      "Assuming the caller never has the nuts. On low and connected boards they often have more of them.",
      "Counting only your own hand's strength rather than how many strong hands each range has.",
    ],
    tryIt: "Compare the share of each range in the top 10% as you change board and matchup.",
  },

  "board-texture": {
    summary: "Paired, suited, connected, high or low: the board's shape decides which hands and draws exist.",
    definition: [
      "Board texture is a short description of the community cards, in the words players use:",
      "Paired or not. Suits: rainbow (three suits on the flop), two-tone (two of one suit — a flush draw is possible) or monotone (one suit — a flush is possible already). Connectedness: how many two-card holdings make a straight; Rail calls a board disconnected with none, semi-connected with one or two, connected with three or more. And the high card: ace-high, broadway (T to K), middling (7 to 9) or low (6 and below).",
    ],
    why: [
      "Texture decides what is out there. On K♦7♣2♥ there are no straight or flush draws; on 8♥7♥6♣ there are straights, open-enders, flush draws and combinations of them.",
      "It decides who the board favours. High boards hit preflop raisers; low connected boards hit callers who defend small suited hands.",
      "And it decides sizing: on a dry board one small bet does most of the work; on a wet board hands want protection and draws want to be charged.",
    ],
    example: {
      title: "Reading four flops",
      setup: "The explorer below uses the same functions as the analysis of your hands.",
      steps: [
        "K♦7♣2♥: unpaired, rainbow, disconnected (no two cards make a straight), broadway.",
        "8♥7♥6♣: two-tone, connected (T9, 95 and 54 all make straights), middling.",
        "Q♣5♦5♥: paired, rainbow, disconnected.",
        "J♠T♠9♠: monotone (any two spades make a flush), connected.",
      ],
      takeaway: "Each word removes or adds a family of hands. Put them together and you have the first sketch of both ranges on that flop.",
    },
    mistakes: [
      "Describing a board only by its suits. Connectedness and height matter as much.",
      "Calling every unpaired rainbow board \"dry\". 9♥8♦7♣ is rainbow and full of straights.",
      "Forgetting that texture is shared: the same board that gives you a draw gives your opponent the hands that beat it.",
    ],
    tryIt: "Pick three to five cards, or start from a preset, and see how the board is classified.",
  },

  "dynamic-boards": {
    summary: "A dynamic board changes a lot on the next card; a static one barely moves. Rail measures which.",
    definition: [
      "Some boards stay what they are: on K♦7♣2♥ the best hand on the flop is very often the best hand on the river. Others are in motion: on 8♥7♥6♣ a large share of turn cards complete a draw or create a new one.",
      "Rail measures it by looking at every possible next card and counting how many would change the board: a third card of a suit (a flush becomes possible), a card that adds two or more new straight-making holdings, or an overcard to the board, which counts half. Below 25% of next cards the board is static; from 45% it is dynamic; in between, medium. The river has no next card, so it is neither.",
    ],
    why: [
      "On dynamic boards equities run: a hand that is ahead now may be behind on the turn. Strong hands want to bet so draws pay to see the next card, and medium hands are harder to play.",
      "On static boards there is less to protect against. Small bets, thin value and checking back to control the pot all work better, because the turn rarely changes who is ahead.",
      "The dynamism of a board is also what makes some spots expensive to get wrong: the bigger the swings, the more a passive play can cost.",
    ],
    formulas: [
      {
        name: "Volatility",
        expression: { frac: ["changing cards + ½ × overcards", "unseen cards"] },
        spoken: "Volatility equals the number of next cards that change the board, plus half the overcards that change nothing else, divided by the number of unseen cards.",
      },
    ],
    example: {
      title: "Static and dynamic, side by side",
      setup: "On the flop there are 49 unseen cards.",
      steps: [
        "K♦7♣2♥: only the aces are overcards and no turn card adds a flush or two straight holdings at once — volatility about 4%. Static.",
        "8♥7♥6♣: every heart brings a third heart, and many cards add new straights — volatility about 59%. Dynamic.",
        "Add a 3♠ to K♦7♣2♥ and the turn board's volatility rises to about 21% — still static.",
      ],
      takeaway: "The flop's texture tells you what exists; its dynamism tells you how fast that will change.",
    },
    mistakes: [
      "Slowplaying strong hands on dynamic boards, giving free cards to the draws that beat you.",
      "Betting big for protection on static boards, where there is little to protect against and only better hands call.",
      "Treating every two-tone board as dynamic: a two-tone K♦7♦2♣ only reaches medium — the flush draw is its one moving part.",
    ],
    tryIt: "Build a flop and watch volatility: add a second suited card, close the gaps between ranks, then try a turn card.",
  },

  blockers: {
    summary: "Your cards are not in anyone else's hand: holding one removes the combos that need it.",
    definition: [
      "A blocker is a card you hold that makes certain hands less likely for your opponent, because they would need that same card. Holding the A♠ means there are 3 combos of AA left instead of 6, and 12 combos of AK instead of 16.",
      "The other side is unblocking: not holding the cards of the hands you want your opponent to have. A bluff works best when you do not block the hands that fold.",
    ],
    why: [
      "Blockers are how close decisions get made. When two hands are worth about the same, the one that removes more of the opponent's strong hands is the better bluff — and the one that removes more of their bluffs is the worse bluff-catcher.",
      "They matter most when ranges are narrow — late in a hand, or after several raises preflop — because each removed combo is a bigger share of what is left.",
      "The board blocks too: a king on the flop leaves 3 combos of KK, not 6.",
    ],
    formulas: [
      {
        name: "Pair combos left",
        expression: ["C(cards left, 2): 6 → 3 → 1"],
        spoken: "A pocket pair has 6 combos with all four cards available, 3 with one removed, and 1 with two removed.",
      },
      {
        name: "Unpaired combos left",
        expression: ["(cards of rank 1 left) × (cards of rank 2 left)"],
        spoken: "An unpaired hand's combos equal the cards left of its first rank times the cards left of its second rank.",
      },
    ],
    example: {
      title: "A 4-bet bluff with A♠5♠",
      setup: "Your opponent continues against a 4-bet with QQ+ and AK: 6 + 6 + 6 + 16 = 34 combos.",
      steps: [
        "Your A♠ removes half the aces: AA drops from 6 combos to 3.",
        "AK drops from 16 to 12 (3 of 4 suited, 9 of 12 offsuit).",
        "KK and QQ are untouched: 6 each.",
        "Their continuing range falls from 34 combos to 27 — about 21% fewer.",
      ],
      takeaway: "That is why small suited aces are classic 4-bet bluffs: the ace removes a big share of the hands that continue, and the hand still has some equity when called.",
    },
    mistakes: [
      "Bluffing because of one blocker when the opponent's range is still mostly strong hands.",
      "Blocking the hands that fold. A bluff with the cards your opponent would fold makes them more likely to have something that calls.",
      "Forgetting the board: cards on the table remove combos for both players.",
    ],
    tryIt: "Pick your two cards (and a board) and see how many combos of each class are left.",
  },
};
