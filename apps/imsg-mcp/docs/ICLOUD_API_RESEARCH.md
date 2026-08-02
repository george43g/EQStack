# iCloud API Research: Sending/Receiving iMessages Without Messages.app

Research conducted Feb 2026. Summarises approaches to interfacing with iMessage via iCloud/Apple APIs, their feasibility, and risks.

## Current Approach (imsg-mcp)

- **Reading**: SQLite at `~/Library/Messages/chat.db` (requires Full Disk Access).
- **Sending**: AppleScript to Messages.app (`osascript`). Requires Automation permission.
- **Pros**: Uses public macOS APIs, no ToS risk, reliable.
- **Cons**: Requires macOS + Messages.app running, AppleScript is limited (no direct group chat by GUID).

## Approach A: pypush (Open-Source Reverse-Engineered iMessage)

**Project**: [JJTech0130/pypush](https://github.com/JJTech0130/pypush) (~3.5k stars)

**What it does**: Python reimplementation of Apple's iMessage protocol. Can send and receive iMessages without macOS.

**How it works** (from [JJTech's blog](https://jjtech.dev/reverse-engineering/imessage-explained/)):

1. **APNs connection**: Connect to Apple Push Notification Service (bidirectional). Receive a "push token" for routing. iMessage topic: `com.apple.madrid`. Requires a client certificate from Apple's Albert activation server.

2. **IDS authentication**: Log in with Apple ID (username + password). 2FA handled via "GrandSlam" method using "Anisette data" to prove device identity, yielding a Password Equivalent Token (PET).

3. **IDS registration**: Upload public encryption/signing keys. Requires generating "validation data" — an obfuscated binary blob that Apple uses to verify the client is an Apple device. pypush emulates this using the Unicorn Engine to run an older macOS binary.

4. **Key lookup**: Query IDS for a recipient's public keys and push tokens. Returns one identity per device on the account. Session tokens (from the lookup) are needed to send messages and expire.

5. **Message encryption**: AES + RSA signcryption. Newer `pair-ec` format provides forward secrecy via pre-keys (similar to Signal).

6. **Send via APNs**: Push encrypted payload to recipient's push token. Messages are delivered to all participants, including sender's own devices.

**Difficulty**: Very High
- Requires emulating Apple's obfuscated validation binary
- Protocol changes with each macOS/iOS update
- Multiple interacting subsystems (APNs, IDS, Albert activation)

**Status**: Alpha (v2.0.1), owned by Beeper (now Automattic). Undergoing rewrite.

**Risk**: Apple actively blocks these clients. Beeper tried commercially; Apple blocked them repeatedly. Beeper gave up in December 2023, stating: *"we can't win a cat-and-mouse game with the largest company on earth."* Some users reported their Macs were blocked from using iMessage entirely.

## Approach B: ricloud by Reincubate (Commercial, Read-Only)

**Product**: [ricloud API](https://reincubate.com/ricloud-api/) by Reincubate Ltd (UK).

**Pricing**: From $4/device/month, 125 device minimum.

**Authentication flow**:
1. Create session with Apple ID password
2. If 2FA: triggers code push → resubmit with code
3. If 2SV: choose device → code push → resubmit with code
4. Session token issued for data polling

**Capabilities** (read-only):
- iMessage, SMS, MMS with attachments
- Contacts (MobileMe), Calendar, Notes
- iCloud Photo Library
- Call history (CallKit)
- Safari browser history
- Find My device locations
- Third-party: WhatsApp, WeChat, Kik, Viber, LINE

**Cannot send messages.** Designed for compliance, monitoring, forensics, and parental monitoring use cases.

**Data output**: JSON via webhooks to customer S3/GCS storage. Real-time iCloud data access and historical backups.

**Relevant for**: Read-only iCloud data access if local `chat.db` access is unavailable. Not useful for sending.

## Approach C: BlueBubbles (macOS Server Required)

**Project**: [BlueBubbles](https://bluebubbles.app/) — open-source iMessage API server.

**How it works**: Runs on a dedicated macOS machine. Provides REST API + WebSocket for sending/receiving. Uses private macOS frameworks (not AppleScript). Supports attachments, reactions, group chats.

**Pros**: Full send + receive, group chat support, real API.
**Cons**: Requires a dedicated Mac (or Mac VM), more complex setup.

**Relevant for**: If a more capable API is needed beyond AppleScript.

## Approach D: Apple Business Chat / Messages for Business

Apple's official API for businesses to communicate via iMessage. Requires Apple Business Register enrollment and a Customer Service Platform (CSP) partner. Not applicable for personal/agent use.

## Regulatory Landscape

The DOJ filed an antitrust lawsuit against Apple in March 2024, specifically citing Apple's blocking of Beeper (which used pypush) as anticompetitive behavior. If the case succeeds, Apple may be forced to open iMessage interoperability, but nothing concrete has resulted yet as of Feb 2026.

The EU Digital Markets Act (DMA) designated iMessage as potentially subject to interoperability requirements, but Apple argued (and the EC initially accepted) that iMessage doesn't meet the "gatekeeper" threshold. This may change.

## Recommendation

**For imsg-mcp**: Continue with the current approach (AppleScript + chat.db). It's reliable, uses public APIs, has no ToS risk, and covers the primary use case.

**If cross-platform is needed**: BlueBubbles on a dedicated Mac is the most practical middle ground — a real API with full send/receive.

**Avoid reverse-engineered iCloud APIs** for production use:
- Apple actively blocks them
- Account suspension risk
- High maintenance burden (protocol changes)
- Legal/ToS risk

pypush is interesting for research and understanding the protocol, but not production-ready.
