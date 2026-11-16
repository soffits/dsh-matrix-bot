# Decisions

## Building blocks

- Own plugin. The DSH Matrix plugins on npm don't fit: `dsh-matrix-agent` has no end-to-end encryption, and `@xmanrui/dsh-im` uses the deprecated libolm with no cross-signing, key backup or Spaces. OpenClaw's `@openclaw/matrix` (MIT) was read for its practice: it runs matrix-js-sdk with the WASM crypto and keeps the crypto store alive across restarts by snapshotting a fake IndexedDB to disk, which takes a lot of its code.
- Client: `@vector-im/matrix-bot-sdk` (Element's maintained fork of matrix-bot-sdk, MIT) with `@matrix-org/matrix-sdk-crypto-nodejs` (Apache-2.0, the Rust crypto with a SQLite store on disk). It is made for bots, keeps its crypto state in plain files that survive restarts, and already has cross-signing setup, secret storage and key backup. matrix-js-sdk would need the IndexedDB snapshot layer above and keeps a full client model in memory. Both packages are pinned to exact versions.
- The crypto package fetches its native library in a postinstall script, so a profile that installs with pnpm must allow that package's build script (`allowBuilds` / `onlyBuiltDependencies`). README says so.
- Node 24 or newer: the Element fork and the crypto package both require it.
- `markdown-it` (MIT) turns answers into the HTML subset Matrix clients render; raw HTML in an answer is escaped, not passed on.
- Session handling, delivery rules (`messageAnswer`, `[SILENT]`, steering, recording sends in the bound session), models and voice come from soffits/dsh-deltachat-bot and soffits/dsh-telegram-bot so the chat bridges behave alike. The sender is recorded on each prompt as `source.principal` (kind `matrix-user`) with a notice before it, as the Telegram bot does.

## Login and encryption

- Password login through `/_matrix/client/v3/login`: Matrix Authentication Service answers it through its compatibility layer, and a bot cannot do the browser OAuth flow. The password is read from `passwordFile` only to log in; the access token and device id are kept in `session.json` (0600).
- An access token that stops working (`M_UNKNOWN_TOKEN`) means a new login with the same device id, so the crypto store stays valid; if the server hands out another device id, the old crypto store is moved aside and a new device set up.
- On the first start the bot creates its cross-signing keys (MSC3967 lets the first upload go without interactive auth, which MAS servers can't do for bots), secret storage with a new recovery key, and a server-side key backup whose key is kept in secret storage. The recovery key is written once to `recoveryKeyFile` (0600) and never logged or sent.
- On a new device of an account that already has cross-signing, the bot reads the recovery key from `recoveryKeyFile`, imports the cross-signing keys from secret storage, signs its device and turns on the backup. Without the key it runs unverified and says so in its status; it never resets the account's cross-signing by itself.
- Rooms the bot creates are encrypted from their first event.
- A device that verifies itself with the recovery key imports the cross-signing keys through the crypto machine directly, not the SDK's helper: that helper keeps a native device object alive, and one alive at exit makes the crypto library abort the process.
- Stopping waits until the sync loop is idle (the SDK's own stop still processes the request in flight), saves no sync token for an unprocessed batch, then closes the crypto store; a new connection waits for the old one's stop, as both would use one store. An open store is also closed on process exit, since the native library aborts when it is dropped outside its runtime.

## Spaces and rooms (power levels)

- The person is made admin with a power levels update right after the bot creates a room, not in `power_level_content_override`: room version 12 refuses creators in the power levels, and in older versions overriding `users` would drop the bot's own level.

## Spaces and rooms

- Each allowed person gets their own private Space, never a shared one (like each person's own Telegram chat). The bot makes it when the person first invites it to a room or a direct chat, invites them and gives them power level 100. A Space the person made and invited the bot to is adopted instead, when the bot may add rooms to it; otherwise the bot says which power level it needs.
- A Space has a lobby room (the bot's display name), which is also a session; `help` is pinned there.
- A room inside a person's Space is one of that person's sessions: only that person's messages count there, others are ignored. A room the person creates in their Space is joined when it appears as a child (`m.space.child`), or when they invite the bot; `new` makes one from any client.
- Any other room an allowed person invites the bot to (a direct chat or not) becomes that person's room and is added to their Space.
- One room is one session; the room → session map lives in `state.json`.

## Messages

- Replies stream: the first text of a turn is sent as a message and later text edits it (`m.replace`), at most every 2 s, with the full answer as the last edit. Matrix clients show edits in place, so this is the counterpart of Telegram's streamed drafts. A typing notice runs while the turn works.
- Messages longer than one event allows are split; the HTML part counts against the size, as the event is encrypted whole.
- Working signs are reactions, as in the Delta Chat bot: ⏳ when a message is taken, 👀 when it is steered into a running turn, redacted once the answer is out. Read receipts go back only after a message reached DSH.
- Edits to a sent message are not new prompts (rel_type `m.replace` is ignored).

## Commands and choices

- Element X is the main client. Element X Android parses `/` commands only behind an unfinished feature flag, and refuses unknown ones when it is on; Element X iOS only handles `/me` and sends other `/` text as is; Element Web asks before sending an unknown `/` command. So help shows `!` (works in every client) and `/` is accepted too.
- The command list is published for autocomplete in both proposals clients have started on: MSC4332 (`org.matrix.msc4332.commands`, one state event keyed by the bot's id) and MSC4391 (`org.matrix.msc4391.command_description`, one state event per command). Element X shows neither; gomuks and tesseract do. Invocation blocks from either are read when present, the body otherwise.
- `new [name]` creates a new room in the person's Space and invites them: one room is one session, like a new Telegram topic. `reset` starts a new session in the current room (Telegram's `/new`).
- Buttons become numbered lists answered by number or reply, plus reactions the bot puts on the question itself so they are one tap away: 👍/👎 for approvals, keycap digits for up to ten single-choice options.
