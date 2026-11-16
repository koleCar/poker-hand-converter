//! A native port of the TypeScript solver path that a flop library solve runs
//! (`web/src/lib/solver`): the betting tree, the game (hands, card removal,
//! strength-sorted showdowns, suit isomorphism), discounted CFR with both
//! storage modes, exploitability and best response, frozen nodes for
//! nodelock, and the library's chunk encoding (docs/NODELOCK.md §2.5).
//!
//! **Parity first.** Every module mirrors its TypeScript twin operation for
//! operation: the same node order, the same summation order, `f64` scratch and
//! `f32` (or 16-bit) storage exactly where the TypeScript has them. A solve
//! here gives the TypeScript's strategies to within float noise (the parity
//! tests hold it to 1e-4), so the app can use either engine.
//!
//! **Speed** comes from the turn subtrees in parallel (`cfr.rs`, §2.2):
//! each traversal walks the flop part once to learn the opponent's reach at
//! every turn deal, solves the turn subtrees on every core, and walks the flop
//! part again to back the values up. The subtrees are combined in a fixed
//! order, so the result does not depend on the thread count.

// The solver is floating-point arithmetic and index casts throughout; the
// workspace denies both for money (docs/PHF-SPEC.md §1), which this crate
// never handles.
#![allow(
    clippy::float_arithmetic,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_arguments,
    clippy::too_many_lines,
    clippy::many_single_char_names,
    clippy::similar_names,
    // Index loops mirror the TypeScript line for line (and vectorise);
    // `!(x > 0.0)` is the TypeScript's NaN-aware test, on purpose.
    clippy::needless_range_loop,
    clippy::neg_cmp_op_on_partial_ord
)]

pub mod betting;
pub mod cards;
pub mod cfr;
pub mod chunk;
pub mod flop;
pub mod game;
pub mod iso;
pub mod js;
pub mod lock;
pub mod nodelock;
pub mod solve;
pub mod spot;
pub mod subgame;
pub mod tree;

pub use cfr::{
    DcfrParams, Exploitability, RunOptions, RunResult, Solver, SolverConfig, StoppedBy, Storage,
};
pub use flop::{FlopSpot, build_flop_game};
pub use solve::{Scope, SolveResult, SolvedNode, extract};
pub use subgame::{BuiltSubgame, build_river_game, build_turn_game};

/// Any input the solver cannot make sense of (`SolverInputError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolverInputError(pub String);

impl std::fmt::Display for SolverInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SolverInputError {}

pub(crate) fn input_error<T>(message: impl Into<String>) -> Result<T, SolverInputError> {
    Err(SolverInputError(message.into()))
}
