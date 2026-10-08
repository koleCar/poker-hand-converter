import type { LessonBodies } from "./types";

/**
 * Reference pages since L1.1 (`/learn/reference/<id>`, `REFERENCE_IDS`):
 * L1's M0 — orientation, out of the course map, kept read-only.
 *
 * M0 — orientation, English. Every computed number in a section is listed in
 * its lesson's `checks` (or a checkpoint's `math`) and recomputed by
 * `tests/test/course.test.ts`.
 */
export const m0En: LessonBodies<"how-rail-teaches" | "gto-mixing-and-simplifying" | "reading-rail-reports" | "variance-bankroll-and-tilt"> = {
  "how-rail-teaches": {
    sections: [
      {
        heading: "A loop, not a syllabus",
        blocks: [
          "Reading about poker feels like progress, but it only sticks once you use it at the table and look back at what you did. Rail is built around a loop that does exactly that, and each lesson is one turn of it.",
          {
            list: [
              "Learn: read a short lesson and answer its checkpoints before the explanation opens.",
              "Drill: practise the idea on spots Rail generates and grades on the spot.",
              "Play: take it to your own games.",
              "Review: upload your hands and let the analysis grade every decision.",
              "Repeat: your costliest leaks point to the next lesson.",
            ],
          },
          "Nothing locks. The course map suggests an order, but you can open any lesson at any time, and your own reports are often the best guide to where to go next.",
        ],
      },
      {
        heading: "What a grade measures",
        blocks: [
          "Every decision Rail grades is compared with a reference strategy: preflop charts before the flop, Rail's own solver after it. For your exact hand the reference gives each option a frequency (how often it takes it) and an EV (what it is worth on average, in big blinds).",
          "Your EV loss is the gap between the best option's EV and the EV of the one you chose. Rail measures it as a share of the pot, because losing 2 bb matters far more in a small pot than in a huge one. The concept page \"EV, EV loss and how Rail grades\" goes through it in full.",
          {
            list: [
              "Perfect: the reference plays your option within 5 percentage points of its most frequent one, or you lost no more than 0.1% of the pot.",
              "Good: the reference plays your option at least 3.5% of the time.",
              "Inaccurate: played less often than that, losing up to 2% of the pot.",
              "Mistake: losing up to 8% of the pot.",
              "Blunder: losing more than 8% of the pot.",
            ],
          },
          {
            checkpoint: {
              question:
                "The pot is 20 bb. The reference calls 70% of the time (EV 3.00 bb) and raises 30% (EV 2.90 bb). You raise. Which grade?",
              options: ["Perfect", "Good", "Inaccurate", "Mistake"],
              answer: 1,
              explain:
                "30% is more than 5 points below 70%, so it is not Perfect on frequency. The EV loss is 3.00 − 2.90 = 0.10 bb, which is 0.5% of the pot: more than 0.1%, so not Perfect on EV either. The reference does raise more than 3.5% of the time, so it is Good.",
              math: { fn: "ratio", args: [0.1, 20], value: 0.005 },
            },
          },
          {
            widget: { id: "grading" },
            caption: "Set the reference's frequencies and EVs, pick your option, and watch the grade and the score move. Try making the EVs nearly equal and see how little the frequencies then matter.",
          },
          {
            checkpoint: {
              question: "Same spot, but this time you fold. The reference never folds, and folding is worth 0. Which grade?",
              options: ["Inaccurate", "Mistake", "Blunder"],
              answer: 2,
              explain: "Calling was worth 3 bb, so folding gives all of it up: 3 / 20 = 15% of the pot, well past the 8% line. That is a Blunder.",
              math: { fn: "ratio", args: [3, 20], value: 0.15 },
            },
          },
        ],
      },
      {
        heading: "Study the spots you meet most",
        blocks: [
          "Every hand you play starts with a preflop decision, fewer reach the flop, and fewer still reach the river. So a small preflop leak repeats far more often than an exotic river one, and fixing it is worth more.",
          "Start with the spots that come up in every session: opening, defending the blinds, the first bet after the flop. Your reports show which of them cost you the most; the lessons on those come first.",
        ],
      },
      {
        heading: "Short, regular and mixed",
        blocks: [
          "Twenty focused minutes most days beats one long session a week. Memory holds what you return to after a gap, and short sessions keep the quality of your attention high.",
          "Mix your practice. Ten different spots in a row feel harder than ten copies of the same one, and that is exactly why they teach more: at the table you never know which spot comes next. Rail's drills deal varied spots for this reason.",
          "Stick to one format while you build the basics. Everything here is cash: 6-max and full ring, mostly at 100 big blinds, with deeper stacks and live games later in the course.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Learn, drill, play, review, repeat: one turn of the loop per lesson.",
        "Judge a decision by its EV loss, not by whether you won the hand.",
        "Fix the spots you meet every session before the rare ones.",
        "Short, regular sessions with mixed spots beat long blocks of one spot.",
      ],
      breaks: [
        "A grade compares you with a reference strategy, not with the best play against your actual opponent. A deliberate exploit can grade Inaccurate and still be right.",
        "Where Rail has no reference for a spot it does not grade it, so a clean report there means \"not measured\", not \"played well\".",
      ],
    },
    exercises: {
      "grade-quiz":
        "Six small option tables, each with the pot, the reference's frequency and EV for every option, and the option chosen. Name the grade Rail gives it, then see the EV loss worked out.",
      placement:
        "A short placement test is on its way: a handful of mixed questions that suggest where in the course to start. Until then, begin with pot odds, or wherever your reports point.",
    },
    checks: [{ fn: "sum", args: [3, -2.9], value: 0.1 }],
  },

  "gto-mixing-and-simplifying": {
    sections: [
      {
        heading: "What equilibrium promises",
        blocks: [
          "An equilibrium is a pair of strategies where neither player can gain by changing theirs. Play your half of it and no opponent can beat you: the best they can do is not lose. That is what people mean by GTO.",
          "It is not the same as the most profitable play against everyone. Against an opponent with a clear leak, a strategy that leans into the leak earns more, at the price of being exploitable itself.",
          {
            checkpoint: {
              question: "Your opponent bluffs the river far too often. Is the equilibrium strategy the most profitable answer?",
              options: ["Yes: it is the best play against anyone", "No: it cannot lose to him, but calling more would earn more"],
              answer: 1,
              explain:
                "Equilibrium guarantees you do not lose to any strategy. Against someone who over-bluffs, calling more often than equilibrium does wins more, as long as the read is right.",
            },
          },
        ],
      },
      {
        heading: "Why a solver mixes",
        blocks: [
          "If one action were clearly better with a hand, the solver would take it every time. It splits a hand between actions only when they are worth the same, or nearly the same. So a mix tells you something useful: the actions are close in EV.",
          "The classic case is a bluff-catcher on the river. When the pot is 10 bb and the bet is 7.5 bb, the bettor's equilibrium range bluffs 7.5 / (10 + 15) = 30% of the time. Calling then wins 17.5 bb 30% of the time and loses 7.5 bb the rest: 0.3 × 17.5 = 5.25 and 0.7 × 7.5 = 5.25. The call is worth exactly zero, the same as folding, so mixing costs nothing.",
          {
            widget: { id: "bluff-catcher", pot: 10, bet: 7.5, share: 0.3 },
            caption: "Move the bettor's bluff share off 30% and one action pulls clearly ahead. Only at the balance point are calling and folding worth the same.",
          },
        ],
      },
      {
        heading: "The grade measures EV, not frequency",
        blocks: [
          "Because mixed actions are close in EV, Rail does not punish you for taking the less frequent one. The grade follows how much EV your choice gave up, and frequency only decides between Perfect and Good when the loss is small.",
          {
            checkpoint: {
              question:
                "The pot is 25 bb. The reference bets 60% of the time (EV 4.10 bb) and checks 40% (EV 4.05 bb). You check. Which grade?",
              options: ["Perfect", "Good", "Inaccurate"],
              answer: 1,
              explain:
                "40% is more than 5 points below 60%, and the loss of 0.05 bb is 0.2% of the pot, a little over the 0.1% that counts as nothing. The reference checks well over 3.5% of the time, so the check is Good: a fine play, just not the main one.",
              math: { fn: "ratio", args: [0.05, 25], value: 0.002 },
            },
          },
          "Compare an option the reference plays only 2% of the time that gives up 1.5% of the pot: that is Inaccurate. One it never plays that gives up 5% of the pot is a Mistake. The bigger the EV gap, the worse the grade, whatever the frequencies say.",
          "If you always pick the 40% option, no single hand will grade badly. The pattern shows up in your reports instead, where it belongs.",
        ],
      },
      {
        heading: "Simplifying costs little when the EVs are close",
        blocks: [
          "Nobody can reproduce a solver's exact mixes at the table, and you do not need to. When two actions are close, picking one of them every time costs only the small gap, multiplied by how often you are in the spot.",
          {
            checkpoint: {
              question:
                "The reference bets and checks a hand about half the time each, and the two EVs are within 0.02 bb. You decide to always check it. Over 500 times in the spot, at most how much does that cost?",
              options: ["About 10 bb", "About 100 bb", "About 250 bb"],
              answer: 0,
              explain: "At most 0.02 bb each time: 0.02 × 500 = 10 bb over 500 hands in that spot. A simplification like that is nearly free.",
              math: { fn: "product", args: [0.02, 500], value: 10 },
            },
          },
          "The same logic tells you where not to simplify. When one option is far ahead, always taking the other is a real leak, and your grades will say so in every hand.",
        ],
      },
      {
        heading: "A baseline to exploit from",
        blocks: [
          "Treat equilibrium as your default against players you know nothing about: it cannot lose to anyone and it profits from every mistake they make. Deviate when you have a real read, and deviate in the direction of their leak.",
          "When you do, the grade tells you what the exploit costs if your read is wrong. A small cost for a big expected gain is a good trade; a large cost on a thin read is not.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "A mix means the actions are close in EV; taking the more frequent or the simpler one costs little.",
        "Judge a choice by its EV loss. Frequency only separates Perfect from Good.",
        "The cost of a simplification is the EV gap times how often you are in the spot.",
        "Start from equilibrium, and deviate only with a read, towards the opponent's leak.",
      ],
      breaks: [
        "A mix in a solver output can hide hands that are not close at all: check the EV of your exact hand, not the range's average.",
        "Against a player with a big, proven leak, equilibrium play leaves money on the table; that is when exploiting pays.",
      ],
    },
    exercises: {
      "close-calls":
        "Five option tables built around close decisions: two or three actions the reference plays, with EVs near each other. Name each choice's grade and notice how often the less-played option is still Good or Perfect.",
      "mixed-rivers":
        "Four river spots dealt towards the close decisions. Rail's solver grades your choice; when two actions are close in EV, either can come back Good or Perfect, and the option table shows how little separates them.",
    },
    checks: [
      { fn: "product", args: [2, 7.5], value: 15 },
      { fn: "bluffShare", args: [10, 7.5], value: 0.3 },
      { fn: "sum", args: [10, 7.5], value: 17.5 },
      { fn: "product", args: [0.3, 17.5], value: 5.25 },
      { fn: "product", args: [0.7, 7.5], value: 5.25 },
      { fn: "bluffCatcherEv", args: [10, 7.5, 0.3], value: 0, tolerance: 0.001 },
    ],
  },

  "reading-rail-reports": {
    sections: [
      {
        heading: "The overview: one number for how you play",
        blocks: [
          "The Analysis overview puts your whole sample on one screen: your score, your EV loss per 100 hands, how your moves split across the five grades, and coverage, meaning how many hands were fully analysed, partly analysed or not at all, and why.",
          "EV loss per 100 hands is the number to watch. It adds up the EV you gave away in every graded decision and scales it to 100 hands, so samples of different sizes compare fairly.",
          {
            formula: {
              name: "EV lost per 100 hands",
              expression: { frac: ["EV lost (bb) × 100", "hands"] },
              spoken: "EV lost per 100 hands equals the EV lost in big blinds, times 100, divided by the number of hands.",
            },
          },
          "Say you lost 36 bb of EV over 1,200 hands. That is 12 hundreds of hands, so 36 / 12 = 3 bb per 100.",
          {
            checkpoint: {
              question: "You lost 45 bb of EV over 3,000 hands. What is your EV loss per 100 hands?",
              options: ["0.15 bb", "1.5 bb", "15 bb"],
              answer: 1,
              explain: "3,000 hands is 30 hundreds, so 45 / 30 = 1.5 bb per 100.",
              math: { fn: "ratio", args: [45, 30], value: 1.5 },
            },
          },
        ],
      },
      {
        heading: "Breakdowns: where it goes",
        blocks: [
          "The breakdowns split the same numbers by street, position, pot type and preflop scenario, with the same filters as your stats: dates, stakes, room and game. They answer the first question worth asking: is the EV leaking preflop, on the flop, from one seat?",
        ],
      },
      {
        heading: "Leaks, ranked by what they cost",
        blocks: [
          "A leak is a situation plus one wrong turn in it: the street, the scenario and the seats, and an action that differs from the reference's best, or the right action at the wrong size. The leak finder ranks them by the total EV they lost, in big blinds.",
          "Total EV is the right order because it counts both how bad a mistake is and how often you make it. A small mistake in a spot you meet every session can cost more than a big one you made once.",
          {
            checkpoint: {
              question: "Leak A loses 0.4 bb each time and happened 50 times. Leak B was one 12 bb mistake. Which costs more?",
              options: ["Leak A", "Leak B", "They are about even"],
              answer: 0,
              explain: "Leak A has cost 0.4 × 50 = 20 bb, against 12 bb for leak B. It is also a habit, so it will keep costing until you fix it.",
              math: { fn: "product", args: [0.4, 50], value: 20 },
            },
          },
          "Frequency differences on their own are not leaks. If you take a mixed action more often than the reference but every one of those decisions graded Perfect, nothing was lost and the finder leaves it out. Leaks smaller than 0.05 bb in total are left out too.",
          {
            widget: { id: "grading" },
            caption: "Set two options close in EV, then move the frequencies: the grade barely changes. Widen the EV gap and it falls fast.",
          },
        ],
      },
      {
        heading: "How sure is the finder?",
        blocks: [
          "A leak built on three hands might be three unlucky spots, not a habit. So every leak carries a confidence level based on how many decisions you made in the spot and how many were mistakes.",
          {
            list: [
              "High confidence: at least 50 decisions in the spot and 5 mistakes.",
              "Medium confidence: at least 20 decisions and 2 mistakes.",
              "Low confidence: fewer than that. It could be a single hand; open the hands before you change anything.",
            ],
          },
          "Spots with very few decisions are merged into a broader group, such as the same scenario from other seats, so they can still say something. Trends that compare periods say \"too few to tell\" when there is not enough play to separate a change from chance.",
        ],
      },
      {
        heading: "From report to plan",
        blocks: [
          "The study plan takes the three costliest areas the sample can vouch for, of medium or high confidence. Only if there are fewer does it fill in with thinner ones, marked \"tentative\", with a note to review the hands first.",
          "Each area comes with concepts to read, a trainer session set to the spot, and hands to review. That closes the loop: the report tells you which lesson to take next.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Watch EV loss per 100 hands: it compares samples of any size.",
        "Work on leaks in order of total EV lost, not of how painful a hand felt.",
        "A frequency difference matters only when it costs EV.",
        "Open the hands behind a low-confidence leak before you change your game.",
      ],
      breaks: [
        "Spots the analysis does not cover are not in the totals, so a clean report can hide a leak Rail cannot measure yet.",
        "A leak ranked low because you rarely reach the spot can still matter once you play more of those spots, for example at a new stake or table size.",
      ],
    },
    exercises: {
      "per-100":
        "Five sums like the overview's: a number of hands and the EV lost over them. Give the EV lost per 100 hands; an answer within 3% of the exact figure counts.",
      "your-hands":
        "Your own costliest decisions, the worst first, replayed without the result. Decide what you would do before you see what you did.",
    },
    checks: [
      { fn: "ratio", args: [1200, 100], value: 12 },
      { fn: "ratio", args: [36, 12], value: 3 },
      { fn: "ratio", args: [3000, 100], value: 30 },
    ],
  },

  "variance-bankroll-and-tilt": {
    sections: [
      {
        heading: "Results are decisions plus luck",
        blocks: [
          "Every result mixes two things: the quality of your decisions and the cards that came. Over one session, the cards win easily. A good call can lose and a bad one can win, and how the hand ended says nothing about which it was.",
          {
            checkpoint: {
              question: "You call an all-in with more equity than the price asks for, and lose the hand. Was the call a mistake?",
              options: ["Yes: it lost", "No: it earned money on average", "Only if it happens again"],
              answer: 1,
              explain:
                "A call is judged by its EV at the moment you make it. With more equity than the price needs, it wins money on average; this time the runout went the other way.",
            },
          },
        ],
      },
      {
        heading: "All-in EV: the result you earned",
        blocks: [
          "When the money goes in before the river, you can measure what the decision earned instead of what the cards did. The EV of the call is your equity times the final pot, minus what you put in.",
          {
            formula: {
              name: "EV of calling an all-in",
              expression: ["equity × final pot − call"],
              spoken: "The EV of calling an all-in equals your equity times the final pot, minus the call.",
              where: [
                ["final pot", "everything in the middle after your call"],
                ["call", "what calling costs you"],
              ],
            },
          },
          "Say there is 10 bb in the middle and your opponent shoves 40 bb more, so the pot is 50 bb and the call is 40 bb. If you call, the final pot is 90 bb. With 50% equity the call is worth 0.5 × 90 − 40 = 45 − 40 = +5 bb, whether you win this particular hand or not. It needs 40 / 90, about 44.4%, to break even.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 50, bet: 40, share: 0.5 },
            caption: "The pot here includes the shove, and the call is what you put in. Slide your equity and watch the call's EV; this is the number an all-in is worth, before the cards run out.",
          },
          {
            checkpoint: {
              question: "There is 10 bb in the middle and your opponent shoves 20 bb. You have 45% equity. What is calling worth?",
              options: ["+2.5 bb", "−2.5 bb", "+22.5 bb"],
              answer: 0,
              explain: "The final pot is 10 + 20 + 20 = 50 bb. The call is worth 0.45 × 50 − 20 = 22.5 − 20 = +2.5 bb.",
              math: { fn: "callEv", args: [30, 20, 0.45], value: 2.5 },
            },
          },
          "Rail's stats graph has an all-in EV line: your results with every all-in runout paid at equity. When it sits well above your real results, you ran badly in those pots; the decisions were fine.",
        ],
      },
      {
        heading: "How long luck lasts",
        blocks: [
          "Results settle down slowly. A few thousand hands can swing a long way up or down for a player of any skill, and even much larger samples leave plenty of room for luck.",
          "Your EV loss per 100 hands settles much faster, because it does not depend on which cards came. It compares each decision with the alternatives in that same spot, and a hand usually holds several decisions. That makes it Rail's best signal of how well you are playing.",
        ],
      },
      {
        heading: "Bankroll and stop-loss: rules you set",
        blocks: [
          "Swings are normal, so decide in advance how you will handle them, while you are calm. These are personal rules, and only you can set the numbers.",
          {
            list: [
              "Keep the money you play with separate, and only use money you can afford to lose.",
              "Play stakes where a normal losing stretch does not change how you play. If a loss makes you play scared, the stake is too high for you right now.",
              "Pick a stop-loss for a session, in buy-ins or big blinds, and stop when you reach it, however the session feels.",
              "Decide when you move stakes up or down before the swing comes, not during it.",
            ],
          },
        ],
      },
      {
        heading: "Tilt shows in the numbers",
        blocks: [
          "Tilt is not just anger: it is your decisions getting worse after something goes wrong. That makes it measurable. Your progress page can split EV loss by session, and the sessions after a big losing hand are the ones to compare.",
          "If your EV loss per 100 jumps after big losses, that is the clearest case for a stop-loss rule. The cards are out of your control; how you play the next hand is not.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Judge a decision by its EV at the moment you made it, never by how the hand ended.",
        "The EV of calling an all-in is equity × final pot − call.",
        "EV loss per 100 hands is a faster, steadier signal of skill than results.",
        "Set your bankroll and stop-loss rules before a session, not during a swing.",
      ],
      breaks: [
        "All-in EV only removes luck from all-in pots; luck in hands that end in a fold or reach showdown without an all-in stays in your results.",
        "EV loss compares you with a reference, so a profitable exploit can raise it while your results improve.",
      ],
    },
    exercises: {
      "allin-ev":
        "Six all-in calls: the money already in the middle, the shove you face and your equity. Work out the EV of calling, equity × final pot − call, before the calculator shows it.",
      "your-hands":
        "Your own costliest decisions, replayed without the result. Judge each one on the decision alone, before you see how it ended.",
    },
    checks: [
      { fn: "sum", args: [10, 40], value: 50 },
      { fn: "sum", args: [50, 40], value: 90 },
      { fn: "product", args: [0.5, 90], value: 45 },
      { fn: "callEv", args: [50, 40, 0.5], value: 5 },
      { fn: "requiredEquity", args: [50, 40], value: 0.444 },
      { fn: "sum", args: [10, 20, 20], value: 50 },
      { fn: "product", args: [0.45, 50], value: 22.5 },
    ],
  },
};
