//! Refusal reason codes: every machine code a `ConversionFailure.reason` can
//! hold, with the TypeScript strings.

use std::fmt;

/// Declares a string-coded enum: variants, their codes, `as_str`, `from_code`
/// and `ALL`.
macro_rules! coded_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $code:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $($(#[$vmeta])* #[doc = concat!("`", $code, "`")] $variant,)+
        }

        impl $name {
            /// Every variant, in declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            /// The TypeScript code.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $code,)+
                }
            }

            /// The variant with this code.
            pub fn from_code(code: &str) -> Option<Self> {
                match code {
                    $($code => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

coded_enum! {
    /// The reason a parser refuses a hand it recognises (`ParseSkip.reason`).
    ///
    /// The complete set of codes the TypeScript parsers throw - every
    /// `new ParseSkip("…")` in `frontend/src/lib`, the WePlay normalizer's
    /// `Skip` records, and `HI_LO_SKIP_REASON` - checked against the source by
    /// `detect::tests::skip_reasons_are_exactly_the_typescript_set`.
    SkipReason {
        AllInOrFoldTable = "all-in-or-fold-table",
        AmbiguousAmount = "ambiguous-amount",
        BbOnlyWalk = "bb-only-walk",
        BoardMismatch = "board-mismatch",
        BoardSize = "board-size",
        BombPot = "bomb-pot",
        CancelledHand = "cancelled-hand",
        Cashout = "cashout",
        ChipMismatch = "chip-mismatch",
        ContributionMismatch = "contribution-mismatch",
        CorruptHand = "corrupt-hand",
        DuplicateCard = "duplicate-card",
        DuplicatePlayer = "duplicate-player",
        DuplicateSeat = "duplicate-seat",
        FractionalChips = "fractional-chips",
        GhostAnte = "ghost-ante",
        HandCancelled = "hand-cancelled",
        InconsistentPot = "inconsistent-pot",
        LossyEncoding = "lossy-encoding",
        MalformedXml = "malformed-xml",
        MissingStreetMarkers = "missing-street-markers",
        NoCurrency = "no-currency",
        NoHands = "no-hands",
        NoHeader = "no-header",
        NoPlayers = "no-players",
        NoSeatBlock = "no-seat-block",
        NoWinner = "no-winner",
        NormalizedUnparseable = "normalized-unparseable",
        PayoutMismatch = "payout-mismatch",
        PlayMoney = "play-money",
        RakeMismatch = "rake-mismatch",
        RiverWithoutTurn = "river-without-turn",
        RunItTwice = "run-it-twice",
        ShortAllinBigBlind = "short-allin-big-blind",
        ShortAllinCall = "short-allin-call",
        ShortAllinSmallBlind = "short-allin-small-blind",
        TooFewPlayers = "too-few-players",
        TournamentInCashMode = "tournament-in-cash-mode",
        TournamentSummary = "tournament-summary",
        TournamentUnsupported = "tournament-unsupported",
        TruncatedHand = "truncated-hand",
        TurnWithoutFlop = "turn-without-flop",
        UncalledExceedsCommitment = "uncalled-exceeds-commitment",
        UncalledMismatch = "uncalled-mismatch",
        UnknownActionType = "unknown-action-type",
        UnknownRound = "unknown-round",
        UnnamedActor = "unnamed-actor",
        UnnamedSeat = "unnamed-seat",
        UnseatedActor = "unseated-actor",
        UnsupportedCurrency = "unsupported-currency",
        UnsupportedEncoding = "unsupported-encoding",
        UnsupportedFormat = "unsupported-format",
        UnsupportedHiLo = "unsupported-hi-lo",
        UnsupportedLocale = "unsupported-locale",
        UnsupportedPrecision = "unsupported-precision",
        UnsupportedTournament = "unsupported-tournament",
        UnsupportedVariant = "unsupported-variant",
        ZeroStackActor = "zero-stack-actor",
    }
}

coded_enum! {
    /// Reasons the pipeline itself gives, around the parsers (`convertAny`).
    PipelineReason {
        /// No parser claims the text (or a forced site id is not registered).
        UnknownSite = "unknown-site",
        /// The primary parser's `splitHands` failed.
        SplitFailed = "split-failed",
        /// The primary parser's `splitHands` found nothing.
        NoHands = "no-hands",
        /// `parseHand` failed with something other than a `ParseSkip`.
        ParserError = "parser-error",
        /// `validateHand` failed without naming an error (cannot happen while
        /// `ok` means "no errors", but it is the TypeScript's fallback).
        InvalidHand = "invalid-hand",
    }
}

coded_enum! {
    /// `ConversionFailure.stage`.
    Stage {
        Split = "split",
        Detect = "detect",
        Parse = "parse",
        Validate = "validate",
        Serialize = "serialize",
    }
}

/// `ConversionFailure.reason`: one of three code spaces.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FailureReason {
    /// The pipeline's own reasons.
    Pipeline(PipelineReason),
    /// A parser's [`ParseSkip`](super::ParseSkip), or the pipeline's hi/lo
    /// and short-deck backstops.
    Skip(SkipReason),
    /// Stage `validate`: the code of the first error `validateHand` reports
    /// (`chip-mismatch`, `negative-stack`, …), a string as the
    /// [`ValidationProblem`](crate::validate::ValidationProblem) code it
    /// comes from is.
    Validation(String),
}

impl FailureReason {
    /// The machine code, as stored and as the goldens record it.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Pipeline(reason) => reason.as_str(),
            Self::Skip(reason) => reason.as_str(),
            Self::Validation(code) => code,
        }
    }
}

impl fmt::Display for FailureReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<SkipReason> for FailureReason {
    fn from(reason: SkipReason) -> Self {
        Self::Skip(reason)
    }
}

impl From<PipelineReason> for FailureReason {
    fn from(reason: PipelineReason) -> Self {
        Self::Pipeline(reason)
    }
}
