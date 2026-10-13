//! The pipeline: bytes in, hands and refusals out.
//!
//! [`convert`] is what the converter does with a dropped file and what the
//! golden emitter (`tests/scripts/golden/emit.ts`) records:
//!
//! ```text
//! bytes ─ decode_source ─ convert_any(text, { source_filename, validate: true })
//! ```
//!
//! [`convert_any`] is `convertAny` of `frontend/src/lib/phf/detect.ts`, step
//! for step: detect on the whole text; split with the best parser; per chunk,
//! detect again (an export can mix formats) and parse with the best parser
//! for the chunk; the hi/lo and short-deck backstops; positions; validation.
//! Every chunk ends as exactly one hand or one refusal, in chunk order. A file
//! that nothing claims, whose split fails or finds no hands is one file-level
//! refusal (`index: None`).
//!
//! Positions and validation are behind [`HandChecks`], so the pipeline's own
//! logic is testable on its own; [`CoreChecks`] - the real ones,
//! [`crate::positions`] and [`crate::validate`] - is what [`convert`] and
//! [`convert_any`] use.
//!
//! **A throw.** `validateHand` throws (`not a card: …`) when a hi/lo payout
//! check meets a card the evaluator cannot read, and nothing in `convertAny`
//! catches it: the whole call rejects, and no hand or refusal of that text
//! comes back. That is the `Err` of [`convert_any`] (and of
//! [`FileConversion::result`]). No corpus file does it - parsers emit cards
//! they have read - but a hand that does is not quietly stored or refused.
//!
//! The converter batches `convertAny` 100 chunks at a time; R0.3 showed the
//! whole-file call gives identical hands and refusals on every corpus file,
//! so this port does the whole-file call.

use crate::decode::{Decoded, Encoding, SourceProblem, decode_source};
use crate::detect::{
    ConvertOptions, DetectionCandidate, FORCED_PERMILLE, FailureReason, ParseError, PipelineReason,
    Registry, SiteParserContext, Stage, fingerprint, short_deck_skip,
    unsupported_game_skip_for_game,
};
use crate::js::JsError;
use crate::phf::{PhfHand, Variant};
use crate::unrecognized::Unrecognized;
use crate::validate::ValidationReport;

/// Positions and validation: the two checks every parsed hand goes through.
pub trait HandChecks {
    /// `assignPositions(hand)`.
    fn assign_positions(&self, hand: &mut PhfHand);
    /// `validateHand(hand)`; `Err` where it throws.
    fn validate_hand(&self, hand: &PhfHand) -> Result<ValidationReport, JsError>;
}

/// The real checks: [`crate::positions::assign_positions`] and
/// [`crate::validate::validate_hand`].
#[derive(Debug, Clone, Copy, Default)]
pub struct CoreChecks;

impl HandChecks for CoreChecks {
    fn assign_positions(&self, hand: &mut PhfHand) {
        crate::positions::assign_positions(hand);
    }

    fn validate_hand(&self, hand: &PhfHand) -> Result<ValidationReport, JsError> {
        crate::validate::validate_hand(hand)
    }
}

/// `ConversionFailure`: a chunk (or a whole file) that did not become a hand,
/// in the shape the `unparsed_hands` table stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionFailure {
    /// sha-256 hex of the whitespace-normalized raw text; the dedupe key.
    pub fingerprint: String,
    pub raw_text: String,
    /// The id of the parser that refused it, or `None`.
    pub detected_site: Option<String>,
    /// That parser's detection score in per-mille (`detectionConfidence`).
    pub detection_permille: Option<u32>,
    pub stage: Stage,
    pub reason: FailureReason,
    /// Human readable; for stage `validate` every error message joined by `; `.
    pub message: String,
    /// `"0"` when no parser was involved.
    pub parser_version: String,
    pub source_filename: Option<String>,
    /// Rust only: the chunk this failure is (0-based within the primary
    /// parser's split), or `None` for a file-level refusal.
    pub index: Option<u32>,
}

/// An accepted hand, with its chunk index and the validator's report (`None`
/// when validation was switched off).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedHand {
    pub index: u32,
    pub hand: PhfHand,
    pub report: Option<ValidationReport>,
}

/// `ConversionResult.stats`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConversionStats {
    pub total: u32,
    pub converted: u32,
    pub failed: u32,
    /// Accepted hands per parser id, in first-seen order (a JavaScript
    /// object's key order).
    pub by_site: Vec<(String, u32)>,
}

/// `ConversionResult`, plus the number of chunks the primary parser's split
/// returned (0 when the file was refused before or at the split).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConversionResult {
    pub hands: Vec<ConvertedHand>,
    pub failures: Vec<ConversionFailure>,
    pub stats: ConversionStats,
    pub chunks: u32,
}

/// A parser id and score, detached from the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub parser: String,
    pub permille: u32,
}

/// What became of one file: [`convert`]'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileConversion {
    pub encoding: Encoding,
    /// Set when the bytes could not be read as text; then nothing else ran,
    /// `detected` is empty and `result` is `None` (the converter lists the
    /// file with its problem and does not call `convertAny`).
    pub problem: Option<SourceProblem>,
    /// `detectSite` on the whole decoded text, best first.
    pub detected: Vec<Candidate>,
    /// `convertAny`'s result; `Err` when it throws (see the module docs).
    pub result: Option<Result<ConversionResult, JsError>>,
    /// Rust only (R0.11): set exactly when no parser claims the file - the
    /// result is then the one file-level `unknown-site` refusal, and this is
    /// the unsupported-format registry's record of it, with the refusal's
    /// fingerprint. Not part of the golden document.
    pub unrecognized: Option<Unrecognized>,
}

/// The built-in parsers (`crate::parsers::builtin`) and the real checks.
pub fn convert(bytes: &[u8], filename: &str) -> FileConversion {
    convert_with(crate::parsers::builtin(), &CoreChecks, bytes, filename)
}

/// [`convert`] with a given registry and checks. `filename` is the file name
/// alone, as a browser reports a dropped file.
pub fn convert_with(
    registry: &Registry,
    checks: &dyn HandChecks,
    bytes: &[u8],
    filename: &str,
) -> FileConversion {
    let options = ConvertOptions {
        source_filename: Some(filename.to_owned()),
        validate: true,
        ..ConvertOptions::default()
    };
    convert_file_with(registry, checks, bytes, &options)
}

/// [`convert`] with the caller's options: the WebAssembly facade's entry
/// (R0.13), which takes `parsedAt` from its caller since the core has no
/// clock. With `options.source_filename` set, `validate: true` and the
/// rest at their defaults it is exactly [`convert`].
pub fn convert_file(bytes: &[u8], options: &ConvertOptions) -> FileConversion {
    convert_file_with(crate::parsers::builtin(), &CoreChecks, bytes, options)
}

/// [`convert_file`] with a given registry and checks. A forced parser
/// (`options.site_id`) still reports the detection ranking; the registry
/// record is made only when nothing is forced and no parser claims the file.
pub fn convert_file_with(
    registry: &Registry,
    checks: &dyn HandChecks,
    bytes: &[u8],
    options: &ConvertOptions,
) -> FileConversion {
    let Decoded {
        text,
        encoding,
        problem,
    } = decode_source(bytes);
    if problem.is_some() {
        return FileConversion {
            encoding,
            problem,
            detected: Vec::new(),
            result: None,
            unrecognized: None,
        };
    }
    let candidates = registry.detect_site(&text);
    let detected = candidates
        .iter()
        .map(|candidate| Candidate {
            parser: candidate.parser.id().to_owned(),
            permille: candidate.permille,
        })
        .collect();
    // No candidate and no forced parser: `run` refuses the file whole as
    // `unknown-site`, and the registry gets its record.
    let unrecognized = (candidates.is_empty() && options.site_id.is_none())
        .then(|| crate::unrecognized::unrecognized(registry, &text));
    let result = run(registry, checks, &text, options, Some(candidates));
    FileConversion {
        encoding,
        problem: None,
        detected,
        result: Some(result),
        unrecognized,
    }
}

/// `convertAny(text, opts)` with the built-in parsers and the real checks;
/// `Err` where it throws (see the module docs).
pub fn convert_any(text: &str, options: &ConvertOptions) -> Result<ConversionResult, JsError> {
    convert_any_with(crate::parsers::builtin(), &CoreChecks, text, options)
}

/// `convertAny(text, opts)` with a given registry and checks.
pub fn convert_any_with(
    registry: &Registry,
    checks: &dyn HandChecks,
    text: &str,
    options: &ConvertOptions,
) -> Result<ConversionResult, JsError> {
    run(registry, checks, text, options, None)
}

/// [`convert_any`] for a caller that has already run
/// [`Registry::detect_site`] on this same `text` with the built-in parsers
/// (the desktop's incremental reader does, to split the text before it
/// converts it): the same result, without detecting twice - which is what
/// [`convert_file_with`] does with its own detection. `detected` must be
/// `crate::parsers::builtin().detect_site(text)`; with `options.site_id`
/// set it is not used, as in [`convert_any`].
pub fn convert_any_detected<'r>(
    text: &str,
    options: &ConvertOptions,
    detected: Vec<DetectionCandidate<'r>>,
) -> Result<ConversionResult, JsError> {
    run(
        crate::parsers::builtin(),
        &CoreChecks,
        text,
        options,
        Some(detected),
    )
}

/// Collects failures the way `convertAny`'s `fail` does.
struct Failures<'o> {
    list: Vec<ConversionFailure>,
    source_filename: Option<&'o str>,
}

impl Failures<'_> {
    fn push(
        &mut self,
        index: Option<u32>,
        raw_text: &str,
        stage: Stage,
        reason: FailureReason,
        message: String,
        parser: Option<&DetectionCandidate<'_>>,
    ) {
        self.list.push(ConversionFailure {
            fingerprint: fingerprint(raw_text),
            raw_text: raw_text.to_owned(),
            detected_site: parser.map(|c| c.parser.id().to_owned()),
            detection_permille: parser.map(|c| c.permille),
            stage,
            reason,
            message,
            parser_version: parser.map_or("0", |c| c.parser.version()).to_owned(),
            source_filename: self.source_filename.map(str::to_owned),
            index,
        });
    }

    /// The early return of a file-level refusal: `total: 1`.
    fn file_level(self) -> ConversionResult {
        let failed = u32::try_from(self.list.len()).unwrap_or(u32::MAX);
        ConversionResult {
            hands: Vec::new(),
            failures: self.list,
            stats: ConversionStats {
                total: 1,
                converted: 0,
                failed,
                by_site: Vec::new(),
            },
            chunks: 0,
        }
    }
}

fn run<'r>(
    registry: &'r Registry,
    checks: &dyn HandChecks,
    text: &str,
    options: &ConvertOptions,
    detected: Option<Vec<DetectionCandidate<'r>>>,
) -> Result<ConversionResult, JsError> {
    let mut failures = Failures {
        list: Vec::new(),
        source_filename: options.source_filename.as_deref(),
    };

    let forced = options.site_id.as_deref().map(|id| registry.get(id));
    if let Some(site_id) = &options.site_id
        && forced.flatten().is_none()
    {
        failures.push(
            None,
            text,
            Stage::Detect,
            PipelineReason::UnknownSite.into(),
            format!("No parser registered for \"{site_id}\"."),
            None,
        );
        return Ok(failures.file_level());
    }
    let forced = forced.flatten().map(|parser| DetectionCandidate {
        parser,
        permille: FORCED_PERMILLE,
    });

    let candidates = match forced {
        Some(forced) => vec![forced],
        None => detected.unwrap_or_else(|| registry.detect_site(text)),
    };
    let Some(primary) = candidates.first().copied() else {
        failures.push(
            None,
            text,
            Stage::Detect,
            PipelineReason::UnknownSite.into(),
            "The text does not match any hand history format we recognise.".to_owned(),
            None,
        );
        return Ok(failures.file_level());
    };

    let chunks = match primary.parser.split_hands(text) {
        Ok(chunks) => chunks,
        Err(error) => {
            failures.push(
                None,
                text,
                Stage::Split,
                PipelineReason::SplitFailed.into(),
                error.0,
                Some(&primary),
            );
            return Ok(failures.file_level());
        }
    };
    if chunks.is_empty() {
        failures.push(
            None,
            text,
            Stage::Split,
            PipelineReason::NoHands.into(),
            format!(
                "{} recognised the file but found no hands in it.",
                primary.parser.name()
            ),
            Some(&primary),
        );
        return Ok(failures.file_level());
    }

    let context = SiteParserContext {
        source_filename: options.source_filename.as_deref(),
        options,
    };
    let mut hands = Vec::new();
    let mut by_site: Vec<(String, u32)> = Vec::new();
    for (index, chunk) in (0_u32..).zip(&chunks) {
        let per_chunk = if forced.is_some() {
            None
        } else {
            registry.detect_site(chunk).first().copied()
        };
        let chosen = per_chunk.unwrap_or(primary);
        let fail = |failures: &mut Failures<'_>, stage, reason, message| {
            failures.push(Some(index), chunk, stage, reason, message, Some(&chosen));
        };

        let mut hand = match chosen.parser.parse_hand(chunk, &context) {
            Ok(hand) => hand,
            Err(ParseError::Skip(skip)) => {
                fail(&mut failures, skip.stage, skip.reason.into(), skip.message);
                continue;
            }
            Err(ParseError::Bug(message)) => {
                fail(
                    &mut failures,
                    Stage::Parse,
                    PipelineReason::ParserError.into(),
                    message,
                );
                continue;
            }
        };

        // The refused games are checked centrally too: a parser that forgets
        // its own guard cannot leak one into storage.
        let refusal = unsupported_game_skip_for_game(&hand.game, chosen.parser.hi_lo_variants())
            .or_else(|| {
                (hand.game.variant == Variant::Shortdeck && !chosen.parser.short_deck())
                    .then(|| short_deck_skip(&hand.game.label))
            });
        if let Some(refusal) = refusal {
            fail(
                &mut failures,
                refusal.stage,
                refusal.reason.into(),
                refusal.message,
            );
            continue;
        }

        checks.assign_positions(&mut hand);

        let report = if options.validate {
            let report = checks.validate_hand(&hand)?;
            if !report.ok() {
                let reason = report.errors().next().map_or(
                    FailureReason::Pipeline(PipelineReason::InvalidHand),
                    |first| FailureReason::Validation(first.code.clone()),
                );
                let message = report
                    .errors()
                    .map(|problem| problem.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ");
                fail(&mut failures, Stage::Validate, reason, message);
                continue;
            }
            Some(report)
        } else {
            None
        };

        let site = chosen.parser.id();
        match by_site.iter_mut().find(|(id, _)| id == site) {
            Some((_, count)) => *count += 1,
            None => by_site.push((site.to_owned(), 1)),
        }
        hands.push(ConvertedHand {
            index,
            hand,
            report,
        });
    }

    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(ConversionResult {
        stats: ConversionStats {
            total: count(chunks.len()),
            converted: count(hands.len()),
            failed: count(failures.list.len()),
            by_site,
        },
        chunks: count(chunks.len()),
        hands,
        failures: failures.list,
    })
}

#[cfg(test)]
mod tests {
    //! The pipeline half of `tests/test/phfDetect.test.ts` and the backstop
    //! tests of `tests/test/phfOmaha.test.ts`, with fake parsers.

    use std::cell::Cell;

    use super::*;
    use crate::detect::{ParseSkip, SiteParser, SkipReason, SplitError};
    use crate::phf::test_support;

    #[derive(Debug)]
    struct Fake {
        id: &'static str,
        prefix: &'static str,
        hi_lo: &'static [Variant],
        short_deck: bool,
        split: fn(&str) -> Result<Vec<String>, SplitError>,
        parse: fn(&str) -> Result<PhfHand, ParseError>,
    }

    impl SiteParser for Fake {
        fn id(&self) -> &'static str {
            self.id
        }
        fn name(&self) -> &'static str {
            "Test Site"
        }
        fn version(&self) -> &'static str {
            "0.0.1"
        }
        fn detect(&self, text: &str) -> u32 {
            if text.starts_with(self.prefix) {
                1000
            } else {
                0
            }
        }
        fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
            (self.split)(text)
        }
        fn parse_hand(&self, raw: &str, _: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
            (self.parse)(raw)
        }
        fn hi_lo_variants(&self) -> &'static [Variant] {
            self.hi_lo
        }
        fn short_deck(&self) -> bool {
            self.short_deck
        }
    }

    fn whole(text: &str) -> Result<Vec<String>, SplitError> {
        Ok(vec![text.to_owned()])
    }

    fn fake(
        id: &'static str,
        prefix: &'static str,
        parse: fn(&str) -> Result<PhfHand, ParseError>,
    ) -> Fake {
        Fake {
            id,
            prefix,
            hi_lo: &[],
            short_deck: false,
            split: whole,
            parse,
        }
    }

    fn registry(parsers: Vec<Fake>) -> Registry {
        let mut registry = Registry::new();
        for parser in parsers {
            registry.register(Box::new(parser));
        }
        registry
    }

    /// Positions are a no-op and validation passes, counting calls.
    #[derive(Default)]
    struct Passing {
        positions: Cell<u32>,
    }

    impl HandChecks for Passing {
        fn assign_positions(&self, _: &mut PhfHand) {
            self.positions.set(self.positions.get() + 1);
        }
        fn validate_hand(&self, _: &PhfHand) -> Result<ValidationReport, JsError> {
            Ok(ValidationReport::default())
        }
    }

    /// The pipeline, for checks that never throw.
    fn convert_any_with(
        registry: &Registry,
        checks: &dyn HandChecks,
        text: &str,
        options: &ConvertOptions,
    ) -> ConversionResult {
        super::convert_any_with(registry, checks, text, options).expect("the checks do not throw")
    }

    fn hi_lo_hand(raw: &str) -> Result<PhfHand, ParseError> {
        let mut hand = test_support::hand();
        hand.game.variant = Variant::Omaha;
        hand.game.hi_lo = true;
        hand.game.label = "Omaha Hi/Lo Pot Limit".to_owned();
        hand.meta.raw_text = raw.to_owned();
        Ok(hand)
    }

    fn not_implemented(_: &str) -> Result<PhfHand, ParseError> {
        Err(ParseError::Bug("not implemented".to_owned()))
    }

    #[test]
    fn reports_an_unrecognised_upload_as_a_failure_rather_than_throwing() {
        let options = ConvertOptions {
            source_filename: Some("notes.txt".to_owned()),
            ..ConvertOptions::default()
        };
        let result = convert_any_with(
            &Registry::new(),
            &Passing::default(),
            "hello world",
            &options,
        );
        assert!(result.hands.is_empty());
        assert_eq!(result.failures.len(), 1);
        let failure = &result.failures[0];
        assert_eq!(failure.detected_site, None);
        assert_eq!(failure.detection_permille, None);
        assert_eq!(failure.stage, Stage::Detect);
        assert_eq!(failure.reason.as_str(), "unknown-site");
        assert_eq!(failure.source_filename.as_deref(), Some("notes.txt"));
        assert_eq!(failure.parser_version, "0");
        assert_eq!(failure.index, None);
        assert_eq!(failure.fingerprint.len(), 64);
        assert!(
            failure
                .fingerprint
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(
            result.stats,
            ConversionStats {
                total: 1,
                converted: 0,
                failed: 1,
                by_site: vec![]
            }
        );
        assert_eq!(result.chunks, 0);
    }

    #[test]
    fn lets_a_new_site_register_itself_without_touching_the_pipeline() {
        let registry = registry(vec![fake("test-site", "TESTSITE", not_implemented)]);
        assert_eq!(
            registry.detect_site("TESTSITE Hand #1")[0].parser.id(),
            "test-site"
        );
        let result = convert_any_with(
            &registry,
            &Passing::default(),
            "TESTSITE Hand #1",
            &ConvertOptions::default(),
        );
        let failure = &result.failures[0];
        assert_eq!(failure.detected_site.as_deref(), Some("test-site"));
        assert_eq!(failure.stage, Stage::Parse);
        assert_eq!(failure.reason.as_str(), "parser-error");
        assert_eq!(failure.message, "not implemented");
        assert_eq!(failure.parser_version, "0.0.1");
        assert_eq!(failure.detection_permille, Some(1000));
        assert_eq!(failure.index, Some(0));
    }

    #[test]
    fn honours_an_explicit_site_id() {
        let options = ConvertOptions {
            site_id: Some("does-not-exist".to_owned()),
            ..ConvertOptions::default()
        };
        let result = convert_any_with(&Registry::new(), &Passing::default(), "hello", &options);
        assert_eq!(result.failures[0].reason.as_str(), "unknown-site");
        assert_eq!(
            result.failures[0].message,
            "No parser registered for \"does-not-exist\"."
        );
    }

    #[test]
    fn refuses_a_hi_lo_hand_from_any_parser_that_has_not_opted_in() {
        let registry = registry(vec![fake("test-forgetful", "FORGETFUL", hi_lo_hand)]);
        let options = ConvertOptions {
            site_id: Some("test-forgetful".to_owned()),
            ..ConvertOptions::default()
        };
        let checks = Passing::default();
        let result = convert_any_with(&registry, &checks, "FORGETFUL\n", &options);
        assert!(result.hands.is_empty());
        let reasons: Vec<_> = result.failures.iter().map(|f| f.reason.as_str()).collect();
        assert_eq!(reasons, ["unsupported-hi-lo"]);
        assert_eq!(result.failures[0].stage, Stage::Parse);
        assert_eq!(result.failures[0].detection_permille, Some(FORCED_PERMILLE));
        assert_eq!(checks.positions.get(), 0, "refused before positions");
    }

    #[test]
    fn lets_a_parser_s_declared_hi_lo_deals_through_the_backstop_and_only_those() {
        let mut declared = fake("test-declared", "DECLARED", hi_lo_hand);
        declared.hi_lo = &[Variant::Omaha];
        let registry = registry(vec![declared]);
        let options = ConvertOptions {
            site_id: Some("test-declared".to_owned()),
            ..ConvertOptions::default()
        };
        let checks = Passing::default();
        let result = convert_any_with(&registry, &checks, "DECLARED\n", &options);
        assert!(result.failures.is_empty());
        assert_eq!(
            result
                .hands
                .iter()
                .map(|h| h.hand.game.hi_lo)
                .collect::<Vec<_>>(),
            [true]
        );
        assert_eq!(checks.positions.get(), 1);
        assert_eq!(result.stats.by_site, [("test-declared".to_owned(), 1)]);
    }

    #[test]
    fn refuses_short_deck_unless_the_parser_reads_it() {
        fn short(_: &str) -> Result<PhfHand, ParseError> {
            let mut hand = test_support::hand();
            hand.game.variant = Variant::Shortdeck;
            hand.game.label = "ShortDeck No Limit".to_owned();
            Ok(hand)
        }
        let mut reads = fake("reads", "R", short);
        reads.short_deck = true;
        let registry = registry(vec![fake("plain", "P", short), reads]);
        let checks = Passing::default();
        let refused = convert_any_with(&registry, &checks, "P", &ConvertOptions::default());
        assert_eq!(refused.failures[0].reason.as_str(), "unsupported-variant");
        let accepted = convert_any_with(&registry, &checks, "R", &ConvertOptions::default());
        assert_eq!(accepted.hands.len(), 1);
    }

    #[test]
    fn walks_chunks_in_order_and_detects_each_one() {
        fn split(text: &str) -> Result<Vec<String>, SplitError> {
            Ok(text.split("\n\n").map(str::to_owned).collect())
        }
        fn parse_a(raw: &str) -> Result<PhfHand, ParseError> {
            if raw.contains("skip") {
                return Err(ParseSkip::new(SkipReason::BbOnlyWalk, "walk").into());
            }
            Ok(test_support::hand())
        }
        let mut a = fake("a", "A", parse_a);
        a.split = split;
        let registry = registry(vec![a, fake("b", "B", not_implemented)]);
        let result = convert_any_with(
            &registry,
            &Passing::default(),
            "A one\n\nB two\n\nA skip\n\nA four",
            &ConvertOptions::default(),
        );
        assert_eq!(
            result.hands.iter().map(|h| h.index).collect::<Vec<_>>(),
            [0, 3]
        );
        let failures: Vec<_> = result
            .failures
            .iter()
            .map(|f| (f.index, f.detected_site.as_deref(), f.reason.as_str()))
            .collect();
        assert_eq!(
            failures,
            [
                (Some(1), Some("b"), "parser-error"),
                (Some(2), Some("a"), "bb-only-walk")
            ]
        );
        assert_eq!(
            result.stats,
            ConversionStats {
                total: 4,
                converted: 2,
                failed: 2,
                by_site: vec![("a".to_owned(), 2)]
            }
        );
        // A chunk no parser claims falls back to the file's primary parser.
        let fallback = convert_any_with(
            &registry,
            &Passing::default(),
            "A x\n\nZ y",
            &ConvertOptions::default(),
        );
        assert_eq!(fallback.hands.len(), 2);
    }

    #[test]
    fn a_split_that_fails_or_finds_nothing_refuses_the_file() {
        fn fails(_: &str) -> Result<Vec<String>, SplitError> {
            Err(SplitError("boom".to_owned()))
        }
        fn empty(_: &str) -> Result<Vec<String>, SplitError> {
            Ok(vec![])
        }
        let mut a = fake("a", "A", not_implemented);
        a.split = fails;
        let mut b = fake("b", "B", not_implemented);
        b.split = empty;
        let registry = registry(vec![a, b]);
        let checks = Passing::default();
        let failed = convert_any_with(&registry, &checks, "A", &ConvertOptions::default());
        let f = &failed.failures[0];
        assert_eq!(
            (f.stage, f.reason.as_str(), f.message.as_str()),
            (Stage::Split, "split-failed", "boom")
        );
        assert_eq!(failed.stats.total, 1);
        let none = convert_any_with(&registry, &checks, "B", &ConvertOptions::default());
        let f = &none.failures[0];
        assert_eq!(
            (f.stage, f.reason.as_str(), f.message.as_str()),
            (
                Stage::Split,
                "no-hands",
                "Test Site recognised the file but found no hands in it."
            )
        );
        assert_eq!(f.index, None);
    }

    #[test]
    fn a_failed_validation_names_the_first_error_and_joins_the_messages() {
        use crate::validate::{Severity, ValidationProblem};
        struct Failing;
        impl HandChecks for Failing {
            fn assign_positions(&self, _: &mut PhfHand) {}
            fn validate_hand(&self, _: &PhfHand) -> Result<ValidationReport, JsError> {
                let problem = |code: &str, severity| ValidationProblem {
                    code: code.to_owned(),
                    message: format!("{code}!"),
                    severity,
                    context: None,
                };
                Ok(ValidationReport {
                    problems: vec![
                        problem("odd", Severity::Warning),
                        problem("chip-mismatch", Severity::Error),
                        problem("negative-stack", Severity::Error),
                    ],
                })
            }
        }
        fn ok(_: &str) -> Result<PhfHand, ParseError> {
            Ok(test_support::hand())
        }
        let registry = registry(vec![fake("a", "A", ok)]);
        let result = convert_any_with(&registry, &Failing, "A", &ConvertOptions::default());
        let f = &result.failures[0];
        assert_eq!(
            (f.stage, f.reason.as_str(), f.message.as_str()),
            (
                Stage::Validate,
                "chip-mismatch",
                "chip-mismatch!; negative-stack!"
            )
        );
        let unvalidated = ConvertOptions {
            validate: false,
            ..ConvertOptions::default()
        };
        let result = convert_any_with(&registry, &Failing, "A", &unvalidated);
        assert_eq!(result.hands.len(), 1);
        assert_eq!(result.hands[0].report, None);
    }

    #[test]
    fn a_validator_that_throws_rejects_the_whole_conversion() {
        struct Throwing;
        impl HandChecks for Throwing {
            fn assign_positions(&self, _: &mut PhfHand) {}
            fn validate_hand(&self, _: &PhfHand) -> Result<ValidationReport, JsError> {
                Err(JsError::new("not a card: Xx"))
            }
        }
        fn ok(_: &str) -> Result<PhfHand, ParseError> {
            Ok(test_support::hand())
        }
        let registry = registry(vec![fake("a", "A", ok)]);
        let thrown = super::convert_any_with(&registry, &Throwing, "A", &ConvertOptions::default());
        assert_eq!(thrown, Err(JsError::new("not a card: Xx")));
        // Without validation nothing throws.
        let unvalidated = ConvertOptions {
            validate: false,
            ..ConvertOptions::default()
        };
        assert!(super::convert_any_with(&registry, &Throwing, "A", &unvalidated).is_ok());
    }

    #[test]
    fn a_file_that_cannot_be_decoded_is_not_converted() {
        let file = convert_with(&Registry::new(), &Passing::default(), b"", "empty.txt");
        assert_eq!(file.problem, Some(SourceProblem::Empty));
        assert!(file.result.is_none() && file.detected.is_empty());
    }

    /// Handing over the detection the caller already ran on the same text
    /// changes nothing in the result (corpus files of three formats).
    #[test]
    fn convert_any_detected_equals_convert_any() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for file in [
            "fixtures/samples/partypoker/14-multiple-hands-concatenated.txt",
            "fixtures/samples/888poker/13-invalid-hand-truncated-flop.txt",
            "fixtures/samples/pokerbros/02-cash-nlhe-pokerstars-dialect-same-hand.txt",
        ] {
            let bytes = std::fs::read(root.join(file)).expect("corpus file");
            let text = decode_source(&bytes).text;
            let options = ConvertOptions::default();
            let detected = crate::parsers::builtin().detect_site(&text);
            assert!(!detected.is_empty(), "{file}");
            assert_eq!(
                super::convert_any_detected(&text, &options, detected),
                super::convert_any(&text, &options),
                "{file}"
            );
        }
    }
}
