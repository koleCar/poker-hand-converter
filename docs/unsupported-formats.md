# Unsupported formats

The register of hand-history formats Rail cannot read yet (docs/RAIL-PLAN.md
R0.11; guideline, "Registar nepodržanih formata"). It has two halves:

- **Formats we have seen.** Every file no parser claims is recorded
  automatically: by the web converter today, by the desktop app from R1.2.
  Those records live in `public.unparsed_hands` and are triaged weekly with
  the query below.
- **Formats we know of without a usable sample.** They cannot reach the
  database until somebody drops a file, so they are listed here by hand. When a
  sample arrives, the entry moves to the first table and gets an issue.

Every new format, from either half, gets a GitHub issue with the label
`new-format` ("A hand-history format Rail cannot read yet").

## How a file gets into the registry

1. **The core** ([`rail_core::convert`](../core/rail-core/src/convert.rs))
   refuses a file no parser claims as `unknown-site`, exactly as the
   TypeScript does (the goldens pin it), and returns beside the refusal an
   `Unrecognized` record ([`unrecognized.rs`](../core/rail-core/src/unrecognized.rs)):

   | Field | What it is |
   | --- | --- |
   | `fingerprint` | The refusal's fingerprint: sha-256 of the decoded text with whitespace runs collapsed. The registry key; the same file again (re-saved with CRLF, or from another user) is the same record and bumps its count. |
   | `header_sample` | The first 12 non-blank lines of the **anonymised** text, trailing whitespace removed, each cut to 160 characters, joined with `\n`. Deterministic: BOM and line endings are gone before it is taken. |
   | `guessed_site`, `confidence` | A parser whose detector scored the text above 0 but below the 0.2 threshold (`below-threshold`), else a known format whose signature matches at least half its markers (`known-format`: today `bossmedia` and `merge`, the two formats with samples and no parser). Per-mille; `None` / 0 without a guess. |
   | `guess_basis`, `shape` | Where the guess came from; `xml`, `json` or `text` from the first character. |

   `rail-convert` prints the record for such a file, and
   `rail-convert --anonymise <file>` prints its shareable sample.

2. **The anonymiser** ([`anonymise.rs`](../core/rail-core/src/anonymise.rs))
   turns the file into a sample that can leave the machine: every player name
   it can find is replaced by `Player1`, `Player2`, ... (the same name always
   the same placeholder; the prefix changes to `Anon`, `Villain`, ... when the
   file itself contains `Player`), amounts, cards and layout kept byte for
   byte, cut at 64 KiB on a line end. Version `rail-anon/1`.

3. **The database.** With the user's consent, the desktop app sends the sample
   through the same RPC the web uses, `record_conversion_failures`, as a record
   with `origin: "desktop"`, `os`, `clientVersion`, `consentedAt`,
   `anonymiserVersion`, `guessedSite`, `guessConfidence`. A desktop record
   without consent, anonymiser version, OS or client version, or over 64 KiB,
   is skipped by the RPC and refused by a CHECK constraint
   (`20270414090000_unparsed_registry.sql`, docs/DATABASE.md).

4. **Locally**, the desktop app keeps every record whether or not the user
   consents (the `unsupported` table, docs/RAIL-PLAN.md §3.4; built in R1.2).

### What the anonymiser can and cannot promise

It is tested against the whole corpus: over all 556 corpus files, 3 454
(file, name) pairs - 1 471 distinct names, from every parser's output and,
for the 24 files no parser reads, from a format-specific reading of their
`NAME=` / `nickname=` / seat lines - not one name survives in the anonymised
text, the sample, or the header sample; a name of three characters or more
is not even a substring of the output (`core/rail-core/tests/anonymise.rs`).

A format is unknown by definition, so the rules are guesses, made wide on
purpose:

- keyed values whose key names a person (`name`, `nick`, `alias`, `player`,
  `user`, `login`, `screen`, `hero`, `winner`, `account`, `member`, `handle`,
  `owner`, `dealer`, ...; not `table`, `tournament`, `game`, ...) in XML
  attributes and elements, JSON members and arrays, `key = value` lines;
- `Seat N: <name> (<stack>)` in any bracket and currency;
- `<name>: <action>`, `<name> <action>`, column layouts
  (`<name>     Call (0.25)`, `<name>     (EUR 50 in seat 3)`), `Dealt to`,
  `returned to`, `said`, `Dealer:` / `Small Blind:` / `Winner:` lines.

A name found once is replaced **everywhere** it stands as a token, so a name
that is also an ordinary word (`call`, `Button`) costs the sample a little
structure. One- or two-digit values under `player=` / `dealer=` are kept as
seat references (Merge writes `player="5"`); longer numbers are replaced,
since some rooms use numeric ids as names.

It cannot promise:

- a name that appears **only** in a place no rule reads - a chat line or a
  summary sentence in a layout we have never seen, with the name never on a
  seat or action line;
- a name **encoded** - base64, percent-encoding, a hash - except under a
  name-like key (Microgaming's `unicodealias`, base64 of the name, is
  replaced because its key contains `alias`);
- a name split across lines or wrapped in markup inside a value;
- a placeholder-like name (`N/A`, `none`, `true`, `Y`) under a name key:
  those values are left alone;
- the **file name**: it is not part of the text. `Anonymised::apply` maps it
  with the same names, and the desktop client must send only that.

`unparsed_hands.anonymiser_version` says which rules produced each desktop
row, so if a version turns out to leak, its rows can be found and deleted.

## Weekly triage

Run as the service role (the SQL editor): `unparsed_gaps` is `security
invoker`, so under a user's key it shows only that user's rows.

```sql
-- What arrived or recurred this week, biggest first.
select detected_site, guessed_sites, stage, reason,
       distinct_hands, desktop_hands, total_occurrences,
       first_seen_at, last_seen_at
from public.unparsed_gaps
where status = 'new'
  and last_seen_at >= now() - interval '7 days'
order by total_occurrences desc, distinct_hands desc
limit 25;

-- New formats only: nobody claims them, first seen this week.
select coalesce(guessed_site, '(no guess)') as guess, origin,
       count(*) as files, sum(occurrences) as occurrences,
       min(first_seen_at) as first_seen
from public.unparsed_hands
where reason = 'unknown-site' and status = 'new'
  and first_seen_at >= now() - interval '7 days'
group by 1, 2
order by occurrences desc;
```

For each new format: look at a sample (`raw_text`; a desktop row's is
already anonymised, a web row's is verbatim and stays in the database),
open an issue with the label `new-format` naming the guessed site, the
fingerprints and the count, add a row to the rooms table in
docs/RAIL_GUIDELINE.md, and set the rows' `status` to `triaged` with the
issue number in `notes` (docs/DATABASE.md, "Triaging the unparsed corpus").
A real sample file goes under `fixtures/samples/<site>/` only with its
`SOURCES.md` entry and the names already replaced (`rail-convert --anonymise`).

## Formats with a sample and no parser

| Format | Sample | Why there is no parser | Registry guess |
| --- | --- | --- | --- |
| Boss Media (Sweden; `<HISTORY ...>` XML) | `fixtures/samples/bossmedia/` (10 files) | Cards are numeric ids; the rank is solved (`id % 13`), the suit labelling is not and cannot be from this corpus - no flush in it. One real hand with a flush unblocks it. `docs/research/hh-formats/legacy-networks.md` | `bossmedia` (`known-format`) |
| Merge Gaming (Carbon, Lock; `<description>` + `<game>` XML) | `fixtures/samples/merge/` (12 files) | Nothing blocks it; the network is dead, so the payoff is small. The cheapest remaining parser (`docs/research/COVERAGE-PLAN.md` §2). | `merge` (`known-format`) |
| PHH (TOML interchange spec, not a site) | `fixtures/samples/phh/` (4 files) | A research format, not something a room or tracker emits. `docs/research/hh-formats/interchange-formats.md` §2 | none |

## Formats known without a sample

| Format | What we know | What would unblock it |
| --- | --- | --- |
| **WPT Global** | Removed hand-history export in June 2026; there was never a local folder. The only published "example" is a mock-up. The GGPoker parser refuses `WPT Global` branding on purpose, so an old export lands here as `unknown-site`. `hh-formats/wpt-global.md` | A real pre-June-2026 export. Do not write a parser from the mock-up. |
| **PPPoker** | No native text export; the app exposes JSON to replay tools. Third-party converters emit files with a `PokerStars Hand #` header - indistinguishable from PokerStars. Do **not** add a detection rule. `hh-formats/pppoker.md` | Nothing on our side: a UI message, not a parser. |
| **Suprema Poker** | fpdb's PokerStars-family regex lists `SupremaPoker`; a header `SupremaPoker Hand #<id>: ...` is a plausible guess, not confirmed by any byte. `hh-formats/club-apps-misc.md` | One real file. |
| **X-Poker** | No text export: players share replay links. `hh-formats/club-apps-misc.md` | Nothing; there is no file. |
| **KKPoker**, **Upoker** | Listed by Hand2Note / Asian Hand Converter marketing; nothing about a file. `hh-formats/club-apps-misc.md` | One real file, native or converter output. |
| **Club apps via converters** (DriveHUD / Ace Poker Solutions / Hand2Note "Asia") | Re-emit captured hands as PokerStars- or iPoker-style text: the dialect describes the converter, not the room. Those files mostly convert already as the dialect they imitate. `hh-formats/club-apps-misc.md` | A converter output that does *not* convert. |
| **ClubGG**, **Natural8**, **BestPoker** (GG skins) | One ClubGG header quoted in a forum report; Natural8 and BestPoker emit GG's grammar without branding, so the GGPoker parser should read them. Unverified. `hh-formats/ggpoker.md`, `COVERAGE-PLAN.md` §2 | One real skin export - to confirm, probably not to write a parser. |
| **Open Hand History (OHH)** | A versioned JSON spec (`spec_version` 1.4.7 in the wild, `rs-poker` implements it); no sample file found. `hh-formats/interchange-formats.md` §3 | One real OHH file. |
| **PokerMaster**, **MPL Poker** | Named in fpdb's PokerStars-family site regex beside rooms we read; no sample. `hh-formats/club-apps-misc.md` | One real file each. |
| **PokerNow**, **Global Poker** | Community converters turn their logs into PokerStars text (`pn2ps`, `global-poker-hand-history-converter`); the native logs are not hand histories. `hh-formats/interchange-formats.md` §1 | A native export users actually have. |

When one of these turns up in the registry, move its row to the first table
(or delete it, once a parser ships) in the same PR that adds the sample.
