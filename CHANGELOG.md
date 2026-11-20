# Changelog

## 0.3.0

- Session handling (finding, creating and claiming a room's session, admitting prompts once, recording notes, reading answers and titles) and the `dsh-matrix` request spool now come from `@soffits/dsh-channel-core` instead of a copy.
- A message for an archived session that this DSH cannot unarchive is logged instead of silently going unanswered.
- The subagent status message is the one the Telegram bot shows: subagents started by subagents are listed under their parent, each line has the model and time (refreshed once a minute while running), failures say why, and long lists fold their oldest finished lines. `!agents` shows each subagent's state, model, time and last report, also for runs before a restart. Both now say "subagent" instead of "helper".

## 0.2.2

- The answer, silent marker, model, voice and sender logic now comes from `@soffits/dsh-channel-core`, the package shared with the Telegram bot, instead of a copy. While an answer streams, a trailing `[SILENT]` that is still being written after real text no longer flashes in the room.
- `@deepseek-ai/schemastery` is a peer dependency, so the bot uses the harness's own copy and an update never brings a private one.

## 0.2.1

- `!model` and `!effort` switch only the room's session. They used to go through the Web UI's model picker, which also saves every pick as the default for new sessions, so a switch in one room changed the model every other new session started on. The model is still checked with the host before the switch, and `/reset` in the room still starts on the room's pick.

## 0.2.0

- Prompts carry metadata only: the sender on `source.principal` (the room is now `chat: { id, name }`, was `room`), and the send time and the replied-to message on `source.envelope` (`sentAt`, `replyTo`), the shape [dsh-message-context](https://github.com/soffits/dsh-message-context) reads. The bot no longer adds its own `matrix-sender` notice or reply text; install dsh-message-context to show the model who wrote each message.

## 0.1.0

First release: a Matrix bot for DSH with end-to-end encryption (cross-signing, recovery key, key backup), a private Space per allowed person with one room per session, rooms joined from the Space or made with `!new`, streamed answers, typing notices and working reactions, files and voice messages, tool approvals and agent questions answered with reactions, Telegram-style commands published for bot command completion, `Matrix-<person>-<task>` session titles, the `matrixRooms` send service, the `matrix_send` tool and the `dsh-matrix` command.
