# dsh-matrix-bot

Talk to your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions over [Matrix](https://matrix.org). The plugin logs in as its own Matrix account and gives every allowed person a private Space: each room in it is one DSH session, so a new room is a new conversation. Answers stream into the room as they are written, files and voice messages go both ways, and tool approvals and agent questions are answered right there. End-to-end encryption is on: the bot sets up its own cross-signing, secret storage and key backup the first time it starts.

It is made with [Element X](https://element.io/app) in mind and works in any Matrix client.

## Installation

Use the DSH Plugins page, or install from a shell:

```sh
dsh plugin --profile web add @soffits/dsh-matrix-bot
```

You need Node.js 24 or newer. Encryption uses `@matrix-org/matrix-sdk-crypto-nodejs`, which downloads its prebuilt native library in an install script. pnpm 10 and newer skip such scripts until you approve them, so in the profile directory run:

```sh
pnpm approve-builds @matrix-org/matrix-sdk-crypto-nodejs
```

The bundle adds two plugin rows: `matrix-bot` (the bot) and `matrix-bot-tools` (which gives agents the `matrix_send` tool).

## Setup

Make a Matrix account for the bot on any homeserver, put its password in a file only you can read, and fill in the settings:

```yaml
- id: matrix-bot
  config:
    homeserver: https://matrix.example.org
    userId: '@mybot:example.org'
    passwordFile: /home/me/secrets/matrix-bot-password   # mode 0600
    displayName: My Assistant
    allowedUsers:
      - userId: '@alex:example.org'
        name: Alex
```

The password is read only to log in. Servers that use Matrix Authentication Service accept this through their password login compatibility, so it works there too.

On the first start the bot logs in, creates its cross-signing keys, a recovery key and a server-side key backup. The recovery key is written to `recoveryKeyFile` (by default `$DSH_HOME/matrix/recovery-key`, mode 0600) and nowhere else: move it to your password manager or secret store and point `recoveryKeyFile` at where it lives. A later new device of the bot (after its data is lost) reads it from there to verify itself; without it, the bot runs unverified and says so in `!status`.

## Talking to it

Invite the bot to a direct chat. It makes you a private Space (named after the bot, or `spaceName`), makes you an admin there, adds the chat to it as your first room and pins a short help message. Accept the Space invite, and from then on:

- Every room in your Space is its own session. Create a room inside the Space in your client, or send `!new <name>` and the bot makes one and invites you.
- If you made a Space yourself, invite the bot to it and it adopts it instead, as long as it may add rooms there (it tells you which power level it needs if not).
- Each person gets their own Space; one person's rooms never answer another.

Only people in `allowedUsers` get replies; everyone else is ignored, and their invites are turned down. `dsh-matrix status` lists who was ignored, and `dsh-matrix allow '@alex:example.org' --name Alex` adds someone through DSH's configuration editor.

While a turn runs, the bot shows it is typing, and your message gets ⏳ (or 👀 when it went into the running turn). The answer appears as one message that grows as it is written. Turns started elsewhere, such as the Web UI or a scheduled task, are shown in the room too unless `mirrorTurns` is off.

When the agent needs approval for a tool, the bot asks in the room with 👍 and 👎 already added: tap one. Questions list numbered options with number reactions to tap, or you can reply with a number or your own answer.

### Commands

Commands start with `!`, which works in every Matrix client. `/` works too in clients that send unknown slash commands as text (Element X on iPhone does; Element Web asks first). The bot also publishes its commands in each room for clients that offer bot command completion (MSC4332 and MSC4391).

| Command | What it does |
|---|---|
| `!help` | List commands |
| `!new [name]` | Open a new room with a new session |
| `!reset` | Start a new session in this room |
| `!stop` | Stop the running turn |
| `!clear` | Drop messages still waiting for the session |
| `!status` | Bot and session status |
| `!current` | Show this room's session |
| `!last [1-5]` | Show the latest answers |
| `!agents` | List this session's helpers and their last reports |
| `!sessions` | Browse workspaces and sessions, continue one here |
| `!workspace <n>` | Start a new session in another workspace |
| `!fork [name]` | Fork this session into a new room |
| `!rename <name>` | Rename this room's session |
| `!goal` | Set, edit, pause, resume or clear the goal |
| `!menu`, `!model`, `!effort`, `!mode`, `!context` | Model, reasoning effort, access mode and context use |
| `!allow`, `!deny` | Answer the waiting tool request |
| `!id`, `!ping`, `!restart` | Ids, a check, and reconnecting |

Lists such as `!model` are numbered; the same command with the numbers picks one (`!model 2 5`).

## Sending from scripts, agents and other plugins

```sh
dsh-matrix send --room '!abc:example.org' 'The backup finished.'
dsh-matrix send --room '!abc:example.org' --file /tmp/report.pdf --job nightly
dsh-matrix rooms
```

Agents get the `matrix_send` tool. Other plugins can use the `matrixRooms` service: `send({ to, text, files, from, replyTo, reaction })`. Sends are recorded in the session bound to the room, without starting a turn. A session cannot send text into its own room while that room receives its turn's answer, since it would arrive twice.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the bot with this profile |
| `homeserver`, `userId`, `passwordFile` | | The bot's account |
| `recoveryKeyFile` | `$DSH_HOME/matrix/recovery-key` | Where the recovery key is written, and read on a new device |
| `deviceName` | `DSH` | Name of the bot's device |
| `displayName`, `avatar` | | The bot's name and picture; empty keeps them |
| `spaceName` | the display name | Name of new Spaces |
| `allowedUsers` | `[]` | `{ userId, name }` of the people who may talk to it |
| `cwd`, `agentPreset` | | Directory and preset of new sessions |
| `mirrorTurns` | `true` | Show turns started elsewhere in their room |
| `busyMessages` | `steer` | `steer` sends messages into a running turn; `queue` waits for it to end |
| `streaming` | `true` | Show answers while they are written |
| `transcriber`, `transcribeLanguage`, `transcribeCommand`, `ffmpegPath` | `dsh` | How voice messages become text |

## Where files live

Everything is under `$DSH_HOME/matrix`, whose directories are 0700 so only the user DSH runs as can read them (the bot's own files are 0600 as well): `account/` holds the login (`session.json`), the sync position and the crypto store; `state.json` maps rooms to sessions and remembers each person's Space; `media/` keeps received files; `spool/` carries requests from `dsh-matrix`; `status.json` is the last state. Keep this directory with the DSH home: the crypto store is the bot's identity in encrypted rooms.

## Removal

Remove the plugin from the Plugins page. The bot's device stays signed in on the server until you sign it out in your account's device list (or the homeserver's account page). Delete `$DSH_HOME/matrix` to forget the login and keys.

## Development

```sh
npm test        # unit and bridge tests on a fake Matrix connection
npm run check   # syntax check
npm run e2e     # the real bot against a throwaway local homeserver (Tuwunel)
```

`npm run e2e` downloads a pinned Tuwunel release into `.e2e/` unless `TUWUNEL` names a server binary.

## License

MIT
