//! Segments (docs/RAIL-PLAN.md §3.4, R2.3): the unit statistics are summed
//! over. A segment is
//!
//! ```text
//! (site, game format, variant, limit, table-size class, stake)
//! ```
//!
//! - **site**: the site id trimmed and lower-cased - the prefix of
//!   `hand_key` (`handKeyOf`), so one room is one site whatever case its
//!   parser printed.
//! - **game format**: `cash`, `tournament`, `sng`, `spin`.
//! - **variant**: `holdem`, `omaha`, `omaha5`, ... (`Variant`).
//! - **limit**: `nl`, `pl`, `fl`.
//! - **table-size class** ([`SizeClass`]): by the table's seats (`maxSeats`),
//!   not by how many sat in: `hu` (2 seats), `6max` (3-6), `full` (7 and
//!   more). A 6-max table played three-handed is still `6max`, as trackers
//!   count it. A hand with no usable `maxSeats` (under 2) is classed by its
//!   players.
//! - **stake** ([`Stake`]): a cash game's currency and big blind in that
//!   currency's minor units, exactly (`USD:200` is $1/$2, `EUR:10` is
//!   EUR 0.05/0.10, `TCHIP:200` a play-money table): every stake level the
//!   rooms deal is its own bucket. A coarser grouping (NL2-NL5, "micro") is
//!   a sum over these at query time; a finer one could not be had back from
//!   a coarse key. Tournament formats (`tournament`, `sng`, `spin`) are
//!   `chips`: their blinds rise through the event, so a big blind names a
//!   level, not a game; the buy-in is not part of the segment (a filter on
//!   the hand, R2.7).
//!
//! The segment is a property of the hand: every seat of a hand is in the
//! same one. [`Segment::of`] is pure, and the HUD computes the segment of
//! the table it draws on the same way.

use rail_core::phf::{Amount, GameFormat, LimitType, PhfHand, Variant};

/// The table-size class of a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SizeClass {
    /// Two seats.
    HeadsUp,
    /// Three to six seats.
    ShortHanded,
    /// Seven seats and more (full ring: 7-, 8-, 9- and 10-max).
    FullRing,
}

impl SizeClass {
    /// `"hu"`, `"6max"`, `"full"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HeadsUp => "hu",
            Self::ShortHanded => "6max",
            Self::FullRing => "full",
        }
    }

    /// Back from [`SizeClass::as_str`].
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "hu" => Some(Self::HeadsUp),
            "6max" => Some(Self::ShortHanded),
            "full" => Some(Self::FullRing),
            _ => None,
        }
    }

    /// The class of a table with `max_seats` seats; `players` (seated in
    /// the hand) stands in when `max_seats` is under 2.
    pub fn of(max_seats: u32, players: usize) -> Self {
        let seats = if max_seats >= 2 {
            u64::from(max_seats)
        } else {
            u64::try_from(players).unwrap_or(u64::MAX)
        };
        match seats {
            0..=2 => Self::HeadsUp,
            3..=6 => Self::ShortHanded,
            _ => Self::FullRing,
        }
    }
}

/// The stake of a segment.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Stake {
    /// A tournament format: blinds rise, chips are not money.
    Chips,
    /// A cash game: the unit's code and the big blind in its minor units.
    Cash { currency: String, big_blind: Amount },
}

impl Stake {
    /// The stake of `hand`.
    pub fn of(hand: &PhfHand) -> Self {
        match hand.game.format {
            GameFormat::Cash => Self::Cash {
                currency: hand.game.unit.code.clone(),
                big_blind: hand.game.big_blind,
            },
            GameFormat::Tournament | GameFormat::Sng | GameFormat::Spin => Self::Chips,
        }
    }

    /// The column value: `chips`, or `<currency>:<big blind>` (`USD:200`).
    pub fn key(&self) -> String {
        match self {
            Self::Chips => "chips".to_owned(),
            Self::Cash {
                currency,
                big_blind,
            } => format!("{currency}:{big_blind}"),
        }
    }

    /// Back from [`Stake::key`]; `None` for anything it does not write.
    pub fn from_key(key: &str) -> Option<Self> {
        if key == "chips" {
            return Some(Self::Chips);
        }
        let (currency, big_blind) = key.rsplit_once(':')?;
        Some(Self::Cash {
            currency: currency.to_owned(),
            big_blind: big_blind.parse().ok()?,
        })
    }
}

/// One segment: (site, game format, variant, limit, table-size class,
/// stake).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Segment {
    /// The site id, trimmed and lower-cased (`hand_key`'s prefix).
    pub site: String,
    pub format: GameFormat,
    pub variant: Variant,
    pub limit: LimitType,
    pub size: SizeClass,
    pub stake: Stake,
}

/// `handKeyOf`'s site: trimmed (as JavaScript trims) and lower-cased.
pub fn site_key(site_id: &str) -> String {
    rail_core::js::trim(site_id).to_lowercase()
}

impl Segment {
    /// The segment `hand` is in.
    pub fn of(hand: &PhfHand) -> Self {
        Self {
            site: site_key(&hand.meta.site_id),
            format: hand.game.format,
            variant: hand.game.variant,
            limit: hand.game.limit,
            size: SizeClass::of(hand.table.max_seats, hand.players.len()),
            stake: Stake::of(hand),
        }
    }

    /// One line for logs and tests:
    /// `pokerstars/cash/holdem/nl/6max/USD:200`.
    pub fn key(&self) -> String {
        format!(
            "{}/{}/{}/{}/{}/{}",
            self.site,
            self.format.as_str(),
            self.variant.as_str(),
            self.limit.as_str(),
            self.size.as_str(),
            self.stake.key()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{SizeClass, Stake};

    #[test]
    fn size_classes_follow_the_seats() {
        let class = |seats, players| SizeClass::of(seats, players).as_str();
        assert_eq!(class(2, 2), "hu");
        assert_eq!(class(3, 2), "6max");
        assert_eq!(class(6, 2), "6max");
        assert_eq!(class(7, 9), "full");
        assert_eq!(class(9, 3), "full");
        assert_eq!(class(10, 10), "full");
        // No usable table size: the players decide.
        assert_eq!(class(0, 2), "hu");
        assert_eq!(class(1, 5), "6max");
        assert_eq!(class(0, 8), "full");
        for class in [
            SizeClass::HeadsUp,
            SizeClass::ShortHanded,
            SizeClass::FullRing,
        ] {
            assert_eq!(SizeClass::from_name(class.as_str()), Some(class));
        }
    }

    #[test]
    fn stake_keys_round_trip() {
        let cash = Stake::Cash {
            currency: "USD".to_owned(),
            big_blind: 200,
        };
        assert_eq!(cash.key(), "USD:200");
        assert_eq!(Stake::from_key("USD:200"), Some(cash));
        assert_eq!(Stake::Chips.key(), "chips");
        assert_eq!(Stake::from_key("chips"), Some(Stake::Chips));
        assert_eq!(Stake::from_key("USD:x"), None);
        assert_eq!(Stake::from_key("USD"), None);
    }
}
