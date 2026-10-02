import type { ConceptTexts } from "./types";

type Betting =
  | "spr"
  | "mdf-alpha"
  | "bet-sizing"
  | "continuation-bet"
  | "check-raise"
  | "donk-bet"
  | "bluff-catching"
  | "thin-value";

/** Betting, English. Every number in an example is checked in `tests/test/learn.test.ts`. */
export const bettingEn: ConceptTexts<Betting> = {
  spr: {
    summary: "Stack-to-pot ratio: how many pots are left behind, and so how committed a hand is.",
    definition: [
      "SPR is the effective stack — the smaller of the two stacks still in — divided by the pot. Rail measures it at the start of each street, the way players quote it (\"SPR 4 on the flop\"), not after every bet.",
      "Typical numbers at 100 bb: a single-raised pot starts the flop around SPR 15 to 18; a 3-bet pot around 4; a 4-bet pot around 1.",
    ],
    why: [
      "SPR tells you in advance which hands can go all in. At SPR 1 to 3, top pair is usually happy to get the money in; at SPR 15, one pair wants to keep the pot small and the stacks belong to sets, straights and better.",
      "It lets you plan the hand: how big each bet must be to get the stacks in by the river, and whether a bet now leaves enough behind to fold to a raise.",
      "Two of Rail's flags are SPR questions: a bet that leaves too little behind (all in, in all but name) and a fold after most of the stack is already in.",
    ],
    formulas: [
      {
        name: "SPR",
        expression: { frac: ["effective stack", "pot"] },
        spoken: "SPR equals the effective stack divided by the pot, at the start of the street.",
      },
      {
        name: "Geometric bet",
        expression: { frac: [["(1 + 2 × SPR)", { sup: "1/n" }, " − 1"], "2"] },
        spoken: "The geometric bet, as a fraction of the pot, equals one plus two times SPR, to the power one over n, minus one, all divided by two.",
        where: [["n", "the streets left to bet, each bet called"]],
      },
    ],
    example: {
      title: "A 3-bet pot",
      setup: "The cutoff opens to 2.5 bb, the button 3-bets to 10 bb, the blinds fold and the cutoff calls. Both started with 100 bb.",
      steps: [
        "The pot on the flop: 10 + 10 + 0.5 + 1 = 21.5 bb. Each player has 90 bb behind.",
        "SPR = 90 / 21.5 ≈ 4.2.",
        "To get the stacks in over three streets with equal bets, each bet should be about 55% of the pot.",
        "Over two streets it takes about pot-sized bets (103%).",
        "Compare a single-raised pot: 2.5 + 2.5 + 0.5 = 5.5 bb with 97.5 bb behind, SPR ≈ 17.7 — three bets of about 116% pot.",
      ],
      takeaway: "In the 3-bet pot, three ordinary bets put top pair all in; in the single-raised pot it takes three bigger-than-pot bets. Same hand, different plan.",
    },
    mistakes: [
      "Playing one pair for the whole stack at a high SPR.",
      "Folding top pair at SPR 1 after putting a third of the stack in.",
      "Betting so that a sliver is left behind: the opponent can call knowing you will never fold.",
      "Measuring SPR after a bet on the same street, which makes every spot look more committed than it is.",
    ],
    tryIt: "Set the pot and the stacks, then the number of streets: the geometric bet is the size that gets it all in by the river.",
  },

  "mdf-alpha": {
    summary: "MDF is how much of your range has to continue against a bet; alpha is how often that bet must make you fold.",
    definition: [
      "Alpha is the break-even fold rate of a bet that never wins when called: the bet risks its own size to win the pot, so it needs the opponent to fold bet / (pot + bet) of the time.",
      "The minimum defence frequency (MDF) is the other side of the same number: 1 − alpha = pot / (pot + bet). If the defender folds more than that, any two cards can bet and profit, so a balanced defender continues at least MDF of their range — by calling or raising.",
    ],
    why: [
      "They put numbers on \"am I folding too much?\" and \"how often does this bluff need to work?\". A pot-sized bet must work half the time; a third-pot bet, a quarter.",
      "They apply after the flop. Preflop the blinds are posted before anyone decides, ranges are far apart, and MDF misreads defence as a leak. Rail compares your defence with MDF on postflop streets only.",
      "MDF is a guide against an unknown opponent, not a law. Against someone who rarely bluffs, defend less; against someone who bluffs too much, more.",
    ],
    formulas: [
      {
        name: "Alpha",
        expression: { frac: ["bet", "pot + bet"] },
        spoken: "Alpha equals the bet divided by the pot plus the bet, where the pot is before the bet.",
      },
      {
        name: "MDF",
        expression: { frac: ["pot", "pot + bet"] },
        spoken: "The minimum defence frequency equals the pot divided by the pot plus the bet.",
        where: [["pot", "the pot before the bet"]],
      },
    ],
    example: {
      title: "A three-quarter-pot bet",
      setup: "The pot is 10 bb and your opponent bets 7.5 bb.",
      steps: [
        "Alpha: 7.5 / (10 + 7.5) ≈ 42.9%. A pure bluff needs you to fold that often.",
        "MDF: 10 / 17.5 ≈ 57.1%. Out of 100 combos you arrive with, continue with at least 57.",
        "For a single call, the price is 7.5 / (17.5 + 7.5) = 30% equity.",
      ],
      takeaway: "Three numbers, one bet: the bettor's alpha, the defender's MDF, and the caller's price. The table under the maths has them for the common sizes.",
    },
    mistakes: [
      "Using MDF preflop, where it mistakes normal folding for a leak.",
      "Defending to MDF on every street: 57% three times in a row is 19% of where you started — and that may be right, but only if the bets are balanced.",
      "Forgetting that raises count as defence.",
      "Defending to MDF against an opponent who never bluffs.",
    ],
    tryIt: "Move the bet size and watch alpha and MDF trade places: bigger bets need fewer folds per bet but ask the defender to give up more.",
  },

  "bet-sizing": {
    summary: "Small, big or overbet: every size has a job, and the job depends on the board and on which hands you bet.",
    definition: [
      "Small bets (about a quarter to two fifths of the pot) charge many hands a little. They suit ranges with a broad advantage on boards that do not change much: most of the range can bet, and most of the opponent's range can still call.",
      "Big bets (two thirds to a full pot) and overbets (more than the pot) suit polarised ranges — very strong hands and bluffs, no middle — and need a nut advantage behind them. They deny equity on boards where it is running, and they charge the most to the hands that call.",
      "A polarised range bets its best hands and its bluffs and checks its medium hands. A merged (linear) range bets from the top down, including medium hands that are ahead of what calls, usually with a smaller size.",
    ],
    why: [
      "Size decides who can call, how much equity you deny, and how many bluffs your value can carry. On the river, with a perfectly polarised range, a bet can contain bet / (pot + 2·bet) bluffs and still leave the bluff-catcher indifferent.",
      "Picking size by hand strength alone — big with strong hands, small with weak ones — tells an attentive opponent exactly what you have. Size by range: decide what the bet is for, then put every hand with that purpose into it.",
    ],
    formulas: [
      {
        name: "Bluff share of a polarised bet",
        expression: { frac: ["bet", "pot + 2 × bet"] },
        spoken: "The bluff share of a polarised river bet equals the bet divided by the pot plus twice the bet.",
      },
      {
        name: "Value per bluff",
        expression: { frac: ["pot + bet", "bet"] },
        spoken: "Value combos per bluff combo equal the pot plus the bet, divided by the bet.",
      },
    ],
    example: {
      title: "Three river sizes into a 10 bb pot",
      setup: "A perfectly polarised river range: the nuts and air, nothing in between.",
      steps: [
        "Half pot, 5 bb: bluffs can be 5 / (10 + 10) = 25% of the bets — 3 value hands per bluff.",
        "Pot, 10 bb: 10 / 30 ≈ 33% bluffs — 2 value hands per bluff.",
        "Double pot, 20 bb: 20 / 50 = 40% bluffs — 1.5 value hands per bluff.",
      ],
      takeaway: "Bigger bets carry more bluffs per value hand, but they need enough nutted hands to be worth making. With few nuts, a smaller size lets you bet more often.",
    },
    mistakes: [
      "Betting big with strong hands and small with weak ones.",
      "Overbetting without a nut advantage.",
      "Betting small on dynamic boards, which lets draws in cheaply.",
      "Betting medium hands big into ranges that only continue with better.",
    ],
    tryIt: "Set a pot and a bet: the calculator shows the bluff share and value-per-bluff ratio for a polarised bet of that size.",
  },

  "continuation-bet": {
    summary: "The preflop raiser betting the flop — often right, never automatic.",
    definition: [
      "A continuation bet (c-bet) is a flop bet by the player who made the last raise before the flop, continuing the aggression. On the turn it is usually called a second barrel.",
      "How often and how big to c-bet follows from range and nut advantage: on boards that favour the raiser's range, c-bet often and small; on boards that favour the caller, less often, and bigger when you do.",
    ],
    why: [
      "The raiser's range usually has more big cards and big pairs, so many flops hit it better — and the caller misses most flops. A cheap bet then wins the pot often or builds it with value.",
      "Position changes it. In position the raiser can check back and still act last on the turn; out of position, checking gives up the initiative and betting is more expensive when raised.",
      "Multiway, every extra player makes a c-bet less likely to work: someone usually has something.",
    ],
    formulas: [
      {
        name: "Fold rate a pure c-bet bluff needs",
        expression: { frac: ["bet", "pot + bet"] },
        spoken: "The fold rate a c-bet bluff needs equals the bet divided by the pot plus the bet.",
      },
    ],
    example: {
      title: "Small c-bet, dry flop",
      setup: "Heads up in a 6 bb pot on K♦7♣2♥ as the button against a big-blind call. Using the illustrative ranges, the button's range has about 53% equity there.",
      steps: [
        "A third-pot c-bet of 2 bb needs folds 2 / (6 + 2) = 25% of the time to profit with a hand that never wins when called.",
        "The big blind misses this flop with most of its range, so it folds far more often than that.",
        "On 8♥7♥6♣ the same ranges are about even, and the big blind has as many strong hands: the button c-bets less, and its weaker hands check back.",
      ],
      takeaway: "The flop decides the c-bet, not the fact that you raised before it.",
    },
    mistakes: [
      "C-betting every flop, which makes your checks and bets easy to read.",
      "C-betting into two or three players with the same frequency as heads up.",
      "Using one size on every board.",
      "Betting the flop with no plan for the turn.",
    ],
    tryIt: "Set the pot and the c-bet: the calculator shows how often it must work as a pure bluff.",
  },

  "check-raise": {
    summary: "Check, let them bet, then raise: the out-of-position player's strongest weapon.",
    definition: [
      "A check-raise is checking with the intention of raising after the opponent bets. It is mostly an out-of-position play — usually the big blind against a c-bet.",
      "A good check-raising range has strong made hands (sets, two pair), strong draws that are happy to get more money in (semi-bluffs), and a few bluffs with some equity. Medium hands that want to reach showdown mostly call instead.",
    ],
    why: [
      "It punishes frequent small c-bets: a raise forces the bettor to fold the bottom of a wide range or put in much more money.",
      "It builds the pot out of position with strong hands, and charges draws more than a call would.",
      "It works best where the defender has a nut advantage — more of the very strong hands than the bettor.",
    ],
    formulas: [
      {
        name: "Fold rate a pure check-raise bluff needs",
        expression: { frac: ["raise", "pot + raise"] },
        spoken: "The fold rate a check-raise bluff needs equals the chips the raise adds divided by the pot before the raise plus those chips.",
        where: [
          ["pot", "the pot before your raise, including their bet"],
          ["raise", "the chips your raise puts in"],
        ],
      },
    ],
    example: {
      title: "Raising a small c-bet",
      setup: "The pot is 6 bb, your opponent bets 2 bb (the pot is now 8 bb) and you raise to 7 bb.",
      steps: [
        "Your raise adds 7 bb to win the 8 bb in the middle.",
        "As a pure bluff it must work 7 / (8 + 7) ≈ 46.7% of the time.",
        "A flush draw needs less than that, because it can still win when called; a hand with no outs needs all of it.",
      ],
      takeaway: "Check-raise bluffs should have equity. Without it, the raise needs folds nearly half the time against a range that was willing to bet.",
    },
    mistakes: [
      "Check-raising only the nuts, so every raise is face up.",
      "Check-raising medium hands that would rather call: the raise folds out worse and gets called by better.",
      "Raising too small, giving the bettor a great price to continue.",
      "Forgetting what the raise is for: value, protection, or fold equity — and which hands call it.",
    ],
    tryIt: "Change the pot and the raise to see how often a check-raise bluff has to work.",
  },

  "donk-bet": {
    summary: "Leading into the preflop raiser out of position: usually a mistake, sometimes exactly right.",
    definition: [
      "A donk bet (or lead) is a bet by the out-of-position preflop caller into the preflop raiser, before the raiser has a chance to continuation-bet.",
      "The name comes from its reputation as a beginner's move, and most of the time checking is better. But there are boards and turn cards where the caller's range is the stronger one, and there a small lead is part of a sound strategy.",
    ],
    why: [
      "By default the raiser has the range advantage, so the caller checks and lets them bet. Leading with a weaker range just gives the raiser an easy raise or fold.",
      "When the board shifts to the caller — low connected flops where the big blind has the two pairs and straights, or a turn card that completes the caller's draws — the lead takes the betting initiative away from a range that can no longer bet as much.",
    ],
    formulas: [
      {
        name: "Fold rate a pure lead needs",
        expression: { frac: ["bet", "pot + bet"] },
        spoken: "The fold rate a pure lead needs equals the bet divided by the pot plus the bet.",
      },
    ],
    example: {
      title: "Two flops for the big blind",
      setup: "The button opens and the big blind calls. With the illustrative ranges in the widget:",
      steps: [
        "On K♦7♣2♥ the button has about 53% equity and more of the strongest hands. Leading gives up the check to a stronger range for nothing.",
        "On 8♥7♥6♣ the big blind is slightly ahead, with about 51%, and holds about as many strong hands. A small lead with part of the range is reasonable here.",
      ],
      takeaway: "Lead where the board favours your range — not because your hand is medium and you want to see where you are.",
    },
    mistakes: [
      "Leading with a medium hand \"to see where I am\".",
      "Leading big, which folds out the hands you beat.",
      "Leading on boards that favour the raiser.",
      "Never leading at all, even on turns that clearly favour your range.",
    ],
    tryIt: "Compare the two ranges on different boards: a lead belongs where the caller's share is the larger one.",
  },

  "bluff-catching": {
    summary: "Calling with a hand that beats only bluffs: the price says how often they need to be bluffing.",
    definition: [
      "A bluff-catcher is a hand that loses to every value bet and beats every bluff. On the river it has no outs and no showdown value against the hands that bet for value; it wins only when the bet was a bluff.",
      "Whether to call is then a single question: does the betting range contain more bluffs than the price asks for?",
    ],
    why: [
      "Most hard river decisions are bluff-catches. Folding every one lets the opponent bluff with impunity; calling every one pays off every value bet.",
      "The price of the call is the share of bluffs that makes calling break even. A balanced bettor bluffs exactly that often; real opponents rarely do.",
      "Blockers decide which bluff-catchers call first: the ones that block value hands and do not block bluffs.",
    ],
    formulas: [
      {
        name: "Bluffs needed to call",
        expression: { frac: ["bet", "pot + 2 × bet"] },
        spoken: "The bluff share a call needs equals the bet divided by the pot plus twice the bet, where the pot is before the bet.",
      },
      {
        name: "EV of calling",
        expression: ["bluffs × (pot + bet) − (1 − bluffs) × bet"],
        spoken: "The EV of calling equals the bluff share times the pot plus the bet, minus the value share times the bet.",
      },
    ],
    example: {
      title: "A three-quarter-pot river bet",
      setup: "The pot is 20 bb and your opponent bets 15 bb on the river. You have a pure bluff-catcher.",
      steps: [
        "The call needs 15 / (20 + 30) = 30% bluffs.",
        "If they bluff 25%: 0.25 × 35 − 0.75 × 15 = −2.5 bb. Fold.",
        "If they bluff 40%: 0.40 × 35 − 0.60 × 15 = +5 bb. Call.",
      ],
      takeaway: "The call is a judgement about their bluff share, not about your hand. Your hand only decides whether you are a bluff-catcher at all.",
    },
    mistakes: [
      "Calling with a hand that beats nothing the opponent can have — not even their bluffs.",
      "Folding every bluff-catcher because \"they always have it\".",
      "Choosing the bluff-catcher that blocks their bluffs instead of their value.",
      "Calling because of how much is already in the pot, rather than because of the price.",
    ],
    tryIt: "Move the opponent's bluff share and watch the EV of calling turn positive at the price.",
  },

  "thin-value": {
    summary: "Betting a hand that is only a little ahead of what calls it — profitable more often than it feels.",
    definition: [
      "A thin value bet is a bet with a hand that is ahead of the calling range, but not by much: second pair on a quiet river, top pair with a weak kicker against a player who calls light.",
      "On the river, with no raise to fear, the rule is simple: a bet gains when more than half of the hands that call it are worse than yours.",
    ],
    why: [
      "Checking back a hand that would be called by worse leaves money on the table every time. Over many hands, thin value is a big part of a winning player's edge.",
      "It works best in position, on static boards, with a size that worse hands can still call.",
      "Its opposite shows up in the analysis as a flag: checking back the nuts on the river, where any bet would have been called by worse.",
    ],
    formulas: [
      {
        name: "Gain over checking",
        expression: ["call rate × bet × (2 × share of calls you beat − 1)"],
        spoken: "What a river bet gains over checking equals the call rate times the bet, times two times the share of calls you beat, minus one.",
      },
    ],
    example: {
      title: "A small river bet with top pair, weak kicker",
      setup: "The pot is 20 bb on the river. You bet 7 bb. Your opponent calls 40% of the time.",
      steps: [
        "If you beat 60% of the hands that call: 0.4 × 7 × (1.2 − 1) = +0.56 bb per bet, compared with checking.",
        "If you beat only 45% of them: 0.4 × 7 × (0.9 − 1) = −0.28 bb. Check.",
        "A bigger bet usually changes both numbers: fewer calls, and the calls that come are stronger.",
      ],
      takeaway: "The question is not \"am I ahead of their range?\" but \"am I ahead of the part that calls?\" — and the size you pick decides which part that is.",
    },
    mistakes: [
      "Checking back strong hands \"to be safe\" and missing value.",
      "Betting thin out of position into a player who raises a lot.",
      "Choosing a size so big that only better hands call.",
      "Betting thin against a player who never calls with worse.",
    ],
    tryIt: "Set the call rate and the share of calls you beat; the gain flips sign at exactly half.",
  },
};
