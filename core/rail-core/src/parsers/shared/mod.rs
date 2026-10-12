//! Code the site parsers share (`frontend/src/lib/parsers/shared/`), ported as
//! the parsers that use it arrive. R0.5a: encoding recovery and the variant
//! lock. R0.7a: the PokerStars-family draft (`ps-gg-hand.ts`), its
//! re-export for the clone rooms (`p3-draft.ts`) and their line dispatcher
//! (`p3-stars-dialect.ts`). R0.8: the PartyGaming text helpers
//! (`p2-partygaming.ts`) and the draft builder of the rooms that print no
//! pot (`p2-handbuilder.ts`). R0.9: the XML reader (`p2-xml.ts`) and the
//! text-room helpers (`p4-textroom.ts`). R0.10a: the builder of Winamax and
//! Chico, which reconciles against the printed pot (`p6-handbuilder.ts`).

pub mod p2_handbuilder;
pub mod p2_partygaming;
pub mod p2_xml;
pub mod p3_draft;
pub mod p3_stars_dialect;
pub mod p4_textroom;
pub mod p5_encoding;
pub mod p6_handbuilder;
pub mod ps_gg_hand;
pub mod variant_lock;
