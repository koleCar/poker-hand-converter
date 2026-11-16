//! The user's nodelocks on this computer (docs/NODELOCK.md §3): thin
//! commands over `rail_store::node_locks`. Kept here only; never synced.
//!
//! - `nodelock_list` (the history, newest change first, optionally one
//!   spot's; no chunk), `nodelock_get` (one row with its chunk),
//!   `nodelock_save` (upsert; the whole row, chunk included),
//!   `nodelock_rename`, `nodelock_delete` (many ids at once).
//! - Rows cross as JSON with the table's column names (snake_case), with
//!   `lock_json` and `summary_json` as JSON values rather than text.
//! - **The chunk crosses as bytes**, never as a JSON array: `nodelock_get`
//!   answers a raw [`tauri::ipc::Response`] (as `flop_library_file` does),
//!   and `nodelock_save` takes a raw request body. Both are one frame
//!   ([`frame`]): the row's JSON length (u32, little-endian), the row's
//!   JSON (UTF-8), then the chunk's bytes to the end. The row's
//!   `result_size` says whether there is a chunk (`null`: none).
//!   `nodelock_get` of an unknown id answers no bytes at all.

use rail_store::{NodeLockRow, NodeLockSpot, NodeLockStatus, NodeLockStreet};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::commands::StoreState;

/// A nodelock as the window has it: the table's columns, `lock_json` and
/// `summary_json` parsed. On a save, an empty `id` asks for a new one, and
/// `created_at`, `updated_at` and `result_size` are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeLockDto {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    pub set_id: String,
    pub line: String,
    pub flop: String,
    pub turn: Option<String>,
    pub river: Option<String>,
    pub street: NodeLockStreet,
    pub node_path: String,
    /// The web's `LockSet`.
    pub lock_json: Value,
    pub lock_hash: String,
    pub preset: Option<String>,
    pub status: NodeLockStatus,
    pub engine: Option<String>,
    pub threads: Option<i64>,
    pub iterations: Option<i64>,
    pub exploitability_pct: Option<f64>,
    pub seconds: Option<f64>,
    pub peak_mb: Option<f64>,
    pub summary_json: Option<Value>,
    /// The chunk's bytes; `None`: no chunk.
    #[serde(default)]
    pub result_size: Option<i64>,
}

impl NodeLockDto {
    fn from_row(row: NodeLockRow) -> (Self, Option<Vec<u8>>) {
        // Stored text the store checked on the way in; a row that does not
        // parse (written by hand) still lists, as a string.
        let parse = |text: String| serde_json::from_str(&text).unwrap_or(Value::String(text));
        let dto = Self {
            id: row.id,
            name: row.name,
            created_at: row.created_at,
            updated_at: row.updated_at,
            set_id: row.set_id,
            line: row.line,
            flop: row.flop,
            turn: row.turn,
            river: row.river,
            street: row.street,
            node_path: row.node_path,
            lock_json: parse(row.lock_json),
            lock_hash: row.lock_hash,
            preset: row.preset,
            status: row.status,
            engine: row.engine,
            threads: row.threads,
            iterations: row.iterations,
            exploitability_pct: row.exploitability_pct,
            seconds: row.seconds,
            peak_mb: row.peak_mb,
            summary_json: row.summary_json.map(parse),
            result_size: row.result_size,
        };
        (dto, row.result)
    }

    fn into_row(self, result: Option<Vec<u8>>) -> Result<NodeLockRow, String> {
        if !self.lock_json.is_object() {
            return Err("a nodelock's lock_json is not an object".to_owned());
        }
        let text = |value: &Value| serde_json::to_string(value).map_err(|error| error.to_string());
        Ok(NodeLockRow {
            lock_json: text(&self.lock_json)?,
            summary_json: self.summary_json.as_ref().map(text).transpose()?,
            id: self.id,
            name: self.name,
            created_at: 0,
            updated_at: 0,
            set_id: self.set_id,
            line: self.line,
            flop: self.flop,
            turn: self.turn,
            river: self.river,
            street: self.street,
            node_path: self.node_path,
            lock_hash: self.lock_hash,
            preset: self.preset,
            status: self.status,
            engine: self.engine,
            threads: self.threads,
            iterations: self.iterations,
            exploitability_pct: self.exploitability_pct,
            seconds: self.seconds,
            peak_mb: self.peak_mb,
            result,
            result_size: None,
        })
    }
}

/// A spot of the Solver library, as the history filters by it.
#[derive(Debug, Clone, Deserialize)]
pub struct SpotDto {
    set_id: String,
    line: String,
    flop: String,
}

/// What a save gives back.
#[derive(Debug, Serialize)]
pub struct SavedDto {
    id: String,
    created_at: i64,
    updated_at: i64,
}

/// The row's JSON and the chunk as one frame: the JSON's length (u32,
/// little-endian), the JSON, the chunk.
pub fn frame(json: &[u8], chunk: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let len = u32::try_from(json.len()).map_err(|_| "a nodelock row too large".to_owned())?;
    let chunk = chunk.unwrap_or_default();
    let mut out = Vec::with_capacity(4 + json.len() + chunk.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(json);
    out.extend_from_slice(chunk);
    Ok(out)
}

/// A frame back into the row's JSON and the bytes after it.
pub fn unframe(bytes: &[u8]) -> Result<(&[u8], &[u8]), String> {
    let bad = || "not a nodelock frame".to_owned();
    let (head, rest) = bytes.split_first_chunk::<4>().ok_or_else(bad)?;
    let len = usize::try_from(u32::from_le_bytes(*head)).map_err(|_| bad())?;
    if rest.len() < len {
        return Err(bad());
    }
    Ok(rest.split_at(len))
}

/// The request's bytes: raw, or (where the webview's IPC falls back to
/// JSON) an array of byte values.
fn body_bytes(body: &InvokeBody) -> Result<std::borrow::Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(std::borrow::Cow::Borrowed(bytes)),
        InvokeBody::Json(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or_else(|| "not a nodelock frame".to_owned())
            })
            .collect::<Result<Vec<u8>, String>>()
            .map(std::borrow::Cow::Owned),
        InvokeBody::Json(_) => Err("not a nodelock frame".to_owned()),
    }
}

/// A frame from the window into the row to save (the chunk present when
/// the row's `result_size` is not null).
pub fn save_request(bytes: &[u8]) -> Result<NodeLockRow, String> {
    let (json, chunk) = unframe(bytes)?;
    let dto: NodeLockDto = serde_json::from_slice(json).map_err(|error| error.to_string())?;
    let result = dto.result_size.is_some().then(|| chunk.to_vec());
    dto.into_row(result)
}

/// A new nodelock id: a random uuid v4.
fn new_id() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| "no random id".to_owned())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

/// The history, newest change first, without the chunks; `spot` keeps one
/// spot's.
#[tauri::command]
pub async fn nodelock_list(
    store: State<'_, StoreState>,
    spot: Option<SpotDto>,
) -> Result<Vec<NodeLockDto>, String> {
    let spot = spot.map(|spot| NodeLockSpot {
        set_id: spot.set_id,
        line: spot.line,
        flop: spot.flop,
    });
    Ok(open(&store)?
        .reader()
        .node_locks(spot.as_ref())
        .map_err(text)?
        .into_iter()
        .map(|row| NodeLockDto::from_row(row).0)
        .collect())
}

/// One nodelock with its chunk, as a frame; no bytes when there is none of
/// that id.
#[tauri::command]
pub async fn nodelock_get(store: State<'_, StoreState>, id: String) -> Result<Response, String> {
    let Some(row) = open(&store)?.reader().node_lock(&id).map_err(text)? else {
        return Ok(Response::new(Vec::new()));
    };
    let (dto, chunk) = NodeLockDto::from_row(row);
    let json = serde_json::to_vec(&dto).map_err(|error| error.to_string())?;
    Ok(Response::new(frame(&json, chunk.as_deref())?))
}

/// Insert or replace a nodelock (the request's body is a frame). An empty
/// `id` gets a new uuid.
#[tauri::command]
pub async fn nodelock_save(
    store: State<'_, StoreState>,
    request: Request<'_>,
) -> Result<SavedDto, String> {
    let mut row = save_request(&body_bytes(request.body())?)?;
    if row.id.is_empty() {
        row.id = new_id()?;
    }
    let id = row.id.clone();
    let (created_at, updated_at) = open(&store)?
        .writer()
        .map_err(text)?
        .save_node_lock(row, rail_store::time::now_ms())
        .map_err(text)?;
    Ok(SavedDto {
        id,
        created_at,
        updated_at,
    })
}

/// Rename a nodelock; whether it was there.
#[tauri::command]
pub async fn nodelock_rename(
    store: State<'_, StoreState>,
    id: String,
    name: String,
) -> Result<bool, String> {
    open(&store)?
        .writer()
        .map_err(text)?
        .rename_node_lock(&id, &name, rail_store::time::now_ms())
        .map_err(text)
}

/// Delete nodelocks; how many went.
#[tauri::command]
pub async fn nodelock_delete(
    store: State<'_, StoreState>,
    ids: Vec<String>,
) -> Result<u64, String> {
    open(&store)?
        .writer()
        .map_err(text)?
        .delete_node_locks(ids)
        .map_err(text)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn dto() -> NodeLockDto {
        NodeLockDto {
            id: String::new(),
            name: "Tight BTN · A♣T♣6♦ · BTN vs BB".to_owned(),
            created_at: 0,
            updated_at: 0,
            set_id: "nlhe-cash-6max-100bb".to_owned(),
            line: "BTN-open/BB-call".to_owned(),
            flop: "AcTc6d".to_owned(),
            turn: None,
            river: None,
            street: NodeLockStreet::Flop,
            node_path: "r:0".to_owned(),
            lock_json: json!({"version": 1, "nodes": [], "earlier": "player", "targetPct": 1}),
            lock_hash: "ab".repeat(32),
            preset: Some("tight".to_owned()),
            status: NodeLockStatus::Solved,
            engine: Some("workers".to_owned()),
            threads: Some(9),
            iterations: Some(100),
            exploitability_pct: Some(0.97),
            seconds: Some(250.5),
            peak_mb: Some(1200.0),
            summary_json: Some(json!({"evGain": 0.4})),
            result_size: Some(4),
        }
    }

    /// A frame round-trips; a short or empty one is refused.
    #[test]
    fn frames() {
        let json = br#"{"a":1}"#;
        let framed = frame(json, Some(&[9, 8, 7])).expect("frame");
        assert_eq!(&framed[..4], &7u32.to_le_bytes());
        let (head, chunk) = unframe(&framed).expect("unframe");
        assert_eq!((head, chunk), (&json[..], &[9u8, 8, 7][..]));
        let bare = frame(json, None).expect("frame");
        let (head, chunk) = unframe(&bare).expect("unframe");
        assert_eq!((head, chunk.len()), (&json[..], 0));
        assert!(unframe(&[]).is_err());
        assert!(unframe(&[10, 0, 0, 0, b'{']).is_err());
    }

    /// The window's frame becomes the store's row: the JSON as text, the
    /// chunk when `result_size` says there is one; and a stored row comes
    /// back as the same JSON.
    #[test]
    fn save_and_get_shapes() {
        let mut input = dto();
        let json = serde_json::to_vec(&input).expect("json");
        let row =
            save_request(&frame(&json, Some(b"\x00\x01\x02\x03")).expect("frame")).expect("row");
        assert_eq!(row.result.as_deref(), Some(&[0u8, 1, 2, 3][..]));
        assert_eq!(
            serde_json::from_str::<Value>(&row.lock_json).expect("lock"),
            input.lock_json
        );
        assert_eq!(row.status, NodeLockStatus::Solved);

        let mut stored = row.clone();
        stored.id = "id-1".to_owned();
        stored.result_size = Some(4);
        let (back, chunk) = NodeLockDto::from_row(stored);
        assert_eq!(chunk.as_deref(), Some(&[0u8, 1, 2, 3][..]));
        input.id = "id-1".to_owned();
        assert_eq!(back, input);

        // No chunk: `result_size` null, whatever trails the JSON.
        input.result_size = None;
        let json = serde_json::to_vec(&input).expect("json");
        let row = save_request(&frame(&json, Some(b"junk")).expect("frame")).expect("row");
        assert_eq!(row.result, None);

        // The JSON the window sends: snake_case columns, statuses and
        // streets as the table writes them.
        let value = serde_json::to_value(dto()).expect("value");
        assert_eq!(value["status"], "solved");
        assert_eq!(value["street"], "flop");
        assert_eq!(value["set_id"], "nlhe-cash-6max-100bb");
        assert!(value["lock_json"].is_object());

        // A lock that is not an object is refused.
        let mut bad = dto();
        bad.lock_json = json!([1, 2]);
        let json = serde_json::to_vec(&bad).expect("json");
        assert!(save_request(&frame(&json, None).expect("frame")).is_err());
    }

    /// The JSON fallback of the webview's IPC: an array of byte values.
    #[test]
    fn a_json_body_of_bytes() {
        let body = InvokeBody::Json(json!([1, 2, 255]));
        assert_eq!(&*body_bytes(&body).expect("bytes"), &[1u8, 2, 255]);
        assert!(body_bytes(&InvokeBody::Json(json!([256]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(json!({"a": 1}))).is_err());
        let raw = InvokeBody::Raw(vec![4, 5]);
        assert_eq!(&*body_bytes(&raw).expect("bytes"), &[4u8, 5]);
    }

    /// A new id is a uuid v4.
    #[test]
    fn new_ids_are_uuid_v4() {
        let id = new_id().expect("id");
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(id, new_id().expect("another"));
    }
}
