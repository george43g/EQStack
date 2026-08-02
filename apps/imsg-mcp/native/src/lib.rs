//! imsg-native: Rust acceleration layer for imsg-mcp
//!
//! Exposes N-API functions for the two things Rust accelerates: attributedBody
//! blob parsing and Address Book contact resolution. Conversation listing and
//! message fetching are intentionally NOT here — that path (with its
//! cross-handle merge, slug store, and multi-source contact logic) lives in the
//! TypeScript `IMessageDB` and is the single source of truth. The dev-stats
//! engine label is "Rust parser + TS DB" to reflect exactly this split.

mod attributed_body;
mod contacts;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Parse an attributedBody blob to extract readable text.
/// Useful for messages where the `text` column is NULL.
#[napi]
pub fn parse_attributed_body(blob: Buffer) -> Option<String> {
    attributed_body::extract_text(&blob)
}

/// Resolve contact names for a list of handles (phone numbers / emails),
/// reading the main Address Book plus every iCloud source under `Sources/`.
/// Returns a map of handle → display name.
#[napi]
pub async fn resolve_contacts(
    contacts_main_path: String,
    contacts_sources_dir: Option<String>,
    handles: Vec<String>,
) -> Result<std::collections::HashMap<String, String>> {
    tokio::task::spawn_blocking(move || {
        contacts::resolve_handles(&contacts_main_path, contacts_sources_dir.as_deref(), &handles)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Task join error: {e}")))?
}
