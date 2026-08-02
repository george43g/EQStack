# Contact identity, conversation merge, and thread slugs

This is the canonical reference for how imsg-mcp decides that several `chat`
rows are **one person** and gives that identity a single stable handle. Read
this before touching `contacts-db.ts`, the merge logic in `imessage-db.ts`,
`thread-slug.ts`, or `slug-store.ts`. It exists so the cross-source merge bug
(below) is never reintroduced.

## The problem this solves

In `chat.db`, one human conversation is frequently split across **multiple
`chat` rows**:

- **Handle split:** the same person texts from a phone number *and* an email
  (iMessage). Each handle is a separate `chat` with its own `chat_identifier`.
- **Service split:** the same handle has both an `SMS;-;…` chat and an
  `iMessage;-;…` chat.
- **Account split:** messages routed through two of *your* accounts
  (`P:+61…` vs `E:you@…`) produce separate `chat` rows for the same recipient.

Messages.app shows all of these as **one** thread. imsg-mcp must too — for
`get_messages`, `export_messages`, `list_conversations`, slugs, and sending.

## How identity is resolved

The unifying key is the **Address Book contact**. A handle (phone/email) is
resolved to a `contactId` via `ContactsDB.lookupContact`. Two `chat` rows are
the same conversation when they share a **merge key**
(`getConversationMergeKey` in `imessage-db.ts`):

- `contact:<contactId>` when the handle resolves to an Address Book contact —
  this folds in **every** number + email + SMS + iMessage leg of that contact.
- `identifier:<normalized-handle>` when the handle is in **no** Address Book —
  only chats with that exact normalized handle merge.
- `group:<chatGuid>` for group chats (never merged with 1:1s).

`resolveChatsForConversation(identifier)` returns all chat rows sharing the
representative's merge key. `getMessagesForChatExportPage` and the export walk
every one of them.

## CRITICAL: read ALL Address Books (local + iCloud sources)

Contacts live in more than one SQLite database:

- **Local:** `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb`
- **iCloud / other accounts:** `…/AddressBook/Sources/<uuid>/AddressBook-v22.abcddb`
  (often **one per account** — many contacts exist ONLY here)

**Always construct the contacts layer with `getContactsDbPaths()`** (in
`config.ts`), which discovers the main DB **plus every `Sources/*` DB**. If you
load only the top-level `AddressBook-v22.abcddb` (e.g. by passing a single
`VITE_CONTACTS_DB_PATH` to `new IMessageDB(...)` in a script or test), an
iCloud-only contact won't resolve → their number-chats and email-chats won't
merge → **exports silently undercount**. This exact mistake once made a
~11,390-message thread look like 9,166. The Rust `contacts.rs` also loads all
sources (`ContactsDb::open(main, sources_dir)`).

`ContactsDB` also **dedups and unions across sources** — but only cards that
plausibly name the **same entity**. Union requires the cards' name-candidate
sets ({nickname, "first last", organization}, lowercased, diacritics stripped)
to **intersect**: a person split across a local card (phone) and an iCloud card
(email) with the same name — or a nickname matching another card's full name —
collapses to one `contactId` (`findExistingContactIds` + `mergeContacts`),
including a third same-name card *bridging* two previously-separate ids.

**Sharing one handle is NOT enough to union.** Real counterexample: a person's
card and their business's org card both carrying the same `info@` email. They
are different entities — unioning them mislabeled the person's phone with the
org name and would have merged both entities' conversations and slugs into one.
Messages.app keeps them separate; so do we. The shared handle stays with its
**first claimant**, and every handle's `displayName` comes from **the card that
declares it** (nickname-first) — per-handle names, not the union survivor's.

## Completeness diagnostic

`findUnmergedSiblingChats` warns (in the export footer) when a chat looks like
it belongs to the exported identity but wasn't merged. Two signals:

1. **contactId invariant** (primary) — a non-group chat resolving to the merged
   set's `contactId` that wasn't folded in. Catches merge regressions.
2. **`person_centric_id`** (fallback) — Apple's own cross-handle link.

> Caveat: `handle.person_centric_id` is **NULL on many real chat.dbs** (it is on
> the primary dev machine's), so signal (2) is often inert. A contact in **no**
> Address Book *and* with NULL `person_centric_id` cannot be linked from data
> alone — that gap is covered by the cross-source merge **tests**, not this
> diagnostic.

## Thread slugs are per-IDENTITY, not per-chat

A slug (`alice~imsg~a3f2`) is the stable handle for a whole identity, so it must
be identical across every leg. `generateThreadSlug` hashes a stable
**`identityKey`**, NOT the per-chat `guid`, and uses a **canonical service**
(prefer iMessage) so the SMS leg and iMessage leg don't produce `…~sms~h` vs
`…~imsg~h`. The name part uses the **identity-level card name**, so legs whose
per-handle names differ still yield one slug string.

**The hash must survive restarts.** Session `contactId`s are assigned in
Address Book load order and renumber whenever ANY card is added/removed, so
`computeSlugForChat` anchors the hash on the contact's **smallest normalized
handle** (`ContactsDB.stableAnchor`) — it changes only if that contact's own
handles change. Never hash a session id into anything persisted.

`SlugStore` (schema v2) maps **many `chat_guid`s → one slug**
(`slug_chat_guids` table) with identity rows in `thread_slugs`. The canonical
`chat_identifier` prefers a phone over an email. Slugs are derived data: the v2
migration drops any v1 rows (which hashed the guid) and the background sync
rebuilds them. The sync also **self-heals**: any guid whose expected canonical
slug differs from the stored one is re-synced (so slugs minted under earlier
bugs — or after contact-data changes — converge), and prune sweeps orphaned
slug rows.

## Invariants / tests that must keep passing

- `tests/contacts-cross-source-merge.test.ts` — a contact whose card lives in a
  **secondary source**, split across 4 chats (SMS+iMessage × number+email),
  exports the full set from **either** handle; with no Address Book only the
  number's legs merge (the documented boundary); all four legs share **one**
  stable slug; the diagnostic does not false-positive.
- `tests/contact-thread-merge.test.ts` — phone + email chats collapse to one
  `list_conversations` row.
- `tests/thread-slug.test.ts` / `tests/slug-store.test.ts` — identity hashing,
  many-guids-to-one-slug, prune.
- Rust `native/src/contacts.rs` `#[cfg(test)]` — multi-source merge.

## Where things live

| Concern | File |
|---|---|
| Address Book load + cross-source dedup/union | `src/contacts-db.ts` |
| Contacts DB path discovery (local + Sources) | `src/config.ts` (`getContactsDbPaths`) |
| Merge key + `resolveChatsForConversation` + diagnostic | `src/imessage-db.ts` |
| Slug generation (identityKey hash) | `src/thread-slug.ts` |
| Slug persistence (many guids → one slug) | `src/slug-store.ts` |
| Rust contact resolution (multi-source) | `native/src/contacts.rs` |
