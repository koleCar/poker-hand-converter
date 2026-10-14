//! What the writer stores: one [`ImportBatch`] per read of a file - the
//! file's new state (offset, size, mtime) together with the hands, refusals
//! and registry record that read produced. The writer commits a batch in one
//! transaction, so the offset and the hands up to it are stored together or
//! not at all.
//!
//! Everything expensive - canonical JSON, zstd, the statistics (R2.3) -
//! happens here, on the producer's thread, not on the writer's.

use rail_core::convert::{ConversionFailure, FileConversion};
use rail_core::phf::PhfHand;
use rail_core::unrecognized::Unrecognized;
use rail_equity::EvRow;
use rail_stats::{Segment, SiteAnonymization, StatsRow};

use crate::error::{Error, Result};
use crate::stats::{SeatValues, encode_seat};

/// zstd level for stored PHF. 3 is zstd's default: ~6-8x on canonical PHF,
/// fast enough that compression is a small part of an import.
pub const ZSTD_LEVEL: i32 = 3;

/// A file's state after a read: where the read started and ended, and what
/// the file looked like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileState {
    /// The file's path as text (the key of `files`).
    pub path: String,
    /// The watched folder it belongs to, when known (R1.3).
    pub source_id: Option<i64>,
    /// The offset this read started from. It must equal the stored offset,
    /// or be 0 (a re-read from the start, which dedupe makes safe);
    /// anything else is a stale batch and is refused whole.
    pub from_offset: u64,
    /// The offset the read ended at: everything before it has been turned
    /// into the hands and refusals of this batch.
    pub to_offset: u64,
    /// The file's size when read.
    pub size: u64,
    /// The file's modification time, ms since the epoch, when known.
    pub mtime_ms: Option<i64>,
    /// The decoder's encoding label (`UTF-8`, `UTF-16 LE`, ...).
    pub encoding: Option<String>,
    /// The parser that claimed the file (detection's top candidate).
    pub site: Option<String>,
    /// Why this read produced nothing usable, if it did not (not text, or
    /// the core threw). `None` clears an earlier error.
    pub last_error: Option<String>,
}

/// One converted hand, ready for `hands`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedHand {
    /// `<siteId>:<handKey>`: the web's `handKeyOf` (`frontend/src/lib/db/mapping.ts`).
    pub hand_key: String,
    pub site: String,
    pub site_hand_id: String,
    pub played_at: Option<String>,
    pub game_format: &'static str,
    pub variant: &'static str,
    pub limit_type: &'static str,
    pub currency: String,
    pub small_blind: i64,
    pub big_blind: i64,
    pub ante: i64,
    pub table_name: Option<String>,
    pub max_seats: u32,
    pub hero_seat: Option<u32>,
    pub hero_name: Option<String>,
    pub schema_version: &'static str,
    pub parser_id: String,
    pub parser_version: String,
    /// The canonical PHF JSON, zstd-compressed.
    pub phf_zstd: Vec<u8>,
    /// The canonical JSON's length in bytes.
    pub phf_size: u64,
    /// Its statistics (R2.3): derived here, on the producer's thread, and
    /// written with the hand.
    pub stats: PreparedStats,
}

/// What happens to a hand's all-in EV row (R2.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvPlan {
    /// No hero row: no EV row (as on the web).
    NoHero,
    /// Computed here: a hand without an all-in to evaluate, or one on the
    /// flop or turn (a few hundred boards at most).
    Row(EvRow),
    /// A preflop all-in: 1.7M boards to enumerate (25-46 ms) or 20 000 to
    /// sample. Queued in `ev_pending` for the background pass.
    Deferred,
}

/// A hand's statistics, ready for `seat_stats`, the rollups and `ev_rows`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedStats {
    pub anonymization: SiteAnonymization,
    pub segment: Segment,
    /// The kept rows ([`rail_stats::stored_rows`], villains included),
    /// ready for `seat_stats`.
    pub rows: Vec<PreparedSeat>,
    pub ev: EvPlan,
    /// What the Hands screen's list needs that the rows do not hold (R2.7a,
    /// `hand_list`).
    pub list: ListFacts,
}

/// A hand's facts for `hand_list` beyond its rows (R2.7a): what the list
/// shows and filters on without reading the PHF back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListFacts {
    /// The primary runout (`primaryBoard`), the cards separated by spaces;
    /// `''` when no board was dealt.
    pub board: String,
    /// The hero went all in with cards to come: the hands whose all-in EV
    /// differs from the result (`ev_rows`). A preflop all-in
    /// ([`EvPlan::Deferred`]) counts until the background pass has
    /// evaluated it, which sets the stored value to what it found (the
    /// analysis can still skip a hand: hole cards not shown, ...).
    pub all_in: bool,
    /// `results.wentToShowdown`.
    pub showdown: bool,
    /// `game.unit.symbol` (`$`, `''` for chips), so a list row prints its
    /// money without the PHF.
    pub currency_symbol: String,
}

/// One kept seat, with everything the writer stores of it computed here, on
/// the producer's thread: the writer only binds and sums.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSeat {
    pub row: StatsRow,
    /// Its rollup scope ([`rail_stats::rollup_scope`]).
    pub scope: String,
    /// Its counters and money...
    pub values: SeatValues,
    /// ...as `seat_stats.totals` stores them ([`crate::stats::encode_seat`]).
    pub totals: Vec<u8>,
    /// `seat_stats.hole_cards`: the cards separated by spaces.
    pub hole_cards: String,
}

impl PreparedStats {
    /// Derive the rows a store keeps for `hand` and plan its EV row.
    pub fn from_phf(hand: &PhfHand) -> Self {
        let stored = rail_stats::stored_rows(hand, true);
        let ev = match stored.rows.iter().find(|row| row.seat.is_hero) {
            None => EvPlan::NoHero,
            Some(hero) => {
                rail_equity::ev_row_unless_preflop(hand, hero).map_or(EvPlan::Deferred, EvPlan::Row)
            }
        };
        let anonymization = stored.anonymization;
        let list = ListFacts {
            board: rail_core::phf::hand::primary_board(hand).join(" "),
            all_in: match &ev {
                EvPlan::NoHero => false,
                EvPlan::Row(row) => row.applicable,
                EvPlan::Deferred => true,
            },
            showdown: hand.results.went_to_showdown,
            currency_symbol: hand.game.unit.symbol.clone(),
        };
        Self {
            anonymization,
            list,
            segment: stored.segment,
            rows: stored
                .rows
                .into_iter()
                .map(|row| {
                    let values = SeatValues::of(&row);
                    PreparedSeat {
                        scope: rail_stats::rollup_scope(anonymization, &row),
                        totals: encode_seat(&values),
                        hole_cards: row.seat.hole_cards.join(" "),
                        values,
                        row,
                    }
                })
                .collect(),
            ev,
        }
    }

    /// The hero's row, when there is one.
    pub fn hero(&self) -> Option<&StatsRow> {
        self.rows
            .iter()
            .map(|seat| &seat.row)
            .find(|row| row.seat.is_hero)
    }
}

/// `handKeyOf(hand)`: the site id trimmed and lower-cased, a colon, and
/// `meta.handKey` (or `meta.handId` when the key is empty).
pub fn hand_key_of(hand: &PhfHand) -> String {
    let site = rail_core::js::trim(&hand.meta.site_id).to_lowercase();
    let key = if hand.meta.hand_key.is_empty() {
        &hand.meta.hand_id
    } else {
        &hand.meta.hand_key
    };
    format!("{site}:{key}")
}

impl PreparedHand {
    /// Project and compress one hand.
    pub fn from_phf(hand: &PhfHand) -> Result<Self> {
        let json = rail_core::canonical::to_canonical_json(hand)
            .map_err(|error| Error::Canonical(error.to_string()))?;
        let phf_zstd =
            zstd::bulk::compress(json.as_bytes(), ZSTD_LEVEL).map_err(Error::Compression)?;
        let hero = hand.players.iter().find(|player| player.is_hero);
        Ok(Self {
            hand_key: hand_key_of(hand),
            site: hand.meta.site_id.clone(),
            site_hand_id: hand.meta.hand_id.clone(),
            played_at: hand.played_at.clone(),
            game_format: game_format_str(hand),
            variant: hand.game.variant.as_str(),
            limit_type: limit_str(hand),
            currency: hand.game.unit.code.clone(),
            small_blind: hand.game.small_blind,
            big_blind: hand.game.big_blind,
            ante: hand.game.ante,
            table_name: hand.table.name.clone(),
            max_seats: hand.table.max_seats,
            hero_seat: hero.map(|player| player.seat),
            hero_name: hero.map(|player| player.name.clone()),
            schema_version: rail_core::PHF_SCHEMA,
            parser_id: hand.meta.parser_id.clone(),
            parser_version: hand.meta.parser_version.clone(),
            phf_zstd,
            phf_size: u64::try_from(json.len()).map_err(|_| Error::OutOfRange("PHF size"))?,
            stats: PreparedStats::from_phf(hand),
        })
    }
}

fn game_format_str(hand: &PhfHand) -> &'static str {
    use rail_core::phf::GameFormat;
    match hand.game.format {
        GameFormat::Cash => "cash",
        GameFormat::Tournament => "tournament",
        GameFormat::Sng => "sng",
        GameFormat::Spin => "spin",
    }
}

fn limit_str(hand: &PhfHand) -> &'static str {
    use rail_core::phf::LimitType;
    match hand.game.limit {
        LimitType::Nl => "nl",
        LimitType::Pl => "pl",
        LimitType::Fl => "fl",
    }
}

/// Decompress a stored PHF back to its canonical JSON.
pub fn decompress_phf(blob: &[u8], size: u64) -> Result<String> {
    let capacity = usize::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
    let bytes = zstd::bulk::decompress(blob, capacity).map_err(Error::Compression)?;
    String::from_utf8(bytes).map_err(|_| Error::Corrupt("PHF is not UTF-8".to_owned()))
}

/// A refused chunk, ready for `quarantine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub chunk_index: Option<u32>,
    pub fingerprint: String,
    pub stage: &'static str,
    pub reason: String,
    pub message: String,
    pub detected_site: Option<String>,
    pub detection_permille: Option<u32>,
    pub parser_version: String,
    pub raw_text: String,
}

impl From<&ConversionFailure> for Refusal {
    fn from(failure: &ConversionFailure) -> Self {
        Self {
            chunk_index: failure.index,
            fingerprint: failure.fingerprint.clone(),
            stage: failure.stage.as_str(),
            reason: failure.reason.as_str().to_owned(),
            message: failure.message.clone(),
            detected_site: failure.detected_site.clone(),
            detection_permille: failure.detection_permille,
            parser_version: failure.parser_version.clone(),
            raw_text: failure.raw_text.clone(),
        }
    }
}

/// The registry record of a file no parser claims (R0.11), ready for
/// `unsupported`. The path and encoding come from the batch's [`FileState`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnrecognizedFile {
    pub fingerprint: String,
    pub header_sample: String,
    pub guessed_site: Option<String>,
    /// Per-mille.
    pub confidence: u32,
    pub guess_basis: Option<&'static str>,
    pub shape: &'static str,
}

impl From<&Unrecognized> for UnrecognizedFile {
    fn from(record: &Unrecognized) -> Self {
        Self {
            fingerprint: record.fingerprint.clone(),
            header_sample: record.header_sample.clone(),
            guessed_site: record.guessed_site.clone(),
            confidence: record.confidence,
            guess_basis: record.guess_basis.map(|basis| basis.as_str()),
            shape: record.shape.as_str(),
        }
    }
}

/// One read of one file, committed by the writer in one transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportBatch {
    pub file: FileState,
    pub hands: Vec<PreparedHand>,
    pub refusals: Vec<Refusal>,
    pub unrecognized: Option<UnrecognizedFile>,
}

impl ImportBatch {
    /// The batch for a read that produced `conversion`. `file.encoding`,
    /// `file.site` and `file.last_error` are filled from it.
    ///
    /// The file-level `unknown-site` refusal of a file no parser claims is
    /// not quarantined: the file goes to the registry (`unsupported`)
    /// instead, which holds its fingerprint and anonymised header.
    pub fn from_conversion(mut file: FileState, conversion: &FileConversion) -> Result<Self> {
        file.encoding = Some(conversion.encoding.label().to_owned());
        file.site = conversion
            .detected
            .first()
            .map(|candidate| candidate.parser.clone());
        file.last_error = None;
        let mut hands = Vec::new();
        let mut refusals = Vec::new();
        if let Some(problem) = conversion.problem {
            file.last_error = Some(format!("not readable as text: {problem}"));
        }
        match &conversion.result {
            None => {}
            Some(Err(error)) => file.last_error = Some(format!("the core threw: {error}")),
            Some(Ok(result)) => {
                hands.reserve(result.hands.len());
                for converted in &result.hands {
                    hands.push(PreparedHand::from_phf(&converted.hand)?);
                }
                refusals.extend(
                    result
                        .failures
                        .iter()
                        .filter(|failure| {
                            !(conversion.unrecognized.is_some() && failure.index.is_none())
                        })
                        .map(Refusal::from),
                );
            }
        }
        Ok(Self {
            file,
            hands,
            refusals,
            unrecognized: conversion.unrecognized.as_ref().map(UnrecognizedFile::from),
        })
    }
}

/// What the writer did with a batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportOutcome {
    /// `files.id` of the batch's file.
    pub file_id: i64,
    /// Hands stored (and queued for sync) by this batch.
    pub inserted: u32,
    /// Hands the store already had (dedupe by `hand_key`).
    pub duplicates: u32,
    /// Refusals written or refreshed in `quarantine`.
    pub quarantined: u32,
    /// The file went to the unsupported-format registry.
    pub unrecognized: bool,
}
