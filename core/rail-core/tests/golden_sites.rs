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

// R0.7 onwards, one line per site (or family):
// #[test]
// fn pokerstars_family() {
//     golden::check(Selection::Parsers(&["pokerstars", "ggpoker", "weplay", "coinpoker", "standard"]));
// }
