import type { ConceptTexts } from "./types";

/** Preflop, English. Every number in an example is checked in `tests/test/learn.test.ts`. */
export const preflopEn: ConceptTexts<"rfi" | "three-bet" | "squeeze" | "blind-defence" | "steal"> = {
  rfi: {
    summary: "Raise first in: opening the pot with a raise when everyone before you has folded.",
    definition: [
      "RFI (raise first in) is the first voluntary action of the hand being a raise — an open. Your RFI percentage is how often you open when the action folds to you, and it should depend heavily on your seat.",
      "The alternative, calling the big blind first in (an open limp), is rarely better in a raked six-handed game: it gives up the chance to win the blinds right away and invites the players behind to raise.",
    ],
    why: [
      "Opening ranges widen with every seat closer to the button: fewer players are left to act behind you, and you are more likely to have position after the flop.",
      "From under the gun, five players can still wake up with a strong hand; from the button, two — and both will be out of position.",
      "A sensible open size is 2 to 2.5 bb from most seats, and a little more from the small blind, which plays the rest of the hand out of position.",
    ],
    formulas: [
      {
        name: "RFI",
        expression: { frac: ["hands opened", "hands folded to you"] },
        spoken: "RFI equals the hands you opened divided by the hands where the action folded to you.",
      },
    ],
    example: {
      title: "Counting an under-the-gun range",
      setup: "The illustrative under-the-gun range used on these pages: 66+, A9s+, A5s, A4s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo.",
      steps: [
        "Pairs 66 to AA: 9 pairs × 6 = 54 combos.",
        "Suited hands: A9s to AKs (5), A5s and A4s (2), KTs to KQs (3), QTs and QJs (2), JTs, T9s and 98s (3) — 15 classes × 4 = 60 combos.",
        "Offsuit hands: AJo, AQo, AKo and KQo — 4 classes × 12 = 48 combos.",
        "Total: 54 + 60 + 48 = 162 combos, 162 / 1,326 ≈ 12.2% of all hands.",
      ],
      takeaway: "The button's illustrative range on these pages is about 42% — more than three times as many hands, from the same player, because of the seat.",
    },
    mistakes: [
      "Opening the same range from every seat.",
      "Open-limping hands that are good enough to raise or bad enough to fold.",
      "Opening too wide from early seats, where the hands that call or 3-bet you are strong.",
      "Using a big open size from late position, where a smaller one risks less to win the same blinds.",
    ],
    tryIt: "Set the open size and the blinds to see how often an open has to win right away if it never wins when called.",
  },

  "three-bet": {
    summary: "The first re-raise before the flop, and the re-raise after it: building pots with value and taking them with fold equity.",
    definition: [
      "Preflop the big blind counts as the first bet, so an open is the second bet and the first re-raise is a 3-bet. A re-raise of that is a 4-bet.",
      "A 3-betting range mixes strong hands that want a bigger pot (value) with hands that are happy to win the pot now and still play well when called (bluffs) — often small suited aces, which also block the strongest hands, and suited connectors. Some players 3-bet more linearly, from the top down, especially in position against wide opens.",
      "Common sizes: about three times the open in position, about four times out of position, and a 4-bet of about 2.2 to 2.5 times the 3-bet.",
    ],
    why: [
      "A 3-bet wins the pot immediately often enough to be worth making with some hands that would struggle as a call. It also takes away the opener's chance to see a cheap flop and realise their equity.",
      "It lowers the SPR, which makes strong one-pair hands easier to play for stacks after the flop.",
      "A range that only 3-bets premium hands is easy to play against: fold everything but the nuts. Bluffs make the value get paid.",
    ],
    formulas: [
      {
        name: "Fold rate a 3-bet bluff needs",
        expression: { frac: ["3-bet", "3-bet + pot"] },
        spoken: "The fold rate a 3-bet bluff needs equals the chips the 3-bet risks divided by those chips plus the pot already in the middle.",
      },
    ],
    example: {
      title: "A button 3-bet against a cutoff open",
      setup: "The cutoff opens to 2.5 bb and you 3-bet to 8 bb from the button. The pot before your 3-bet is 2.5 + 0.5 + 1 = 4 bb.",
      steps: [
        "As a pure bluff the 3-bet must take the pot 8 / (8 + 4) ≈ 66.7% of the time — the cutoff and both blinds must all fold.",
        "The illustrative button 3-bet range on these pages is TT+, AJs+, AKo, AQo, KQs, A5s, A4s, 76s and 65s: 86 combos, about 6.5% of all hands.",
        "70 of those combos are strong hands; the other 16 (A5s, A4s, 76s, 65s) are the bluffs.",
        "The aces block AA and AK; the connectors make straights and two pairs when called.",
      ],
      takeaway: "Bluffs are chosen for what they do when called and what they remove from the hands that continue — not just because they are too weak to call.",
    },
    mistakes: [
      "3-betting only premium hands, which makes every 3-bet face up.",
      "Calling 3-bets out of position with dominated hands like KJo or ATo.",
      "4-bet bluffing with hands that block nothing.",
      "3-betting small out of position, giving the opener a cheap call in position.",
    ],
    tryIt: "Pick your hand and see how much it removes from the hands that would continue against your 3-bet or 4-bet.",
  },

  squeeze: {
    summary: "A 3-bet after an open and a call: more money in the middle, and a caller who is unlikely to be strong.",
    definition: [
      "A squeeze is a 3-bet made after one player has opened and at least one other has called.",
      "It works for two reasons: the caller's chips are dead money you can win, and the caller's range is usually capped — with their strongest hands they would have 3-bet themselves. The opener, meanwhile, is caught between you and the caller.",
    ],
    why: [
      "More money in the pot means the same squeeze needs to work a little less often than a 3-bet against a lone opener.",
      "But two players have to fold, not one. That is why squeezes are bigger than plain 3-bets — about one extra open size for each caller — and why they lean on hands that play well when called.",
    ],
    formulas: [
      {
        name: "Fold rate a squeeze bluff needs",
        expression: { frac: ["squeeze", "squeeze + pot"] },
        spoken: "The fold rate a squeeze bluff needs equals the chips the squeeze risks divided by those chips plus the pot already in the middle.",
      },
    ],
    example: {
      title: "Squeezing from the button",
      setup: "The hijack opens to 2.5 bb, the cutoff calls, and you squeeze to 12 bb from the button. The pot before you act is 2.5 + 2.5 + 0.5 + 1 = 6.5 bb.",
      steps: [
        "As a pure bluff it must take the pot 12 / (12 + 6.5) ≈ 64.9% of the time.",
        "If the opener and the caller each fold 80% of the time, both fold 0.8 × 0.8 = 64% — just short.",
        "The caller's capped range folds more often, say 90%: 0.8 × 0.9 = 72%, comfortably above the price.",
      ],
      takeaway: "A squeeze is profitable because the caller is weak, not just because there is more money in the middle. Against a caller who traps big hands, it is just an expensive 3-bet.",
    },
    mistakes: [
      "Squeezing to the same size as a 3-bet against one player.",
      "Squeezing light against a caller known to flat strong hands.",
      "Squeezing out of position from the blinds with hands that play badly when called.",
    ],
    tryIt: "Change the dead money and the squeeze size to see how often it has to work.",
  },

  "blind-defence": {
    summary: "Defending the blinds against an open: a great price, paid for by playing out of position.",
    definition: [
      "The big blind already has 1 bb in the pot and closes the action preflop, so calling an open costs less than it does for anyone else. That discount is why the big blind defends far more hands than any other seat calls.",
      "The small blind is different: it is out of position against everyone, including the big blind still to act behind it, and it does not close the action. From the small blind most defence is a 3-bet or a fold.",
    ],
    why: [
      "The price depends on the open size. Against a 2 bb open the big blind needs about 22% equity, against 2.5 bb about 27%, against 3 bb about 31%.",
      "Equity is not everything: out of position, hands realise less of it. Hands that make strong hands — suited, connected — defend wider than offsuit hands with weak kickers.",
      "Folding too much from the big blind is one of the most common and most expensive preflop leaks, because the blinds are posted every orbit.",
    ],
    formulas: [
      {
        name: "Required equity",
        expression: { frac: ["call", "pot + call"] },
        spoken: "The equity the big blind needs equals the call divided by the pot plus the call, the pot including the open.",
      },
    ],
    example: {
      title: "J♣5♦ against a button open",
      setup: "The button opens and the small blind folds. Against the illustrative button range on these pages, J♣5♦ has about 36% equity.",
      steps: [
        "Against a 2.5 bb open: the pot is 2.5 + 0.5 + 1 = 4 bb and the call is 1.5 bb, so the price is 1.5 / 5.5 ≈ 27.3%.",
        "Against a 2 bb open: the pot is 3.5 bb and the call 1 bb — 1 / 4.5 ≈ 22.2%.",
        "Suppose J♣5♦ realises 65% of its equity out of position: 0.36 × 0.65 ≈ 23.4%.",
        "That is short of 27.3% but above 22.2%.",
      ],
      takeaway: "Fold it to the bigger open, defend against the min-raise. The open size moves the bottom of the big blind's range, and the realisation factor — an assumption here — decides where.",
    },
    mistakes: [
      "Folding too often from the big blind against late-position opens.",
      "Calling too much from the small blind, which is out of position and does not close the action.",
      "Defending the same range against an under-the-gun open as against a button open.",
      "Ignoring the open size.",
    ],
    tryIt: "Set the pot and the call for different open sizes and see the price the big blind is getting.",
  },

  steal: {
    summary: "Opening from the late seats to win the blinds: a bet that is profitable even when it fails a lot.",
    definition: [
      "A steal is an open from the cutoff, the button or the small blind when everyone before has folded, made with a range much wider than the hands that are strong in their own right. The main goal is to win the blinds (and antes) right away.",
      "It risks the open size to win what is already in the middle, so it has a simple break-even fold rate — and when it is called, it still has equity and often position.",
    ],
    why: [
      "The blinds are in every orbit. Picking them up often enough is a meaningful part of a winning player's results, and stealing too little leaves it to everyone else.",
      "Antes change the price: more dead money, so a steal needs to work less often.",
      "The blinds fight back by 3-betting and defending. A steal range is right only relative to how the blinds play.",
    ],
    formulas: [
      {
        name: "Break-even fold rate",
        expression: { frac: ["open", "open + blinds + antes"] },
        spoken: "A steal's break-even fold rate equals the open size divided by the open size plus the blinds and antes.",
      },
    ],
    example: {
      title: "Three button steals",
      setup: "You open the button with a hand that will never win if called — the worst case.",
      steps: [
        "2.5 bb into 1.5 bb of blinds: 2.5 / (2.5 + 1.5) = 62.5% folds needed.",
        "3 bb instead: 3 / 4.5 ≈ 66.7%. Bigger is not better when the goal is the blinds.",
        "2.5 bb with an ante of 0.1 bb from each of 6 players: the pot is 2.1 bb, so 2.5 / 4.6 ≈ 54.3%.",
      ],
      takeaway: "The real break-even is lower still, because a called steal keeps its equity and usually its position. That is why button ranges are wide.",
    },
    mistakes: [
      "Stealing with oversized opens.",
      "Stealing just as wide into blinds who 3-bet very often.",
      "Not stealing enough from the button.",
      "Giving up on every flop after a steal is called.",
    ],
    tryIt: "Set the blinds (add antes) and the open size: the calculator shows how often the steal has to win right away.",
  },
};
