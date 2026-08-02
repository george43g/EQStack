# iMessage Database Schema Reference

This document describes the key structures and conventions in macOS's iMessage SQLite database (`~/Library/Messages/chat.db`).

## Timestamps

All timestamps are stored as **nanoseconds since January 1, 2001** (Mac epoch).

```javascript
const MAC_EPOCH_OFFSET = 978307200; // seconds between Unix epoch (1970) and Mac epoch (2001)
const timestamp = new Date((date / 1_000_000_000 + MAC_EPOCH_OFFSET) * 1000);
```

## Key Tables

| Table | Purpose |
|-------|---------|
| `message` | All messages (sent, received, reactions, etc.) |
| `handle` | Phone numbers and email addresses |
| `chat` | Conversation threads |
| `chat_message_join` | Links messages to chats |
| `attachment` | File attachments |
| `message_attachment_join` | Links attachments to messages |
| `recoverable_message_part` | Recently deleted messages (iOS 16+) |

## Message Types (`associated_message_type`)

### Regular Messages
| Type | Meaning |
|------|---------|
| `0` | Normal message (text, attachment, reply) |

### Tapback Reactions (Add)
| Type | Reaction |
|------|----------|
| `2000` | ❤️ Love |
| `2001` | 👍 Like |
| `2002` | 👎 Dislike |
| `2003` | 😂 Laugh (Ha Ha) |
| `2004` | ‼️ Emphasize |
| `2005` | ❓ Question |
| `2006` | Custom emoji (iOS 18+) - see `associated_message_emoji` field |

### Tapback Reactions (Remove)
| Type | Reaction Removed |
|------|------------------|
| `3000` | Removed ❤️ Love |
| `3001` | Removed 👍 Like |
| `3002` | Removed 👎 Dislike |
| `3003` | Removed 😂 Laugh |
| `3004` | Removed ‼️ Emphasize |
| `3005` | Removed ❓ Question |
| `3006` | Removed custom emoji (iOS 18+) |

### Other Types
| Type | Meaning |
|------|---------|
| `1000` | Sticker reaction |
| `2`, `3` | Business extension interactions (e.g., Apple Business Chat) |

## Reactions & Tapbacks

When `associated_message_type` is non-zero (a reaction):
- `associated_message_guid`: Format is `p:PART_INDEX/MESSAGE_GUID`
  - `PART_INDEX`: Which part of the message was reacted to (0 for first part)
  - `MESSAGE_GUID`: The `guid` of the original message
- `associated_message_emoji`: The actual emoji for type 2006/3006 (iOS 18+ custom emoji reactions)

## Inline Replies (Threads)

For messages that are replies to other messages:
- `thread_originator_guid`: The `guid` of the message being replied to
- `thread_originator_part`: Format `START:END:INDEX` (e.g., `0:0:24`)
  - Used for multi-part messages

**Important**: Use `thread_originator_guid` for replies, NOT `reply_to_guid` (which is unreliable).

## Message Content

### Text Field vs attributedBody

Modern macOS often stores message content in `attributedBody` (binary NSAttributedString format) rather than the plain `text` field. The `text` field may be NULL.

Use a library like `imessage-parser` to decode `attributedBody`.

### U+FFFC (Object Replacement Character)

The character `\uFFFC` (￼) is used as a placeholder for:
- **Inline attachments**: Images/files embedded in the message
- **Rich content**: The position where non-text content appears

When you see `\uFFFC`:
1. Check `cache_has_attachments` - if true, look up attachments via `message_attachment_join`
2. Check `balloon_bundle_id` - may indicate rich content (link preview, app message, etc.)

## Rich Messages (`balloon_bundle_id`)

| Bundle ID | Content Type |
|-----------|--------------|
| `com.apple.messages.URLBalloonProvider` | Link preview |
| `com.apple.DigitalTouchBalloonProvider` | Digital Touch sketch |
| `com.apple.Handwriting.HandwritingProvider` | Handwritten message |
| `com.apple.messages.MSMessageExtensionBalloonPlugin:*:com.apple.findmy.FindMyMessagesApp` | Find My location |
| `com.apple.messages.MSMessageExtensionBalloonPlugin:*:com.google.Maps.MessagesExtension` | Google Maps |

## Edit/Retract (iOS 16+)

| Column | Purpose |
|--------|---------|
| `date_edited` | Timestamp when message was edited (0 if never) |
| `date_retracted` | Timestamp when message was unsent (0 if never) |
| `expire_state` | Message expiration state |

Edited message history is stored in the `message_summary_info` or `recoverable_message_part` tables.

## Read Status

| Column | Purpose |
|--------|---------|
| `is_read` | Whether message has been read (0/1) |
| `date_read` | When the message was read |
| `is_delivered` | Whether message was delivered |
| `date_delivered` | When message was delivered |

**Note**: For outgoing messages (`is_from_me = 1`), `is_read` indicates if the *recipient* read it.

## Attachments

Query attachments for a message:
```sql
SELECT a.* 
FROM attachment a
JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
WHERE maj.message_id = ?
```

Key attachment fields:
- `filename`: Full path to the file (may start with `~`)
- `mime_type`: MIME type
- `transfer_name`: Original filename
- `total_bytes`: File size

## Group Chats

Group chats have:
- `chat.chat_identifier` starting with `chat` (e.g., `chat123456789`)
- `chat.display_name` with the group name
- Multiple entries in `chat_handle_join`

## Example Queries

### Get recent messages with sender info
```sql
SELECT 
  m.ROWID,
  m.text,
  m.is_from_me,
  CASE WHEN m.is_from_me = 1 THEN 'me' ELSE h.id END as sender,
  datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.associated_message_type = 0  -- exclude reactions
ORDER BY m.date DESC
LIMIT 20
```

### Get reactions for a message
```sql
SELECT 
  m.associated_message_type,
  m.associated_message_emoji,
  h.id as reactor
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.associated_message_guid LIKE '%' || ? || '%'  -- original message guid
  AND m.associated_message_type >= 2000
```

### Get thread/reply chain
```sql
SELECT m.* FROM message m
WHERE m.thread_originator_guid = ?
   OR m.guid = ?
ORDER BY m.date
```

## Contact identity & conversation merge

One human conversation is frequently split across **multiple `chat` rows** — a
phone-number chat and an email chat, an `SMS;-;…` chat and an `iMessage;-;…`
chat, and chats routed through different `account_login`s of yours. Messages.app
shows them as **one** thread, and imsg-mcp merges them by **Address Book
`contactId`** (not by `chat_identifier`).

- `handle.person_centric_id` is Apple's own cross-handle identity link, **but it
  is NULL on many real `chat.db`s** (including the primary dev machine's) — do
  not rely on it as the sole signal.
- Contacts can live in the local Address Book **and** one or more iCloud sources
  (`AddressBook/Sources/<uuid>/AddressBook-v22.abcddb`). All must be loaded or a
  contact's legs won't merge and exports undercount.

Full reference (merge keys, slugs, the completeness diagnostic, invariants):
**`docs/CONTACT_MERGE_AND_SLUGS.md`**.
