#![forbid(unsafe_code)]
//! The HUD overlay process (docs/RAIL-PLAN.md §3.2, Phase 3). It runs apart
//! from the app so that a stalled UI never freezes overlays on live tables.
//! Everything is in the library (`rail_hud`).

fn main() {
    std::process::exit(rail_hud::main_with(std::env::args_os().skip(1).collect()));
}
