//! Site detection and the parser plug-in contract: the Rust side of
//! `frontend/src/lib/phf/detect.ts` (the pipeline itself, `convertAny`, is
//! [`crate::convert`](mod@crate::convert)).
//!
//! - [`SiteParser`] is the TypeScript `SiteParser` interface as a trait: `id`,
//!   `name`, `version`, `detect`, `split_hands`, `parse_hand`, and the two
//!   allowlists `hi_lo_variants` / `short_deck` with the same defaults.
//! - [`Registry`] is the TypeScript module-level registry as a value:
//!   registration order, `register` replacing in place (as `Map.set` does),
//!   [`Registry::detect_site`] ranking.
//! - [`ParseSkip`], [`SkipReason`] and [`FailureReason`]: refusals, with the
//!   complete set of TypeScript reason codes.
//! - [`fingerprint`]: the sha-256 dedupe key of a refusal, over the text with
//!   JavaScript's `\s` collapsed.
//! - The hi/lo and short-deck backstops ([`unsupported_game_skip`],
//!   [`unsupported_game_skip_for_game`], [`short_deck_skip`]).
//!
//! **Scores are integer per-mille.** TypeScript detectors return a float in
//! 0..1; here they return `round(score * 1000)` as a `u32` (the workspace
//! denies float arithmetic). Every score the corpus produces is one of five
//! literals - 0.99, 0.95, 0.9, 0.86, 0.25 - which map to 990, 950, 900, 860,
//! 250; the threshold 0.2 is [`DETECTION_THRESHOLD_PERMILLE`] = 200. A detector
//! that computes its score must produce what `Math.round(score * 1000)` gives
//! for the TypeScript's double (use [`crate::js::JsNumber`]). Ranking by the
//! integers is the TypeScript ranking as long as distinct scores stay distinct
//! after rounding, which holds for every score in the tree today.

mod reason;

use std::fmt::{self, Write as _};

use sha2::{Digest, Sha256};

pub use self::reason::{FailureReason, PipelineReason, SkipReason, Stage};
use crate::js;
use crate::phf::{PhfGame, PhfHand, Variant, variant_from_label};

/// Scores at or above this are a match (`DETECTION_THRESHOLD = 0.2`).
pub const DETECTION_THRESHOLD_PERMILLE: u32 = 200;

/// The confidence of a parser chosen by site id rather than detected
/// (`{ parser: forced, confidence: 1 }`).
pub const FORCED_PERMILLE: u32 = 1000;

/// `meta.parsedAt` when the caller gives no clock: the value the goldens pin.
/// The core has no clock of its own (there is none on `wasm32-unknown-unknown`).
pub const PINNED_PARSED_AT: &str = "1970-01-01T00:00:00.000Z";

/// `ConvertOptions`: threaded from the caller down to the site parsers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertOptions {
    /// Name of the uploaded file (no directory), for provenance and failures.
    pub source_filename: Option<String>,
    /// Skip tournament hands (the legacy converter tab is cash-only).
    pub cash_only: bool,
    /// Skip bomb-pot hands.
    pub skip_bomb_pots: bool,
    /// Run the validator and turn hard errors into failures. Default `true`.
    pub validate: bool,
    /// Force a parser instead of detecting one.
    pub site_id: Option<String>,
    /// Rust only: the ISO timestamp parsers stamp on `meta.parsedAt`, which
    /// TypeScript takes from the wall clock. Default [`PINNED_PARSED_AT`].
    pub parsed_at: String,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        Self {
            source_filename: None,
            cash_only: false,
            skip_bomb_pots: false,
            validate: true,
            site_id: None,
            parsed_at: PINNED_PARSED_AT.to_owned(),
        }
    }
}

/// `SiteParserContext`.
#[derive(Debug, Clone, Copy)]
pub struct SiteParserContext<'a> {
    pub source_filename: Option<&'a str>,
    pub options: &'a ConvertOptions,
}

impl SiteParserContext<'_> {
    /// What to stamp on `meta.parsedAt` ([`ConvertOptions::parsed_at`]).
    pub fn parsed_at(&self) -> &str {
        &self.options.parsed_at
    }
}

/// `ParseSkip`: a hand the parser recognises but refuses to convert. Becomes
/// a stored `ConversionFailure` someone can write a converter for later.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ParseSkip {
    pub reason: SkipReason,
    pub message: String,
    pub stage: Stage,
}

impl ParseSkip {
    /// `new ParseSkip(reason, message)`: stage `parse`.
    pub fn new(reason: SkipReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
            stage: Stage::Parse,
        }
    }

    /// `new ParseSkip(reason, message, stage)`.
    pub fn with_stage(reason: SkipReason, message: impl Into<String>, stage: Stage) -> Self {
        Self {
            reason,
            message: message.into(),
            stage,
        }
    }
}

impl fmt::Display for ParseSkip {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.reason, self.message)
    }
}

impl std::error::Error for ParseSkip {}

/// Why `parse_hand` produced no hand.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ParseError {
    /// A recognised hand refused on purpose (TypeScript: `throw new ParseSkip`).
    Skip(ParseSkip),
    /// Anything else (TypeScript: any other exception): a bug in the parser,
    /// recorded as `parser-error` with this message - which must be the
    /// message the TypeScript exception carries, since the goldens keep it.
    Bug(String),
}

impl From<ParseSkip> for ParseError {
    fn from(skip: ParseSkip) -> Self {
        Self::Skip(skip)
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Skip(skip) => skip.fmt(f),
            Self::Bug(message) => write!(f, "parser-error: {message}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// `splitHands` failed (TypeScript: it threw). Recorded as `split-failed`
/// with this message.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SplitError(pub String);

impl fmt::Display for SplitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SplitError {}

/// The contract every site parser implements (`SiteParser` in `detect.ts`).
///
/// `detect` must be cheap and total - it runs against every candidate parser
/// for every upload. The TypeScript catches a throwing detector and scores it
/// 0; a Rust detector returns a number and cannot fail (a panic is a bug).
pub trait SiteParser: fmt::Debug + Send + Sync {
    /// Stable machine id; stored in `PhfHand.meta.siteId` and the database.
    fn id(&self) -> &'static str;
    /// Human readable name, used in messages (`"<name> recognised the file
    /// but found no hands in it."`).
    fn name(&self) -> &'static str;
    /// Bumped when the parser's behaviour changes; recorded on every hand and
    /// failure.
    fn version(&self) -> &'static str;
    /// Confidence in per-mille that `text` came from this site: 0 is "not
    /// mine", [`DETECTION_THRESHOLD_PERMILLE`] and up is a candidate. The
    /// TypeScript score times 1000, rounded (see the module docs).
    fn detect(&self, text: &str) -> u32;
    /// Splits a file into hand chunks.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError>;
    /// Parses one chunk. [`ParseError::Skip`] for a hand recognised but
    /// refused; [`ParseError::Bug`] for anything unexpected.
    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError>;
    /// `hiLoVariants`: deals this parser reads high-low split for. Empty, the
    /// default, means every hi/lo hand it returns is refused by the pipeline.
    fn hi_lo_variants(&self) -> &'static [Variant] {
        &[]
    }
    /// `shortDeck`: whether this parser reads short deck. `false`, the
    /// default, means every short-deck hand it returns is refused.
    fn short_deck(&self) -> bool {
        false
    }
}

/// A parser that claims a text, with its score (`DetectionCandidate`).
#[derive(Debug, Clone, Copy)]
pub struct DetectionCandidate<'r> {
    pub parser: &'r dyn SiteParser,
    pub permille: u32,
}

/// The parser registry: registration order matters, because ties in
/// detection keep it (the TypeScript sorts stably over a `Map`).
#[derive(Debug, Default)]
pub struct Registry {
    parsers: Vec<Box<dyn SiteParser>>,
}

impl Registry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// `registerParser`: appends, or - for an id already registered - replaces
    /// the parser in place, keeping its position (`Map.prototype.set`).
    pub fn register(&mut self, parser: Box<dyn SiteParser>) {
        if let Some(slot) = self.parsers.iter_mut().find(|p| p.id() == parser.id()) {
            *slot = parser;
        } else {
            self.parsers.push(parser);
        }
    }

    /// `unregisterParser`.
    pub fn unregister(&mut self, id: &str) {
        self.parsers.retain(|parser| parser.id() != id);
    }

    /// `getParsers`, in registration order.
    pub fn parsers(&self) -> impl Iterator<Item = &dyn SiteParser> {
        self.parsers.iter().map(|parser| parser.as_ref())
    }

    /// `getParser`.
    pub fn get(&self, id: &str) -> Option<&dyn SiteParser> {
        self.parsers().find(|parser| parser.id() == id)
    }

    /// `detectSite`: every parser that scores at least the threshold, best
    /// first, ties in registration order.
    pub fn detect_site(&self, text: &str) -> Vec<DetectionCandidate<'_>> {
        let mut out: Vec<DetectionCandidate<'_>> = self
            .parsers()
            .map(|parser| DetectionCandidate {
                parser,
                permille: parser.detect(text),
            })
            .filter(|candidate| candidate.permille >= DETECTION_THRESHOLD_PERMILLE)
            .collect();
        // `sort` is stable, like `Array.prototype.sort`.
        out.sort_by_key(|candidate| std::cmp::Reverse(candidate.permille));
        out
    }
}

/// `normalizeForFingerprint`: runs of JavaScript whitespace collapsed to one
/// space, then trimmed - so a file re-saved with CRLF fingerprints the same.
pub fn normalize_for_fingerprint(text: &str) -> String {
    js::trim(&js::collapse_whitespace(text)).to_owned()
}

/// `fingerprint`: sha-256 hex of the normalized text's UTF-8; the dedupe key
/// for failures.
pub fn fingerprint(text: &str) -> String {
    let digest = Sha256::digest(normalize_for_fingerprint(text).as_bytes());
    digest
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// `fingerprintSync`: the 128-bit FNV-1a-style mix the TypeScript falls back
/// to without Web Crypto, over UTF-16 code units with `Math.imul` arithmetic.
/// The Rust core always has sha-256 ([`fingerprint`]); this exists so a row
/// written by that fallback can be recognised and recomputed.
pub fn fingerprint_sync(text: &str) -> String {
    let input = normalize_for_fingerprint(text);
    let (mut h1, mut h2, mut h3, mut h4): (u32, u32, u32, u32) =
        (0x811c_9dc5, 0x0100_0193, 0x9e37_79b9, 0x85eb_ca6b);
    for (i, code) in (0_u32..).zip(input.encode_utf16()) {
        let code = u32::from(code);
        h1 = (h1 ^ code).wrapping_mul(0x0100_0193);
        h2 = h2.wrapping_add(code).wrapping_mul(0x85eb_ca6b);
        h3 = (h3 ^ code.wrapping_add(i)).wrapping_mul(0xc2b2_ae35);
        h4 = h4.wrapping_add(code << (i % 13)).wrapping_mul(0x27d4_eb2f);
    }
    format!("fnv1a128-{h1:08x}{h2:08x}{h3:08x}{h4:08x}")
}

/// `"<trimmed label>"`, or `This hand` for a blank label.
fn named(label: &str) -> String {
    let trimmed = js::trim(label);
    if trimmed.is_empty() {
        "This hand".to_owned()
    } else {
        format!("\"{trimmed}\"")
    }
}

fn hi_lo_skip(label: &str) -> ParseSkip {
    ParseSkip::new(
        SkipReason::UnsupportedHiLo,
        format!(
            "{} is a high-low split game this parser has not been verified against. \
             Half the pot goes to the low hand, and a hi/lo hand read as a high-only hand \
             balances against itself - so it is refused rather than approximated.",
            named(label)
        ),
    )
}

/// `HI_LO_SKIP_REASON`.
pub const HI_LO_SKIP_REASON: SkipReason = SkipReason::UnsupportedHiLo;

/// `unsupportedGameSkip(label, hiLoVariants)`: the refusal for a hi/lo label
/// whose deal is not on the parser's hi/lo list; `None` otherwise.
pub fn unsupported_game_skip(label: &str, hi_lo_variants: &[Variant]) -> Option<ParseSkip> {
    if !crate::phf::is_hi_lo_label(label) {
        return None;
    }
    if hi_lo_variants.contains(&variant_from_label(label)) {
        None
    } else {
        Some(hi_lo_skip(label))
    }
}

/// `unsupportedGameSkipForGame(game, hiLoVariants)`: the same question for a
/// built hand, trusting `game.hiLo` rather than re-reading the label.
pub fn unsupported_game_skip_for_game(
    game: &PhfGame,
    hi_lo_variants: &[Variant],
) -> Option<ParseSkip> {
    (game.hi_lo && !hi_lo_variants.contains(&game.variant)).then(|| hi_lo_skip(&game.label))
}

/// `shortDeckSkip(label)`: the refusal for a short-deck hand from a parser not
/// proven against short deck.
pub fn short_deck_skip(label: &str) -> ParseSkip {
    ParseSkip::new(
        SkipReason::UnsupportedVariant,
        format!(
            "{} is a short-deck game, which this parser has not been verified against. \
             It is dealt from 36 cards, a flush beats a full house and A-6-7-8-9 is a \
             straight, and a short-deck hand read as Hold'em balances against itself - so \
             it is refused rather than approximated.",
            named(label)
        ),
    )
}

#[cfg(test)]
mod tests {
    //! `tests/test/phfDetect.test.ts` (registry, fingerprint, the parts of
    //! detection that need no parser) and the backstop half of
    //! `tests/test/phfOmaha.test.ts`.

    use std::collections::BTreeSet;
    use std::path::Path;

    use super::*;
    use crate::js::regex::js_regex;

    #[derive(Debug)]
    struct Fake {
        id: &'static str,
        prefix: &'static str,
        score: u32,
    }

    impl SiteParser for Fake {
        fn id(&self) -> &'static str {
            self.id
        }
        fn name(&self) -> &'static str {
            "Fake"
        }
        fn version(&self) -> &'static str {
            "0.0.1"
        }
        fn detect(&self, text: &str) -> u32 {
            if text.starts_with(self.prefix) {
                self.score
            } else {
                0
            }
        }
        fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
            Ok(vec![text.to_owned()])
        }
        fn parse_hand(&self, _: &str, _: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
            Err(ParseError::Bug("not implemented".to_owned()))
        }
    }

    fn fake(id: &'static str, prefix: &'static str, score: u32) -> Box<dyn SiteParser> {
        Box::new(Fake { id, prefix, score })
    }

    #[test]
    fn ranks_best_first_with_ties_in_registration_order() {
        let mut registry = Registry::new();
        registry.register(fake("a", "X", 900));
        registry.register(fake("b", "X", 950));
        registry.register(fake("c", "X", 900));
        registry.register(fake("d", "X", 199));
        registry.register(fake("e", "X", 200));
        let ranked: Vec<_> = registry
            .detect_site("X")
            .iter()
            .map(|c| (c.parser.id(), c.permille))
            .collect();
        assert_eq!(ranked, [("b", 950), ("a", 900), ("c", 900), ("e", 200)]);
    }

    #[test]
    fn registering_an_id_again_replaces_it_in_place() {
        let mut registry = Registry::new();
        registry.register(fake("a", "X", 900));
        registry.register(fake("b", "X", 900));
        registry.register(fake("a", "Y", 900));
        let ids: Vec<_> = registry.parsers().map(SiteParser::id).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(registry.detect_site("X")[0].parser.id(), "b");
        registry.unregister("a");
        assert!(registry.get("a").is_none());
        assert_eq!(registry.get("b").map(SiteParser::name), Some("Fake"));
    }

    #[test]
    fn returns_nothing_for_text_that_is_not_a_hand_history() {
        let mut registry = Registry::new();
        registry.register(fake("test-site", "TESTSITE", 1000));
        assert!(registry.detect_site("hello world").is_empty());
        assert_eq!(
            registry.detect_site("TESTSITE Hand #1")[0].parser.id(),
            "test-site"
        );
    }

    #[test]
    fn fingerprint_is_a_sha_256_hex_digest() {
        assert_eq!(
            fingerprint("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn fingerprint_ignores_whitespace_differences_so_a_re_saved_file_dedupes() {
        let a = "Poker Hand #1:\nSeat 1: x ($1 in chips)";
        let b = "Poker Hand #1:\r\n  Seat 1: x ($1 in chips)\n";
        assert_eq!(normalize_for_fingerprint(a), normalize_for_fingerprint(b));
        assert_eq!(fingerprint(a), fingerprint(b));
    }

    #[test]
    fn fingerprint_uses_javascripts_whitespace() {
        // U+FEFF is \s to JavaScript; U+0085 is not.
        assert_eq!(
            normalize_for_fingerprint("\u{FEFF}a\u{FEFF}\u{FEFF}b"),
            "a b"
        );
        assert_eq!(normalize_for_fingerprint("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_ne!(fingerprint("a\u{85}b"), fingerprint("a b"));
    }

    #[test]
    fn has_a_deterministic_synchronous_fallback() {
        assert_eq!(fingerprint_sync("abc"), fingerprint_sync("abc"));
        assert_ne!(fingerprint_sync("abc"), fingerprint_sync("abd"));
        let re = js_regex(r"^fnv1a128-[0-9a-f]{32}$", "");
        assert!(re.is_match(&fingerprint_sync("abc")));
        // Computed by the TypeScript (`fingerprintSync`) under Node.
        assert_eq!(
            fingerprint_sync("abc"),
            "fnv1a128-1a47e90b836bcc4fbd643a5a83895fec"
        );
        assert_eq!(
            fingerprint_sync(" Poker Hand #1:\r\n€ 😀 "),
            "fnv1a128-8fbe73164050603cf4b040e948d05069"
        );
    }

    #[test]
    fn offers_parsers_a_ready_made_hi_lo_refusal_and_stays_quiet_otherwise() {
        let skip = unsupported_game_skip("PL Omaha Hi-Lo", &[]).expect("refused");
        assert_eq!(skip.reason, SkipReason::UnsupportedHiLo);
        assert_eq!(skip.reason, HI_LO_SKIP_REASON);
        assert_eq!(skip.stage, Stage::Parse);
        assert_eq!(
            skip.message,
            "\"PL Omaha Hi-Lo\" is a high-low split game this parser has not been verified \
             against. Half the pot goes to the low hand, and a hi/lo hand read as a high-only \
             hand balances against itself - so it is refused rather than approximated."
        );
        assert!(unsupported_game_skip("Omaha Pot Limit", &[]).is_none());
        assert!(unsupported_game_skip("PL Omaha Hi-Lo", &[Variant::Omaha]).is_none());
        assert_eq!(
            unsupported_game_skip("5 Card Omaha Hi/Lo", &[Variant::Omaha]).map(|s| s.reason),
            Some(SkipReason::UnsupportedHiLo)
        );
        assert_eq!(
            unsupported_game_skip("7 Card Stud Hi/Lo Limit", &[Variant::Omaha]).map(|s| s.reason),
            Some(SkipReason::UnsupportedHiLo)
        );
    }

    #[test]
    fn the_game_backstop_trusts_the_flag() {
        let mut game = crate::phf::test_support::hand().game;
        assert!(unsupported_game_skip_for_game(&game, &[]).is_none());
        game.hi_lo = true;
        game.label = "  ".to_owned();
        let skip = unsupported_game_skip_for_game(&game, &[]).expect("refused");
        assert!(
            skip.message
                .starts_with("This hand is a high-low split game")
        );
        assert!(unsupported_game_skip_for_game(&game, &[Variant::Holdem]).is_none());
    }

    #[test]
    fn short_deck_refusal_names_the_label() {
        let skip = short_deck_skip(" ShortDeck No Limit ");
        assert_eq!(skip.reason, SkipReason::UnsupportedVariant);
        assert_eq!(
            skip.message,
            "\"ShortDeck No Limit\" is a short-deck game, which this parser has not been \
             verified against. It is dealt from 36 cards, a flush beats a full house and \
             A-6-7-8-9 is a straight, and a short-deck hand read as Hold'em balances against \
             itself - so it is refused rather than approximated."
        );
    }

    /// Every `.ts` file below `dir`.
    fn ts_sources(dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("read frontend/src/lib") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                ts_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "ts") {
                out.push(std::fs::read_to_string(&path).expect("read source"));
            }
        }
    }

    /// The reason enum is the TypeScript's reason set, no more and no less.
    #[test]
    fn skip_reasons_are_exactly_the_typescript_set() {
        let lib = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/src/lib");
        let mut sources = Vec::new();
        ts_sources(&lib, &mut sources);
        let thrown = js_regex(r#"ParseSkip\(\s*"([a-z0-9-]+)""#, "g");
        let weplay_skip = js_regex(r#"\breason: "([a-z0-9-]+)""#, "g");
        let mut codes = BTreeSet::new();
        for source in &sources {
            for captures in thrown.captures_iter(source) {
                codes.insert(captures[1].to_owned());
            }
            if source.contains("interface Skip {") {
                for captures in weplay_skip.captures_iter(source) {
                    codes.insert(captures[1].to_owned());
                }
            }
        }
        let detect_ts = include_str!("../../../../frontend/src/lib/phf/detect.ts");
        assert!(detect_ts.contains(r#"export const HI_LO_SKIP_REASON = "unsupported-hi-lo";"#));
        codes.insert(HI_LO_SKIP_REASON.as_str().to_owned());
        let ours: BTreeSet<String> = SkipReason::ALL
            .iter()
            .map(|r| r.as_str().to_owned())
            .collect();
        assert_eq!(
            ours, codes,
            "SkipReason differs from the reasons the TypeScript throws"
        );
        for reason in SkipReason::ALL {
            assert_eq!(SkipReason::from_code(reason.as_str()), Some(*reason));
        }
    }

    #[test]
    fn pipeline_reasons_and_stages_are_the_typescript_codes() {
        let detect_ts = include_str!("../../../../frontend/src/lib/phf/detect.ts");
        for reason in PipelineReason::ALL {
            assert!(
                detect_ts.contains(&format!("\"{}\"", reason.as_str())),
                "{reason}"
            );
        }
        assert!(
            detect_ts
                .contains(r#"stage: "split" | "detect" | "parse" | "validate" | "serialize";"#)
        );
        assert_eq!(
            Stage::ALL.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            ["split", "detect", "parse", "validate", "serialize"]
        );
        assert_eq!(
            FailureReason::Validation("chip-mismatch".into()).as_str(),
            "chip-mismatch"
        );
        assert_eq!(
            FailureReason::from(SkipReason::BbOnlyWalk).as_str(),
            "bb-only-walk"
        );
    }

    #[test]
    fn the_threshold_is_the_typescript_one() {
        let detect_ts = include_str!("../../../../frontend/src/lib/phf/detect.ts");
        assert!(detect_ts.contains("export const DETECTION_THRESHOLD = 0.2;"));
        assert_eq!(DETECTION_THRESHOLD_PERMILLE, 200);
    }
}
