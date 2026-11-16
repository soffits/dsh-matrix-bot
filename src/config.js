/** Editable plugin configuration. Every field is volatile: it is read live. */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** Whether the bot runs while this profile runs. */
  enabled: z.boolean().default(true).volatile(),
  /** Homeserver base URL, such as https://matrix.example.org. */
  homeserver: z.string().default('').volatile(),
  /** The bot's own Matrix user id, such as @bot:example.org. */
  userId: z.string().default('').volatile(),
  /** File holding the bot account's password (mode 0600), read only to log in. */
  passwordFile: z.string().default('').volatile(),
  /**
   * File the recovery key is written to when the bot sets up encryption for
   * the account, and read from when a new device of the bot joins it. Empty
   * uses `recovery-key` in the bot's data directory.
   */
  recoveryKeyFile: z.string().default('').volatile(),
  /** Name of the bot's device in people's device lists. */
  deviceName: z.string().default('DSH').volatile(),
  /** Display name of the bot account; empty keeps the current one. */
  displayName: z.string().default('').volatile(),
  /** Absolute path of a picture used as the bot's avatar; empty keeps the current one. */
  avatar: z.string().default('').volatile(),
  /** Name of each person's Space; empty uses the bot's display name. */
  spaceName: z.string().default('').volatile(),
  /**
   * People who may talk to the bot, by Matrix user id. `name` is how their
   * messages are labelled for the agent and in session titles. An entry
   * without a user id is skipped. Everyone else is ignored.
   */
  allowedUsers: z.array(z.object({
    userId: z.string().default(''),
    name: z.string().default(''),
  })).default([]).volatile(),
  /** Working directory of sessions the bot creates. */
  cwd: z.string().default(process.cwd()).volatile(),
  /** Agent preset of sessions the bot creates; empty uses the Host default. */
  agentPreset: z.string().default('').volatile(),
  /**
   * Also show turns started elsewhere (Web UI, scheduled tasks, other plugins)
   * in the room bound to their session.
   */
  mirrorTurns: z.boolean().default(true).volatile(),
  /**
   * Messages sent while the session's turn runs: `steer` sends them into that
   * turn (as the Web UI does); `queue` holds them until the turn ends.
   */
  busyMessages: z.union(['steer', 'queue']).default('steer').volatile(),
  /** Show answers while they are written, by editing the message in place. */
  streaming: z.boolean().default(true).volatile(),
  /**
   * How voice messages and audio files become text: `dsh` uses the DSH
   * speech-to-text service (decoded with ffmpeg), `command` runs
   * `transcribeCommand`, `off` passes only the file.
   */
  transcriber: z.union(['dsh', 'command', 'off']).default('dsh').volatile(),
  /** Language hint for the DSH speech-to-text service; empty uses its setting. */
  transcribeLanguage: z.string().default('').volatile(),
  /**
   * Program and arguments for `transcriber: command`, run without a shell.
   * `{file}` is replaced by the recording's path (appended when absent).
   */
  transcribeCommand: z.array(z.string()).default([]).volatile(),
  /** ffmpeg program used to decode recordings for the DSH service. */
  ffmpegPath: z.string().default('ffmpeg').volatile(),
})
