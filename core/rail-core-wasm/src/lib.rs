//! WebAssembly facade over `rail-core` (docs/RAIL-PLAN.md R0.13): `convert`,
//! `detect`, `serialize` and `anonymise`, bytes and JSON text in, JSON text
//! out, for the web app's worker (R4.1) and the TypeScript harness's shadow
//! mode (`tests/scripts/wasm/`).
//!
//! The logic is [`api`], plain Rust, testable natively. This file is only
//! the `#[wasm_bindgen]` shims. The crate forbids `unsafe` like the other
//! core crates: the attribute does expand to `unsafe` ABI glue (`extern "C"`
//! exports, raw pointers into linear memory), but the `unsafe_code` lint
//! does not look inside an external macro's expansion, so `forbid` holds
//! every line written here to it and nothing else.
//!
//! The typed TypeScript wrapper (`JSON.parse` and the result types over the
//! generated `types/phf.d.ts`) is `js/index.ts`; build with
//! `npm run wasm:build` in `tests/`.

#![forbid(unsafe_code)]

pub mod api;

use wasm_bindgen::prelude::*;

/// `convert(bytes, filename, optionsJson)`: one dropped file through the
/// whole pipeline; returns the `rail-convert/1` document as JSON text.
/// Throws on bad options. `optionsJson` must carry `parsedAt`.
#[wasm_bindgen]
pub fn convert(bytes: &[u8], filename: &str, options: &str) -> Result<String, JsError> {
    api::convert(bytes, filename, options).map_err(|message| JsError::new(&message))
}

/// `detect(bytes)`: decoding and the detection ranking, as JSON text.
#[wasm_bindgen]
pub fn detect(bytes: &[u8]) -> String {
    api::detect(bytes)
}

/// `serialize(phfJson)`: the standard text of one PHF hand, or of an array
/// of hands (a file). Throws when the JSON is not PHF.
#[wasm_bindgen]
pub fn serialize(phf: &str) -> Result<String, JsError> {
    api::serialize(phf).map_err(|message| JsError::new(&message))
}

/// `anonymise(bytes)`: the shareable sample of a file, as JSON text.
#[wasm_bindgen]
pub fn anonymise(bytes: &[u8]) -> String {
    api::anonymise(bytes)
}

/// The facade's document format and the PHF schema it writes, as JSON text:
/// `{ "convert": "rail-convert/1", "phf": "phf/1" }`.
#[wasm_bindgen]
pub fn formats() -> String {
    format!(
        "{{\"convert\":\"{}\",\"phf\":\"{}\"}}",
        api::CONVERT_FORMAT,
        rail_core::PHF_SCHEMA
    )
}
