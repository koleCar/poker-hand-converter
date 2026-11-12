# Table manager and RNG policies per room (T0)

Step T0 of the table-tiling plan (`docs/research/TABLE-TILING.md` §3, on
the `docs/table-tiling` branch): for every entry of `config/sites.json`,
whether the room permits, while its client runs,

- **(a) tiling**: a table manager that only moves and resizes the room's
  table windows, and
- **(b) the RNG**: an on-screen random number generator drawn over its
  tables,

with the room's own page that says so and the date it was read. The
`tiling` and `rng` blocks of each entry are this table;
`core/rail-config/tests/sites.rs` (`TOOL_POLICIES`) and
`tests/test/sitesConfig.test.ts` pin it, so a change to any verdict is a
reviewed diff.

Both are separate from the HUD: `hud.allowed` decides neither. A room that
refuses a HUD can still allow a table manager (WPT Global, CoinPoker).

**Status: proposal, needs the owner's sign-off.** Read on 2026-11-11 from
Croatia, without signing in anywhere. The owner decided on 2026-11-11 that
Rail does not apply to partypoker's whitelist for now, and that Unibet is
`false` for both.

## Rules used

- `allowed: true` only where the room's **own** `https://` page says that
  table management / tiling software (or an RNG) is permitted, in general
  words or by naming the kind of tool.
- `allowed: false` where the room's own page prohibits it, where it keeps an
  explicit whitelist that does not name Rail (anything off the list needs
  approval or is prohibited), or where there is no desktop client (closed
  rooms, PokerBros, Rail's own format).
- `allowed: null` where it could not be established or the text is
  ambiguous. Compliance treats `null` as no (`Site::permits`,
  `rail_hud::compliance::Compliance::{tiling_permit, rng_permit}`).
- A network entry never allows (as for the HUD): its skins differ.
- A stricter verdict may come from the same operator's page for another
  market; a looser one may not.
- Secondary sources (news, affiliate guides, tool vendors) are context only,
  labelled as such, never the reason for `true`.
- Quotes are short (under 15 words); the rest is paraphrase. **Quote** marks
  what the page says; **Reading** marks the inference.

**Access.** As in October: pokerstars.com, 888poker.com and betfair.com are
blocked from Croatia (expired-certificate redirect). New since then:
`pokerstars.uk/poker/room/prohibited/` now answers with a 301 to
`poker.betfair.com/info/room-prohibited-software`, also blocked - the
PokerStars Reference Guide PDF on the CDN was read directly instead.
CoinPoker and BetOnline still answer scripted fetches with 403.

## Summary

| Entry | `tiling` | `rng` | Deciding source | Confidence |
| --- | --- | --- | --- | --- |
| pokerstars | **true** | null | Reference Guide PDF (21 Sep 2026) | high (tiling); RNG not addressed |
| acr | **true** | null | <https://www.acrpoker.eu/security/> 4.1.7 | high (tiling); RNG not addressed |
| wpt-global | **true** | false | <https://wptglobal.com/terms-and-conditions> Annex A 25 / 6 | high / medium-high |
| coinpoker | **true** | false | Terms and Conditions 2026 (PDF) | medium (policy page 403) / medium-high |
| ggpoker | false | false | <https://ggpoker.com/network/security-ecology-policy/> (20261029) | high |
| partypoker | false | false | <https://www.partypoker.com/en/poker/p/safer-poker> whitelist | high |
| unibet | false | false | <https://www.unibet.co.uk/promotions/poker-promotions/why-play-at-unibet> | high |
| winamax | false | false | Poker rules PDF (10 Oct 2023), section 1.2 | medium-high (approval route) |
| 888poker | null | false | <https://www.888.ca/security-and-privacy/user-agreement/> (Ontario) | low (tiling) / medium (RNG) |
| ignition (network) | null | null | <https://www.ignitioncasino.eu/terms-of-service> | - |
| ipoker (network) | null | null | RedStar Poker's page only | - |
| chico (network) | null | null | - (403) | - |
| weplay | null | null | - (no web terms) | - |
| pokerbros | false | false | no desktop client | high |
| closed rooms and networks | false | false | research docs | high |
| standard (format) | false | false | not a room | - |

So: tiling is proposed on **PokerStars, ACR, WPT Global and CoinPoker**,
and the RNG on **no room** yet. PokerStars and ACR are the two RNG answers
worth an e-mail to support.

## Per room

### PokerStars - tiling `true`, RNG `null`

- Source: "Third Party Tools and Services Policy: Reference Guide", last
  updated 21 Sep 2026,
  <https://cms.rationalcdn.com/v3/assets/blteecf9626d9a38b03/blt02c85850f029e8fb/tpt-reference-guide.pdf>,
  read 2026-11-11 (the same PDF R3.0 read; the policy page it hangs from now
  redirects to a blocked Betfair page).
- **Quote** (Gameplay Utility and Hotkey Scripts, permitted scripts):
  "Tiles tables based on big blind amount".
- **Quote** (prohibited scripts): "Repositions a table if dealt a premium
  pair". Scripts may use what is known before the cards are dealt (stakes,
  stack, absolute position) plus street, pot, bet size and whether the time
  bank shows - never card values, relative position, or any player's action.
- **Reading:** a table manager that places tables by layout, room or stakes
  is permitted. Rail's tiling must never react to the hand in play. This
  matters for T7: an "In-Hand" slot triggered by hero's VPIP uses a player's
  action, which the Guide forbids a script to consider; "Action Required"
  (hero's turn) is not on either list and needs its own check.
- RNG - **Quote**: tools that "randomize the size of bets are prohibited";
  a tool that "reduces the requirement of a human to make decisions" is
  prohibited at all times; so is delaying a decision by a randomised time.
- **Reading:** the Guide does not mention an RNG that only shows a number. It
  does not size bets or act, but it can stand in for the player's choice
  between actions, which is close to "reduces the requirement ... to make
  decisions". Ambiguous, so `null`. To settle: ask PokerStars support in
  writing whether an on-screen random number generator is permitted.
- Confidence: high for tiling (named example), none either way for the RNG.

### ACR (Americas Cardroom) - tiling `true`, RNG `null`

- Source: "Policies", <https://www.acrpoker.eu/security/>, read 2026-11-11.
- **Quote** (4.1.7, accepted): "Table arranger tools that tile up tables
  based on player preferences."
- Still binding (4.2.11): no tool may change or overlap ACR's own table
  graphics, which ACR uses for bot detection. Moving and resizing the
  window leaves the client's layout alone; the RNG widget (T4) would have to
  stay off the table graphics like the HUD's panels (`noOverlapTableGraphics`).
- RNG: no item names one. 4.1.0 accepts any tool that improves playing
  performance "provided it doesn't pose any threat" to the games'
  integrity; 4.2.3 prohibits real-time advice on how to act.
- **Reading:** an RNG gives no advice from the game state, so it is not
  4.2.3's tool, and 4.1.0 reads as allowing it - but it is not named, and
  whether it threatens integrity is ACR's call. `null`; ask ACR support.
- Confidence: high for tiling; RNG not addressed.

### WPT Global - tiling `true`, RNG `false`

- Source: "Terms and Conditions", Annex A (prohibited activity list),
  <https://wptglobal.com/terms-and-conditions>, read 2026-11-11 (no version
  or date on the page).
- **Quote** (item 25, in parentheses after prohibiting automated seating,
  betting or table monitoring software): "table organization and resizing
  tools are permitted".
- RNG - **Quote** (item 6, prohibited third-party add-ons): any tool that
  "aids in decision making of bet sizing or strategy".
- **Reading:** an RNG at the table exists to pick between actions (strategy),
  so `false`.
- The HUD stays `false` (item 24), so WPT Global is the clearest case of
  tiling without a HUD.
- Confidence: high for tiling (explicit), medium-high for the RNG.

### CoinPoker - tiling `true`, RNG `false`

- Source: CoinPoker's "Terms and Conditions of Use" (2026),
  <https://coinpoker.com/wp-content/uploads/2026/06/Terms_and_Conditions_2026.pdf>,
  definitions (k) and (l), read 2026-11-11.
- **Quote** ((l) "Permitted Tools"): they "may include table management
  software, hotkey tools", provided they comply with the Third-Party Tools &
  Software Policy and give no gameplay assistance or strategic advantage.
- The policy page itself, <https://coinpoker.com/third-party-tools/>,
  answers scripted fetches with 403 (as in October). **Secondary context**:
  news and affiliate reports of it (SoMuchPoker, updated 16 Oct 2026; other
  guides) say stacking, tiling and arranging windows stays acceptable within
  reasonable limits, and that a HUD open only for other rooms is fine.
- RNG - **Quote** ((k) "Prohibited Software" includes): "decision engines"
  and recommendation engines, and any overlay giving a direct or indirect
  gameplay advantage or strategic assistance.
- **Reading:** an RNG overlay is an indirect strategic aid, so `false`.
- Confidence: medium for tiling (the operator's own terms name table
  management software, but the policy they defer to was not read
  first-hand); medium-high for the RNG. The owner should open the policy
  page in a browser before release.

### GGPoker - tiling `false`, RNG `false`

- Source: "Security & Ecology Policy", current version 20261029,
  <https://ggpoker.com/network/security-ecology-policy/>, read 2026-11-11.
- **Quote** ("Prohibited Use of Auxiliary Tools or Services"): any external
  software that "supports, interacts with, augments, or manipulates a
  client" is prohibited; general-purpose utilities only if they run
  "completely independently".
- **Reading:** a table manager moves and resizes the client's windows - it
  interacts with the client - and an RNG drawn over the table augments the
  game. Section 2 also bans real-time assistance from any software or app.
- **Secondary context:** GGPoker's announcement of 15 Oct 2026, as reported
  (gambling.com, updated 19 Oct 2026), names Jurojin and Intuitive Tables
  among the banned tools, and AutoHotkey.
- This contradicts the plan's §3 example, which hoped GGPoker might allow
  tiling though it refuses HUDs.
- Confidence: high.

### partypoker - tiling `false`, RNG `false`

- Source: "Fairer Place to Play",
  <https://www.partypoker.com/en/poker/p/safer-poker>, read 2026-11-11
  (rendered by script; read through a fetch service).
- **Quote:** "the only third-party tools that are permitted" while the
  client is open are ten: PartyCaption, StackAndTile, PlaceMint, Table
  Tamer, StarsHelper, Mosaic 2, IntuitiveTables, Universal Replayer,
  Jurojin Poker, Slot Poker Pro. Any other tool is prohibited while the
  client runs. The page also refuses permission to timing randomisers.
- An explicit whitelist without Rail, so `false` for both. Owner,
  2026-11-11: Rail will not apply for now.
- Confidence: high.

### Unibet Poker - tiling `false`, RNG `false`

- Source:
  <https://www.unibet.co.uk/promotions/poker-promotions/why-play-at-unibet>,
  read 2026-11-11. **Quote:** "No 3rd party software is allowed at Unibet
  Poker".
- Matches Jurojin's own list of rooms where its tiling does not work.
- Confidence: high. Owner, 2026-11-11: `false` for both.

### Winamax - tiling `false`, RNG `false`

- Source: the poker rules linked from <https://www.winamax.fr/cgu-poker>,
  <https://operator-front-static-cdn.winamax.fr/img/content/poker/2023/20231010_cgu/reglement-poker.pdf>
  (10 Oct 2023), section 1.2 "Aide au moyen d'un logiciel", read 2026-11-11.
- **Quote:** a player who wants a helper program "qui n'est pas disponible
  dans la liste" needs the prior agreement of integrity@winamax.com.
- The authorised list: odds and starting-hand software; trackers and
  profiling ("HoldemManager, PokerTracker, Xeester, etc."); hotkey programs
  that do not influence play ("WinHotKey, etc."). Table managers and RNGs
  are not a listed category.
- **Reading:** a list plus "anything else needs approval" is a whitelist that
  does not name Rail's tiling or RNG, so `false` under the rules. Tiling is
  plainly not the kind of aid the prohibited list targets (bots, solvers,
  ICM, ranges, seating scripts, VMs), so this is the verdict most likely to
  change: one e-mail to integrity@winamax.com describing a table manager
  that only moves windows. The RNG is less likely to be approved.
- Confidence: medium-high (literal reading of the approval clause).

### 888poker - tiling `null`, RNG `false`

- 888poker.com is still blocked from Croatia. Read instead: the 888 Ontario
  user agreement, <https://www.888.ca/security-and-privacy/user-agreement/>,
  version 2.0, last updated 5 Aug 2026, read 2026-11-11.
- **Quote** (Permitted Aids): tools that "improve your experience without
  influencing the game itself", for example enhanced display and keyboard
  shortcuts. Anything not on the Permitted Aids list is a prohibited aid.
- **Reading:** a table manager is an "enhanced display" tool, so on the
  Ontario agreement tiling would be `true`. But that is a regulated market's
  agreement, not 888poker.com's, and a looser verdict needs the room's own
  page: `null`. An RNG exists to influence the decision, so it is not a
  display aid and not on the list: `false` (a stricter verdict may come from
  a sibling market).
- To settle tiling: the owner reads 888poker.com's terms from outside
  Croatia (or asks 888 support in writing).
- Confidence: low for tiling, medium for the RNG.

### Ignition / Bovada / Bodog (network) - `null`, `null`

- Source: Ignition's terms of service,
  <https://www.ignitioncasino.eu/terms-of-service> ("Latest Update: November
  10, 2020"), read 2026-11-11.
- **Quote** (13.3(a)): users may not use robot software or "external player
  assistance programs". Nothing on table managers or RNGs.
- **Reading:** a table manager is not an assistance program in any obvious
  sense; an RNG might be. Neither is decided by the text, and the entry is a
  network, which never allows. Both `null`.

### iPoker (network) - `null`, `null`

- Per skin; a network entry never allows. One skin's page could be read:
  RedStar Poker, <https://www.redstarpoker.eu/play_poker/prohibited_software>
  (undated), read 2026-11-11. **Quote:** "you can use only those programs
  that help you collect and save statistics" and hand histories; software
  that "advises or removes the decision process" is prohibited.
- **Reading:** on RedStar, both would be `false` (a whitelist without table
  managers; an RNG removes part of the decision). Other skins (bet365,
  Betfair, William Hill, Betsson ...) were not read. A skin entry split out
  later gets its own verdict.

### Chico (network) - `null`, `null`

- BetOnline's help centre and site still answer scripted fetches with 403;
  no skin's own text on table managers or RNGs could be read. A search found
  nothing official. The owner can read BetOnline's poker rules in a browser.

### WePlay - `null`, `null`

- No official website with terms; the rules are inside the app. The owner
  has an account: read the in-app terms (or ask support) for both.

### PokerBros - `false`, `false`

- Mobile-only club app, no desktop client
  (`docs/research/hh-formats/pokerbros.md`): no table window to arrange or
  draw on. Re-check if a desktop client appears.

### Closed rooms and networks - `false`, `false`

MicroGaming, Ongame, Entraction, Boss Media, Merge, Full Tilt and Run It
Once: no client exists (their research docs, as in `HUD-POLICIES.md`).

### `standard` - `false`, `false`

Rail's own text format, not a room.

## The Action Required slot (T7) - `actionSlot`, `null` everywhere

T7 adds a third block per entry, `actionSlot`: may tiling move a table
into an "Action Required" slot while the room's client **itself** signals
that it is the user's turn, and on which signal (`signal`: per system,
`flash` - the taskbar button flashes -, `foreground` or `raised`; `null`:
none usable). The engine uses nothing else: no pixel reading, no screen
capture, nothing read inside the table - only the client's own window
signals (`rail-hud --watch-signals`, REAL-CLIENT-CHECK.md §6).

Rules, enforced by the loader and the schema: `allowed: true` only on a
room, with an `https` source and a date (as for `tiling` and `rng`),
**only where `tiling` is `true` too**, and only with a signal for at least
one system; a `signal` in any other block is refused. A downloaded copy can
only withdraw the slot (stricter-only, like every block), and the signal
is always the shipped copy's - a download cannot point the slot at another
signal. There is **no "In-Hand" slot**: moving a table because the user is
in the hand reacts to a player's action, which PokerStars' Reference Guide
forbids a script to do.

Written 2026-11-12. **Every entry is `null` (unknown, so no) with
`signal: null`**, because nothing below has been checked yet:

| Entry | `actionSlot` | What must be settled before it can be `true` |
| --- | --- | --- |
| pokerstars | null | The Reference Guide forbids repositioning a table on card values, relative position or any player's action ("Repositions a table if dealt a premium pair"); a table moved on the client's own your-turn signal is on neither list. Ask PokerStars in writing; capture the signal (§6). |
| acr | null | 4.1.7 accepts table arrangers that tile by player preference; moving on the turn signal is not addressed. Capture the signal (§6); ask ACR if in doubt. |
| wpt-global | null | Annex A item 25 permits table organisation and resizing tools; moving on the turn signal is not addressed. Capture the signal (§6). |
| coinpoker | null | The Terms name table management software and hotkey tools as permitted; the third-party tools page could not be read. Read it in a browser; capture the signal (§6). |
| 888poker, ipoker, chico, ignition, weplay | null | Their tiling policy is not established either. |
| ggpoker, winamax, partypoker, unibet, pokerbros, closed rooms, standard | null | Moot: tiling itself is not allowed (or there is no desktop client). |

**Turning any room on** needs, in this order: the room's own text read and
quoted here (or its written answer), the client's turn signal captured on
each system with `rail-hud --watch-signals` (REAL-CLIENT-CHECK.md §6: the
signal comes **every** time it is the user's turn, on that table's window,
within about a second, and not otherwise), and **the owner's signed
verdict** - then the block (`allowed`, `source`, `checkedAt`, `notes`,
`signal`) and the pins in `core/rail-config/tests/sites.rs` and
`tests/test/sitesConfig.test.ts` change in one reviewed diff.

## What the verdicts mean for the build

- T2 (tiling) acts on a window only with a `TilingPermit`; T4 draws the RNG
  only with an `RngPermit`. Today no room has an `RngPermit`, so T4 can be
  built and tested on the simulator but shows nothing on a real client until
  a room says yes.
- Tiling must not react to the hand in play (PokerStars forbids repositioning
  a table by cards or by any player's action). Static tiling - by layout,
  room, stakes, number of tables - is what the yes covers.
- On ACR the RNG widget, if ever allowed, must keep off the client's table
  graphics like the HUD's panels.
- (T7) The Action Required slot moves a table only with an `ActionPermit`
  (`actionSlot` and `tiling` allowed, a signal for this system): today no
  room, so the slot can be drawn in a layout only once one does (the
  editor greys it with "No room allows this yet") and the HUD watches no
  client's signals.

## Re-check before every release (plan section 12)

For every entry with `tiling.allowed` or `rng.allowed` `true` (today
PokerStars, ACR, WPT Global and CoinPoker for tiling), and for every `null`
the release wants to turn on:

1. Open the `source` page (from outside Croatia where it is blocked) and
   confirm the deciding sentence is still there. PokerStars: the Reference
   Guide's "Last Updated" date and the "Gameplay Utility and Hotkey
   Scripts" lists. ACR: 4.1.7 and 4.2.11. WPT Global: Annex A items 6 and
   25. CoinPoker: the Terms' definitions (k) and (l), and the
   third-party-tools page in a browser.
2. Look for a newer policy version (GGPoker's version string, Winamax's PDF
   date, partypoker's whitelist) and for news of a change - news is a prompt
   to re-read, never a source.
3. Record the outcome: a changed verdict is a change to `config/sites.json`
   and to `TOOL_POLICIES` in `core/rail-config/tests/sites.rs` (and the
   TypeScript pin); an unchanged one moves `checkedAt` (and
   `TOOLS_CHECKED_AT`). `npm run hud:policy-check` in `tests/` lists every
   allowance - HUD, tiling and RNG - and fails on one older than 90 days.
4. Between releases, a room that withdraws its permission is switched off
   through the remote `sites.json` (the merge only lets it get stricter; a
   downloaded file without the blocks leaves them as shipped).
5. Open questions that can turn a `null` or `false` into `true`, each needing
   the owner's sign-off: PokerStars and ACR support on the RNG;
   integrity@winamax.com on tiling; 888poker.com's own terms; WePlay's
   in-app terms; partypoker's whitelist if Rail ever applies.
