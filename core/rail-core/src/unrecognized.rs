//! The unsupported-format registry's record (docs/RAIL-PLAN.md R0.11).
//!
//! When no parser claims a file, the pipeline refuses it whole as
//! `unknown-site` (the refusal the goldens pin). [`crate::convert`] returns,
//! next to that refusal, an [`Unrecognized`]: what the desktop app keeps in
//! its local `unsupported` table (R1.2) and, with the user's consent, sends
//! to `unparsed_hands` together with an [`crate::anonymise::shareable_sample`].
//! The record is a separate field of [`crate::FileConversion`], so the
//! refusal, and every golden, is unchanged.
//!
//! - `fingerprint` is the refusal's: sha-256 of the decoded text with
//!   JavaScript whitespace collapsed ([`crate::detect::fingerprint`]). The
//!   same file seen again - re-saved with CRLF, or by another user - is the
//!   same record, and its count goes up.
//! - `header_sample` is the first [`HEADER_LINES`] non-blank lines of the
//!   **anonymised** text, each without trailing whitespace and cut to
//!   [`HEADER_LINE_CHARS`] characters, joined with `\n`. The decoder has
//!   already dropped the BOM and turned CRLF / CR into LF, so the sample is a
//!   function of the text alone. Anonymised so that a registry row can be
//!   shown, logged or attached to an issue without thinking about it.
//! - `guessed_site` / `confidence`: the best detector score that is above
//!   zero but below the 0.2 threshold, if any parser gave one
//!   ([`GuessBasis::BelowThreshold`]); otherwise the best match against the
//!   signatures of formats we know and have no parser for
//!   ([`KNOWN_FORMATS`], [`GuessBasis::KnownFormat`]), when at least half of
//!   a signature's markers are present. Per-mille, 0 without a guess.

use crate::anonymise::{anonymise, floor_char_boundary};
use crate::detect::{DETECTION_THRESHOLD_PERMILLE, Registry, fingerprint};

/// Lines in a header sample.
pub const HEADER_LINES: usize = 12;
/// Characters kept of each header line.
pub const HEADER_LINE_CHARS: usize = 160;

/// A file no parser claims, as the registry records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unrecognized {
    /// The `unknown-site` refusal's fingerprint: the registry's key.
    pub fingerprint: String,
    /// The first lines of the anonymised text (see the module docs).
    pub header_sample: String,
    /// A parser id or a known format's id; `None` without a guess.
    pub guessed_site: Option<String>,
    /// The guess's score in per-mille; 0 without a guess.
    pub confidence: u32,
    /// Where the guess came from.
    pub guess_basis: Option<GuessBasis>,
    /// What the text looks like at a glance.
    pub shape: TextShape,
}

/// Where a guess came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GuessBasis {
    /// A parser's detector scored the text above zero, below the threshold.
    BelowThreshold,
    /// The text matches the signature of a format we have no parser for.
    KnownFormat,
}

impl GuessBasis {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BelowThreshold => "below-threshold",
            Self::KnownFormat => "known-format",
        }
    }
}

/// The text's outer form, from its first non-whitespace character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TextShape {
    /// Starts with `<`.
    Xml,
    /// Starts with `{` or `[`.
    Json,
    /// Anything else.
    Text,
}

impl TextShape {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Xml => "xml",
            Self::Json => "json",
            Self::Text => "text",
        }
    }

    pub fn of(text: &str) -> Self {
        match crate::js::trim_start(text).chars().next() {
            Some('<') => Self::Xml,
            Some('{' | '[') => Self::Json,
            _ => Self::Text,
        }
    }
}

/// A format we know of and cannot read: an id and the literal markers its
/// files carry. Only formats with a real sample in the corpus are here
/// (`fixtures/samples/<id>/`); the ones known without a sample are listed in
/// `docs/unsupported-formats.md`, where a signature would be a guess.
#[derive(Debug, Clone, Copy)]
pub struct KnownFormat {
    pub id: &'static str,
    pub markers: &'static [&'static str],
}

/// Formats with samples and no parser.
pub const KNOWN_FORMATS: &[KnownFormat] = &[
    // Boss Media (Sweden): `<HISTORY ...>` with `<PLAYER NAME=...>` and
    // `<ACTION TYPE=...>`; cards as numeric `LINK`s.
    KnownFormat {
        id: "bossmedia",
        markers: &[
            "<HISTORY ID=",
            "GAMEKIND=",
            "<PLAYER NAME=",
            "<ACTION TYPE=",
        ],
    },
    // Merge Gaming (Carbon, Lock): `<description .../>` then `<game id=...>`,
    // seats as `nickname=`, actions in `<round id=...>`.
    KnownFormat {
        id: "merge",
        markers: &["<description type=", "<game id=", "nickname=", "<round id="],
    },
];

/// The least share of a signature's markers, in per-mille, that is a guess.
pub const KNOWN_FORMAT_MIN_PERMILLE: u32 = 500;

/// The registry record of a text no parser claims. Meant for a text whose
/// detection came back empty; for any other text the guess may well be a
/// parser that claims it.
pub fn unrecognized(registry: &Registry, text: &str) -> Unrecognized {
    let below = registry
        .parsers()
        .map(|parser| (parser.id(), parser.detect(text)))
        .filter(|&(_, permille)| permille > 0 && permille < DETECTION_THRESHOLD_PERMILLE)
        // The best; on a tie the first registered.
        .fold(None, |best: Option<(&str, u32)>, candidate| match best {
            Some(best) if best.1 >= candidate.1 => Some(best),
            _ => Some(candidate),
        });
    let (guessed_site, confidence, guess_basis) = match below {
        Some((id, permille)) => (Some(id), permille, Some(GuessBasis::BelowThreshold)),
        None => match known_format(text) {
            Some((id, permille)) => (Some(id), permille, Some(GuessBasis::KnownFormat)),
            None => (None, 0, None),
        },
    };
    Unrecognized {
        fingerprint: fingerprint(text),
        header_sample: header_sample(&anonymise(text).text),
        guessed_site: guessed_site.map(str::to_owned),
        confidence,
        guess_basis,
        shape: TextShape::of(text),
    }
}

/// The best [`KNOWN_FORMATS`] match at or above
/// [`KNOWN_FORMAT_MIN_PERMILLE`], first listed on a tie.
pub fn known_format(text: &str) -> Option<(&'static str, u32)> {
    KNOWN_FORMATS
        .iter()
        .filter_map(|format| {
            let total = u32::try_from(format.markers.len())
                .ok()
                .filter(|&n| n > 0)?;
            let hits = u32::try_from(
                format
                    .markers
                    .iter()
                    .filter(|marker| text.contains(**marker))
                    .count(),
            )
            .ok()?;
            let permille = hits.checked_mul(1000)? / total;
            (permille >= KNOWN_FORMAT_MIN_PERMILLE).then_some((format.id, permille))
        })
        .fold(None, |best, candidate| match best {
            Some((_, permille)) if permille >= candidate.1 => best,
            _ => Some(candidate),
        })
}

/// The header sample of an (already anonymised) text.
pub fn header_sample(text: &str) -> String {
    text.split('\n')
        .map(crate::js::trim_end)
        .filter(|line| !crate::js::trim(line).is_empty())
        .take(HEADER_LINES)
        .map(|line| {
            let cut = line
                .char_indices()
                .nth(HEADER_LINE_CHARS)
                .map_or(line.len(), |(index, _)| index);
            &line[..floor_char_boundary(line, cut)]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_sample_is_normalised() {
        let text = "\n  first line   \n\n\tsecond\t\n".to_owned() + &"x".repeat(500);
        let sample = header_sample(&text);
        assert_eq!(
            sample,
            format!("  first line\n\tsecond\n{}", "x".repeat(HEADER_LINE_CHARS))
        );
        let many: String = (0..30).map(|i| format!("line {i}\n")).collect();
        assert_eq!(header_sample(&many).lines().count(), HEADER_LINES);
    }

    #[test]
    fn shapes() {
        assert_eq!(TextShape::of("  <xml/>"), TextShape::Xml);
        assert_eq!(TextShape::of("\n{\"a\":1}"), TextShape::Json);
        assert_eq!(TextShape::of("[1]"), TextShape::Json);
        assert_eq!(TextShape::of("Game #1"), TextShape::Text);
        assert_eq!(TextShape::of(""), TextShape::Text);
    }

    #[test]
    fn known_formats_need_half_their_markers() {
        assert_eq!(
            known_format("<HISTORY ID=\"1\" GAMEKIND=\"x\">"),
            Some(("bossmedia", 500))
        );
        assert_eq!(known_format("<HISTORY ID=\"1\">"), None);
        assert_eq!(
            known_format("<description type=\"Holdem\"/><game id=\"1\"><round id=\"B\"/>"),
            Some(("merge", 750))
        );
    }
}
