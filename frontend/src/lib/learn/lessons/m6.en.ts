import type { LessonBodies } from "./types";

/**
 * M6 — 3-bet and 4-bet pots, English. Every computed number in a section is
 * listed in its lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`. No solver frequency is quoted: the split is
 * described by direction, and the drills grade with Rail's own solves.
 */
export const m6En: LessonBodies<"range-splitting-ip-vs-checks-3bp"> = {
  "range-splitting-ip-vs-checks-3bp": {
    sections: [
      {
        heading: "The spot, from both seats",
        blocks: [
          "This lesson is about one moment that moves a lot of money: a 3-bet pot, you are in position, and the player out of position checks to you. You can get there in two ways, and they play differently.",
          {
            list: [
              "Role A, the in-position 3-bettor: the cutoff opens, you 3-bet on the button, the cutoff calls and checks the flop.",
              "Role B, the in-position caller: you open on the button, the big blind 3-bets, you call, and the big blind checks.",
            ],
          },
          "Either way your whole range now has three options: bet small, bet big or check back. Splitting the range means deciding which hands go where, and why, before you think about the one hand you hold.",
          {
            note: {
              tone: "conceptual",
              text: "The flop part of this lesson is conceptual for now. Rail's flop library is not switched on yet, so the flop split is taught in words, and the drills run on the turn and the river, which Rail solves today.",
            },
          },
        ],
      },
      {
        heading: "The pot and the stacks",
        blocks: [
          "Role A at 100bb, with the sizes in Rail's charts: the cutoff opens to 2.5 bb, you 3-bet to 7.5 bb on the button (three times the open, in position), the blinds fold and the cutoff calls. The pot is 7.5 + 7.5 + 0.5 + 1 = 16.5 bb, with 100 − 7.5 = 92.5 bb behind each player: an SPR of 92.5 / 16.5, about 5.6.",
          "Role B: you open to 2.5 bb on the button, the small blind folds and the big blind 3-bets to 10 bb (four times the open, out of position), and you call. The pot is 10 + 10 + 0.5 = 20.5 bb, with 100 − 10 = 90 bb behind: an SPR of about 4.4.",
          "At SPRs like these, one good pair is often a hand you are happy to play for stacks, and every flop bet is the first step of a plan that can end all in.",
          {
            widget: { id: "spr", pot: 16.5, stack: 92.5 },
            caption:
              "Role A's flop at 100bb. Change the number of streets to see the equal bet that gets everything in, then set the stack to 192.5 bb to see the same pot 200bb deep.",
          },
        ],
      },
      {
        heading: "Three buckets, five jobs",
        blocks: [
          "Each bucket does a different job, and knowing the job lets you place hands you have never studied.",
          {
            list: [
              "Value: getting called by worse hands.",
              "Protection: a made hand that can be outdrawn bets so that it does not hand out free cards.",
              "Denial: overcards and backdoor draws would get cheap equity from a check; a bet makes them pay or fold.",
              "Fold equity: winning the pot now with a hand that rarely wins at showdown.",
              "Pot control: keeping the pot small with a hand that wants to reach showdown but cannot stand a raise.",
            ],
          },
          "The small bet is mostly value, protection and denial, on boards where you are ahead overall. The big bet is polarised: strong hands that want a big pot, and draws that can win it now or later. Checking back is pot control and free equity, plus a few strong hands that keep your checks from being an easy target.",
          {
            checkpoint: {
              question:
                "Role A, a two-tone board where you hold more of the strongest hands. You have the nut flush draw with two overcards. What does a big bet do for this hand?",
              options: ["Value: worse hands call", "Fold equity now, plus plenty of equity when called", "Pot control"],
              answer: 1,
              explain:
                "The draw rarely wins if the hand stops here, so it is not value, and a big bet is the opposite of pot control. A big bet can take the pot at once, and when it is called the draw still has a lot of equity. Those two reasons together make strong draws the natural bluffs in a big-bet bucket.",
            },
          },
        ],
      },
      {
        heading: "Role A: the 3-bettor when the caller checks",
        blocks: [
          "Read the check first. In a 3-bet pot the caller checks to the 3-bettor almost every time, so the check tells you very little: the whole calling range is still there, strong hands included.",
          "Small bets are the main bucket on boards where you have the range advantage: ace-high, king-high and dry, or low and paired. Overpairs, top pairs and many hands with only overcards and backdoor draws bet together. The small size works because the calling range is condensed: it holds few hands that can attack a small bet and many that must pay or fold.",
          "Big bets grow on dynamic boards where you still hold enough of the strongest hands, such as two-tone broadway flops. Strong but vulnerable hands, like overpairs, top pair with a good kicker and two pair, bet big to build the pot before bad turn cards arrive, and strong draws join them.",
          "Checking back is biggest on middling connected boards, where the caller's pocket pairs, suited connectors and suited broadways make sets, two pairs and straights. Medium pairs, one-pair hands that hate facing a check-raise with so little behind, and ace-high hands that can win at showdown go here, along with a few strong hands.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "3bet-vs-call", board: ["Ad", "Kc", "4h"] },
            caption:
              "Illustrative 3-bet and calling ranges, written by hand for teaching, on A♦K♣4♥. Switch the board to T♥9♥8♣ and watch the 3-bettor's lead disappear: that is the board where the check-back bucket grows.",
          },
        ],
      },
      {
        heading: "Role B: the caller when the 3-bettor checks",
        blocks: [
          "Here the check carries real information. An out-of-position 3-bettor bets often on high boards that suit its range, so a check there leans towards medium hands, though it can still hide an overpair. On low connected boards it checks more often, so the checking range is wider and holds fewer of the very best hands.",
          "Small stabs are your widest bucket on dry, low and paired boards. Medium and weak pairs, overcards with backdoor draws, and hands that profit from making unimproved big cards fold all bet small into a checking range full of them.",
          "Big bets appear where you hold the strongest hands: low and middling connected boards, where your sets, two pairs and straights are hands the 3-bettor rarely has. Value hands and strong draws bet big, sized to get the stacks in by the river.",
          "Checking back suits made hands of medium strength that fear a check-raise, hands that will reach showdown and realise their equity anyway, and some strong hands, especially when the 3-bettor is likely to bet the turn.",
          {
            checkpoint: {
              question: "Role B, flop K♠Q♦4♣, and the big blind checks. Which hand fits the check-back bucket best?",
              options: ["4♥4♠, a set", "K♥J♥, top pair with a weak kicker", "7♥6♥, no pair and almost no draw"],
              answer: 1,
              explain:
                "The set wants to build a pot: value. 7♥6♥ has nothing to show down, so if it bets, it bets for fold equity. K♥J♥ is the middle: it beats much of the checking range, but the hands that call a bet are often the overpairs, A-K and K-Q that beat it, and a check-raise at this SPR would leave it stuck. Checking keeps the pot small and still wins at showdown often. Rail's solver may still bet such a hand some of the time; what matters is the reason each hand would bet.",
            },
          },
        ],
      },
      {
        heading: "How the board moves the split",
        blocks: [
          {
            list: [
              "High, dry boards: as the 3-bettor, bet small with most of the range; as the caller, check back more, and keep your stabs small.",
              "Middling connected and two-tone boards: as the 3-bettor, polarise, with more big bets, more checks and fewer small bets; as the caller, bet more often and bigger.",
              "Low paired boards: small bets for whoever bets. Few strong hands exist, and most hands are either well ahead or drawing thin.",
              "Monotone boards: smaller bets and more checks. The high cards of the flush suit decide which hands bet.",
            ],
          },
          {
            widget: { id: "board-texture", focus: "dynamism", board: ["Th", "9h", "8c"] },
            caption:
              "T♥9♥8♣: connected, two-tone and dynamic. Swap in 3♠3♦8♣ or A♦K♣4♥ and watch volatility fall. The split follows the same line, from polarised towards small and frequent.",
          },
        ],
      },
      {
        heading: "How stack depth moves it: 100bb against 200bb",
        blocks: [
          "At 100bb, role A's SPR of about 5.6 leaves room for a plan. Three equal bets of about 65% of the pot get the stacks in by the river. Even a flop bet of 5.5 bb, a third of the pot, leaves a pot of 16.5 + 5.5 + 5.5 = 27.5 bb with 87 bb behind, and two bets of about 85% of the pot finish the job. One pair can bet small and still play for stacks.",
          "Start 200bb deep and the same small flop bet leaves 192.5 − 5.5 = 187 bb behind that 27.5 bb pot. Getting it all in over two more streets would take bets of about 141% of the pot each. That changes the split:",
          {
            list: [
              "One-pair hands move from betting for value towards checking, or betting small for thin value.",
              "Sizes get bigger and checks more common, because big bets need hands that want a big pot.",
              "Hands that can make the nuts, such as small pairs, suited connectors and suited wheel aces, gain value, while overpairs are no longer close to the nuts.",
            ],
          },
          {
            checkpoint: {
              question: "Role A again, but both players started with 200bb. The pot is still 16.5 bb. What is the SPR on the flop?",
              options: ["About 5.6", "About 11.7", "About 23"],
              answer: 1,
              explain:
                "Each player has 200 − 7.5 = 192.5 bb behind, and 192.5 / 16.5 is about 11.7, roughly twice the 100bb figure. Role B at 200bb is similar: 190 / 20.5, about 9.3. Commitment comes much later, so one pair has to be more careful.",
              math: { fn: "spr", args: [192.5, 16.5], value: 11.7 },
            },
          },
        ],
      },
      {
        heading: "Real opponents, and practising it in Rail",
        blocks: [
          "Many live 3-bettors check only their weak hands and bet everything strong. Against them a check is a strong sign that the range is capped, and in role B you can stab more often and with more hands.",
          "Against players who almost never check-raise, the main reason to check back medium hands disappears: bet them for thin value and protection, and your check-back bucket shrinks. Against players who check-raise a lot, check back more of them.",
          "The drills put you in this exact spot on the turn and the river: a 3-bet pot, you in position, the opponent checked. On the turn you choose between checking, betting 75% of the pot and, when the stack is at most three pots, going all in. On the river you choose from a check, several bet sizes and all in. The grade is the one the analysis gives a real hand.",
          {
            note: {
              tone: "approximate",
              text: "The ranges that reach the turn and the river in these drills rest on Rail's narrowing model, a heuristic estimate of how each player continues on earlier streets, as the analysis says. Treat a close grade as close.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Name the bucket's job first: value, protection, denial, fold equity or pot control.",
        "As the in-position 3-bettor, bet small and often on high, dry and low paired boards; polarise on middling connected ones.",
        "As the in-position caller, read the check: on high boards it leans medium, on low connected boards it is wide and capped.",
        "Big bets need the strongest hands; check back the one-pair hands that cannot stand a raise.",
        "Deeper stacks mean bigger sizes, more checks and less love for one pair.",
      ],
      breaks: [
        "Against 3-bettors who check only weak hands, stab far more often than a balanced split would.",
        "Against players who rarely check-raise, bet more of your medium hands for thin value instead of checking them back.",
        "Multiway or with uneven stacks, the SPR and the ranges change, and so does the split.",
      ],
    },
    exercises: {
      "flop-split":
        "Coming with the flop library: drag hand categories into bet small, bet big and check back after the check, and compare your split with Rail's solve for that flop.",
      "turn-3bettor":
        "Two turn spots as the in-position 3-bettor after a check, solved by Rail on demand: check, bet 75% of the pot, or all in when the stack is short enough.",
      "turn-caller":
        "Two turn spots as the in-position caller after the 3-bettor checks, with the same menu. Read the check before you choose.",
      "river-3bettor":
        "Three river spots as the in-position 3-bettor facing a check: check or pick a size, graded the way the analysis grades a real hand.",
      "river-caller":
        "Three river spots as the in-position caller facing a check from the 3-bettor, graded the same way.",
      "your-hands":
        "Your own 3-bet pots in position where the opponent checked to you, on any street, the costliest first. Choose your bucket before you see what you did.",
    },
    checks: [
      { fn: "product", args: [2.5, 3], value: 7.5 },
      { fn: "sum", args: [7.5, 7.5, 0.5, 1], value: 16.5 },
      { fn: "sum", args: [100, -7.5], value: 92.5 },
      { fn: "spr", args: [92.5, 16.5], value: 5.6 },
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "sum", args: [10, 10, 0.5], value: 20.5 },
      { fn: "sum", args: [100, -10], value: 90 },
      { fn: "spr", args: [90, 20.5], value: 4.4 },
      { fn: "geometricBet", args: [16.5, 92.5, 3], value: 0.65 },
      { fn: "ratio", args: [5.5, 16.5], value: 0.333 },
      { fn: "sum", args: [16.5, 5.5, 5.5], value: 27.5 },
      { fn: "sum", args: [92.5, -5.5], value: 87 },
      { fn: "geometricBet", args: [27.5, 87, 2], value: 0.85 },
      { fn: "sum", args: [200, -7.5], value: 192.5 },
      { fn: "sum", args: [192.5, -5.5], value: 187 },
      { fn: "geometricBet", args: [27.5, 187, 2], value: 1.41 },
      { fn: "sum", args: [200, -10], value: 190 },
      { fn: "spr", args: [190, 20.5], value: 9.3 },
    ],
  },
};
