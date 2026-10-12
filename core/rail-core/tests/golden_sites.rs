//! The Rust pipeline against the TypeScript oracle, site by site
//! (docs/RAIL-PLAN.md R0.5 onwards). Each parser step adds one line here; the
//! harness is `tests/golden/mod.rs`.

mod golden;

use golden::Selection;

/// The 24 files no TypeScript parser claims (the Boss Media and Merge
/// samples, which have no parser, plus one Winamax and one Full Tilt
/// fragment) are refused whole as `unknown-site`, with the same message,
/// stage and fingerprint (sha-256 of the decoded file with JavaScript's `\s`
/// collapsed).
/// They must stay unclaimed as parsers are added.
#[test]
fn unrecognised_files_are_refused_whole() {
    let report = golden::check(Selection::Unrecognised);
    assert_eq!(
        report.files, 24,
        "the set of unrecognised corpus files changed"
    );
    assert_eq!(report.refusals, 24);
    assert_eq!(report.hands, 0);
}

/// The harness itself: a golden that differs in one field is caught, at the
/// right path.
#[test]
fn the_harness_reports_a_changed_field() {
    let (path, mut golden) = golden::goldens()
        .into_iter()
        .find(|(_, golden)| golden["detected"]["top"].is_null())
        .expect("an unrecognised file");
    golden["refusals"][0]["fingerprint"] = "0".repeat(64).into();
    golden["stats"]["total"] = 2.into();
    let mut report = golden::Report::default();
    let paths = golden::compare_file(&path, golden, &mut report).expect_err("must differ");
    assert_eq!(paths.len(), 2, "{paths:?}");
    assert!(
        paths[0].starts_with("$.refusals[0].fingerprint: expected \"000"),
        "{paths:?}"
    );
    assert!(
        paths[1].starts_with("$.stats.total: expected 2, got 1"),
        "{paths:?}"
    );
}

/// `standard` (R0.6): our own text read back - the `gg-hh/` reference files,
/// their copies under `fixtures/samples/ggpoker/`, GG's AoF Omaha sample and
/// the stats fixtures. Detection, chunks, every hand's PHF, standard text and
/// warnings, the per-file text, refusals and stats. Since R0.7a the ranking
/// is compared whole: `ggpoker`'s 0.86 under `standard`'s 0.9 on all 38 of
/// these files that carry a GG fee line.
#[test]
fn standard() {
    let report = golden::check(Selection::Parsers(&["standard"]));
    assert_eq!(report.files, 39, "the set of files `standard` wins changed");
    assert_eq!(report.hands, 881);
    assert_eq!(report.refusals, 0);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// `pokerstars` (R0.7a): PokerStars cash, Zoom, Home Games, play money,
/// tournaments, hi/lo, run-it-twice; refusals for stud, razz, badugi, stud
/// hi/lo and a cancelled hand.
#[test]
fn pokerstars() {
    let report = golden::check(Selection::Parsers(&["pokerstars"]));
    assert_eq!(
        report.files, 45,
        "the set of files `pokerstars` wins changed"
    );
    assert_eq!(report.hands, 108);
    assert_eq!(report.refusals, 5);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// `ggpoker` (R0.7a): the GG samples `standard` does not win - tournaments,
/// Omaha, PLO-5, short deck, Rush & Cash, straddles, cash drops, all-in
/// insurance, run-it-twice; two `unseated-actor` refusals.
#[test]
fn ggpoker() {
    let report = golden::check(Selection::Parsers(&["ggpoker"]));
    assert_eq!(report.files, 24, "the set of files `ggpoker` wins changed");
    assert_eq!(report.hands, 215);
    assert_eq!(report.refusals, 2);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// Whole-file detection over the entire corpus (556 files), restricted to the
/// parsers ported so far: every ported parser scores every file exactly as
/// the golden ranking says - claiming no file of a site not yet ported, and
/// ranked in the same order. This is what keeps the files of later sites from
/// being misrouted once their parser arrives.
#[test]
fn ported_parsers_rank_every_corpus_file_as_the_goldens_do() {
    let registry = rail_core::parsers::builtin();
    let mut files = 0;
    let mut problems = Vec::new();
    for (path, golden) in golden::goldens() {
        let bytes = golden::input_bytes(&path, &golden);
        let decoded = rail_core::decode::decode_source(&bytes);
        if decoded.problem.is_some() {
            continue;
        }
        files += 1;
        let expected: Vec<(String, u64)> = golden["detected"]["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| Some((c["parser"].as_str()?.to_owned(), c["permille"].as_u64()?)))
            .filter(|(id, _)| registry.get(id).is_some())
            .collect();
        let actual: Vec<(String, u64)> = registry
            .detect_site(&decoded.text)
            .iter()
            .map(|c| (c.parser.id().to_owned(), u64::from(c.permille)))
            .collect();
        if expected != actual {
            problems.push(format!("{path}: expected {expected:?}, got {actual:?}"));
        }
    }
    assert!(files > 500, "{files}");
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// `weplay` (R0.7b): the `weplay-hh/` exports of both accounts, the WePlay
/// samples and the regression fixtures - cash, tournaments, bomb pots,
/// straddles, run-it-twice, hidden `##` cards; refusals for BB-only walks,
/// an uncalled bet over the commitment, a ghost ante, Omaha, a short all-in
/// small blind, a zero-stack actor, and one hand the validator refuses
/// (`chip-mismatch`).
#[test]
fn weplay() {
    let report = golden::check(Selection::Parsers(&["weplay"]));
    assert_eq!(report.files, 128, "the set of files `weplay` wins changed");
    assert_eq!(report.hands, 6726);
    assert_eq!(report.refusals, 96);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// `coinpoker` (R0.7b): the 16 CoinPoker samples - USDT cash, MTT, PKO,
/// satellite, freeroll, straddle, the all-in raise without `to`, dead blinds,
/// a side pot; one refusal (`hand-cancelled`).
#[test]
fn coinpoker() {
    let report = golden::check(Selection::Parsers(&["coinpoker"]));
    assert_eq!(
        report.files, 16,
        "the set of files `coinpoker` wins changed"
    );
    assert_eq!(report.hands, 21);
    assert_eq!(report.refusals, 1);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// `partypoker` (R0.8): NL, PL and FL Hold'em, PL Omaha, the `PL Omaha
/// Hi-Lo` split pot with partypoker's own `wins Lo (...)`, dead blinds,
/// sit-outs, timebank lines, a five-hand file; one refusal (`no-winner`, a
/// hand cut off before it was settled).
#[test]
fn partypoker() {
    let report = golden::check(Selection::Parsers(&["partypoker"]));
    assert_eq!(
        report.files, 15,
        "the set of files `partypoker` wins changed"
    );
    assert_eq!(report.hands, 18);
    assert_eq!(report.refusals, 1);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// `888poker` (R0.8): 888poker, LuckyAcePoker and Cassava skins - NL and FL
/// Hold'em, NL Omaha, `Pot Limit OmahaHL` (a scoop, a pot with no low), a
/// dead blind, thousands separators; one refusal (`truncated-hand`).
#[test]
fn poker888() {
    let report = golden::check(Selection::Parsers(&["888poker"]));
    assert_eq!(report.files, 14, "the set of files `888poker` wins changed");
    assert_eq!(report.hands, 13);
    assert_eq!(report.refusals, 1);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}

/// `pokerbros` (R0.8): the one hand in both converter dialects - the party
/// dialect (derived pot and rake, the hero mis-attribution, the 12-hour
/// clock) and the PokerStars dialect (the button on an empty seat).
#[test]
fn pokerbros() {
    let report = golden::check(Selection::Parsers(&["pokerbros"]));
    assert_eq!(report.files, 2, "the set of files `pokerbros` wins changed");
    assert_eq!(report.hands, 2);
    assert_eq!(report.refusals, 0);
    assert_eq!(report.pending_text_hashes, 0);
    assert_eq!(report.unported_candidates, 0);
}
