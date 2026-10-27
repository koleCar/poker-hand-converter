//! The one place the Full Tilt, Run It Once and PokerBros parsers reach into
//! the PokerStars-family draft (`web/src/lib/parsers/shared/p3-draft.ts`):
//! a re-export of the part of [`super::ps_gg_hand`] they use, so a change to
//! that module's surface has one place to be fixed.

pub use super::ps_gg_hand::{
    DraftGame, MONEY, StarsHandDraft, buy_in_unit_for, detect_decimals, detect_pad_hour,
    has_unsupported_currency, limit_from_label, normalize_newlines, strip_bom, to_lines,
    unit_for_stakes, variant_from_label,
};
