# Queue

- Group rooms with read-along and a wake gate (design in the parent's notes).
- Received files in `$DSH_HOME/matrix/media/` are never pruned.
- `splitText` can cut a long answer inside a code fence, which breaks the formatting of both parts.
- An edit the person makes to a sent message is ignored; it could be steered into the running turn as a correction.
- The send service cannot remove a reaction (it would need to find and redact the bot's own reaction event).
- Not tested against a server that expires access tokens: the re-login on the same device after `M_UNKNOWN_TOKEN` has no test.
- After the bot's data is lost, its old device stays signed in on the server; the owner signs it out in the account's device list.
- There is no release workflow yet, although the Git section of AGENTS.md describes one; the first npm publish is done by hand.
- A message being handled when DSH stops (between its sync and the prompt reaching the session, e.g. during a voice transcription) is lost: the sync position is saved once the batch is handed out, not when its handlers finish.
- An access token revoked while the bot runs (its device signed out elsewhere) leaves the sync loop failing with `M_UNKNOWN_TOKEN` until the next start; only the start logs in again.
- A send that fails on a network error is not retried, so an answer sent during a drop is lost. A retry needs the same transaction id, which the SDK's `sendEvent` doesn't take.
- Adopting a Space doesn't check who made it: anyone with power there can add rooms, and the bot joins them as the person's. Only the person's messages count there, but the bot's answers are visible to that room's members.
- When a room's owner leaves and others stay, the bot stays too and mirrored turns keep going there; it could leave once the owner is gone.
- Room upgrades (tombstones) are not followed: the new room gets a new session only when the person invites the bot, and the old session stays bound to the old room.
- Switching `userId` to another account keeps one `account/` directory: the new account starts from the old one's sync position, and old per-device crypto stores stay on disk.
- A received file named `..` fails to save (and its message with it); the size limit trusts the size the sender's client declares.
- rare: lobby session placeholder title reads "Matrix-Livia-Matrix room" (prefix and room label both say Matrix); trim one.
