//! What a hand's player names are worth as identities:
//! `web/src/lib/db/anonymization.ts` (`detectAnonymization`), and
//! docs/DATABASE.md "Player identity and anonymized rooms".
//!
//! | value | the names are | rooms |
//! | --- | --- | --- |
//! | [`SiteAnonymization::None`] | persistent screen names | PokerStars, WePlay, ACR/WPN (normal dialects), ... |
//! | [`SiteAnonymization::Positional`] | position labels that remap every hand | Ignition / Bodog / Bovada |
//! | [`SiteAnonymization::OpaqueId`] | per-session tokens (hashes, numeric ids) | GGPoker, ACR/WPN's data-mined dialect |
//!
//! Not a statistic: which rows a writer keeps and how it groups them is the
//! writer's decision ([`crate::stored`]), made from this value.

use rail_core::phf::{PhfHand, PhfPlayer};

/// `SiteAnonymization`: the `site_anonymization` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SiteAnonymization {
    /// Persistent screen names: usable as identities.
    None,
    /// Every seat is named by its position relative to the button, which
    /// moves every hand: a name is a different human in every hand.
    Positional,
    /// Per-session tokens: one token is one human, but only within a
    /// session; the same human gets another token in another session.
    OpaqueId,
}

impl SiteAnonymization {
    /// The column value: `none`, `positional`, `opaque-id`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Positional => "positional",
            Self::OpaqueId => "opaque-id",
        }
    }

    /// `hasUsablePlayerNames`: villain names identify people across hands.
    pub const fn has_usable_player_names(self) -> bool {
        matches!(self, Self::None)
    }
}

/// `POSITIONAL_SITES`.
const POSITIONAL_SITES: [&str; 1] = ["ignition"];

/// `OPAQUE_ID_SITES`.
const OPAQUE_ID_SITES: [&str; 1] = ["ggpoker"];

/// `OPAQUE_ID_WARNINGS`: parser warnings that say the names are not screen
/// names (per hand: ACR/WPN's mined dialect shares its site id with the
/// normal ones).
const OPAQUE_ID_WARNINGS: [&str; 1] = ["numeric-player-ids"];

/// `MIN_VILLAINS_FOR_STRUCTURAL`.
const MIN_VILLAINS_FOR_STRUCTURAL: usize = 2;

/// `POSITION_PSEUDONYM`: `/^(?:dealer|small blind|big blind|utg(?:\+\d+)?)$/i`.
/// Without the `u` flag, `i` folds ASCII letters only and `\d` is `[0-9]`.
fn is_position_pseudonym(name: &str) -> bool {
    if ["dealer", "small blind", "big blind", "utg"]
        .iter()
        .any(|label| name.eq_ignore_ascii_case(label))
    {
        return true;
    }
    let Some(prefix) = name.get(..4) else {
        return false;
    };
    let digits = &name[4..];
    prefix.eq_ignore_ascii_case("utg+")
        && !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `OPAQUE_TOKEN`: `/^(?:[0-9a-f]{6,}|\d{5,})$/i`.
fn is_opaque_token(name: &str) -> bool {
    let hex = name.len() >= 6 && name.bytes().all(|b| b.is_ascii_hexdigit());
    let numeric = name.len() >= 5 && name.bytes().all(|b| b.is_ascii_digit());
    hex || numeric
}

fn villains_of(hand: &PhfHand) -> impl Iterator<Item = &PhfPlayer> {
    hand.players.iter().filter(|player| !player.is_hero)
}

/// `detectAnonymization(hand)`: the site registry, then parser warnings,
/// then the structural fallback (every villain name - at least two - a
/// position label, or every one an opaque token).
pub fn detect_anonymization(hand: &PhfHand) -> SiteAnonymization {
    let site = rail_core::js::trim(&hand.meta.site_id).to_lowercase();
    if POSITIONAL_SITES.contains(&site.as_str()) {
        return SiteAnonymization::Positional;
    }
    if OPAQUE_ID_SITES.contains(&site.as_str()) {
        return SiteAnonymization::OpaqueId;
    }
    if hand
        .meta
        .warnings
        .iter()
        .any(|warning| OPAQUE_ID_WARNINGS.contains(&warning.code.as_str()))
    {
        return SiteAnonymization::OpaqueId;
    }
    if villains_of(hand).count() < MIN_VILLAINS_FOR_STRUCTURAL {
        return SiteAnonymization::None;
    }
    let names: Vec<&str> = villains_of(hand)
        .map(|player| rail_core::js::trim(&player.name))
        .filter(|name| !name.is_empty())
        .collect();
    if names.len() < MIN_VILLAINS_FOR_STRUCTURAL {
        return SiteAnonymization::None;
    }
    if names.iter().all(|name| is_position_pseudonym(name)) {
        return SiteAnonymization::Positional;
    }
    if names.iter().all(|name| is_opaque_token(name)) {
        return SiteAnonymization::OpaqueId;
    }
    SiteAnonymization::None
}

#[cfg(test)]
mod tests {
    use super::{is_opaque_token, is_position_pseudonym};

    #[test]
    fn position_pseudonyms_are_the_typescript_regex() {
        for name in [
            "Dealer",
            "DEALER",
            "small blind",
            "Big Blind",
            "UTG",
            "utg+1",
            "UTG+12",
        ] {
            assert!(is_position_pseudonym(name), "{name}");
        }
        for name in ["UTG+", "UTG+a", "UTG 1", "Dealer ", "Smallblind", "", "MP"] {
            assert!(!is_position_pseudonym(name), "{name}");
        }
    }

    #[test]
    fn opaque_tokens_are_the_typescript_regex() {
        for name in ["a1b2c3", "ABCDEF12", "12345", "0123456789"] {
            assert!(is_opaque_token(name), "{name}");
        }
        for name in ["a1b2c", "1234", "abcdeg", "12 345", ""] {
            assert!(!is_opaque_token(name), "{name}");
        }
    }
}
