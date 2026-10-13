//! The string tags of the PHF enums, for messages that print them (the
//! validator's `${hand.game.variant}`, `${action.type}`, …, and the local
//! store's columns). They are the serde tags; a test holds the two to each
//! other.

use super::{ActionType, GameFormat, LimitType, Position, PotHalf, Street, Variant};

impl GameFormat {
    /// `"cash"`, `"tournament"`, `"sng"` or `"spin"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cash => "cash",
            Self::Tournament => "tournament",
            Self::Sng => "sng",
            Self::Spin => "spin",
        }
    }
}

impl LimitType {
    /// `"nl"`, `"pl"` or `"fl"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Nl => "nl",
            Self::Pl => "pl",
            Self::Fl => "fl",
        }
    }
}

impl Position {
    /// The `Position` string, e.g. `"UTG+1"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Btn => "BTN",
            Self::Sb => "SB",
            Self::Bb => "BB",
            Self::Utg => "UTG",
            Self::Utg1 => "UTG+1",
            Self::Utg2 => "UTG+2",
            Self::Mp => "MP",
            Self::Lj => "LJ",
            Self::Hj => "HJ",
            Self::Co => "CO",
        }
    }
}

impl Variant {
    /// The `Variant` string, e.g. `"shortdeck"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Holdem => "holdem",
            Self::Omaha => "omaha",
            Self::Omaha5 => "omaha5",
            Self::Omaha6 => "omaha6",
            Self::Shortdeck => "shortdeck",
            Self::Stud => "stud",
            Self::Razz => "razz",
            Self::Draw => "draw",
            Self::Other => "other",
        }
    }
}

impl Street {
    /// The `Street` string, e.g. `"preflop"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preflop => "preflop",
            Self::Flop => "flop",
            Self::Turn => "turn",
            Self::River => "river",
            Self::Showdown => "showdown",
        }
    }
}

impl ActionType {
    /// The `ActionType` string, e.g. `"small-blind"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ante => "ante",
            Self::SmallBlind => "small-blind",
            Self::BigBlind => "big-blind",
            Self::Straddle => "straddle",
            Self::Post => "post",
            Self::MissedBlind => "missed-blind",
            Self::BombAnte => "bomb-ante",
            Self::Fold => "fold",
            Self::Check => "check",
            Self::Call => "call",
            Self::Bet => "bet",
            Self::Raise => "raise",
            Self::Uncalled => "uncalled",
            Self::Show => "show",
            Self::Muck => "muck",
            Self::Collect => "collect",
            Self::CashoutChoose => "cashout-choose",
            Self::CashoutPay => "cashout-pay",
        }
    }
}

impl PotHalf {
    /// `"hi"` or `"lo"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hi => "hi",
            Self::Lo => "lo",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn tag<T: serde::Serialize>(value: T) -> String {
        match serde_json::to_value(value) {
            Ok(Value::String(tag)) => tag,
            other => panic!("not a string tag: {other:?}"),
        }
    }

    #[test]
    fn every_tag_is_the_serde_tag() {
        use ActionType as A;
        use Variant as V;
        for v in [
            V::Holdem,
            V::Omaha,
            V::Omaha5,
            V::Omaha6,
            V::Shortdeck,
            V::Stud,
            V::Razz,
            V::Draw,
            V::Other,
        ] {
            assert_eq!(v.as_str(), tag(v));
        }
        for s in [
            Street::Preflop,
            Street::Flop,
            Street::Turn,
            Street::River,
            Street::Showdown,
        ] {
            assert_eq!(s.as_str(), tag(s));
        }
        for a in [
            A::Ante,
            A::SmallBlind,
            A::BigBlind,
            A::Straddle,
            A::Post,
            A::MissedBlind,
            A::BombAnte,
            A::Fold,
            A::Check,
            A::Call,
            A::Bet,
            A::Raise,
            A::Uncalled,
            A::Show,
            A::Muck,
            A::Collect,
            A::CashoutChoose,
            A::CashoutPay,
        ] {
            assert_eq!(a.as_str(), tag(a));
        }
        for h in [PotHalf::Hi, PotHalf::Lo] {
            assert_eq!(h.as_str(), tag(h));
        }
        for f in [
            GameFormat::Cash,
            GameFormat::Tournament,
            GameFormat::Sng,
            GameFormat::Spin,
        ] {
            assert_eq!(f.as_str(), tag(f));
        }
        for l in [LimitType::Nl, LimitType::Pl, LimitType::Fl] {
            assert_eq!(l.as_str(), tag(l));
        }
        for p in [
            Position::Btn,
            Position::Sb,
            Position::Bb,
            Position::Utg,
            Position::Utg1,
            Position::Utg2,
            Position::Mp,
            Position::Lj,
            Position::Hj,
            Position::Co,
        ] {
            assert_eq!(p.as_str(), tag(p));
        }
    }
}
