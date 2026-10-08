import type { LessonOutlines } from "./types";

/**
 * Every lesson's outline, English: one sentence for the map card and the
 * page's meta description (at most 155 characters), and three to five
 * learning goals, each starting with a verb. Same ids and the same number of
 * goals as `outline.hr.ts`. Plain concepts only: no chart or solver numbers.
 */
export const outlineEn: LessonOutlines = {
  // ---- Reference pages since L1.1 (`REFERENCE_IDS`): L1's M0 orientation
  "how-rail-teaches": {
    summary: "How Rail's study loop works (learn an idea, drill it, play, review your own hands) and what its grades and EV loss tell you.",
    goals: [
      "Follow the loop: learn an idea, drill it, play, then review your own hands.",
      "Read a grade and the EV loss behind it, and tell a close call from a real mistake.",
      "Plan short, mixed study sessions instead of long runs of one spot.",
      "Focus on one format at a time, starting with cash games.",
    ],
  },
  "gto-mixing-and-simplifying": {
    summary: "What an equilibrium strategy really is, why solvers split some hands between two actions, and when a simpler play costs you almost nothing.",
    goals: [
      "Explain equilibrium as a strategy nobody can beat, not as the best play against everyone.",
      "Explain why a hand that mixes earns nearly the same with each of its actions.",
      "Judge a decision by its EV loss, not by how often the reference picks it.",
      "Choose the simpler action when the EV difference is small.",
      "Treat equilibrium as the baseline that every exploit starts from.",
    ],
  },
  "reading-rail-reports": {
    summary: "How to read Rail's overview, breakdowns and leak list, and how to tell a leak that costs money from noise in a small sample.",
    goals: [
      "Find your way around the overview, the breakdowns, the reference comparison and the leaks.",
      "Express results in big blinds per 100 hands to compare sessions and spots fairly.",
      "Rank leaks by the big blinds they cost, not by how far a frequency is off.",
      "Tell a leak built on a thin sample from one you can trust.",
      "Open the hands behind your biggest leak and replay them.",
    ],
  },
  "variance-bankroll-and-tilt": {
    summary: "Why short-run results drift so far from skill, how all-in EV and sample size help you see through it, and simple bankroll and stop-loss rules.",
    goals: [
      "Judge a decision by its expected value, not by how the hand ended.",
      "Work out all-in EV and compare it with the money you actually won.",
      "Explain why a small sample says little about your real win rate.",
      "Set bankroll and stop-loss rules you will keep to.",
      "Recognise tilt as a rise in mistakes after big losses.",
    ],
  },

  // ---- Reference: L1's M1 poker maths
  "pot-odds": {
    summary: "How to work out what share of the final pot a call costs, and so how much equity the call needs to break even.",
    goals: [
      "Work out the required equity as the call divided by the pot after you call.",
      "Convert pot odds between a ratio and a percentage.",
      "Count the bet as part of the pot so you never misprice a call.",
      "Say when pot odds alone are not enough because more cards and bets are coming.",
    ],
  },
  "equity-and-outs": {
    summary: "How to count your outs, turn them into a quick equity estimate, and spot when that shortcut gives the wrong answer.",
    goals: [
      "Count clean outs and discount the ones that also help the opponent.",
      "Estimate equity from outs by multiplying by two or by four.",
      "Explain why the flop shortcut assumes you see two cards for one price.",
      "Use one-card equity when another bet is likely to come on the turn.",
      "Compare your estimate with the exact equity Rail computes.",
    ],
  },
  "expected-value": {
    summary: "What expected value means, how to compute it for a call or for a bet that can win the pot at once, and why folding is the zero point.",
    goals: [
      "Work out EV by weighting each outcome by its chance and adding them up.",
      "Treat folding as the zero baseline every other option is measured against.",
      "Compute the EV of a call and of a bet that can make the opponent fold.",
      "Explain why many profitable plays still lose more often than they win.",
      "Read Rail's EV loss as the gap between your choice and the best option.",
    ],
  },
  "combos-and-card-removal": {
    summary: "How many ways each hand can be dealt, how the board and your own cards remove some of them, and why that changes what an opponent holds.",
    goals: [
      "Count the combos of a pocket pair, a suited hand and an offsuit hand.",
      "Remove the combos the board and your own cards make impossible.",
      "Compare how many value combos and bluff combos a range holds.",
      "Explain how holding one card changes what the opponent can have.",
    ],
  },
  "bluffing-math-alpha-mdf": {
    summary: "How often a bluff must work for its size, how much of a range has to keep going against a bet, and where those two numbers stop applying.",
    goals: [
      "Work out how often a bluff of a given size has to succeed.",
      "Work out what share of a range must continue so a pure bluff cannot profit.",
      "Relate a bigger bet to more folds needed by the bettor and fewer calls needed by the defender.",
      "Explain why both numbers are only guides before the river and against players who rarely bluff.",
    ],
  },
  "equity-realisation-and-implied-odds": {
    summary: "Why the same equity is worth more in position and with playable hands, and when money you can win later justifies calling now.",
    goals: [
      "Explain how position, suits and connectedness change the equity a hand actually realises.",
      "Tell implied odds from reverse implied odds.",
      "Judge when deep stacks and a well-hidden hand make a call worth it.",
      "Choose big blind defends against a button open by playability, not by raw equity.",
    ],
  },

  // ---- Reference: L1's M2 ranges
  "thinking-in-ranges": {
    summary: "How to stop guessing one hand and picture every hand an opponent could hold, starting from the 13×13 grid and the preflop action.",
    goals: [
      "Read the 13×13 hand grid and find any hand class on it.",
      "Build a likely preflop range from a player's seat and action.",
      "Explain how each action removes some hands from a range.",
      "Widen and reshape a range for players who play looser or less logically.",
    ],
  },
  "range-advantage": {
    summary: "Whose whole range does better on a given flop, why the preflop raiser often holds that edge, and how it shapes how often each player bets.",
    goals: [
      "Define range advantage as one whole range's equity against the other.",
      "Explain why the preflop raiser usually holds more high cards and big pairs.",
      "Predict which player a flop favours from the two preflop lines.",
      "Link range advantage to how often a player can bet.",
    ],
  },
  "nut-advantage": {
    summary: "Who holds more of the very strongest hands on a board, how that differs from range advantage, and why it decides how big to bet.",
    goals: [
      "Tell nut advantage apart from range advantage.",
      "Work out which range holds more sets, straights and other top hands on a board.",
      "Link a nut advantage to big bets and overbets.",
      "Explain why an even share of the nuts points to smaller bets.",
    ],
  },
  "board-texture": {
    summary: "How to describe a flop (high or low, paired, suited, connected) and judge how much the turn and river can change who is ahead.",
    goals: [
      "Classify flops by height, pairing, suits and connectedness.",
      "Tell a static board from a dynamic one.",
      "Predict how much later cards can change who leads on a board.",
      "Relate static boards to small bets, and dynamic boards to bigger bets or checks.",
    ],
  },
  "who-the-next-card-helps": {
    summary: "Which turn and river cards help the preflop raiser and which help the caller, and what to do when a card suits your range but not your hand.",
    goals: [
      "Tell which turn cards favour the preflop raiser and which favour the caller.",
      "Explain how one card can move both range advantage and nut advantage.",
      "Keep betting on cards that help your range and slow down on cards that do not.",
      "Decide whether to play your range or your hand by the kind of opponent you face.",
    ],
  },
  "range-narrowing": {
    summary: "How to cut an opponent's range down street by street from each action, so you reach the river with a short list of possible hands.",
    goals: [
      "Remove hands from a range after each action: a call, a check, a bet.",
      "Ask on every street which hands would have raised, folded or bet instead.",
      "Reach the river with a short list of value hands and bluffs.",
      "Use the narrowed range to decide your river calls.",
    ],
  },

  // ---- Lessons. The map's order is `LESSON_IDS`; this file is grouped by L1's modules.
  // ---- M3 preflop
  "positions-and-opening-ranges": {
    summary: "The name of every seat at a 6-max and a 9-max table, and why opening ranges get wider the closer you sit to the button.",
    goals: [
      "Name every seat at a 6-max and a 9-max table.",
      "Explain why opens widen as fewer players are left to act behind you.",
      "Compare the early seats of a full-ring table with UTG at 6-max.",
      "Choose opens by seat from Rail's 6-max and 9-max charts.",
    ],
  },
  "open-sizing": {
    summary: "What the size of your open changes (the blinds' price, who calls, the SPR) and how to adjust it for limpers, antes and live games.",
    goals: [
      "Explain how open size changes the blinds' price, the calling ranges and the SPR.",
      "Work out how often a steal has to work at a given size.",
      "Add to your open for each player who has already limped.",
      "Adjust your size for antes, straddles and looser live tables.",
    ],
  },
  "facing-an-open": {
    summary: "How to choose between calling, 3-betting and folding when a player opens before you, depending on your seat and the rake.",
    goals: [
      "Choose between a call and a 3-bet based on your position.",
      "Explain why the small blind leans towards 3-bet or fold.",
      "Avoid calling with hands the opener's range dominates.",
      "Account for the rake before you flat an open.",
    ],
  },
  "three-betting": {
    summary: "How to build a 3-bet range, linear or polarised, which hands make good 3-bet bluffs, and how big to 3-bet in and out of position.",
    goals: [
      "Tell a linear 3-bet range from a polarised one and pick the right shape for the spot.",
      "Choose 3-bet bluffs that block strong hands and still play well when called.",
      "Size 3-bets bigger out of position and against bigger opens.",
      "Spot the hands that want to 3-bet rather than call.",
    ],
  },
  "facing-3bets-and-4bets": {
    summary: "How to respond when your open is 3-bet or your 3-bet is 4-bet: when to call, when to raise again and when to let the hand go.",
    goals: [
      "Defend against a 3-bet with a range that depends on your position.",
      "Decide when to 4-bet for value and when to 4-bet as a bluff.",
      "Choose which hands call a 4-bet and which fold or go all-in.",
      "Fold more to the value-heavy 4-bets common at low stakes and in live games.",
    ],
  },
  "blind-play-and-bvb": {
    summary: "How the big blind's discount lets it defend wide, why the small blind mostly raises or folds, and how blind-versus-blind pots play.",
    goals: [
      "Defend the big blind according to the price you are getting.",
      "Explain why the small blind prefers raising to calling.",
      "Play blind versus blind from both seats.",
      "Adjust when both blinds are the same size and the discount disappears.",
    ],
  },
  "squeezes-and-multiway-preflop": {
    summary: "When an open and a call in front of you make a squeeze profitable, how big to squeeze, and when an overcall is the better choice.",
    goals: [
      "Spot squeeze chances from the dead money and a capped caller.",
      "Size a squeeze up for each player already in the pot.",
      "Choose squeeze hands that block strong ranges or play well when called.",
      "Overcall instead with suited hands and pairs that do well in multiway pots.",
    ],
  },
  "limpers-and-isolation": {
    summary: "How to play against limpers: when to raise to isolate, how big to go, when limping behind is fine, and how the big blind plays limped pots.",
    goals: [
      "Isolate weak limpers with a raise that grows for each limper.",
      "Choose a size that is likely to get the pot heads-up.",
      "Decide when limping behind beats both raising and folding.",
      "Play the big blind's option and limped pots after the flop.",
    ],
  },
  "preflop-by-stack-depth": {
    summary: "How opening, 3-betting and calling change from 40 to 200 big blinds deep, read from Rail's own chart set at each depth.",
    goals: [
      "Explain why short stacks open tighter and answer a 3-bet more often with all-in or fold.",
      "Name the hands that gain value as stacks get deeper, and the ones that lose it.",
      "Adjust a call facing a 3-bet to the stack left behind.",
      "Pick the chart set that matches the stack you actually have.",
    ],
  },

  // ---- M4 single-raised pots as the preflop raiser
  "cbet-why-and-when": {
    summary: "Why the preflop raiser bets the flop so often, and how range and nut advantage decide between a small bet, a big bet and a check.",
    goals: [
      "Explain why the raiser's range is usually the stronger one on the flop.",
      "Choose between a small bet with the whole range, a big polarised bet and a check.",
      "Explain why checking is not a loss in itself.",
      "Link how often and how big you c-bet to range and nut advantage.",
    ],
  },
  "cbet-by-texture": {
    summary: "How flop texture shapes the raiser's plan: where to bet small and often, where to bet big or check, and why ace-high boards are a case apart.",
    goals: [
      "Bet small and often on high, dry and paired flops.",
      "Check more and bet bigger on middling, connected flops.",
      "Play monotone flops with small bets and more checks.",
      "Explain why protection matters little on static boards and a lot on dynamic ones.",
      "Read [[range-advantage|range advantage]] (whose whole range is ahead on this flop) and [[nut-advantage|nut advantage]] (who holds more of the strongest hands): the first sets how often you bet, the second how big.",
    ],
  },
  "hand-classes-on-the-flop": {
    summary: "How to sort your hands on the flop into value, thin value and protection, draws and air, and which of those bet and which check.",
    goals: [
      "Name a hand's class on a flop: value, thin value, draw or air.",
      "Bet strong hands to build the pot, and draws for fold equity plus equity.",
      "Check medium hands that fear a check-raise.",
      "Decide when air bets, when it gives up and when it waits for the turn.",
    ],
  },
  "oop-as-the-raiser": {
    summary: "Why the preflop raiser bets less often out of position, and how to keep its checking range strong enough to defend itself.",
    goals: [
      "Explain why a raiser out of position realises less equity and bets less.",
      "Keep some strong hands in your checking range.",
      "Bet a more polarised range when you do bet out of position.",
      "Apply this to the small blind against the big blind and to early seats against a button caller.",
    ],
  },
  "checking-back-and-delayed-cbets": {
    summary: "When checking back the flop beats betting, how to bet the turn after that check, and when slowplaying a strong hand makes sense.",
    goals: [
      "Choose the hands that do better checking back the flop.",
      "Bet the turn when the caller checks again and shows a capped range.",
      "Slowplay only when the board is static and the opponent's range is weak.",
      "Bet strong hands fast against passive opponents.",
    ],
  },
  "facing-a-check-raise": {
    summary: "How to respond when your flop c-bet is check-raised: how much of your range continues, which hands to keep, and when to fold more.",
    goals: [
      "Continue with enough of your range that check-raises do not win automatically.",
      "Prefer draws and hands with equity over thin made hands when you continue.",
      "Treat minimum defence as a soft guide, not a rule.",
      "Fold more against players who check-raise only with strong hands.",
    ],
  },

  // ---- M5 single-raised pots as the caller
  "defending-vs-cbets": {
    summary: "How to defend against a flop c-bet as the caller: how wide to go against small and big bets, and which hands fold, call or raise.",
    goals: [
      "Defend wider against small c-bets and tighter against big ones.",
      "Keep hands with backdoor draws and fold hands with no equity.",
      "Choose fold, call or raise by hand class.",
      "Check a call against both the price and the equity your hand will realise.",
      "Work out [[bluffing-math-alpha-mdf|alpha and MDF]] for the bet you face: alpha, bet ÷ (pot + bet), is how often a pure bluff must work, and MDF, 1 − alpha, is how much of your range must continue.",
    ],
  },
  "check-raising": {
    summary: "How to build a flop check-raise range from strong hands and good draws, and how to recognise the boards that suit it.",
    goals: [
      "Build a check-raise range of strong value hands and good draws.",
      "Find the boards where the caller holds more sets and two pairs.",
      "Use draws as raises because they keep equity when called.",
      "Check-raise more often against small c-bets.",
    ],
  },
  "floating-and-stabbing-ip": {
    summary: "How to call a c-bet in position with hands that can win later, and how to bet when the raiser checks to you.",
    goals: [
      "Call in position with hands that can improve or take the pot later.",
      "Explain why a check from the raiser caps their range.",
      "Bet small with a wide range when the raiser checks to you.",
      "Keep strong hands among your stabs so they are hard to attack.",
    ],
  },
  "probes-and-donk-bets": {
    summary: "When the caller should bet first into the preflop raiser: on cards that move the strongest hands its way, or after the raiser checks back.",
    goals: [
      "Lead on cards that hit your range much harder than the raiser's.",
      "Bet the turn after the raiser checks back the flop and caps their range.",
      "Pick the hands that gain from leading rather than checking.",
      "Explain why leading on flops the raiser hits well rarely pays.",
    ],
  },
  "facing-turn-barrels": {
    summary: "How to decide which hands keep calling when the raiser bets the turn again, using bet size, draws and how capped their range is.",
    goals: [
      "Fold more as the turn bet gets bigger.",
      "Prefer calls with extra draws and chances to make two pair.",
      "Explain how a capped range turns low pairs into calls.",
      "Choose calls by how the hand plays on the river, not only by the pair it holds.",
    ],
  },
  "turn-check-raise-and-probe": {
    summary: "How the caller attacks the turn out of position: leading after a checked flop, and check-raising a second barrel.",
    goals: [
      "Lead the turn when the card favours your range and the raiser checked the flop.",
      "Build a turn check-raise from strong hands and draws that improved.",
      "Choose between check-call, check-raise and a lead by hand class.",
      "Size a turn lead for the stacks left behind.",
    ],
  },
  "bb-vs-btn-blueprint": {
    summary: "The most common single-raised pot, big blind against a button open, played from flop to river with everything from the two modules before.",
    goals: [
      "Plan a big blind defence against a button open from the flop to the river.",
      "Combine the raiser's and the caller's ideas in one hand.",
      "Handle mixed turn and river decisions in a single practice session.",
      "Find and replay your own big blind versus button hands.",
    ],
  },

  // ---- M6 3-bet and 4-bet pots
  "spr-and-commitment": {
    summary: "What the stack-to-pot ratio is, how to work it out, and how it decides which hands are ready to put all their chips in.",
    goals: [
      "Work out the SPR on the flop from the pot and the stacks.",
      "Name the hands that play for stacks at a low SPR.",
      "Explain how dangerous boards and deeper stacks weaken one-pair hands.",
      "Compare how a 3-bet pot plays at 100bb and at 200bb.",
      "Avoid folding after most of your stack is already in.",
    ],
  },
  "cbetting-as-the-3bettor": {
    summary: "How the 3-bettor bets the flop in and out of position, and how a low SPR changes which hands bet and how big.",
    goals: [
      "Bet small and often in position on high, paired and ace-high flops.",
      "Take more care on middling, connected flops.",
      "Check more out of position, especially on low boards.",
      "Explain why big pairs act like very strong hands at a low SPR.",
      "Bet bigger with strong hands that are vulnerable.",
    ],
  },
  "playing-3bp-as-the-caller": {
    summary: "How to play a 3-bet pot as the caller: defending against small c-bets, check-raising low connected boards and catching bluffs.",
    goals: [
      "Explain why the caller's range is packed with middling pairs and suited hands.",
      "Defend against small c-bets with enough of your range.",
      "Check-raise on low, connected boards the 3-bettor misses.",
      "Catch bluffs on the river against capped lines.",
    ],
  },
  "range-splitting-ip-vs-checks-3bp": {
    summary: "How to split your range in position into a small bet, a big bet and a check after the player out of position checks a 3-bet pot.",
    goals: [
      "Split an in-position range into small bets, big bets and checks after a check in a 3-bet pot.",
      "Make the split both as the 3-bettor and as the caller facing the 3-bettor's check.",
      "Predict how the split moves with board texture.",
      "Predict how the split moves with deeper stacks and a higher SPR.",
      "Explain what each option is for: value, denial, fold equity, pot control or protection.",
    ],
  },
  "3bp-turn": {
    summary: "How the turn plays in a 3-bet pot with little behind: barrel or give up, and size so the stacks go in by the river.",
    goals: [
      "Decide on the turn whether to barrel or give up, knowing it usually settles the stacks.",
      "Size the turn so a river all-in is the natural next bet.",
      "Recognise turn cards that shift the advantage between the 3-bettor and the caller.",
      "Defend the turn as the caller without folding too much of your range.",
    ],
  },
  "3bp-river": {
    summary: "How the river plays in a 3-bet pot: polarised all-ins, picking real bluffs, and calling down against ranges with too few.",
    goals: [
      "Bet the river all-in with a polarised range of value hands and real bluffs.",
      "Pick bluffs by the cards you hold when the stack is the only size left.",
      "Catch bluffs against ranges that can no longer hold the strongest hands.",
      "Fold to river all-ins that hold too few bluffs.",
    ],
  },
  "four-bet-pots": {
    summary: "How 4-bet pots play with very little behind: small c-bets, all-in-or-fold choices, and which hands can call a 4-bet.",
    goals: [
      "Work out the SPR in a 4-bet pot.",
      "Choose between a small c-bet, an all-in and a fold.",
      "Choose the hands that can call a 4-bet and play well after the flop.",
      "Explain why equity and commitment matter more than position here.",
    ],
  },

  // ---- M7 the turn
  "turn-card-classes": {
    summary: "How to sort turn cards into overcards, cards that complete draws, pairing cards and blanks, and say which player each one helps.",
    goals: [
      "Classify a turn card as an overcard, a draw completer, a pairing card or a blank.",
      "Say which player a turn card helps, given the action so far.",
      "Explain why the board grows more stable and pot control matters more.",
      "Track how a turn card changes range and nut advantage.",
    ],
  },
  "double-barreling": {
    summary: "When to bet the turn again as the preflop raiser: which value hands and bluffs keep betting, and when to give up.",
    goals: [
      "Bet the turn again with value and with bluffs that have equity when the card helps you.",
      "Choose second-barrel bluffs that can improve or that block the caller's best hands.",
      "Give up on turn cards that help the caller.",
      "Plan the river before you bet the turn.",
    ],
  },
  "turn-sizing-and-overbets": {
    summary: "How big to bet on the turn, when an overbet is right, and which medium hands should check instead.",
    goals: [
      "Overbet when you hold the nut advantage and the opponent's range is capped.",
      "Choose overbet bluffs that block the calling hands and leave the folding hands alone.",
      "Check medium hands to keep the pot under control.",
      "Match the turn size to the shape of your betting range.",
    ],
  },
  "turn-after-flop-checks-through": {
    summary: "How to play the turn after both players checked the flop: leading out of position, betting in position, and defending against both.",
    goals: [
      "Explain how a checked flop caps both ranges in different ways.",
      "Lead the turn out of position when the card favours your range.",
      "Bet the turn in position after the flop checks through.",
      "Defend sensibly against turn leads and delayed bets.",
    ],
  },

  // ---- M8 the river
  "river-polarisation": {
    summary: "Why river betting ranges split into strong hands and bluffs, and how often a value bet must win when it gets called.",
    goals: [
      "Explain why a value bet must win more than half the time when called.",
      "Explain why river ranges split into strong hands and bluffs.",
      "Check the middle hands that neither win calls nor make better hands fold.",
      "Find river spots where betting beats checking.",
    ],
  },
  "thin-value": {
    summary: "How to bet modest hands for value on the river, how small to bet them, and how to tell when a bet has become too thin.",
    goals: [
      "Find river bets that beat enough of the hands that call.",
      "Size thin value bets small.",
      "Recognise when the risk of a raise turns a thin bet into a losing one.",
      "Bet thinner against passive players and less thin against frequent raisers.",
      "Stop checking back strong hands that should bet.",
    ],
  },
  "choosing-bluffs-blockers": {
    summary: "How to choose river bluffs by the cards you hold: block the hands that call and leave alone the hands that fold.",
    goals: [
      "Choose bluffs that hold cards from the opponent's calling hands.",
      "Avoid bluffs that hold cards from the opponent's folding hands.",
      "Explain why a missed flush draw can be a weaker bluff than it looks.",
      "Decide which missed draws bet and which give up.",
      "Count [[combos-and-card-removal|combinations and card removal]]: a pair has 6 combos, a suited hand 4, an offsuit hand 12, and every card you hold removes the combos that need it.",
    ],
  },
  "bluff-catching": {
    summary: "How to decide whether to call a river bet with a hand that only beats bluffs, by counting value, bluffs and the cards you hold.",
    goals: [
      "Count the opponent's value hands and bluffs for the line they took.",
      "Check how your own cards change those counts.",
      "Use minimum defence as a starting point, not a rule.",
      "Fold more against big river bets from players who rarely bluff.",
      "Apply the same method in single-raised, 3-bet and limped pots.",
    ],
  },
  "river-sizing": {
    summary: "How to pick a river bet size from your range's shape: small with thin value, big or an overbet with the nuts and bluffs.",
    goals: [
      "Bet small when your range holds many thin value hands.",
      "Bet big or overbet when you hold the nut advantage and enough bluffs.",
      "Explain why the nuts sometimes bet small.",
      "Match the size to the hands you want to be called by.",
    ],
  },
  "facing-river-raises": {
    summary: "How to respond to a raise or a lead on the river, and why most players raise the river with strong hands far more than with bluffs.",
    goals: [
      "Read a river raise as usually strong, especially in live games.",
      "Decide which hands can still call a river raise.",
      "Raise or call more against wide river leads after the turn checks through.",
      "Tell where folding exploits the pool and where it gives up too much.",
    ],
  },

  // ---- M9 multiway
  "multiway-principles": {
    summary: "What changes when three or more players see the flop: the job of defending is shared, bluffs work less and strong hands count for more.",
    goals: [
      "Explain why each extra opponent makes a strong hand out there more likely.",
      "Share the job of defending with the other players still in the hand.",
      "Bet tighter and smaller, and bluff less often.",
      "Prefer hands that can make the nuts over dominated draws.",
      "Avoid slowplays that let several opponents catch up.",
    ],
  },
  "multiway-as-the-raiser": {
    summary: "How the preflop raiser bets the flop into two or more opponents: which boards and hands to bet, and how big.",
    goals: [
      "Bet strong hands and strong draws into several players.",
      "Check most medium-strength hands.",
      "Bet smaller than you would heads-up.",
      "Adjust the plan to how wide or tight the callers' ranges are.",
    ],
  },
  "multiway-defence": {
    summary: "How to defend against a bet when other players are still to act behind you, and when to lead into the field yourself.",
    goals: [
      "Defend tighter when players behind you can still raise.",
      "Call wider as the last player to act.",
      "Split the job of defending with the other players in the pot.",
      "Lead into the field when the board favours your range.",
    ],
  },
  "multiway-preflop-choices": {
    summary: "Which preflop choices keep a pot heads-up and which invite more players in, and the hands that suit each.",
    goals: [
      "Choose between squeezing, isolating and calling to steer how many players see the flop.",
      "Overcall with suited hands and pairs that play well multiway.",
      "Avoid multiway pots with offsuit broadway hands.",
      "Recognise how limps and straddles create multiway pots.",
    ],
  },

  // ---- M10 live cash, deep stacks, straddles, exploits
  "live-game-dynamics": {
    summary: "How live cash differs from online: bigger sizes, deep and uneven stacks, rake, fewer hands an hour, keeping track of the pot, and showing bluffs.",
    goals: [
      "Adjust to bigger live opens and to deep, uneven stacks.",
      "Account for the rake and the slower pace when you choose your spots.",
      "Keep track of the pot in chips on every street.",
      "Decide when, if ever, to show a bluff.",
    ],
  },
  "straddle-preflop": {
    summary: "How a straddle changes the pot, the positions and every preflop range, from the opens to the blinds and the straddler's own defence.",
    goals: [
      "Explain how a straddle changes the pot size and who acts last before the flop.",
      "Adjust opening and 3-bet ranges seat by seat in a straddled game.",
      "Play the small blind tighter and defend the straddle like a deeper big blind.",
      "Expect more multiway pots when there is a straddle.",
    ],
  },
  "straddle-postflop-low-spr": {
    summary: "How the bigger preflop pots of straddled games lower the SPR, and what that means for commitment, draws and multiway play.",
    goals: [
      "Work out the SPR in a straddled pot.",
      "Commit with top pair and overpairs more often at a lower SPR.",
      "Explain why draws lose implied odds when the stacks are short next to the pot.",
      "Plan multiway straddled pots with commitment in mind.",
    ],
  },
  "deep-stacks-200bb": {
    summary: "How play changes at 200 big blinds: which hands gain or lose before the flop, bigger bets after it, and why one pair is worth less.",
    goals: [
      "Open and defend more suited, connected hands and fewer offsuit broadway hands when deep.",
      "Explain why nut potential and implied odds matter more with deep stacks.",
      "Value one-pair hands less at a higher SPR.",
      "Use bigger sizes so plans over several streets still get the stacks in.",
    ],
  },
  "population-exploits": {
    summary: "How to start from a balanced strategy, spot what the player pool does too much or too little, and adjust without opening new leaks.",
    goals: [
      "Start from the equilibrium baseline before you adjust anything.",
      "Spot where players bet, call or bluff too much or too little.",
      "Apply common low-stakes counters, such as folding more to big river bets.",
      "Follow an adjustment through the later streets so it does not become a leak.",
    ],
  },
  "player-profiles": {
    summary: "How to recognise calling stations, nits, maniacs and solid regulars from their stats, and the main adjustment against each of them.",
    goals: [
      "Recognise calling stations, nits, maniacs, TAGs and LAGs from their stats.",
      "Value bet more and bluff less against calling stations.",
      "Steal more from nits and respect their aggression.",
      "Call down wider and trap more against maniacs.",
      "Stay close to the baseline against solid regulars.",
    ],
  },
  "reading-hud-stats": {
    summary: "What the numbers in Rail's opponents panel count, and how many hands each needs before it tells you anything.",
    goals: [
      "Read each stat in the opponents panel and the situations it counts.",
      "Explain why a frequency over a few hands is mostly noise.",
      "Tell a stat that settles quickly from one that needs hundreds of chances.",
      "Turn a stat with enough sample behind it into one concrete adjustment.",
    ],
  },
  "exploiting-overfolders": {
    summary: "How to win more against players who fold too often: bluff more, bet smaller, and know which spots their folds come from.",
    goals: [
      "Spot a player who folds more than the bet size allows, from your own data.",
      "Add bluffs where the extra folds come from, and keep your value bets as they are.",
      "Use smaller bets when a small bet already gets the fold.",
      "Name the risk: what you lose if they stop folding.",
    ],
  },
  "exploiting-calling-stations": {
    summary: "How to play against players who call too much: bet thinner for value, bluff less, and size up with strong hands.",
    goals: [
      "Recognise a player who calls more often than the price justifies.",
      "Value-bet thinner hands that would check against a balanced opponent.",
      "Cut bluffs, above all on the river.",
      "Bet bigger with strong hands when the calls come anyway.",
    ],
  },
  "exploiting-aggressive-players": {
    summary: "How to face players who bet and raise too often: call down wider, check strong hands more, and let them bluff.",
    goals: [
      "Recognise aggression that runs ahead of the hands behind it.",
      "Widen your bluff-catching range against frequent barrels.",
      "Check strong hands more often so the opponent keeps betting.",
      "Avoid thin bets that only get raised off your equity.",
    ],
  },
  "underbluffed-rivers": {
    summary: "Where river bets hold too few bluffs and how to fold more there, judged from your own hands and their sample sizes.",
    goals: [
      "Explain why some river lines hold fewer bluffs than the bet size needs.",
      "Fold more bluff-catchers where your own data shows few bluffs.",
      "Check the sample behind a river read before acting on it.",
      "Keep calling where a line still holds enough bluffs.",
    ],
  },
  "node-locking-in-rail": {
    summary: "Lock an opponent's frequency at one decision, re-solve, and see the best response: what it gains and what it risks.",
    goals: [
      "Lock an opponent's strategy at one decision in Rail's solver.",
      "Read the best response against the locked strategy.",
      "Compare what the exploit gains with what it loses if the read is wrong.",
      "Choose locks that match what your own data shows.",
    ],
  },
  "when-not-to-exploit": {
    summary: "When to stay close to the baseline strategy: thin samples, opponents who adjust back, and reads that cost a lot if wrong.",
    goals: [
      "Judge whether a sample is big enough to act on.",
      "Recognise opponents who adjust and exploit you back.",
      "Weigh what an exploit gains against the cost of being wrong.",
      "Fall back to the baseline when the read is unclear.",
    ],
  },
};
