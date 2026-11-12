# Real-client check: the HUD, table tiling and the RNG

Phase 3 ends when the HUD runs on 12 tables at once, on Windows and macOS,
within the latency budget, and only on rooms whose HUD policy allows it
(docs/RAIL-PLAN.md, Phase 3 exit; R3.14). CI checks this on the table
simulator. This page is the owner's procedure for the real clients: what to
have ready, what to check on each room and system, and what to send back.

Sections 0 - 4 are the HUD's. Table tiling and the RNG (T6,
[`TABLE-TILING.md`](TABLE-TILING.md)) are [section 5](#5-tiling-and-the-rng-per-room-t6),
the window signals T7's dynamic slots would need are
[section 6](#6-window-signals-for-dynamic-slots-t7), and
[section 7](#7-tiling-and-signals-what-to-send-back) is what to send back
for both.

The rooms are the three whose `hud.allowed` is `true` (R3.0,
[`HUD-POLICIES.md`](HUD-POLICIES.md)): **PokerStars, Winamax, ACR**. Test
on play-money tables where the room has them (check the client's lobby).
The HUD counts only your own hands on these three rooms, so hands you
only watch add nothing to anyone's numbers, as they should not: sit in and
play (or fold) to fill the panels. Never test on a room the HUD refuses. Rail offers no real-time help,
so nothing here should give you an edge at the table.

Plan about an hour per room and system, and 15 minutes for the twelve
tables.

---

## 0. Before you start

Each line has to be true before the checks mean anything.

- [ ] **A Windows PC (P5) and the Mac.** Note each one's display setup: the
      scaling (Windows: Settings, Display, Scale; Mac: Retina or not), and
      for a second monitor its scaling too.
- [ ] **An account on each room (P6)**, with the client installed from the
      room's own site. Note the client version from its About screen.
- [ ] **The room's tables captured and in `sites.json`.** Follow
      [`CAPTURING-TABLES.md`](CAPTURING-TABLES.md) on each system: the
      process name and title regex (`tables.process.windows` /
      `.macos`, `tables.title`), the seat layout per table size, ACR's table
      graphics (`tables.seatLayouts`) and the preferred-seat default
      (`tables.preferredSeat`). That change must be merged into `staging`
      and built. **Until a room has its `tables` block, the HUD attaches to
      none of its tables.** That is correct behaviour, not a failure, so a
      room without one cannot be checked yet.
- [ ] **A Rail build from `staging` with the HUD**: the unsigned installer
      or `.dmg` from the CI run of the latest pull request merged into
      `staging` (the `app` job's artefacts), or `npm run tauri dev` in
      `app/` for a debug build.
      **Latency check C9 needs the debug build**: only a debug build prints
      the latency line on each table.
- [ ] **Hand histories on in each client** and the folder listed in Rail's
      Settings, Folders (R1.4, R1.5): play one hand and check that Today
      counts it.
- [ ] **macOS: Rail has the Accessibility permission.** Grant it on the HUD
      screen's button, then System Settings, Privacy & Security,
      Accessibility. An unsigned build counts as a new app to macOS each
      time it is rebuilt: if the HUD screen keeps asking, remove Rail from
      the list and add it again.
- [ ] **On each machine, the simulator kit has run once** (section 1). It
      tells a slow machine apart from a real-client problem.

---

## 1. The simulator on this machine (the twelve-table kit)

This is the same scenario CI runs, on your hardware, in a release build:

- twelve simulator tables posing as PokerStars;
- one table posing as GGPoker, which must get no HUD;
- 5 minutes of hands at 6 per minute per table;
- every table moved twice;
- 10 seconds idle.

It checks every number against the budget, writes a report and needs
nothing from the rooms. It runs in a checkout of the repository with the
Rust toolchain (README §8, Rust workspace). The command is the same on both
systems:

```bash
cargo test --release -p rail-hud --test twelve_tables -- --run --real-hw --seconds 300
```

- **macOS**: give your terminal app the Accessibility permission first
  (Privacy & Security, Accessibility; quit and reopen the terminal).
  Without it the run cannot find the tables and stops at the data path; its
  report then says `INCOMPLETE` and lists what it skipped. Switch the
  permission off again afterwards if you like.
- **Windows**: PowerShell or cmd, in the repository folder.
- **Leave the machine alone for about 6 minutes**: 13 windows open, move
  and close by themselves. Do not click them.
- It ends with `R3.14 report: PASS` (or `FAIL` with the failed lines) and
  writes `target/twelve-tables/twelve-tables-<os>-release-<time>.json` and
  `.md`. These files hold only the simulator's data: invented player names,
  timings and counts. They contain no host name, user name or path.
- **macOS, also run**:
  `RAIL_HUD_REAL_HW=1 cargo test -p rail-hud --test macos_tracking -- --nocapture`.
  This is R3.13's drag test. On real hardware it fails if a fast drag's
  p95 is over three frames. Copy its lines that start with `R3.13`.

What the report checks, and against what limit:

| Check | Limit |
| --- | --- |
| A hand written to its frame on the table, p95 | under 1 s (the plan's §3.3) |
| An overlay's paint, p95 | under 16.7 ms (one frame) |
| A moved table to its overlay over it, p50 / p95 | two / three frames |
| HUD CPU with 12 tables, idle / playing | 5 % / 15 % of one core (on an M2 Pro; scaled for a slower machine) |
| The app's CPU while 12 tables play | 20 % of one core (scaled the same way) |
| HUD memory | 256 MiB |
| Overlays on screen | exactly 12; none on the GGPoker table |
| Hands | every hand shown; none from the refused table; the recompute paused while tables are open |

---

## 2. The checks, per room and system

Copy this block once for each room and system (up to six:
PokerStars / Winamax / ACR on Windows / macOS) and tick each box. Write a
note on every **fail**: what you did, what you saw, and a screenshot with
every name blurred.

```text
Room: ______   System: Windows / macOS   Client version: ______
Display: ______ (scale)   Second display: ______ (scale)   Rail build: ______
```

**C1. The HUD attaches only where it may.**
- [ ] Open one table of the room. Within a second it shows "waiting for
      first hand" and is listed on Rail's HUD screen under the tables with
      a HUD.
- [ ] The lobby, the cashier and tournament lobbies get no overlay.
- [ ] If a room the HUD refuses is installed (GGPoker, partypoker, ...),
      open one of its tables: no overlay, and the HUD screen lists it as
      refused with the room's reason.

**C2. Panels at the right seats.** Check every table size the room has
(heads-up, 6-max, 9-max).
- [ ] After your first hand at the table, each player has a panel next to
      their own seat plate, on no other plate, and clear of the board and
      pot.
- [ ] A player who leaves loses their panel, and a new player gets one,
      after the next hand.

**C3. Preferred seat.** Skip if the client has no such setting.
- [ ] Switch the client's preferred-seat option on, and set Rail's "My
      client seats me at the bottom" to match (HUD screen, the room's
      preview). After the next hand
      every panel is still next to its own player, with yours at the seat
      the client puts you in.
- [ ] Switched off again, it still matches.

**C4. ACR: nothing over ACR's own graphics** (ACR only; policy 4.2.11).
- [ ] No panel covers the board, pot, dealer tray, chip stacks, action
      buttons, time bank or chat, at every table size.
- [ ] Drag a panel onto the board: it lands on the nearest place clear of
      the graphics.

**C5. Following the table.**
- [ ] Drag the table slowly, then fast: the panels move with it. They do
      not trail visibly. On macOS, if they jump about twice a second instead
      of moving smoothly, the client does not post its window
      notifications: note it.
- [ ] Resize the table to its smallest and largest size: the panels scale
      and stay at their seats.
- [ ] Minimise the table: the panels go. Restore it: the panels come back
      at once.
- [ ] Use the client's own tile or cascade command: the panels follow.
- [ ] Click on the table's felt: the client gets the click, and the table
      comes in front of other windows with its panels still on top of it.

**C6. Tournament table move.** A multi-table tournament or sit-and-go,
until you are moved to another table, or until tables merge.
- [ ] After the move the table shows only its new players, with no
      numbers left over from the old table. The new table's first hand
      fills them.

**C7. The popup.**
- [ ] Click an opponent's panel: the popup opens beside it, and the table
      keeps the keyboard (you can still type in its chat or bet box).
      Click the table again: the popup closes.
- [ ] macOS: put the table in full screen and click a panel. The popup
      opening on the desktop's Space is a known limit (R3.13). Note what
      happens.

**C8. The room's restrictions, visibly respected.**
- [ ] **PokerStars**: no more than two colour thresholds (the legend shows
      at most three bands), no labels, note marks or colour tags on the
      panels, and nothing that changes with position or stack size. The
      HUD editor refuses those settings for PokerStars and says why.
- [ ] **ACR**: no labels on the panels.
- [ ] **Winamax**: your labels and colour tags show.
- [ ] **All three: nothing from the hand in play.** During a hand no number
      changes. They change only after the hand ends. Check this on a long
      hand too: use your time bank on the river.

**C9. Latency: from the end of a hand to the HUD.** Needs the debug build.
- [ ] Each table shows a line `debug: file to HUD N ms`. Over 20 hands, N
      stays under 1 000. About 500 is expected (the quiet period).
- [ ] With a screen recording at 60 frames per second, count the frames
      from the pot being pushed to a panel's hand count going up. Note the
      median and the slowest over 10 hands. The budget is under 1 s,
      including the room's own delay in writing the file.

**C10. Does the room pause mid-hand while writing a hand?** This is R3.7's
finding: a room that writes part of a hand, pauses for more than 500 ms
and then writes the rest could get the partial hand stored.
- [ ] Watch the room's newest hand-history file while you play 10 hands,
      one of them long (time bank on every street):
  - macOS: `tail -f "<the file>"`
  - Windows (PowerShell): `Get-Content -Wait -Tail 5 "<the file>"`

  Pass: nothing of a hand appears before it ends, and each hand appears in
  one burst. Fail: any line of a hand appears while it is still being
  played, or a hand appears in pieces more than half a second apart. Note
  which, and on which street.

**C11. Twelve real tables.** Play money; sitting out where the room allows
it, or folding.
- [ ] Open 12 tables. All 12 get panels, and none of the lobby windows do.
- [ ] After 15 minutes, read `rail-hud` and Rail:
  - macOS: Activity Monitor, CPU tab, `% CPU` (100 % is one core) and the
    Memory column.
  - Windows: Task Manager, Details tab. `CPU` there is a share of all
    cores: multiply it by the number of logical processors to get "of one
    core".

  Note `rail-hud` idle and while hands play, and Rail, against the kit's
  limits (5 % / 15 % / 20 % of one core, 256 MiB).
- [ ] The poker client is no slower with Rail running: compare its CPU and
      how it feels, with Rail quit and with Rail running.

**C12. High-DPI and two displays.**
- [ ] At the display's scaling (Windows 150 % or more; a Retina Mac), the
      panels are sharp and at their seats.
- [ ] Drag a table to the second display, especially one with a different
      scaling, and back: the panels follow, change size with the display's
      scale and stay at their seats.

**C13. macOS: Spaces and full screen.**
- [ ] Move a table to another Space (desktop): its panels are not shown on
      this one. Switch to its Space and they appear there.
- [ ] Full screen a table: the panels are on it. Leave full screen: the
      panels are back on the window.

**C14. macOS: the title bar.**
- [ ] The panels line up with the seats vertically, not shifted down or up
      by the height of a title bar (about 28 points). A client that draws
      its own title bar would shift them. Note it, with a screenshot (names
      blurred).

**C15. The client's own life cycle.**
- [ ] Close a table: its panels go. Quit the client: every panel goes.
- [ ] Quit Rail and start it again with tables open: each table shows its
      numbers again at once, without waiting for a hand.

---

## 3. Results

Fill one line per room and system: **pass**, **fail** (with the note's
number), or **n/a** (with why).

| | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | C11 | C12 | C13 | C14 | C15 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PokerStars, Windows | | | | n/a | | | | | | | | | n/a | n/a | |
| PokerStars, macOS | | | | n/a | | | | | | | | | | | |
| Winamax, Windows | | | | n/a | | | | | | | | | n/a | n/a | |
| Winamax, macOS | | | | n/a | | | | | | | | | | | |
| ACR, Windows | | | | | | | | | | | | | n/a | n/a | |
| ACR, macOS | | | | | | | | | | | | | | | |

---

## 4. What to send back

In a pull-request comment, or a file under `docs/research/` added in a
pull request:

1. **The kit's reports**: the `.json` and `.md` files from
   `target/twelve-tables/`, one pair per machine, plus the `R3.13` lines on
   the Mac. These hold only the simulator's data.
2. **The results table** above, and a note for every fail and n/a.
3. **The numbers** you noted for C9 (latency) and C11 (CPU and memory with
   12 real tables), with each machine's model, processor and display
   scaling.
4. **C10's answer per room**: whether a hand is written in one burst after
   it ends.
5. **Screenshots only where a note needs one, every name blurred**: your
   screen name, opponents' names and chat. Never send a hand history, an
   account id or an e-mail address.

What happens with it:

- A fail in C2, C4 or C14 fixes that room's `seatLayouts` or title bar in
  `sites.json`.
- A fail in C5 or C13 becomes a tracking fix (R3.5 / R3.13 follow-up).
- A fail in C10 adds a per-room "hand finished" check to the reader before
  that room's `tables` block may stay verified (R3.7).
- A fail in C1 or C8 stops the release until it is fixed.

When every room passes on both systems, Phase 3's exit criterion is met on
real clients and the plan's Phase 3 summary records the date.

---

## 5. Tiling and the RNG, per room (T6)

Table tiling moves and resizes a room's table windows; the RNG draws a
number over them. Each has its own policy per room, separate from the HUD's
([`TILING-POLICIES.md`](TILING-POLICIES.md), `config/sites.json`):

| Room | Tiling | RNG | What to check |
| --- | --- | --- | --- |
| PokerStars | true | null | the whole of 5.2; RNG: R0 only |
| ACR | true | null | the whole of 5.2; RNG: R0 only |
| WPT Global | true | false | the whole of 5.2 (no HUD there: no panels to follow); RNG: R0 |
| CoinPoker | true | false | the whole of 5.2 (no HUD there); RNG: R0 |
| Winamax, GGPoker, partypoker, Unibet | false | false | only T13: nothing moves |

One sitting per machine does all of it: about 45 minutes per room and
system, plus 15 minutes for section 6. Play money, sitting out or folding,
is enough everywhere (P6).

### 5.1 Before you start

- [ ] Everything in [section 0](#0-before-you-start) that is not the HUD's:
      the machine's display setup noted, the client installed and its
      version noted, a Rail build from `staging`.
- [ ] **`rail-hud` in a terminal**: beside `Rail.exe` / in
      `Rail.app/Contents/MacOS/`, or `cargo build --release -p rail-hud`.
      On a Mac the terminal needs the Accessibility permission
      ([`CAPTURING-TABLES.md`](CAPTURING-TABLES.md#on-macos-r311)).
- [ ] **For T6 - T12 only**: the room's `tables` block merged into
      `staging` and built (T1 - T5 produce what that block needs, so the
      first sitting may stop after T5 and the second do the rest).
- [ ] If you have them: a second monitor, and a display scale other than
      100 % on one of the two (Windows: Settings, Display, Scale).

### 5.2 The checks

Copy this block once per room and system and tick each box. Paste the
outputs it asks for **after reading them through** (they are redacted, but
check for your screen name anyway; add `--you <name>` if it shows).

```text
Room: ______   System: Windows / macOS   Client version: ______
Displays: ______ (scale)   ______ (scale)   Rail build: ______
Program name (--list-windows): ______
```

**T1. The windows, as the tiler sees them.** Open 4 tables (two kinds if the
room has them: cash and a tournament) and the lobby.
- [ ] `rail-hud --list-windows --process <exe>`: each table has a `frame:`
      line (outer rect and insets) and a `size:` line (resizable). Paste it.
- [ ] Note whether a table's `resizable` is `no` (the client then only
      takes positions, never sizes).

**T2. The title regex.** Write one with a `table` group (as in
[`CAPTURING-TABLES.md`](CAPTURING-TABLES.md#from-the-capture-to-sitesjson)).
- [ ] `rail-hud --list-windows --process <exe> --try-title "<regex>" --room <id>`:
      every table shows `try: table "..."` and
      `as <id>: ... tiling permitted`; the lobby and every other window
      `try: no match`.

**T3. One placement, auto grid.** With the 4 tables open and the mouse
left alone:
- [ ] `rail-hud --tile-check --process <exe> --room <id> --try-title "<regex>"`
      (without `--room` / `--try-title` once the room has its block).
      Every table is `placed`; none `FAILED`. Paste the whole output.
- [ ] By eye: the tables sit edge to edge, no overlap, no gap you can see,
      nothing under the taskbar / menu bar / Dock.
- [ ] Note from the output: `SIZE REFUSED` lines (the size the client kept),
      `aspect ... CHANGED`, and the slowest move in ms.
- [ ] `rail-hud --tile-check --restore`: every table back where it was.

**T4. Many tables.** Open as many tables as you can, at least 9 (12 if the
room lets you).
- [ ] `--tile-check` again: all placed; note the smallest size the client
      accepted (a `SIZE REFUSED` line here is the room's minimum size).
      Paste the summary line and any `SIZE REFUSED` lines.
- [ ] `--tile-check --restore`.

**T5. A saved layout from a file (optional).** Save as `two.json`:
`{"id":"two","name":"Two","slots":[{"id":"a","rect":{"x":0,"y":0,"width":500,"height":1000}},{"id":"b","rect":{"x":500,"y":0,"width":500,"height":1000}}]}`
- [ ] With 2 tables: `--tile-check ... --layout two.json`: one table per
      half of the screen. `--restore`.

The rest needs the room's `tables` block in the build (5.1).

**T6. The Tables screen, auto grid.** In Rail: Tables, switch "Table
tiling" on, the room's "Tile <room>" on, layout "Auto grid".
- [ ] Open 4 tables one after another: each new one lands in a free cell;
      the grid is edge to edge.
- [ ] PokerStars and ACR: the HUD's panels follow the tables as they move
      and sit at their seats afterwards.
- [ ] The Tables screen's display preview shows the 4 tables where they
      are.

**T7. A saved layout.**
- [ ] Arrange the tables by hand, then "+ Layout", "Save current
      arrangement". Close every table and open them again: they go to the
      saved places.
- [ ] Switch back to "Auto grid": they are tiled again.

**T8. Closing and opening (gaps).** Auto grid, 4 tables.
- [ ] Close one: no table is left half off the screen; either the others
      stay where they are or the grid re-forms with larger tables - note
      which. No table jumps back and forth.
- [ ] Open a new one: it takes the free cell; no other table moves unless
      the grid's shape changed (e.g. from 4 to 5 tables).

**T9. The mouse rule (misclicks cost money).**
- [ ] Hold the left button down on a table's felt (do not release) while
      another table opens (or press "Re-tile" in the tray with the other
      hand): nothing moves while the button is down, and the new table is
      placed only after you let go (about 0.6 s later).
- [ ] Drag a tiled table somewhere by its title bar: it stays where you
      drop it (the Tables screen marks it "Moved by hand"); "Re-tile" puts
      it back in the grid.
- [ ] During a hand, act at a table (a check or a fold button) while a new
      table opens: the table you click is never moved under the pointer.

**T10. Two monitors** (skip without one).
- [ ] With 8 or more tables the auto grid uses both monitors; tables do not
      straddle the edge between them.
- [ ] Drag a table to the other monitor, then "Re-tile": it goes back into
      the grid.

**T11. Mixed scaling** (skip without two scales; Windows mainly).
- [ ] With one monitor at 100 % and the other at 125 % or more: the tables
      on each are edge to edge and the right size (not one scale's size on
      the other monitor).
- [ ] `--tile-check` lists both monitors with their scales; paste its
      `monitor` lines and one table per monitor.

**T12. A minimised table.**
- [ ] Minimise one tiled table: the others do not move.
- [ ] Restore it from the taskbar / Dock: it goes back to its cell.
- [ ] macOS: put one table in full screen: tiling leaves it alone; leave
      full screen: it is tiled again.

**T13. Rooms that refuse tiling stay untouched** (any of Winamax, GGPoker,
partypoker, Unibet that you have installed).
- [ ] Open two of its tables with tiling on: they never move; the Tables
      screen lists the room as not allowed.
- [ ] `rail-hud --tile-check --process <its exe> --room <its id> --try-title ".*"`
      refuses at once (exit code 6, "tiling refused"): nothing moves.

**RNG.** The RNG is allowed on no room yet (`rng.allowed` is `null` for
PokerStars and ACR - a question to their support is open - and `false`
elsewhere):
- [ ] **R0.** Switch the RNG on in the Tables screen: no table of any room
      shows a number. (When a room's `rng.allowed` becomes `true`, its
      check is: the number shows in the table's corner, rolls on a new
      hand, on a click and on the timer as set, can be dragged and keeps
      its place, and on ACR never covers the table's graphics.)

### 5.3 Results

**pass**, **fail** (with a note), or **n/a** (with why):

| | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | R0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PokerStars, Windows | | | | | | | | | | | | | | |
| PokerStars, macOS | | | | | | | | | | | | | | |
| ACR, Windows | | | | | | | | | | | | | | |
| ACR, macOS | | | | | | | | | | | | | | |
| WPT Global, Windows | | | | | | | | | | | | | | |
| WPT Global, macOS | | | | | | | | | | | | | | |
| CoinPoker, Windows | | | | | | | | | | | | | | |
| CoinPoker, macOS | | | | | | | | | | | | | | |
| Refused rooms (T13) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | | |

---

## 6. Window signals for dynamic slots (T7)

T7's dynamic slots (Action Required: a table moves to a slot while it is
your turn) need to know it is your turn **without reading the table**. The
only acceptable source is what the client itself does with its windows
([`TABLE-TILING.md`](TABLE-TILING.md) §4.6): many Windows clients flash the
taskbar button or bring the table to the front on your turn. This section
records, per room, whether such a signal exists and is reliable. Nothing
here changes what Rail does today.

`rail-hud --watch-signals` logs, with timestamps, for one program's windows
only: on Windows the taskbar flash (`FLASH`, the shell's `HSHELL_FLASH`),
the foreground window (`FOREGROUND`), the window order (`TOP-OF-DESKTOP`: a
table raised above every other program; `front-of-client`), minimise and
title changes; on macOS the window order only (a Dock bounce cannot be seen
by another program - note it by eye). It moves nothing and reads nothing
inside a table.

Per room and system (Windows first; macOS if the room has a Mac client):

1. **The client's own settings.** Look in its options for anything like
   "flash the taskbar / bring the table to front / play a sound when it is
   my turn". Note each one's name and default, and leave them at their
   defaults for the first run.
2. **Two tables, the client in the background.** Sit at two tables, then
   click on another program (a text editor) so the client is not in front.
3. Run, with a clock in view:
   `rail-hud --watch-signals --process <exe> --seconds 600 --you <name>`
4. Play about 20 hands. Each time it is your turn, note the time (to the
   second) and the table; act a few seconds later. Also note other things
   that happened: a new hand dealt while you were folded, a chat line, a
   tournament break or table move, a pop-up.
5. Run it again with the client's "flash / bring to front" options switched
   on (if it has them), for 10 hands.
6. Paste the log (it ends with a tally) after reading it through.

What to record per run (`yes` / `no` / `sometimes`):

```text
Room: ______   System: ______   Client version: ______   Settings: defaults / changed: ______
Your turn -> FLASH on that table's window:              ___  (delay, seconds: ___)
Your turn -> FOREGROUND / TOP-OF-DESKTOP on that table: ___  (delay: ___)
A signal when it was NOT your turn (which, when):        ___
The signal stops when you act / time out:                ___
macOS: the Dock icon bounced on your turn (by eye):      ___
```

A usable signal is one that comes **every** time it is your turn, on that
table's own window, within about a second, and not otherwise. The policy
side is separate: PokerStars' guide allows a script to react to the time
bank showing but not to a player's action, and "Action Required" needs its
own reading before T7 builds anything
([`TILING-POLICIES.md`](TILING-POLICIES.md)).

| | Flash on turn | Raise / foreground on turn | False signals | Client setting needed | Usable? |
| --- | --- | --- | --- | --- | --- |
| PokerStars, Windows | | | | | |
| ACR, Windows | | | | | |
| WPT Global, Windows | | | | | |
| CoinPoker, Windows | | | | | |
| PokerStars, macOS | n/a | | | | |
| ACR, macOS | n/a | | | | |

---

## 7. Tiling and signals: what to send back

In a pull-request comment, or a file under `docs/research/` added in a
pull request, per room and system - read every line first; the outputs are
redacted, but your screen name must not appear anywhere:

1. **The header block** of 5.2 (room, system, client version, displays,
   program name).
2. **T1**: the `--list-windows --process <exe>` output with 4 tables and
   the lobby open.
3. **T2**: the regex you settled on, and the `--try-title` output that shows
   it taking every table and no other window.
4. **The hand histories' table names** for those tables (only what follows
   `Table '`), as in [`CAPTURING-TABLES.md`](CAPTURING-TABLES.md#what-to-paste-back),
   if the room's HUD is allowed (PokerStars, ACR).
5. **T3 and T4**: the full `--tile-check` output with 4 tables, and the
   summary plus any `SIZE REFUSED` lines with the most tables; whether
   `--restore` worked.
6. **T11**: the `monitor` lines and one table per monitor, if you have two
   scales.
7. **The results table** of 5.3, and a note for every fail and n/a.
8. **Section 6**: the record block per run and the `--watch-signals` log
   with its tally.
9. Screenshots only where a note needs one, every name blurred.

What happens with it:

- Items 1 - 4 become the room's `tables` block in `config/sites.json`
  (processes per system, the title regex, `verified`, a source line
  "Observed on ..."), the simulator's title format in
  `hud/rail-hud-sim/rooms.json`, and the tests that pin them.
- Items 5 - 6 give the room's table geometry for the tiler: its aspect ratio
  (when the client keeps its own), its minimum client size, and its frame;
  they go into the source text now and into a `tables.geometry` field when
  `sites.json` has one.
- A fail in T3 - T12 becomes a tiling fix before the room's tiling is
  switched on for users; a fail in T13 or R0 stops the release.
- Item 8 decides whether T7's dynamic slots are possible on that room.
