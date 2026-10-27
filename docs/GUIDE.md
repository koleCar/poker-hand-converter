# Rail user guide

How each part of Rail works for a player: what you see, what you do, what
each number means, and where the limits are. For how the code works, see the
developer READMEs listed in the [root README](../README.md#11-documentation-index).

> Rail is in **early access**. Every feature is open to every account and no
> limit applies until paid plans are switched on; where a feature will become
> part of the paid plan, this guide says so.

---

## What Rail is

Rail is a poker tracker. It reads the hand histories your poker room writes,
turns every hand into one exact record, and builds everything else on that
record:

- a **web app** (in any browser) to convert hand histories, keep a private
  library of your hands, replay them, read your statistics, study your
  opponents, analyse your decisions, take a course, and discuss hands on a
  forum;
- a **desktop app** for macOS and Windows that imports your hands by itself
  while you play, keeps them on your computer, syncs them to the same account,
  and draws a **HUD** (heads-up display) of your opponents' statistics over
  your tables at rooms that allow one.

Two principles show up all through this guide:

- **Refuse when unsure.** A hand Rail cannot read exactly is refused, with the
  reason, and shown to you. It is never guessed at, because one wrong hand
  quietly spoils your statistics.
- **Room rules come first.** Rail never helps you during play, and the HUD
  only appears at rooms whose rules allow it.

The web app is at **https://poker-hand-converter.vercel.app**.

## Contents

1. [Getting started](#getting-started) - account, sign in, plans
2. [Convert](#convert) - upload and convert hand histories, manual entry, refused hands
3. [Library](#library) - browse, filter, search, saved filters
4. [Replayer](#replayer) - the hand page, share links, embeds
5. [Stats](#stats) - statistics, reports, all-in EV
6. [Players](#players) - opponent profiles and notes
7. [Analysis](#analysis) - session review, leaks, charts, training, plan, progress, reports
8. [Learn](#learn) - course, placement test, reference, review
9. [Community](#community) - forum, published hands, profiles, notifications, moderation
10. [Account](#account) - settings, data export, account deletion, billing
11. [Desktop setup](#desktop-setup) - install, sign in, folders, import, sync
12. [Desktop app](#desktop-app) - the desktop screens day to day
13. [HUD](#hud) - the HUD on your tables, panels, popups, room rules

---

## Getting started

> Tutorial video: _coming soon_ (id: `getting-started`)

**Without an account** you can convert hand histories, preview them, download
the converted text and replay any hand. Nothing you drop leaves your browser.

**With an account** you also get a library: the hands you save are yours, and
nobody else can read them. Statistics, players, analysis, the forum, sharing
and the desktop app's sync all need an account.

### Creating an account and signing in

1. Choose **Sign in** in the top bar, then **Create an account**.
2. Enter your email and a password (at least six characters) and complete the
   robot check.
3. Open the confirmation link Rail emails you, then sign in.

Google sign-in appears as **Continue with Google** where it is enabled.
**Forgot your password?** sends a reset link. Signing in keeps you signed in
in that browser until you sign out.

Your account gets a provisional public username at signup; you can choose your
own in [Settings](#account). The first change is free.

### Plans

Rail has two plans, **Free** and **Pro**. While Rail is in early access the
plan panel says so ("every feature is open to every account, and no limit
applies"), and nothing on this page is locked.

| | Free | Pro |
| --- | --- | --- |
| Converter, replayer, sharing | yes | yes |
| Library | up to a hand limit (10 000 hands today) | unlimited |
| Basic statistics (summary, every statistic, the graph) | yes | yes |
| Full reports (situations, sessions, opponents, the Players screen) | - | yes |
| Analysis (session review, leaks, your own charts, training) | - | yes |
| Learn | - | yes |
| Desktop sync and the HUD | - | yes |

When paid plans are switched on, a Pro screen opened on Free shows **This is
a Pro feature** with **Upgrade to Pro** in place of the screen. Accounts
created before the launch are **early users** and keep a lifetime discount
(30 % by default) on Pro for as long as they stay subscribed. Subscribing is
described under [Account](#account).

### Language

Rail is in English and Croatian. Pick the language in Settings; the browser
remembers it. Addresses do not change with the language.

---

## Convert

> Tutorial video: _coming soon_ (id: `convert`)

The converter (**Upload hand** in the top bar, `/convert`) turns hand-history
files from almost any poker room into one standard text that Holdem Manager
and PokerTracker import, and into hands you can replay and save.

### Converting files

1. Drop files, a whole export folder or a zip anywhere on the page, or use
   **Choose files** / **Choose a folder**. To try one hand, paste it into
   **Paste a hand here**.
2. Conversion starts at once and runs in your browser tab. A progress line
   shows hands converted, files and bytes read; **Stop** cancels.
3. The results list each file with the rooms detected, its hands and
   **Download** for that file; **Download all** gives one combined file.
   **Preview** or **Replay** opens any converted hand.

What the converter promises: **nothing is uploaded** unless you choose to save.
Your files are read, detected and converted inside the tab.

Limits:

- A single file or zip entry over 100 MB is skipped (hand histories are not
  that big). An archive itself has no size limit.
- Screenshots and other files that are not hand histories are left out and
  counted under the results.
- Encrypted zip entries are not supported.
- The tab keeps the first 20 000 hands of a drop for the list, previews and
  downloads. Past that the counts keep growing, the hands can still be saved,
  and downloads are off for that drop.

### Saving to your library

Signed in, **Save to my library** (on by default; the browser remembers your
choice) saves hands while they convert. The line under the progress shows how many were saved, how many were
already in your library, and how many the server refused.

- Saving the same files again adds nothing: duplicates are recognised.
- **Also keep the original files** (off by default, on each visit) stores the
  original files, compressed and private to your account. Off, only the
  converted hands are saved.
- Signed out, the converter keeps the finished run in the tab and offers
  **Sign in and save** (up to 20 000 hands; a bigger drop asks you to sign in
  and drop it again).
- If the connection drops, saving retries by itself. If the tab closes or the
  daily upload budget runs out, **drop the same files or folder again** later:
  Rail remembers which files were saved and skips them. The page offers this
  when it opens ("An upload from ... did not finish").
- On the Free plan (once enforced), the converter warns when your library is
  nearly full and stops saving at the limit; every hand that fit is saved.

While a save runs, your other tabs and devices show its progress in a strip at
the top of the library screens.

### Rooms and games

Rail reads hand histories from PokerStars, GGPoker, Winamax, 888poker,
partypoker, the iPoker network, ACR / Winning Poker Network, Ignition (also
Bodog and Bovada), the Chico network, Unibet, WePlay, CoinPoker, PokerBros and
several closed rooms (MicroGaming, Full Tilt, Ongame, Entraction, Run It
Once), plus Rail's own standard text. Games: No Limit and Pot Limit Hold'em,
four- and five-card Omaha, Omaha Hi/Lo and short deck where that room's
format has been proven; cash, fast-fold, tournaments, Sit & Go and Spin.
Stud, razz and draw games are refused.

### Refused hands

A hand Rail cannot convert exactly is **refused**, never approximated. Below
the results, a panel lists them ("N hands we could not convert"), grouped by
reason, each with **Show hand**, **Copy sample** and **Download**. Common
reasons:

| Reason shown | What it means |
| --- | --- |
| We do not recognise this hand history format yet | No converter claims the file. |
| The chips in this hand do not add up | Converting it would give wrong numbers. |
| The same card appears twice in this hand | The file contradicts itself. |
| Everyone folded to the big blind | A walk with nothing to replay. |
| Not supported (for example Hi/Lo or a variant the room's format is not proven for) | Reading it would risk a wrong split or wrong ranking. |

WPT Global and PPPoker files are refused with an explanation: neither room
has a hand-history export Rail can rely on.

Signed in with saving on, Rail keeps a copy of refused hands privately
("They are the queue we write the next converters from"), so the formats that
fail most get converters first. Your original file is never changed; download
the refused hands for your own copy.

### Entering a hand by hand

**Enter a hand manually** (`/convert/manual`) builds a hand from scratch:

1. Set the game: cash or tournament, Hold'em or Omaha (4 or 5 cards), limit,
   blinds, ante, straddle, table size, and optionally table name, date and
   tournament details.
2. Seat the players, set stacks, put the button and mark the hero; set known
   cards.
3. Click a player to enter their action, or the board to deal the cards. The
   bar shows whose turn it is.
4. When the hand is over, pick the winners if they are not decided, then
   replay, download it as a hand history, or save it.

An unfinished hand is kept in your browser and restored when you come back;
it leaves the tab only when you save it.

---

## Library

> Tutorial video: _coming soon_ (id: `library`)

**Hand history** (`/library`) lists every hand you have saved, from the web or
from the desktop app. It is private to your account.

### Browsing

- Hands are listed newest first; sort by pot, result or oldest instead. The
  list loads more as you scroll.
- Click a hand to open it in the [replayer](#replayer) beside the list (above
  it on a phone), with **Share** and **Publish hand**.
- A hand handed over from the converter opens above the list with a save
  button ("From the converter - not saved to your library").

### Filtering

Filters are chips in one row. Each choice shows how many hands it would match
before you pick it.

- **Date, room, stakes, position, pot type** (limped, single-raised, 3-bet,
  4-bet+), **result, stack depth, all-in, game, variant, limit, table size**.
- **Searches**: your cards or a hand class, board cards, a player at the
  table, part of the table's name, a minimum pot (in the hand's own unit: 25
  is $25 at a dollar table, 25 chips in a tournament).
- **Showdown**, the positions that went to showdown and the winners'
  positions.
- **Names**: what the room's names are worth (see below).

Save a combination you use often as a **saved filter** and reapply it in one
click.

### Rooms that hide names

Some rooms do not print lasting screen names, and Rail records that per hand:

- **GGPoker** and some ACR files use per-session tokens: the same tag in two
  sessions may be two people.
- **Ignition, Bodog, Bovada** label seats by position, and a position is a
  different person every hand, so Rail drops those labels and keeps only
  positions.

Filtering by a player therefore works only for rooms with real screen names.

### Live arrivals

When the desktop app syncs, or another tab uploads, new hands appear at the top
without moving the rows you are looking at, and the heading says "Hands
arriving from <device>". Nothing refreshes while the tab is hidden.

### Saved hands and saved posts

The library has no separate "saved hands" list: every hand in it is saved.
**Saved posts** (`/saved`) is the forum's bookmark list, described under
[Community](#community).

---

## Replayer

> Tutorial video: _coming soon_ (id: `replayer`)

The replayer draws the table and plays the hand action by action: pot per
street, each seat's bet, all-in state, the dealer button, run-it-twice boards
and the final distribution of the pot.

### Controls

- Play / pause, step forward and back, scrub, jump to a street, speed 0.5x to
  4x, reveal every known card.
- Keys: `Left` / `Right` step, `Space` plays or pauses, `Home` / `End` jump
  to the start or end. Press `?` on the replayer for its keys.

### Sharing a link

1. Open a hand in your library and choose **Share hand**.
2. Rail creates a link; **Copy**, **Open link** or **Share via...**.
3. Anyone with the link can replay the hand **without an account**.

**Names are hidden by default.** A share link shows Hero, Villain1,
Villain2... and no table name, hand number or time of play. Tick **Show the
players' names** (in the share dialog, or on the shared page while you are
signed in as its owner) to show the screen names as the room printed them.
You can turn it off again; the link stays the same. Shared pages are not
indexed by search engines.

A shared hand can stop working: "This hand is no longer available" means the
owner deleted it or their account.

### Publishing and embedding

**Publish hand** makes a public copy of one of your stored hands, which can be
found by search engines and posted on the [forum](#community). You choose the
names: **Villain1, Villain2...** (recommended), **table positions**, or the
screen names as printed (most rooms forbid publishing other players' names;
Rail asks you to confirm). In every mode the room's raw text, the table name,
the hand number and the exact time are removed.

A published hand's page (`/p/...`) has an **Embed** button with an `<iframe>`
code to paste into a blog or another forum; it sizes itself to the width it
is given. Share links have an embed address too (`/embed/h/...`), which
follows the link's names setting.

If you have analysed a hand, **Share this hand's analysis** (off by default)
shows its grades and explanations wherever that hand is public. Only that
hand: your other hands, statistics and reports stay private.

---

## Stats

> Tutorial video: _coming soon_ (id: `stats`)

**Statistics** (`/stats`) is the report over the hands in your library. It is
the same screen as the desktop app's Reports.

### What you see

1. **The filter chips**: date, room, stakes, position, game, variant, limit,
   table size. Every number below follows them.
2. **The summary**: hands, result, bb/100 (big blinds won per 100 hands) and
   all-in EV bb/100.
3. **The win-rate graph**: total, showdown, non-showdown and all-in EV lines,
   in big blinds or money. The x-axis counts hands, not days, so a break
   between sessions takes no space.
4. **Every statistic by group** (preflop, postflop, showdown), each with its
   sample.
5. **Breakdowns**: position, pot type, stack depth, the 13 x 13 starting-hand
   grid, players, street, stakes, table size, room, game.
6. **Sessions** and **Opponents** panels over the same filter.

A line above says how much of your library the numbers cover ("N of M hands
are not in these numbers yet") with **Rebuild statistics** if they fall
behind. Hands are added to the statistics as they are saved.

### Reading a number

- Each statistic is "made / had the chance". VPIP 24 % over 1 200 hands means
  you put money in voluntarily in 24 % of the hands where you could.
- **Reliability**: a value is drawn fainter while its sample is small, and its
  tooltip shows the sample and a 95 % range. In breakdowns, grey numbers rest
  on few opportunities and a dotted win rate on fewer than 100 hands: a
  direction, not a reading.
- A win rate does not settle until a large sample; the summary says so while
  it is provisional.
- Mixed currencies, or tournament chips mixed with cash, have no money total;
  Rail says so and shows big blinds, which are a unit of the game.

The main statistics, briefly: **VPIP** (money in voluntarily), **PFR**
(raised preflop), **RFI** (opened an unopened pot), **3-bet** (facing one
raise), **Fold to 3-bet** (after opening), **4-bet**, **Squeeze**, **Cold
call**, **Steal** (CO / BTN / SB, folded to you) and **Fold to steal**;
**C-bet** flop / turn / river (a turn c-bet counts only after the flop c-bet
was called), **Fold to c-bet**, **Raise c-bet**, **Donk bet**,
**Check-raise**, **Aggression factor / frequency**; **Saw flop**, **WWSF**
(won when saw flop), **WTSD** (went to showdown having seen a flop) and
**W$SD** (won at showdown). Exact definitions:
[`STATS-SPEC.md`](STATS-SPEC.md).

### All-in EV

The all-in EV line and bb/100 divide each pot at the moment of an all-in by
each player's equity instead of by the cards that came. Compare it with your
real result to see how much of a good or bad run was the deck. It is the same
money split another way: over all players it adds up to the same total.

### Sessions

A session ends at a break longer than 30 minutes. The Sessions panel lists
each one with its length, tables, result and bankroll line; **Review** opens
its [session review](#analysis).

### Plan limits

On Free (once enforced) the summary, every statistic and the graph stay open;
the situation breakdowns, sessions, opponents and the Players screen show the
Pro lock.

---

## Players

> Tutorial video: _coming soon_ (id: `players`)

**Players** (the Statistics / Players switch, `/players`) lists the opponents
in your hands and your result against each.

### Turning it on

Opponent statistics store a row per opponent per hand (about six times the
space of your own statistics), so on the web they are **off until you turn
them on** (**Turn on opponent statistics**). Turning them off later deletes
those rows; your hands and your own numbers are untouched.

### Using it

1. The list shows opponents from rooms that print screen names, most hands
   together first. Search by the start of a name; filter by room, game, or
   "with a note".
2. Open one for their profile: hands together, first and last seen, your
   result against them, their statistics with reliability, their rows by
   position, stake, table size and game.
3. Add a **private note** (and tags in the Opponents panel). Notes are visible
   only to you.
4. **Hands with this player** opens your library filtered to that player.

Limits: opponents of GGPoker (names change between sessions) are counted but
not listed; rooms that label seats by position (Ignition) never record
opponents. Colour tags and labels belong to the desktop app and stay there.

---

## Analysis

> Tutorial video: _coming soon_ (id: `analysis`)

**Analysis** (`/analysis`) walks every decision you made in your saved hands
and grades the ones a reference covers. It is private to you and runs in your
browser tab (on the desktop, in the background).

### Running it

1. Choose **Run analysis** (or **Analyse new hands**). You can start with the
   most recent hands.
2. Progress shows with time left; **Stop** keeps what is done, and running
   again carries on. A new analysis version asks to **Bring it up to date**.

### What is graded, and against what

- **Preflop**: graded **Perfect, Good, Inaccurate, Mistake or Blunder** against
  Rail's own preflop charts where a chart covers the spot (6-max at 40-200 bb,
  full ring at 100-200 bb, heads-up at 100 and 150 bb; no open limpers).
- **Turn and river** in heads-up pots: graded by Rail's own solver.
- **Flop**: facts and flags only. A flag ("Called without the odds", "Folded
  the nuts", ...) is a note to read with the hand open, never a grade.
- **Multiway pots**: facts against every opponent's range, and an approximate
  grade for a call or fold facing a bet, labelled as such.
- **Tournaments**: preflop all-in-or-fold decisions at 20 bb or less are graded
  in a push/fold model, in prize equity (ICM) when the players left and payouts
  are known (you can set them), otherwise in chips. Deeper or postflop
  tournament decisions are not graded.
- Not analysed: hands without a hero seat or hero cards, non-Hold'em, Hi/Lo,
  non-No-Limit, bomb pots. The overview lists why.

A grade is the EV you gave up against the reference's best move, in big blinds
and as a share of the pot. The overview shows coverage, the grade
distribution, a **score** (mean over graded moves, 0-100) and **EV loss per
100 hands**. Each hand opens in the replayer with the Analysis sheet
(`/analysis/h/...`).

### The parts of Analysis

| Screen | What it gives you |
| --- | --- |
| **Session review** (`/analysis/session`) | After a session (a break over 30 minutes), the hands worth a look: the worst graded decisions with the EV they cost, preflop decisions off the charts, and the biggest pots, under the session's result. Previous / Next and a 90-day picker walk to other sessions. |
| **Three biggest leaks** (on the overview) and **Leaks** (`/analysis/leaks`) | Graded decisions grouped into spots (street, scenario, seat, opponent) and ranked by EV lost, with how often, a confidence (high needs 50 decisions in the spot and 5 mistakes, medium 20 and 2), the reference's move, and example hands. Thin spots are merged into coarser ones so one bad hand does not become a leak. |
| **Reports** (`/analysis/reports`) | Your preflop frequencies at every chart spot next to the reference's, blind defence against each opener, and postflop frequencies by role. |
| **Progress** (`/analysis/progress`) | Score and EV lost per 100 hands by week, month or session, by street, seat and pot type. |
| **Train** (`/analysis/train`) | Practise preflop spots, river spots and **your own mistakes** until they are right, graded exactly as the analysis grades. |
| **Study plan** (`/analysis/plan`) | This week's focus from your leaks: concepts to read, trainer spots, drills and your own hands to review, rebuilt every Monday. Trainer items tick themselves as you play them. |
| **Your preflop charts** (`/analysis/my-charts`) | Build or import your own ranges situation by situation (paint a 13 x 13 grid, paste ranges in common formats, start from Rail's chart), then **Compare** them with the hands you played: how often you followed them, where you left them, and what it cost. |
| **Preflop charts** (`/analysis/charts`) and **Concepts** (`/analysis/learn`) | Rail's own charts and the concept library with calculators. Public, no account needed. |

Limits: the charts value some speculative hands low (the page says which), so
grades against playing those lean harsh. Everything here is study after the
session; on the desktop the analysis is hidden while a poker table is open.

---

## Learn

> Tutorial video: _coming soon_ (id: `learn`)

**Learn** (`/learn`) is a course in cash-game poker in the order of a hand:
preflop, the flop situation by situation, the turn, the river, then exploits.
It assumes the basics; the ideas it builds on are reference pages.

### Lessons

1. Open the course map. Each lesson shows its status: **Not started, In
   progress, Tested out, Mastered**. A lesson marked **Recommended** teaches
   the spot your analysis says costs you most.
2. A lesson teaches one idea, asks you to predict before it shows you, and
   ends with practice dealt and graded by Rail's charts, solver and
   calculators. It is **mastered** when every gradable exercise is passed.
3. Signed in, it ends with your own hands in that spot, costliest first.
4. "Read first" is advice, not a lock: every lesson opens.

A lesson you passed is marked **Re-check** if you have played its spots worse
since, by more than the sample's noise (at least 20 graded decisions before
and after).

### Placement test

**Placement test** (`/learn/placement`) lets you test out of what you already
play well: pick a track and answer a few items per module. A module you pass
is marked **tested out** (a status of its own, not mastered); its lessons stay
open.

### Review and daily dose

- **Review** (`/learn/review`): quiz items you missed come back on a
  spaced-repetition schedule.
- **Today's five minutes**: the due review cards plus one new item from the
  recommended lesson.
- A **module review** mixes items across a module's lessons.

### Reference

Reference pages (`/learn/reference/...`) cover using Rail, poker maths, and
ranges and boards, linked from a lesson the first time it uses a term.

Signed out, progress is kept in this browser only; when you sign in Rail
offers to **Add it to this account**.

---

## Community

> Tutorial video: _coming soon_ (id: `community`)

The home page (`/`) is Rail's **forum**: poker hands posted by the people who
played them, replayed in the thread and discussed. Reading needs no account.

| Address | What it is |
| --- | --- |
| `/` | Every board's threads, sorted **Hot**, **New** or **Top**. |
| `/f/<board>` | One board's threads. |
| `/f/<board>/<id>/...` | A thread: the post, its hand in the replayer, comments. |
| `/submit` | **New post**. |
| `/p/<id>` | A published hand. |
| `/u/<username>` | A player's public profile: joined date, karma, published hands. |
| `/search` | Search posts and comments. |
| `/saved` | Your saved posts. |
| `/notifications` | Replies, mentions and comments in threads you follow. |
| `/takedown` | How to ask for a hand history to be taken down. |
| `/mod` | The moderators' queue (moderators only). |
| `/feed.xml`, `/f/<board>/feed.xml` | RSS feeds of the whole forum and of one board. |

### Posting a hand

1. In your library, open a hand and choose **Publish hand** (see
   [Replayer](#replayer) for the names choice).
2. **Start a thread about it** opens **New post** with the hand attached. Pick
   a board, write a title and your question.
3. Optionally **Ask readers what they would do**: pick the decision to stop
   at and the answers to offer, and optionally hide your cards to ask about
   the range. Readers see the hand up to that point, answer, and only then see
   the rest, the votes and the comments. If you shared the hand's analysis,
   readers see the reference answer after they vote.

You need a confirmed email to post (Settings, Posting, shows whether your
account can post).

### Taking part

- Upvote or downvote posts; votes make up a user's **karma**.
- Comment, reply, and **Comment on this spot** to tie a comment to a moment in
  the hand.
- **Save** a post, **Follow thread** for notifications, **Mute** a thread.
- Edit or delete your own posts. A deleted post others replied to stays as
  "[deleted]" so the replies still make sense.

### Reports and takedowns

**Report** anything (spam, harassment, cheating, off-topic, "My hand history -
please take it down", something else). Moderators review reports in the
moderation queue; they can remove, restore, lock, pin and edit titles, with
every action in an audit log. For a takedown, a moderator responds within 48
hours, and the hand is removed from its page, every thread and the sitemap.
Published hands never contain the room's raw text, the table name, the hand
number or the exact time.

---

## Account

> Tutorial video: _coming soon_ (id: `account`)

**Settings** (`/settings`, from the account menu) holds:

- **Language**.
- **Username**: 3-24 letters, numbers and underscores; your public name and
  profile address. Change it once every 30 days; the old name stays reserved
  for you for a year and its links keep working.
- **Posting**: whether your account can post, with **Resend the confirmation
  email**.
- **Plan** (`/settings#plan`): your plan, hands stored, what each plan
  includes, and billing.
- **Password**: change it (at least six characters).
- **Your data** and **Delete account**.

### Your data (export)

**Download my data** builds one ZIP file in your browser with everything Rail
holds about your account: profile and plan, every hand as stored (in PHF, the
JSON format Rail uses), notes, charts, settings, HUD layouts, shares, your
forum content, and a README explaining every file. Options add your
statistics and analysis (Rail can rebuild them; the file gets about three times
larger) and the original files you kept on upload. No copy is kept on Rail's
servers. A large library takes a few minutes per 100 000 hands; keep the tab
open. Up to 10 exports a day.

The desktop app's local database is not in the export; its synced hands are.

### Delete account

1. Optionally **Download your data first**.
2. Type your username and your password, then **Delete my account
   permanently**.
3. A paid subscription is canceled first; then your stored files, forum
   content and hands are deleted. You can close the tab; a large library can
   take up to an hour, and an interrupted deletion offers **Continue the
   deletion**.

What happens: your hands, statistics, analysis, notes, charts, settings, HUD
layouts and kept files are deleted; share links stop working; posts nobody
answered and your published hands are deleted, while posts with replies stay
as "[deleted]" without your words or name; your votes are removed; your
username stays reserved for a year. **The desktop app's data on your
computer is not touched**: remove it there (see [Desktop app](#desktop-app)).

### Billing

When Pro is on sale, the Plan panel offers it:

1. Choose **Monthly** or **Yearly** (prices include VAT where Rail shows
   them so; early users see their discount).
2. Tick the two consents: the Terms of Use, and that Pro starts immediately so
   the right of withdrawal ends once it has started.
3. **Continue to payment** opens Stripe's checkout; a business can add its
   VAT number.
4. Back on Rail, Pro switches on as soon as Stripe confirms the payment,
   usually within seconds. Arriving on the success page does not by itself
   grant anything.

**Manage subscription** opens Stripe's portal to change the card, switch
between monthly and yearly, download invoices or cancel. A canceled
subscription keeps Pro until the end of the paid period. A failed payment
keeps Pro for a grace period (7 days by default) while you update the card.

The terms of use (`/terms`) and the privacy policy (`/privacy`) are linked
from every page's footer; they are drafts, not yet in force, and say so. Their
text is in [`legal/`](legal/).

---

## Desktop setup

> Tutorial video: _coming soon_ (id: `desktop-setup`)

The desktop app imports your hands while you play, keeps them on your
computer and works offline. Signed in, it syncs them to your account so they
appear on the web.

### Installing

Rail ships for macOS and Windows. Until the builds are signed:

- **macOS**: the first launch is blocked; open System Settings, Privacy &
  Security, and choose **Open Anyway**.
- **Windows**: SmartScreen asks; choose **Run anyway**.

Closing the window keeps Rail running in the tray (the menu bar on macOS);
**Quit Rail** in the tray ends it. Rail can start at login.

### First run: three steps

The first launch opens **Welcome to Rail**: "Three steps to your first HUD".

1. **Sign in.** **Sign in in your browser** opens Rail's sign-in page in your
   default browser, where your password manager and Google sign-in work.
   Sign in there if needed, then confirm **Sign in to Rail**. The browser asks
   to open Rail; allow it, and the app is signed in with a sign-in of its own
   (your browser stays signed in). The link works for ten minutes. Or choose
   **Use offline**: everything works on this computer, and you can sign in
   later in Settings, Account.
2. **Confirm your hand-history folders.** Rail looks in the default folders of
   the rooms it knows and lists the ones it found, with the number of files
   and the date of the newest. Untick any to leave out, or **Add a folder
   manually...**. Then choose what to do with the hands already there:
   **import everything** or **only new hands**, and **Watch N folders**.
3. **Open a table.** Play as usual: Rail reads each hand as the room writes
   it, and **Today** shows them arriving.

Rail's list of default folders is still being checked on real installs, so if
your room saves elsewhere, add the folder yourself.

### Folders and import

**Settings, Folders** lists every watched folder with its room, state, last
import, hands today, problems and refused hands. For each you can change the
path (a moved folder continues where it left off), choose its room when
detection fails, switch it on or off, watch subfolders, use polling (for
network drives), or remove it (its hands stay).

A large first import shows its progress (bytes, files, hands, time left) in
the tray, on Today and on the folder's card. **Pause import** is in the tray.
A hand is imported only once it is complete, and nothing of the hand in play
is ever read.

**Refused hands** (Settings) lists every hand Rail refused, by reason, with
the raw text the room wrote. After an update, **Try again after an update**
reads them again with the new version.

### Sync with the web

Signed in (and on a plan that includes sync), Rail sends your hands to your
account in the background, the hands you just played first, and pulls the
hands you saved on the web or synced from another computer.

- **Settings, Account** shows "Syncing 120 of 4 000 hands", up to date,
  offline or paused, the hands the server refused (by reason, with **Try
  again**), **Sync now**, **Pause sync** and an upload limit for a large
  backlog. Today and the tray show one line.
- Offline, Rail keeps working and syncs when it reconnects. Sync slows while
  tables are open.
- If you sign in with a different account than the one this computer's hands
  belong to, nothing syncs until you choose whether to upload them to it.
- The web's library shows "Hands arriving from <device>" while it syncs.

Signing out keeps your local hands. To remove them from the computer, quit
Rail, uninstall it and delete the folders listed under Settings, Account,
Your data.

---

## Desktop app

> Tutorial video: _coming soon_ (id: `desktop-app`)

The desktop app's screens, in the sidebar (Cmd / Ctrl + 1 to 7 to switch):

| Screen | What it shows |
| --- | --- |
| **Today** | The current session (a break over 30 minutes ends it): result in money and big blinds, hands, hands per hour, key statistics, its biggest pots; the import status; and which tables have the HUD. |
| **Hands** | The same hand list, filter chips, saved filters and replayer as the web's [library](#library), over the hands on this computer; a tag and a note per hand. |
| **Reports** | The same report as the web's [Stats](#stats), with its own saved filters, in big blinds or money. |
| **Players** | Opponents of rooms that print screen names, with their profile; plus a **colour tag**, **labels** and a **note** per player, which the HUD can show. |
| **Analysis** | Session review, top leaks, your own charts and a hand's grades, run in the background on this computer. Hidden while a poker table is open. |
| **HUD** | The HUD's status and its editor (see [HUD](#hud)). |
| **Settings** | Account (with Plan and Your data), Folders, Refused hands, Your statistics, Preferences (theme, density, language), About. |

- **Cmd / Ctrl + K** opens the command palette: jump to a hand by its number,
  a player, a report breakdown, a saved filter, a Settings section, or run a
  command (pause import, sync now, theme, language), all from the keyboard.
- **Your statistics** (Settings): write your own statistic as a counter
  (for example "first street = flop and facing a c-bet and multiway => fold")
  and a formula; the editor underlines mistakes and previews the value on
  your last 5 000 hands. It then appears in Reports. A change to a statistic
  recomputes only what it touches, in the background.
- **Preferences**: dark, light or system theme; comfortable or compact lists;
  English or Croatian.

On Free (once enforced) the app keeps importing, the library, the replayer and
basic statistics; the HUD, Analysis, Players and Reports' situation tabs need
Pro, and sync waits. A Pro app keeps working offline for 14 days after its
last plan check, then asks you to reconnect.

---

## HUD

> Tutorial video: _coming soon_ (id: `hud`)

The HUD draws a small panel of statistics next to each opponent at your poker
tables, from the hands already on your computer. It is part of the desktop
app; the web has no HUD.

> **Status.** The HUD is complete and tested on Rail's own table simulator. It
> attaches to a real room's tables only after that room's table windows have
> been captured and checked; no room has been yet. Until then the HUD screen
> lists open tables as tables without the HUD.

### Where the HUD may run (compliance mode)

Many rooms forbid HUDs or set rules for them, and breaking them can cost you
your account. Rail's **compliance mode is always on**: the HUD attaches only
where the room's own published rules allow it.

| Room | HUD |
| --- | --- |
| PokerStars | allowed, with restrictions: your own hands only, numeric statistics, at most two colour thresholds, no labels |
| Winamax | allowed |
| ACR (Winning Poker Network) | allowed, with restrictions: your own hands only, nothing from the hand in play, panels kept off ACR's own table graphics |
| GGPoker, partypoker, WPT Global, CoinPoker, Unibet | not allowed by the room |
| Ignition / Bodog / Bovada, PokerBros, closed rooms | no (anonymous tables, no desktop client, or closed) |
| 888poker, iPoker, Chico, WePlay | rules not established, which Rail treats as not allowed |

The full list, with each room's own policy page and the date it was read, is
in [`research/HUD-POLICIES.md`](research/HUD-POLICIES.md).

There is **no switch to override** this. The list is checked before every
release; between releases the app picks up a corrected list from the web,
which can only switch a room off or add a restriction, never switch one on.
Statistics, reports and your hands work at every room either way.

**The HUD screen, "At the tables"** lists the tables with the HUD and the
tables without it, each with the reason in plain words (for example
"GGPoker's rules do not allow a HUD."), the room's policy page and the date it
was read,
plus **Why can't I enable the HUD here?** and **Look for an update now**.
Today and the tray say the same in one line ("HUD: on 2 tables").

### macOS permission

On a Mac the HUD needs the **Accessibility** permission, to read poker
windows' titles and positions, and nothing else (never Screen Recording or
Input Monitoring). Rail asks only when a supported poker client is running:
**Open System Settings**, switch Rail on under Privacy & Security,
Accessibility, and the HUD screen notices by itself. Until releases are
signed, each new build may need the permission again (remove Rail from the
list and add it back if the screen keeps asking).

### At the table

- One panel per opponent shows six statistics (VPIP, PFR, 3-bet, fold to
  3-bet, flop c-bet, aggression frequency) and the number of hands.
- **Colours**: light blue for low, white for normal, orange for high. A small
  legend in a corner shows `-` low, `=` normal, `+` high.
- **Faded** numbers rest on a small sample.
- The numbers come from **games like this one** (same room, game, limit, table
  size and stake). On PokerStars, Winamax and ACR only **hands you played**
  count; tables you only watched do not.
- **Past hands only.** A hand counts after it has ended and been written by
  the room; nothing of the hand in play is ever shown. A new hand reaches the
  panels within about a second.
- **Drag** a panel to move it; it stays there for that room, table size and
  seat, on every such table and after a restart.
- Where a room allows labels (Winamax), the panel also shows your colour tag,
  a note mark and your labels for that player.
- The HUD follows the table as you move, resize or minimise it, and follows
  tournament table moves.

### The popup

Click a panel to open a popup beside it, without taking the keyboard from the
table:

- the player's statistics by group with their thresholds in words;
- the hands you played together and your result against them in big blinds;
- rows by position where the room allows it (ACR);
- where labels are allowed, the colour, labels and note, editable;
- **Open in Rail** for the full profile.

`Esc`, the close button, clicking the same panel again, or moving the pointer
away closes it.

### Designing your HUD

The **HUD** screen's editor builds the panel:

1. Start from a **preset**: cash, tournaments or Spin (and one by stack depth
   on ACR).
2. Drag statistics into the panel (or use the keyboard); set each one's
   colours, decimals and minimum sample; choose the popup's sections.
3. Assign a design per room, table size and game.
4. The **live preview** draws the panel as the HUD will, under each room's
   rules. Anything a room forbids (on PokerStars: statistics that read the
   cards, a display that changes with stack or position, more than two
   colour thresholds, labels) is refused in the editor with the reason, and
   the HUD drops it anyway.

Designs and dragged panels follow your account to your other computers.

### Nothing during play

While a poker table is open, Rail hides whatever could help you play: the
Analysis screen, the replayer's pot odds and the starting-hand chart ("Hidden
while a poker table is open: Rail gives no help during play"). They come back
when the tables close. Rail never gives advice at the table.

On Free (once enforced) the HUD does not start; the editor stays usable.
