//! Code the site parsers share (`frontend/src/lib/parsers/shared/`), ported as
//! the parsers that use it arrive. R0.5a: encoding recovery and the variant
//! lock. R0.7a: the PokerStars-family draft (`ps-gg-hand.ts`), its
//! re-export for the clone rooms (`p3-draft.ts`) and their line dispatcher
//! (`p3-stars-dialect.ts`).

pub mod p3_draft;
pub mod p3_stars_dialect;
pub mod p5_encoding;
pub mod ps_gg_hand;
pub mod variant_lock;
