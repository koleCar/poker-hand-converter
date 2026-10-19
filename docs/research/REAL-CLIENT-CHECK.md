# Real-client check: the HUD on PokerStars, Winamax and ACR

Phase 3 ends when the HUD runs on 12 tables at once, on Windows and macOS,
within the latency budget, and only on rooms whose HUD policy allows it
(docs/RAIL-PLAN.md, Phase 3 exit; R3.14). CI checks this on the table
simulator. This page is the owner's procedure for the real clients: what to
have ready, what to check on each room and system, and what to send back.

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
