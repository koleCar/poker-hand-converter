//! `runitonce`: Run It Once Poker (`frontend/src/lib/parsers/runitonce.ts`).
//!
//! RIO (2019-2022, closed) wrote a close PokerStars clone, and the body of a
//! hand is read by [`parse_stars_family_body`]. What is RIO's own is the
//! header - dual-timestamped (`2019/06/25 16:12 UTC [.. CET]`), minutes and
//! no seconds -, the tournament header (a name, no level), and Splash The
//! Pot, which the dialect turns into house money.
//!
//! **Hold'em only, a finding rather than an oversight**: the corpus's one
//! Omaha file is a splash-the-pot hand with a side pot whose two `collected`
//! lines count the €5.00 splash twice (€148.84 against the summary's
//! €143.84), with nothing in the text to say which pot really got it. It is
//! refused `unsupported-variant` rather than converted wrong.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `runitonce.ts`); the detection probe and the split run at every
//! JavaScript line start.

use std::sync::LazyLock;

use regex::Regex;

use super::shared::p3_draft::{
    DraftGame, StarsHandDraft, buy_in_unit_for, detect_decimals, has_unsupported_currency,
    limit_from_label, normalize_newlines, strip_bom, to_lines, unit_for_stakes, variant_from_label,
};
use super::shared::p3_stars_dialect::parse_stars_family_body;
use super::shared::ps_gg_hand::{
    BuildError, DraftInit, skip, split_before_line_starts, unrepresentable, unseated,
};
use super::shared::variant_lock::unsupported_variant_skip;
use crate::detect::{
    ParseError, SiteParser, SiteParserContext, SkipReason, SplitError, unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::CHIPS;
use crate::phf::serialize::{line_starts, parse_instant, to_iso_string};
use crate::phf::{
    Amount, CurrencyUnit, GameFormat, PhfHand, PhfTextStyle, PhfTournament, Variant, parse_amount,
    parse_buy_in_token,
};

/// `RUNITONCE_PARSER_VERSION`.
pub const RUNITONCE_PARSER_VERSION: &str = "1.0.0";

/// `RUNITONCE_VARIANTS`: Hold'em only (see the module docs).
const RUNITONCE_VARIANTS: &[Variant] = &[Variant::Holdem];

/// `HEADER_REGEX`: `Run It Once Poker Hand #30266126:  Hold'em No Limit
/// (€0.05/€0.10) - ...`.
static HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Run It Once Poker Hand #(\d+):\s*(.*)$", "");
/// `HEADER_PREFIX`, also the body of the split's lookahead.
static HEADER_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^Run It Once Poker Hand #\d+:", "");
/// `ANY_HEADER` (`/m`): hand files and tournament-summary files.
static ANY_HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Run It Once Poker (?:Hand|Tournament) #\d+", "");
static BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(r"\bRun It Once Poker\b", "");

static PLAYED_AT_UTC: LazyLock<Regex> = crate::js_regex_lazy!(
    r"(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC",
    ""
);
static BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\s*(\S+)\/(\S+)", "");
static TOURNAMENT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Tournament #([^,]+), (\S+(?:\+\S+)*)\s+(.*?), (.+?)\s*\(([^)]*)\)\s+-\s+.*$",
    ""
);
static CASH: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$", "");

/// `Header`.
struct Header {
    hand_id: String,
    game: DraftGame,
    tournament: Option<PhfTournament>,
    played_at: Option<String>,
}

/// `parsePlayedAtUtc(payload)`: the UTC copy of the two timestamps; seconds
/// optional (hand headers stop at minutes).
fn parse_played_at_utc(payload: &str) -> Option<String> {
    let c = PLAYED_AT_UTC.captures(payload)?;
    let hour = &c[4];
    let hour = if hour.len() < 2 {
        format!("0{hour}")
    } else {
        hour.to_owned()
    };
    let seconds = c.get(6).map_or("00", |m| m.as_str());
    let iso = format!("{}-{}-{}T{hour}:{}:{seconds}Z", &c[1], &c[2], &c[3], &c[5]);
    parse_instant(&iso).map(to_iso_string)
}

/// `blindsFrom(stakesText, unit)`.
fn blinds_from(stakes_text: &str, unit: &CurrencyUnit) -> (Amount, Amount) {
    match BLINDS.captures(stakes_text) {
        None => (0, parse_amount(js::trim(stakes_text), unit)),
        Some(c) => (parse_amount(&c[1], unit), parse_amount(&c[2], unit)),
    }
}

/// `parseTournamentHeader(payload)`: `Tournament #158168, €4.69+€0.31 Cub3d,
/// Hold'em No Limit (10/20) - <date>`. No level: the parens are the level's
/// blinds, in chips, while the buy-in is money.
fn parse_tournament_header(payload: &str) -> Option<(PhfTournament, DraftGame)> {
    let c = TOURNAMENT.captures(payload)?;
    let (id, buy_in_token, name, label, stakes) = (&c[1], &c[2], &c[3], &c[4], &c[5]);
    let unit = unit_for_stakes(stakes, &CHIPS.unit())?;
    let (small_blind, big_blind) = blinds_from(stakes, &unit);
    let buy_in_unit = buy_in_unit_for(buy_in_token, None);
    let parts = parse_buy_in_token(buy_in_token, &buy_in_unit);
    let name = js::trim(name);
    Some((
        PhfTournament {
            id: id.to_owned(),
            name: (!name.is_empty()).then(|| name.to_owned()),
            buy_in: parts.buy_in,
            bounty: Some(parts.bounty),
            fee: parts.fee,
            buy_in_unit,
            level_label: None,
            level_number: None,
            level_small_blind: small_blind,
            level_big_blind: big_blind,
            level_ante: 0,
            bounties: Vec::new(),
            prize_pool: None,
        },
        DraftGame {
            variant: variant_from_label(label),
            limit: limit_from_label(label),
            format: GameFormat::Tournament,
            label: js::trim(label).to_owned(),
            unit,
            small_blind,
            big_blind,
        },
    ))
}

/// `parseHeader(line)`.
fn parse_header(line: &str) -> Option<Header> {
    let header = HEADER.captures(line)?;
    let hand_id = header[1].to_owned();
    let payload = header.get(2).map_or("", |m| m.as_str());
    let played_at = parse_played_at_utc(payload);

    if let Some((tournament, game)) = parse_tournament_header(payload) {
        return Some(Header {
            hand_id,
            game,
            tournament: Some(tournament),
            played_at,
        });
    }

    // `Hold'em No Limit (€0.05/€0.10) - 2019/06/25 16:12 UTC [...]`
    let cash = CASH.captures(payload)?;
    let label = js::trim(&cash[1]).to_owned();
    let unit = unit_for_stakes(&cash[2], &CHIPS.unit())?;
    let (small_blind, big_blind) = blinds_from(&cash[2], &unit);
    Some(Header {
        hand_id,
        game: DraftGame {
            variant: variant_from_label(&label),
            limit: limit_from_label(&label),
            format: GameFormat::Cash,
            label,
            unit,
            small_blind,
            big_blind,
        },
        tournament: None,
        played_at,
    })
}

/// `parseOneHand`.
fn parse_one_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(strip_bom(raw));
    let lines = to_lines(text);
    let first = lines.first().copied().unwrap_or("");
    if has_unsupported_currency(first) {
        return Err(skip(
            SkipReason::UnsupportedCurrency,
            format!("PHF has no unit for the currency in \"{first}\"."),
        ));
    }
    let Some(header) = parse_header(first) else {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The chunk has no readable Run It Once Poker header line.",
        ));
    };
    if let Some(refusal) = unsupported_game_skip(&header.game.label, &[]) {
        return Err(refusal.into());
    }
    if let Some(refusal) = unsupported_variant_skip(&header.game.label, RUNITONCE_VARIANTS) {
        return Err(refusal.into());
    }
    if ctx.options.cash_only && header.tournament.is_some() {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped because the converter is in cash-only mode.",
        ));
    }

    let unit = header.game.unit.clone();
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "runitonce".to_owned(),
        site_name: "Run It Once Poker".to_owned(),
        parser_id: "runitonce".to_owned(),
        parser_version: RUNITONCE_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        // Bare integers, namespaced against other rooms' numeric ids.
        hand_key: format!("RIO{}", header.hand_id),
        raw_text: text.to_owned(),
        original_filename: ctx.source_filename.map(str::to_owned),
        game: header.game,
        tournament: header.tournament,
        played_at: header.played_at,
        text_style: PhfTextStyle {
            decimals: detect_decimals(text),
            // The header states minutes only: no hour to pad either way.
            pad_hour: true,
            ..PhfTextStyle::default()
        },
        repair_missing_uncalled: false,
        parsed_at: ctx.parsed_at().to_owned(),
    });

    let body = parse_stars_family_body(&lines, &mut draft, &unit)?;

    if draft.player_count() == 0 {
        return Err(skip(
            SkipReason::NoSeatBlock,
            "The hand lists no seats, so nobody can be attributed.",
        ));
    }
    // The button as the JavaScript number it is: one beyond `u32` sits on
    // no seat either.
    if let Some(button) = body.button_seat_number
        && !body
            .seats
            .iter()
            .any(|seat| JsNumber::from_u64(u64::from(*seat)).strict_equals(button))
    {
        draft.warn(
            "button-seat-empty",
            format!(
                "The table line puts the button on seat {}, which nobody occupies; the seat \
                 number is kept as printed and the ring is resolved from the blinds.",
                button.to_js_string()
            ),
            None,
        );
    }
    // A table size or button beyond `u32` (`Table ID '1' 99999999999-Max`):
    // the TypeScript's hand holds it, so it is R0.6's parser error - but
    // only where the TypeScript returns that hand, after the unseated-actor
    // check. The dialect held it back for `build`; it is taken back here
    // (the stand-ins `set_table_numbers` used, 0 and none) and reported last.
    let as_u32 = |n: JsNumber| n.to_i64().and_then(|n| u32::try_from(n).ok());
    let held_back = if as_u32(body.max_seats_number).is_none() {
        Some("a table size")
    } else if body
        .button_seat_number
        .is_some_and(|button| as_u32(button).is_none())
    {
        Some("a button seat")
    } else {
        None
    };
    if held_back.is_some() {
        draft.set_table(
            body.table_name.clone(),
            body.max_seats,
            body.button_seat,
            None,
        );
    }

    let mut hand = match draft.build() {
        Ok(hand) => hand,
        Err(BuildError::Thrown(thrown)) => return Err(ParseError::Bug(thrown.message)),
        Err(BuildError::UnseatedStraddler) => {
            return Err(unseated(draft.first_unseated_actor().unwrap_or_default()));
        }
    };
    // Promotional chips the room put in itself: not actions.
    if !body.chip_movements.is_empty() {
        hand.chip_movements = Some(body.chip_movements);
    }

    let seated = draft.seated_names();
    if let Some(stranger) = hand
        .actions
        .iter()
        .find(|action| !seated.contains(&action.player))
    {
        return Err(unseated(&stranger.player));
    }
    if let Some(what) = held_back {
        return Err(ParseError::Bug(unrepresentable(what).message));
    }
    Ok(hand)
}

/// `runitonceParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunItOnceParser;

impl SiteParser for RunItOnceParser {
    fn id(&self) -> &'static str {
        "runitonce"
    }

    fn name(&self) -> &'static str {
        "Run It Once Poker"
    }

    fn version(&self) -> &'static str {
        RUNITONCE_PARSER_VERSION
    }

    /// 0.95 for a hand or tournament-summary header at a JavaScript line
    /// start (a summary file is claimed so it is reported as RIO with no
    /// hands), 0.3 for the name alone.
    fn detect(&self, text: &str) -> u32 {
        let stripped = strip_bom(text);
        if line_starts(stripped).any(|start| ANY_HEADER.is_match(&stripped[start..])) {
            return 950;
        }
        if BRANDING.is_match(text) {
            return 300;
        }
        0
    }

    /// Only `Hand #` chunks: a tournament summary splits to nothing.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        let normalized = normalize_newlines(strip_bom(text));
        Ok(split_before_line_starts(&normalized, &HEADER_PREFIX)
            .into_iter()
            .map(|chunk| js::trim(strip_bom(chunk)))
            .filter(|chunk| HEADER_PREFIX.is_match(chunk))
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_one_hand(raw, ctx)
    }
}

#[cfg(test)]
mod tests;
