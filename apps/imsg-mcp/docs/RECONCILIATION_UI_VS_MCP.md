# Reconciliation: Messages.app UI vs imessage MCP Data

This document maps the macOS Messages.app UI (screenshot reference) to the data returned by the imessage MCP tool and the underlying `chat.db` schema.

## Left Pane (Conversation List)

| UI Element | MCP / DB Source | Notes |
|------------|-----------------|--------|
| **Contact/group row** | `chat` table: `chat_identifier`, `display_name` | UI shows `display_name` when set (e.g. "Alice / Bob", "User Name"); otherwise formatted phone (e.g. "+1 555 555 0102"). MCP `list_conversations` returns `chatIdentifier`, `displayName`. |
| **Last message snippet** | Last message in that chat (`message.text` or parsed `attributedBody`) | Messages.app shows a short preview. MCP `list_conversations` now returns `lastMessageSnippet` from `message.text`; this can be empty/null when content exists only in `attributedBody`. |
| **Timestamp (e.g. "8:00 AM", "Yesterday")** | `message.date` (Mac epoch) for the last message in the chat | MCP `list_conversations` now returns `lastMessageDate`; client formatting (“Today”, “Yesterday”, etc.) is display logic. |
| **Ordering** | By last message time descending | MCP `list_conversations` now sorts by last message date descending to match UI ordering. |
| **Unread indicator** | `message.is_read = 0` for incoming, aggregated per chat | MCP now returns aggregated `unreadCount` per chat (incoming unread, normal messages). |

**Reconciliation (implemented):** `list_conversations` now populates `lastMessageDate`, `lastMessageSnippet` (from `message.text`; may be empty when content is in `attributedBody` only), and `unreadCount`, and sorts by last message date descending to match the left pane.

---

## Right Pane (Thread: e.g. "Display Name")

| UI Element | MCP / DB Source | Notes |
|------------|------------------|--------|
| **Header "To: Display Name"** | `chat.display_name` or `chat.chat_identifier` | MCP identifies the chat by `chatIdentifier` (phone/email). To open a chat via MCP you need a handle that matches that chat (e.g. phone number); display name alone isn’t stored as the primary key. |
| **Sent messages (blue, right)** | `message.is_from_me = 1` | MCP `Message.isFromMe === true`. |
| **Received messages (grey, left)** | `message.is_from_me = 0` | MCP `Message.isFromMe === false`. |
| **Message body** | `message.text` or decoded `attributedBody` | MCP returns `Message.text` (we use `imessage-parser` for attributedBody). Inline attachments show as U+FFFC in DB; we replace with 📎 or "(image/attachment)" in the MCP layer. |
| **Timestamps in thread ("Yesterday 5:57 PM", "Today 3:46 AM")** | `message.date` (Mac epoch → JS Date) | MCP `Message.date` is a Date; formatting “Today” / “Yesterday” is client-side. |
| **"Delivered" / "Read 3:51 AM"** | `message.is_delivered`, `message.date_delivered`, `message.is_read`, `message.date_read` | For outgoing messages, DB stores read/delivery status. MCP `Message.isRead`, `Message.dateRead`; delivery fields could be added if needed. |
| **Reactions on a bubble (e.g. heart-eyes tapback)** | Separate rows: `message.associated_message_type` 2000–3006, `associated_message_guid` → target message | In the DB, tapbacks are separate message rows. MCP filters them out of `get_messages` by default; we have `Message.reaction` when the row is a reaction, and `Message.reactions` (reactions on this message) if requested. UI shows reactions on the bubble; MCP can expose them via `reactions` and/or optional `includeReactions`. |

**Reconciliation:** Thread content, order, direction (sent/received), and read status align with the MCP and schema. Matching by display name requires resolving the display name to a `chat_identifier` (e.g. via contact or by searching chats by display name).

---

## Specific Observations from Screenshot

- **"My Name" (8:00 AM, "Continue as per plan")**  
  Likely a self-chat or linked device. Same as any other chat in DB; `chat_identifier` could be the user’s Apple ID or phone.

- **"Display Name" (3:51 AM, selected)**  
  Active thread; content and order in the right pane should match `get_messages(chatIdentifier)` for that chat’s identifier.

- **+15555550101 not in visible list**  
  Verification number from earlier instructions. Not in the top of the list; could be (1) further down, (2) on another device/account, or (3) no conversation yet until the first message is sent. MCP can still `send_message` and `wait_for_reply` for that number if the chat exists or gets created on send.

- **Phone formatting**  
  UI shows "+1 555 555 0102" (with spaces); DB/MCP typically use a canonical form (e.g. +15555550102). Our `findChatByHandle` normalizes (strips spaces, dashes, parentheses) so both should match.

---

## Summary

| Area | Aligned | Gap / Action |
|------|---------|----------------|
| Left pane: display name, chat list | Yes (chat_id, display_name) | `lastMessageDate`, `lastMessageSnippet` (text-column based), and sort-by-last-message are implemented. |
| Right pane: messages, order, sent/received, read status | Yes | Match by chat_identifier; display name → identifier may need contact/lookup. |
| Reactions | Yes (DB + optional MCP) | Default behavior hides reaction rows; use options to include when needed. |
| Timestamps | Yes (Mac epoch → Date) | “Today”/“Yesterday” is display logic, not in MCP. |
| +15555550101 | N/A | Not visible in screenshot; MCP can still target it by number. |

This reconciliation is based on the current imessage MCP implementation and `docs/IMESSAGE_DB_SCHEMA.md`. Remaining UI differences are mainly presentation-layer details (display labels like “Today/Yesterday” and snippet quality when text is only present in `attributedBody`).
