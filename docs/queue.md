# Queue

- Group rooms with read-along and a wake gate (design in the parent's notes).
- Received files in `$DSH_HOME/matrix/media/` are never pruned.
- `splitText` can cut a long answer inside a code fence, which breaks the formatting of both parts.
- An edit the person makes to a sent message is ignored; it could be steered into the running turn as a correction.
- The send service cannot remove a reaction (it would need to find and redact the bot's own reaction event).
- Not tested against a server that expires access tokens: the re-login on the same device after `M_UNKNOWN_TOKEN` has no test.
- After the bot's data is lost, its old device stays signed in on the server; the owner signs it out in the account's device list.
