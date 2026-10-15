# HUD policies per room (R3.0)

The compliance check of `docs/RAIL-PLAN.md` R3.0 and guideline section 7: for
every entry of `config/sites.json`, whether the room allows a third-party
HUD, the room's own page that says so, the date it was read, and whether the
client writes hand histories live and keeps names persistent. The `hud`
block of each entry is this table; `core/rail-config/tests/sites.rs`
(`hud_policies_are_the_signed_list`) pins it, so a change to any policy is a
reviewed diff.

**Status: proposal, needs the owner's sign-off.** Read on 2026-10-14 from
Croatia, without signing in anywhere.

## Rules used

- `allowed: true` only where the room's **own** `https://` page says that
  third-party HUDs or trackers are permitted. The restrictions it sets go
  into `notes` and into the per-room section below; the HUD (R3.8 - R3.10)
  has to keep them.
- `allowed: false` where the room's own page prohibits them, or where a HUD
  cannot work: the room is closed, writes no hand histories while you play,
  or hides names. `notes` says which.
- `allowed: null` where it could not be established. The HUD treats `null`
  as `false` (guideline section 7; `Site::hud_permitted`).
- Secondary sources (forums, tracker vendors, affiliate reviews) are context
  only, labelled as such, and never the reason for `true`.
- Quotes are short (under 15 words); the rest is paraphrase.

**Access from Croatia.** The Croatian tax administration blocks several
gambling domains (a redirect to `porezna-uprava.gov.hr/BlokiraniSadrzaj`, so
the fetch fails on an expired certificate): pokerstars.com, 888poker.com,
betfair.com and 888poker.co.uk among them. Where that happened, the same
operator's page on another of its domains was read, and the entry says so.
winamax.fr's HTML refuses a plain fetch from here (redirect loop) but its
rules PDF on the CDN does not. Several US-facing sites (CoinPoker,
BetOnline, SportsBetting, TigerGaming) answer scripted fetches with 403.

## Summary

| Entry | Proposed `allowed` | Source (own page) | Live files | Persistent names | Operating | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| pokerstars | **true** (restricted) | <https://www.pokerstars.uk/poker/room/prohibited/> + Reference Guide | yes (unverified; local saving reportedly off by default) | yes | yes | high |
| winamax | **true** | <https://www.winamax.fr/cgu-poker> (rules PDF linked there) | yes (unverified) | yes | yes | high |
| acr | **true** (restricted) | <https://www.acrpoker.eu/security/> | yes (unverified) | yes (data-mined dialect: numeric ids) | yes | high |
| ggpoker | false | <https://ggpoker.com/network/security-ecology-policy/> | no (verified, macOS) | no (hashed) | yes | high |
| partypoker | false | <https://www.partypoker.com/en/poker/p/safer-poker> | no (MyGame downloads) | no (opponents hidden in downloads) | yes | medium-high |
| unibet | false | <https://www.unibet.co.uk/promotions/poker-promotions/why-play-at-unibet> | not established | yes | yes | high |
| coinpoker | false | <https://coinpoker.com/third-party-tools/> | no (verified, macOS) | yes | yes | medium (page read through a search engine's copy) |
| wpt-global | false | <https://wptglobal.com/terms-and-conditions> | no (no export since June 2026) | - | yes | high |
| ignition | false (anonymous) | <https://www.ignitioncasino.eu/poker/incognito-poker> | no (downloads) | no (positional) | yes | high |
| pokerbros | false (no desktop client) | `docs/research/hh-formats/pokerbros.md` | no | - | yes | high for "no desktop client"; policy not read |
| 888poker | null | <https://www.888.ca/security-and-privacy/user-agreement/> (Ontario) | not established | yes | yes | low |
| ipoker (network) | null | - | per skin | per skin | yes | - |
| chico (network) | null | - | not established | yes | likely (BetOnline's client help is online) | - |
| weplay | null | - | yes (verified, macOS) | yes | yes | - |
| microgaming, ongame, entraction, bossmedia, merge (networks) | false (closed) | research docs | - | - | no | high |
| fulltilt, runitonce | false (closed) | research docs | - | - | no | high |
| standard (format) | false (not a room) | - | - | - | - | - |

No network entry was split: for iPoker and Chico no skin's own page that
allows a HUD could be read (see below). R0.12's rule stands - a network can
never allow a HUD - so both stay `null`.

`operating` was changed for one entry: `ignition` is now `true` (its own
poker pages are live in October 2026, Ignition and Bovada both).

## Per room

### PokerStars - `true`, with restrictions

- Source: "Third Party Tools and Services Policy",
  <https://www.pokerstars.uk/poker/room/prohibited/>, read 2026-10-14
  (pokerstars.com is blocked from Croatia; the UK page is the same
  operator's). The page links a Reference Guide PDF, "Last Updated:
  September 21, 2026":
  <https://cms.rationalcdn.com/v3/assets/blteecf9626d9a38b03/blt02c85850f029e8fb/tpt-reference-guide.pdf>.
- Policy: in-game statistics are a permitted tool - "Tools or services that
  monitor and display numerical-based statistics in-game" - using only
  information from your own play.
- Restrictions (Reference Guide, "Player Tracking Databases and HUDs"), each
  a requirement on Rail's HUD:
  - statistics only from hands the user personally played; a tracker may
    import at most 30 observed hands per session to seed a HUD;
  - statistics are raw counts over opportunities, not adjusted by
    population tendencies;
  - colour or font may change "based on two different thresholds", fixed
    raw values, never percentiles;
  - pop-ups are allowed;
  - not allowed: statistics split by card values (so R2.10 custom
    statistics with card predicates must not show on PokerStars); a display
    that changes with the game state other than the game format and the
    opponent's name (no per-position or per-stack switching); a display
    that changes with the opponent's tendencies; rating, labelling or
    categorising players; graphs of more than one data point; hand charts.
  - Prohibited at all times: datamining and mass sharing of hands or
    statistics; tools for ring-game selection; seating by opponent stats.
  - Prohibited while the client is open: advanced reference material, GTO /
    range / ICM / Nash tools, AI advice (matches guideline A10).
- Live files: yes per README section 6 and `pokerstars.md` section 12
  (inferred; local saving reportedly off by default). Names: persistent.
- To check by hand: whether R2.5's sample-size dimming counts as a display
  "changing" - it depends on sample size, not game state or tendencies, so
  it reads as allowed, but it is the owner's call.

### Winamax - `true`

- Source: "CGU : reglement poker", <https://www.winamax.fr/cgu-poker>, read
  2026-10-14 through a fetch service (the HTML refuses a plain fetch from
  Croatia); its only PDF link, read in full:
  <https://operator-front-static-cdn.winamax.fr/img/content/poker/2023/20231010_cgu/reglement-poker.pdf>
  (10 Oct 2023), section 1.2 "Aide au moyen d'un logiciel".
- Policy: authorised are programs that store your own statistics and hand
  history and analyse opponent data you collected yourself while playing
  ("profiling") - "Exemples : HoldemManager, PokerTracker, Xeester".
- Prohibited: bots; solvers; ICM calculators; dynamic ranges and equity
  calculators; seating scripts; VMs and remote control; "certaines
  fonctionnalites dynamiques de Hand2Note"; compiling hands of other
  accounts, data mining and data sharing.
- Condition: a tool not in the list needs prior approval from
  integrity@winamax.com. The list is by category with "etc.", and Rail is a
  profiling tool of the listed kind, so `true` stands; an e-mail to
  integrity@winamax.com before release is the safe step (owner).
- Covers winamax.fr. winamax.es was not read.
- Live files: yes per README section 6 (unverified; no real file name known,
  `winamax.md` section 12). Names: persistent.

### ACR (Americas Cardroom) - `true`, with restrictions

- Source: "Policies", <https://www.acrpoker.eu/security/>, read 2026-10-14
  (the FAQ <https://faq.acrpoker.eu/tag/hud/> points there).
- Policy 4.1.3 accepts "Hand trackers and Heads Up Display (HUD) type tools"
  showing numeric stats, based only on your own hand history, and not
  including information from a current hand in play.
- Prohibited: 4.2.7 data-mined hands; 4.2.9 older tracker versions with
  non-compliant features; 4.2.10 seating scripts incl. "Player labeling";
  real-time advice (4.2.1 - 4.2.6); and 4.2.11 tools that change or overlap
  ACR's own table graphics, which it uses for bot detection - HUD panels
  must not cover the client's own table elements (R3.6 layouts).
- Not covered: Black Chip Poker, True Poker, Ya Poker (other WPN skins; not
  entries).
- Live files: yes per README section 6 (unverified). Names: persistent; the
  rare data-mined dialect writes numeric ids.

### GGPoker - `false`

- Source: "Security & Ecology Policy", current version 20260313,
  <https://ggpoker.com/network/security-ecology-policy/>, read 2026-10-14.
- "Prohibited Use of Auxiliary Tools or Services": tools that aid poker
  actions, "solvers, charts, or HUDs are prohibited"; only GG's own Smart
  HUD and PokerCraft.
- Also no live files (verified on macOS in R1.4) and hashed opponents.
- **For the owner, beyond the HUD:** section 7.2 says importing hand
  histories is permitted only to track your own play, and then bars using
  "any 3rd party tools to import and/or convert hand histories" from the
  tables or PokerCraft; 7.3 bars sharing your hand histories with another
  party. Read literally, Rail's GG import itself may fall under 7.2. Not
  part of R3.0's decision, but it should be decided before Rail advertises
  GG import.

### partypoker - `false`

- Source: "Fairer Place to Play",
  <https://www.partypoker.com/en/poker/p/safer-poker>, read 2026-10-14
  through a fetch service (the page is rendered by script).
- Policy: "the only third-party tools that are permitted" while the client
  runs are ten table and caption tools (PartyCaption, StackAndTile, Table
  Tamer, Jurojin and others); any other tool is prohibited while the client
  runs; Super HUD is named as prohibited. Hand histories are downloaded from
  MyGame afterwards, with opponents hidden, so trackers "will not work in
  real time".
- Confidence medium-high: the text came through a summarising fetch, not
  raw HTML.

### Unibet Poker - `false`

- Source: <https://www.unibet.co.uk/promotions/poker-promotions/why-play-at-unibet>,
  read 2026-10-14: "No 3rd party software is allowed at Unibet Poker".
- Corroborated by Unibet's Poker Rules v3.0 (14 Oct 2024), rule 16: Unibet
  may detect and prevent prohibited programs, naming hand trackers and HUDs
  (<https://www.unibet.co.uk/polopoly_fs/1.2648262.1733218258!/menu/standard/file/EN%20Game%20Rules%20full%20.com%203.0%20(1).pdf>).

### CoinPoker - `false`

- Source: "Third-Party Tools & Software Policy",
  <https://coinpoker.com/third-party-tools/>. The page answers scripted
  fetches with 403; its content was read through a search engine's copy on
  2026-10-14 (policy dated 25 June 2026): HUDs and statistical overlays such
  as PokerTracker, Hold'em Manager, Hand2Note and DriveHUD are prohibited
  during CoinPoker play; only CoinPoker's built-in HUD is permitted.
- Secondary context: news sites (PokerListings, SoMuchPoker) report the ban
  from 9 June 2026, reversing CoinPoker's 2025 allowance.
- Independently `false` anyway: no local hand histories (verified on macOS
  in R1.4).

### WPT Global - `false`

- Source: <https://wptglobal.com/terms-and-conditions>, Annex A
  (prohibited activities) item 24: "Using or attempting to use HUDS",
  read 2026-10-14.
- Also writes no hand-history files (no export since June 2026,
  `docs/unsupported-formats.md`).

### Ignition / Bovada / Bodog (network) - `false`

- Source: <https://www.ignitioncasino.eu/poker/incognito-poker>, read
  2026-10-14: "User IDs are hidden. Instead, a number is assigned to each
  player." A HUD has no persistent name to attach to; hand histories are
  downloaded afterwards and positional (`ignition-bodog-bovada.md` section
  11). The room's own pages present this as protection against HUDs.
- Operating: yes (ignitioncasino.eu/poker and bovada.lv/poker live).

### PokerBros - `false`

- Mobile-only club app, no desktop client and no live files
  (`docs/research/hh-formats/pokerbros.md`): nothing for a desktop HUD to
  attach to. Its own third-party-tools policy was not looked up; if a
  desktop client ever appears, re-check.

### 888poker - `null`

- 888poker.com and 888poker.co.uk are blocked from Croatia; no dotcom
  policy page could be read.
- Read instead: the 888 Ontario user agreement,
  <https://www.888.ca/security-and-privacy/user-agreement/> (last updated
  5 Aug 2026), and the Danish one (8 Sep 2026). "Permitted Aids" include
  tracking software showing in-game statistics on the information you
  already have "at that specific table"; anything not on the list is a
  prohibited "Software Aid", and so are tools that collect information on
  players in your absence. Whether a cross-session database HUD fits "at
  that specific table" is unclear - it may mean the current session, like
  888's own built-in HUD - and these are the regulated-market agreements,
  not 888poker.com's.
- Secondary context: Hold'em Manager and Hand2Note support pages say a HUD
  is not allowed on SNAP (fast-fold) tables, and that 888's NJ / NV pools
  disallow HUDs.
- To settle: the owner reads 888poker.com's terms from outside Croatia (or
  asks 888 support in writing). Live files not established either.

### iPoker (network) - `null`

- Skins named by secondary sources for 2025-26: bet365, Betfair, William
  Hill, Betsson, Betsafe, Paddy Power, RedStar, Svenska Spel. None of their
  own pages that were reachable say anything about third-party HUDs
  (bet365's terms are silent; Betfair's integrity page and betfair.com are
  blocked from Croatia; Betsson's poker pages are silent).
- Secondary context: iPoker added a built-in HUD; guides say third-party
  HUDs are still allowed on the network. Not enough for `true`.
- Not split: no skin clearly allows a HUD on its own page. Live files and
  names per skin, not established.

### Chico (network) - `null`

- BetOnline, SportsBetting and TigerGaming answer scripted fetches with 403.
  A search engine's copy of BetOnline's help centre ("Poker Rules",
  <https://help.betonline.ag/en/articles/185234-poker-rules>) says trackers
  showing a HUD from your own play are permitted, but an older BetOnline
  rules page lists the same trackers as "banned while playing", and the
  page could not be read directly. BetOnline's own client help
  (<https://poker.betonline.ag/m/help/hud.html>) documents its built-in,
  session-only HUD and does not address third-party ones.
- Not split: no skin's page could be read. The owner can read BetOnline's
  help article in a browser; if it permits own-play HUDs, add a `betonline`
  room entry (parser `chico`) with that source.

### WePlay - `null`

- No official website with terms or a third-party-software policy was found;
  the rules are inside the app. The client writes live files
  (`~/Documents/hands/<account>/`, verified on macOS in R1.4) and names are
  persistent in the corpus, so a HUD would work technically. The owner has
  an account: read the in-app terms (or ask support) and record the answer
  with its date.

### Closed rooms and networks - `false`

MicroGaming (shut 2016), Ongame (mid-2010s), Entraction (2014-15), Boss
Media (folded into Microgaming), Merge (2017), Full Tilt (no live site) and
Run It Once (closed 2022), per their research docs. Import only.

### `standard` - `false`

Rail's own text format, not a room.

## Restrictions as data (R3.4)

Each allowed room's conditions are also in `config/sites.json`
`hud.restrictions`, which the HUD's renderer enforces on any panel design
(plan R3.4); a downloaded copy can only add restrictions. From the sections
above:

| Restriction | PokerStars | ACR | Winamax |
| --- | --- | --- | --- |
| `ownHandsOnly` | yes | yes | yes ("data you collected yourself") |
| `rawCountsOnly` | yes | - | - |
| `maxColourThresholds` | 2 | - | - |
| `noCardSplitStats` | yes | - | - |
| `noGameStateSwitching` | yes | - | yes (read conservatively: "some dynamic features of Hand2Note" are prohibited, unnamed) |
| `noTendencySwitching` | yes | - | yes (the same) |
| `noPlayerLabels` | yes | yes (4.2.10) | - |
| `noHandCharts` | yes | - | - |
| `noGraphs` | yes | - | - |
| `noHandInPlay` | - | yes (4.1.3) | - |
| `noOverlapTableGraphics` | - | yes (4.2.11) | - |

The HUD's default panel complies with all of them at once. A re-check that
finds a changed condition updates this table and `sites.json` together.

## Re-check before every release (plan section 12)

For every entry with `allowed: true` (today PokerStars, Winamax, ACR), and
for every `null` that the release wants to turn on:

1. Open the `source` page (from outside Croatia where the domain is
   blocked) and confirm third-party HUDs / trackers are still permitted.
   Look for a "last updated" date or version newer than the one recorded.
2. Re-read the restrictions listed in `notes` and in the section above;
   compare with what the HUD shows (stats, colours / thresholds, pop-ups,
   custom statistics, layouts over the client's graphics).
3. PokerStars: also re-read the Reference Guide PDF (its "Last Updated"
   date). Winamax: the PDF linked from the CGU page (its path carries the
   date). ACR: the "Important Update" box at the top of the policy page.
4. Check that the room still writes hand histories live and keeps names
   persistent (`files.live`, `anonymisation`).
5. Look for news of a policy change since the last check (secondary sources
   are a prompt to re-read, never a source).
6. Record the outcome: a changed policy is a change to `config/sites.json`
   and to `HUD_POLICIES` in `core/rail-config/tests/sites.rs`; an unchanged
   one moves `checkedAt` (and `HUD_CHECKED_AT`). Between releases, a room
   that turns a HUD off can be switched off through the remote `sites.json`
   (the merge rule only lets it get stricter).
7. Re-check the `false` entries whose reason is policy (GGPoker,
   partypoker, Unibet, CoinPoker, WPT Global) once a year; a room that
   starts allowing HUDs is a new `true` and needs the owner's sign-off.
