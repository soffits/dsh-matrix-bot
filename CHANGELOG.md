# Changelog

## Unreleased

## 0.2.0

- Prompts carry metadata only: the sender on `source.principal` (the room is now `chat: { id, name }`, was `room`), and the send time and the replied-to message on `source.envelope` (`sentAt`, `replyTo`), the shape [dsh-message-context](https://github.com/soffits/dsh-message-context) reads. The bot no longer adds its own `matrix-sender` notice or reply text; install dsh-message-context to show the model who wrote each message.

## 0.1.0

First release: a Matrix bot for DSH with end-to-end encryption (cross-signing, recovery key, key backup), a private Space per allowed person with one room per session, rooms joined from the Space or made with `!new`, streamed answers, typing notices and working reactions, files and voice messages, tool approvals and agent questions answered with reactions, Telegram-style commands published for bot command completion, `Matrix-<person>-<task>` session titles, the `matrixRooms` send service, the `matrix_send` tool and the `dsh-matrix` command.
