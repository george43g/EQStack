//! Attributed body text extraction from Apple typedstream blobs.
//!
//! This is a simplified initial implementation that extracts readable text
//! from attributedBody BLOBs using heuristic string extraction.
//! A full typedstream binary parser will be added in a later phase.

use std::str;

/// Metadata patterns to filter out (compiled regex would be faster but
/// these are simple enough for string matching).
const METADATA_PREFIXES: &[&str] = &[
    "streamtyped",
    "NS",
    "__kIM",
    "MessagePartAttributeName",
    "DataDetectedAttributeName",
    "CalendarEventAttributeName",
    "X$version",
    "bplist",
    "$class",
    "RMSV$class",
    "NSData",
    "NSDictionary",
    "NSNumber",
    "NSValue",
    "FileTransferGUIDAttributeName",
    "BaseWritingDirectionAttributeName",
];

/// Exactly a canonical 8-4-4-4-12 hex UUID.
fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn is_metadata(text: &str) -> bool {
    for prefix in METADATA_PREFIXES {
        if text.starts_with(prefix) {
            return true;
        }
    }
    // Pattern: at_N_UUID
    if text.starts_with("at_") && text.len() > 5 {
        return true;
    }
    // Bare-UUID attribute values (sticker/attachment GUIDs) leak as message
    // text too — either exactly a UUID ("DB19B098-…") or with the leaked
    // typedstream length byte in front ("$FE7B0D17-…", '$' = 0x24 = 36 = the
    // UUID's length). No human message is exactly a UUID.
    if looks_like_uuid(text) {
        return true;
    }
    if text.len() == 37 {
        if let Some(rest) = text.get(1..) {
            if looks_like_uuid(rest) {
                return true;
            }
        }
    }
    // Length-byte leak variant: the byte-scan collates the typedstream
    // length byte (an arbitrary ASCII char) with a file-transfer GUID
    // attribute value, e.g. "Mat_BDA9FB97-…" for a 77-byte value ('M'=77).
    // Require the tail after "at_" to look like a GUID (hex/dash/underscore
    // only, ≥20 chars) so genuine text like "Bat_signal" is never filtered.
    if text.len() > 24 {
        if let Some(rest) = text.get(1..) {
            if let Some(guid) = rest.strip_prefix("at_") {
                if guid.len() >= 20
                    && guid
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() || c == '-' || c == '_')
                {
                    return true;
                }
            }
        }
    }
    false
}

fn is_control_char(c: char) -> bool {
    c.is_control() || c == '\x7f'
}

/// Score a candidate text string — higher = more likely to be the actual message.
fn score_candidate(text: &str) -> i32 {
    let mut score: i32 = 0;
    if text.chars().any(|c| c.is_alphabetic()) {
        score += 50;
    }
    if text.chars().any(|c| c.is_numeric()) {
        score += 10;
    }
    if text.contains(' ') {
        score += 30;
    }
    if text.contains('.') || text.contains('!') || text.contains('?') {
        score += 15;
    }
    // Emoji range (rough)
    if text.chars().any(|c| ('\u{1F300}'..='\u{1FAFF}').contains(&c)) {
        score += 100;
    }
    // Short alphanumeric-only strings are likely metadata
    if text.len() <= 3 && text.chars().all(|c| c.is_alphanumeric()) {
        score -= 100;
    }
    score += std::cmp::min(text.len() as i32, 200);
    score
}

/// Normalize a candidate string: strip leading punctuation, control chars, etc.
fn normalize_candidate(text: &str) -> Option<String> {
    let trimmed = text
        .trim_start_matches(|c: char| c == '+' || c == ';' || c == ':' || c == '"' || c == '\'' || c == '(' || c == ')' || c == '&' || c.is_whitespace());

    let cleaned: String = trimmed
        .chars()
        .map(|c| if is_control_char(c) { ' ' } else { c })
        .collect::<String>()
        .replace('\u{FFFD}', "")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");

    if cleaned.is_empty() || cleaned == "�" || cleaned == "￼" {
        return None;
    }
    if cleaned.len() < 2 {
        // Allow single emoji
        if !cleaned.chars().any(|c| ('\u{1F300}'..='\u{1FAFF}').contains(&c)) {
            return None;
        }
    }
    if is_metadata(&cleaned) {
        return None;
    }

    // Strip doubled-uppercase-letter prefix: "HHeres" -> "Heres".
    // This pattern is almost always a typedstream length-byte leak — Apple
    // stores the length byte as a single ASCII char immediately before the
    // content, and when the length-byte char happens to match the content's
    // first letter (e.g. message of length 72 = 'H', starting with "Heres"),
    // our heuristic byte-scan picks them up as one continuous run.
    let stripped = strip_doubled_letter_prefix(&cleaned);
    Some(stripped)
}

/// If `text` starts with `[A-Z]\1[a-z]`, drop the first char.
/// Example: "HHeres the question" -> "Heres the question".
fn strip_doubled_letter_prefix(text: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_uppercase()
        && bytes[0] == bytes[1]
        && bytes[2].is_ascii_lowercase()
    {
        return text[1..].to_string();
    }
    text.to_string()
}

/// Boost added to structured-parse candidates so they win against byte-scan
/// noise even when the byte-scan happens to produce a longer string (e.g. a
/// length-byte prefix collated with content, like "RImagine..." for an 82-char
/// message starting with "Imagine...").
const STRUCTURED_BOOST: i32 = 500;

/// Parse a length-prefixed NSString at `marker_end` (the byte index *after*
/// the literal "NSString" marker). Returns the UTF-8 content with the length
/// byte correctly stripped.
///
/// Layout: `[01 94|95 84 01 2b] [LL] [content...]`
///         or `[01 94|95 84 01 2b] [81] [LL_LO LL_HI] [content...]`
///
/// The 5-byte preamble (01 [94|95] 84 01 2b) is the NSString class marker.
/// The length byte that follows is the actual string length in bytes. When
/// that length byte happens to be a printable ASCII char (e.g. 0x52='R'),
/// the heuristic byte-scan will include it as content — that's the artifact
/// this function avoids.
fn parse_nsstring_at(blob: &[u8], marker_end: usize) -> Option<String> {
    const PREAMBLE_LEN: usize = 5;
    if marker_end + PREAMBLE_LEN >= blob.len() {
        return None;
    }
    let preamble = &blob[marker_end..marker_end + PREAMBLE_LEN];
    let matches_preamble = preamble[0] == 0x01
        && (preamble[1] == 0x94 || preamble[1] == 0x95)
        && preamble[2] == 0x84
        && preamble[3] == 0x01
        && preamble[4] == 0x2b;
    if !matches_preamble {
        return None;
    }

    let len_pos = marker_end + PREAMBLE_LEN;
    if len_pos >= blob.len() {
        return None;
    }

    let (content_start, length) = if blob[len_pos] == 0x81 {
        if len_pos + 3 > blob.len() {
            return None;
        }
        let len = u16::from_le_bytes([blob[len_pos + 1], blob[len_pos + 2]]) as usize;
        (len_pos + 3, len)
    } else {
        (len_pos + 1, blob[len_pos] as usize)
    };

    if length == 0 || content_start + length > blob.len() {
        return None;
    }
    str::from_utf8(&blob[content_start..content_start + length])
        .ok()
        .map(String::from)
}

/// Walk the blob and parse every NSString instance via the structured length
/// byte. These results are reliably free of length-byte prefix artifacts.
fn parse_all_nsstrings(blob: &[u8]) -> Vec<String> {
    let marker = b"NSString";
    let mut out = Vec::new();
    let mut search_from = 0;
    while let Some(pos) = blob[search_from..]
        .windows(marker.len())
        .position(|w| w == marker)
    {
        let abs_pos = search_from + pos;
        let marker_end = abs_pos + marker.len();
        if let Some(s) = parse_nsstring_at(blob, marker_end) {
            out.push(s);
        }
        // Always advance past the matched marker so we make progress even
        // when the parse fails (e.g. unknown preamble).
        search_from = marker_end;
    }
    out
}

/// Extract readable text from an attributedBody BLOB.
///
/// Strategy:
///   1. Structured parse — find every NSString via its preamble + length byte
///      and treat those candidates with a +500 score boost. These are
///      guaranteed not to include the length byte as the first char.
///   2. Byte-scan fallback — same heuristic as before, lower priority.
///   3. Highest-scoring candidate wins.
pub fn extract_text(blob: &[u8]) -> Option<String> {
    let mut candidates: Vec<(String, i32)> = Vec::new();

    // Phase 1: structured NSString parsing (high confidence — no length-byte leak).
    let strings = parse_all_nsstrings(blob);
    // Trust the structured parse (and skip the byte-scan) only when it
    // yields usable text or a pure attachment placeholder (U+FFFC) — a parse
    // producing only garbage means the framing is one we don't understand,
    // and the scan stays available as the fallback for exactly that case.
    let structured_trusted = strings.iter().any(|raw| {
        normalize_candidate(raw).is_some()
            || (!raw.is_empty() && raw.chars().all(|c| c == '\u{FFFC}' || c.is_whitespace()))
    });
    for raw in strings {
        if let Some(normalized) = normalize_candidate(&raw) {
            let score = score_candidate(&normalized) + STRUCTURED_BOOST;
            candidates.push((normalized, score));
        }
    }

    // Phase 2: byte-scan fallback — ONLY for blobs with no parseable
    // NSString. A parsed NSString IS the message text (or U+FFFC for
    // attachment-only messages, normalized away); everything else in the
    // blob is attribute metadata that the scan kept resurrecting in new
    // shapes ("Mat_<uuid>", "$<uuid>", bare attribute names). U+FFFD marks
    // bytes that weren't valid UTF-8 — structural bytes between typedstream
    // fields — so treat them as segment breaks.
    if !structured_trusted {
        let text = String::from_utf8_lossy(blob);
        for segment in text.split(|c: char| is_control_char(c) || c == '\0' || c == '\u{FFFD}') {
            let segment = segment.trim();
            if segment.is_empty() {
                continue;
            }
            if let Some(normalized) = normalize_candidate(segment) {
                let score = score_candidate(&normalized);
                candidates.push((normalized, score));
            }
        }
    }

    // Score floor: negative-scored candidates are structural noise (typedstream
    // type codes like "iI", short alnum fragments). Returning them when they're
    // the ONLY candidate turned attachment-only messages into garbage text.
    // Genuine short texts ("ok") arrive via the structured phase-1 path, which
    // carries a +500 boost and clears the floor comfortably.
    candidates.retain(|(_, score)| *score > 0);
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    candidates.into_iter().next().map(|(text, _)| text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn test_score_candidate() {
        assert!(score_candidate("Hello world!") > score_candidate("NS"));
        assert!(score_candidate("Hey what's up?") > score_candidate("streamtyped"));
    }

    #[test]
    fn test_normalize_filters_metadata() {
        assert!(normalize_candidate("streamtyped").is_none());
        assert!(normalize_candidate("NSMutableString").is_none());
        assert!(normalize_candidate("Hello world").is_some());
    }

    /// Attachment-only messages: the NSString is just U+FFFC and the only
    /// stringy content is the __kIMFileTransferGUID attribute VALUE, which
    /// the byte-scan collates with its typedstream length byte ("Mat_…" for
    /// a 77-byte value, 'M' = 77). That leaked candidate must be filtered so
    /// extract_text returns None and the row renders as "(attachment)".
    #[test]
    fn test_transfer_guid_length_byte_leak_is_filtered() {
        assert!(
            normalize_candidate("Mat_00000000-1111-2222-3333-4444444444440_AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")
                .is_none()
        );
        // Any leaked length-byte char, not just 'M'.
        assert!(normalize_candidate("Rat_DEADBEEF-DEAD-BEEF-DEAD-BEEFDEADBEEF").is_none());
        // Genuine text that merely contains "at_" after its first char survives.
        assert!(normalize_candidate("Bat_signal is lit tonight").is_some());
        assert!(normalize_candidate("Look at_ this weird underscore").is_some());
    }

    /// Bare-UUID attribute values (sticker/attachment message GUIDs) leak as
    /// text with or without their length byte ('$' = 36) — both filtered.
    #[test]
    fn test_bare_uuid_values_are_filtered() {
        assert!(normalize_candidate("DB19B098-9804-4E16-B3B4-AB3E4F539B6D").is_none());
        assert!(normalize_candidate("$FE7B0D17-69CF-43EF-8C34-BD96AD2A4037").is_none());
        // A UUID inside a sentence is fine — humans paste IDs sometimes.
        assert!(
            normalize_candidate("the id is DB19B098-9804-4E16-B3B4-AB3E4F539B6D ok").is_some()
        );
    }

    /// End-to-end: a realistic attachment-only blob (structure mirrors a real
    /// chat.db row: NSAttributedString → NSString "\u{FFFC}" → attribute dict
    /// with the transfer GUID value) must yield no text at all.
    #[test]
    fn test_attachment_only_blob_extracts_no_text() {
        let mut blob: Vec<u8> = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+\x03".to_vec();
        blob.extend_from_slice("\u{FFFC}".as_bytes());
        blob.extend_from_slice(b"\x86\x84\x02iI\x01\x01\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x04\x92\x84\x96\x96\x22__kIMFileTransferGUIDAttributeName\x86\x92\x84\x96\x96");
        blob.push(77); // length byte 'M' — the leak
        blob.extend_from_slice(
            b"at_00000000-1111-2222-3333-4444444444440_AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        );
        blob.extend_from_slice(b"\x86\x92\x84\x96\x96\x1d__kIMMessagePartAttributeName\x86\x86\x86");
        let result = extract_text(&blob);
        assert!(
            result.is_none(),
            "attachment-only blob must extract no text, got: {result:?}"
        );
    }

    /// Hang resistance: extract_text must complete on adversarial inputs.
    /// Mirrors the TS regression — the Rust path is structurally simpler
    /// (no byte-by-byte reader) so it cannot hit the same infinite loop,
    /// but we still pin the contract here.
    #[test]
    fn test_extract_text_does_not_hang_on_zeros() {
        let zeros = vec![0u8; 8192];
        let start = Instant::now();
        let _ = extract_text(&zeros);
        assert!(start.elapsed().as_millis() < 500, "must complete fast on all-zero input");
    }

    #[test]
    fn test_extract_text_does_not_hang_on_high_bits() {
        let mut blob = vec![0u8; 8192];
        for (i, b) in blob.iter_mut().enumerate() {
            *b = if i % 2 == 0 { 0xc0 } else { 0x00 };
        }
        let start = Instant::now();
        let _ = extract_text(&blob);
        assert!(start.elapsed().as_millis() < 500);
    }

    /// Real attributedBody header should yield the embedded ASCII text.
    #[test]
    fn test_extract_text_finds_message_in_synthetic_blob() {
        // Synthetic structure: typedstream header bytes, then NSString class
        // refs, then the actual message text surrounded by control bytes.
        let mut blob: Vec<u8> = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@".to_vec();
        blob.extend_from_slice(b"NSString\x01\x94\x84\x01+");
        blob.push(28); // length byte
        blob.extend_from_slice(b"Hello world from typedstream");
        blob.extend_from_slice(b"\x00\x00\x86\x84\x02iI"); // some trailing structure
        let result = extract_text(&blob);
        assert!(result.is_some(), "should find a candidate");
        let text = result.unwrap();
        assert!(
            text.contains("Hello world from typedstream"),
            "expected message text, got: {text:?}"
        );
        assert!(!text.contains("$class"), "no class metadata leak");
        assert!(!text.contains("NSString"), "no NSString class leak");
    }

    /// Empty input should return None gracefully, not panic.
    #[test]
    fn test_extract_text_empty_input() {
        assert!(extract_text(&[]).is_none());
    }

    /// Doubled-letter prefix from typedstream length-byte must be stripped.
    /// "HHeres the question..." was a real bug from a 72-char msg starting with H.
    #[test]
    fn test_strip_doubled_letter_prefix() {
        assert_eq!(strip_doubled_letter_prefix("HHeres the question"), "Heres the question");
        assert_eq!(strip_doubled_letter_prefix("WWhat happened"), "What happened");
        assert_eq!(strip_doubled_letter_prefix("OOkay"), "Okay");
        // Should NOT strip when not a doubled-uppercase-then-lowercase pattern
        assert_eq!(strip_doubled_letter_prefix("Hello"), "Hello");
        assert_eq!(strip_doubled_letter_prefix("HH"), "HH"); // too short, no lowercase after
        assert_eq!(strip_doubled_letter_prefix("HHH"), "HHH"); // third is uppercase
        assert_eq!(strip_doubled_letter_prefix("hi"), "hi");
        assert_eq!(strip_doubled_letter_prefix(""), "");
    }

    /// Real-world artifact: the structured NSString parse must beat the
    /// byte-scan so the length byte never leaks into the result. Mirrors
    /// the bug surfaced live (e.g. "RImagine im dying..." for an 82-char
    /// message starting with "Imagine...", length byte 0x52 = 'R').
    #[test]
    fn test_structured_parse_strips_length_byte_prefix() {
        // Cases where the doubled-letter strip CANNOT catch the artifact:
        //   - length 0x52 'R' before "Imagine im dying..." (82 bytes)
        //   - length 0x5d ']' before "One of my favourite..." (93 bytes)
        //   - length 0x5c '\' before "Lmao no problem..." (92 bytes)
        //   - length 0x35 '5' before "No im saying..." (53 bytes)
        let cases: &[(u8, &str)] = &[
            (0x52, "Imagine im dying of horniness and then go beast mode on u and take it all out on u"),
            (0x5d, "One of my favourite things to do is listen to ur voice / listen to u moan whilst im fukin you"),
            (0x5c, "Lmao no problem. Altho unsure abt drug psychosis lmao not sure when thats every happened lol"),
            (0x35, "No im saying u mentioning clay was good advice lmaooo"),
        ];

        for &(length_byte, content) in cases {
            assert_eq!(
                length_byte as usize,
                content.len(),
                "test fixture: length byte must match content byte length"
            );

            // Build a typedstream-ish blob: header → NSString → preamble → length → content → trailer
            let mut blob: Vec<u8> = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@".to_vec();
            blob.extend_from_slice(b"NSString\x01\x94\x84\x01+");
            blob.push(length_byte);
            blob.extend_from_slice(content.as_bytes());
            blob.extend_from_slice(b"\x86\x84\x02iI");

            let result = extract_text(&blob).expect("should extract text");
            assert_eq!(
                result, content,
                "structured parse must strip length byte 0x{length_byte:02x}; got {result:?}"
            );
            // Catch the specific regression — the length byte should not
            // appear as the leading char of the result.
            let leading = result.chars().next().unwrap();
            assert_ne!(
                leading as u8, length_byte,
                "leading char must not equal length byte (artifact regression)"
            );
        }
    }

    /// Same coverage for the 0x95 preamble variant (DataDetector-annotated messages).
    #[test]
    fn test_structured_parse_handles_0x95_preamble() {
        let content = "Ur crazy. Changing my masterbation fantasy for tonight effective immediately";
        let mut blob: Vec<u8> = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@".to_vec();
        blob.extend_from_slice(b"NSString\x01\x95\x84\x01+");
        blob.push(content.len() as u8);
        blob.extend_from_slice(content.as_bytes());
        blob.extend_from_slice(b"\x86\x84\x02iI");
        let result = extract_text(&blob).expect("should extract text");
        assert_eq!(result, content);
    }

    /// Long-string framing: when the length is >= 256 the typedstream uses
    /// 0x81 LL_LO LL_HI (little-endian u16) instead of a single byte.
    #[test]
    fn test_structured_parse_handles_long_length_marker() {
        let content = "x".repeat(300);
        let len = content.len() as u16;
        let mut blob: Vec<u8> = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@".to_vec();
        blob.extend_from_slice(b"NSString\x01\x94\x84\x01+");
        blob.push(0x81);
        blob.extend_from_slice(&len.to_le_bytes());
        blob.extend_from_slice(content.as_bytes());
        let result = extract_text(&blob).expect("should extract long string");
        assert_eq!(result, content);
    }

    /// Synthetic blob with embedded "HHeres" pattern should produce the
    /// de-doubled "Heres" via normalize_candidate's prefix strip.
    #[test]
    fn test_extract_text_strips_doubled_letter_prefix() {
        // Build a blob whose embedded printable run looks like a length-byte
        // leak: control byte + "HHeres the question tho" (the doubled H simulates
        // length byte 0x48 followed by "Heres...").
        let mut blob = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@".to_vec();
        blob.extend_from_slice(b"\x00HHeres the question tho if i go thrre\x00");
        let result = extract_text(&blob);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(
            text.starts_with("Heres"),
            "expected 'Heres...', got: {text:?}"
        );
        assert!(!text.starts_with("HHeres"));
    }
}
