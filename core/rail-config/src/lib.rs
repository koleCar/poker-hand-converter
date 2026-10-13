#![forbid(unsafe_code)]
//! `config/sites.json` and `config/stats/`: schema, loading, validation
//! (docs/RAIL-PLAN.md §3.6, R0.12, R2.4).
//!
//! `sites.json` has one entry per poker client (room or skin) Rail knows, a
//! `network` entry where the clients behind a parser are not yet told apart,
//! and Rail's own `format`; every `rail_core` parser is named by at least one
//! entry, and a few entries name no parser (WPT Global, Boss Media, Merge).
//! Its shape is `config/sites.schema.json`; [`model`] mirrors it field for
//! field. Unknown is `null`, never a guess: a path or a `files` block is
//! `verified` only once it was seen on a real install (R1.4: WePlay's macOS
//! folder and files, GGPoker's and CoinPoker's "no local files" on macOS),
//! and until R3.0 every `hud.allowed` is `null`, which the HUD reads as no.
//!
//! Pure functions only - no file system, no network. The app embeds
//! [`SHIPPED`], fetches the remote copy itself, and calls [`load_remote`].
//! The parser ids come from the caller (`rail_core::parsers::REGISTRATION_ORDER`)
//! so this crate does not depend on the core. Builds for wasm32.
//!
//! - [`load`] / [`load_shipped`]: parse, [`validate`], [`check_coverage`].
//! - [`load_remote`]: parse and validate a downloaded file, then
//!   [`merge_remote`] it over the shipped one: paths, files and tables may
//!   change, HUD policy only gets stricter, unknown ids are ignored.
//! - [`model::Site::hud_permitted`]: compliance mode's one question (R3.10).
//! - [`stats`]: `config/stats/`, the displayed statistics as data (R2.4):
//!   [`stats::load_stats`], [`stats::SHIPPED_STATS`], the formula language.

pub mod merge;
pub mod model;
pub mod stats;
pub mod validate;

use std::fmt;

pub use merge::{HudLevel, MergeNote, Merged, merge_remote};
pub use model::{Config, Site};
pub use validate::{Problem, check_coverage, validate};

/// The `version` this build reads.
pub const VERSION: u32 = 1;

/// The copy shipped with this build: `config/sites.json`.
pub const SHIPPED: &str = include_str!("../../../config/sites.json");

/// Why a file was not loaded.
#[derive(Debug)]
pub enum Error {
    /// Not JSON, or not this shape (an unknown field, a wrong type).
    Json(serde_json::Error),
    /// A `version` this build does not read.
    Version { found: u32, expected: u32 },
    /// Read, but wrong: every problem found.
    Invalid(Vec<Problem>),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "sites.json is not readable: {error}"),
            Self::Version { found, expected } => {
                write!(f, "sites.json version {found}, expected {expected}")
            }
            Self::Invalid(problems) => {
                f.write_str("sites.json is invalid:")?;
                for problem in problems {
                    write!(f, "\n- {problem}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Version { .. } | Self::Invalid(_) => None,
        }
    }
}

/// Parse `text` and check its version; no other validation.
pub fn parse(text: &str) -> Result<Config, Error> {
    let config: Config = serde_json::from_str(text).map_err(Error::Json)?;
    if config.version != VERSION {
        return Err(Error::Version {
            found: config.version,
            expected: VERSION,
        });
    }
    Ok(config)
}

/// A complete file - the shipped copy: valid, and every parser in `parsers`
/// has an entry.
pub fn load(text: &str, parsers: &[&str]) -> Result<Config, Error> {
    let config = parse(text)?;
    let mut problems = validate(&config, parsers);
    problems.extend(check_coverage(&config, parsers));
    if problems.is_empty() {
        Ok(config)
    } else {
        Err(Error::Invalid(problems))
    }
}

/// [`SHIPPED`], loaded.
pub fn load_shipped(parsers: &[&str]) -> Result<Config, Error> {
    load(SHIPPED, parsers)
}

/// A downloaded file over the shipped one. A remote file that does not parse,
/// has another version, or fails [`validate`] is refused whole (`Err`): the
/// app keeps `shipped`. Coverage is not required of it - an entry it lacks
/// stays as shipped.
pub fn load_remote(shipped: &Config, text: &str, parsers: &[&str]) -> Result<Merged, Error> {
    let remote = parse(text)?;
    let problems = validate(&remote, parsers);
    if !problems.is_empty() {
        return Err(Error::Invalid(problems));
    }
    Ok(merge_remote(shipped, &remote))
}
