/**
 * Everything that talks to the homeserver: login, the client with its
 * on-disk sync and crypto stores, encryption setup (cross-signing, secret
 * storage, key backup) and the few calls the bot makes. The rest of the bot
 * sees only the object `connect` returns, so tests can pass a fake.
 */
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LogLevel, LogService, MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from '@vector-im/matrix-bot-sdk'

const require = createRequire(import.meta.url)
const { BackupDecryptionKey, SecretStorageItems, SecretStorageKey, StoreType } = require('@matrix-org/matrix-sdk-crypto-nodejs')

/**
 * Stops in progress by account directory. Process-wide (and kept across
 * reloads of this module), because a reloaded plugin connects again while
 * the old instance is still stopping, and both would open one crypto store.
 */
const STOPPING = Symbol.for('dsh-matrix-bot.stopping')
globalThis[STOPPING] ??= new Map()

/** Account data name of the key backup's secret. */
const BACKUP_SECRET = 'm.megolm_backup.v1'
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2'

/** @returns the Matrix error code of a failed request, or undefined. */
export function errcodeOf(error) {
  return error?.errcode ?? error?.body?.errcode
}

/** Longest single wait for a rate limit, and the waits a send tries before it fails. */
const RATE_LIMIT_MAX_WAIT_MS = 60_000
const RATE_LIMIT_ATTEMPTS = 8
/** Wait when a rate limit names no time. */
const RATE_LIMIT_DEFAULT_MS = 2_000

/**
 * Run a request again while the server says it is rate limited (429). The
 * server took nothing then, so the request is not sent twice. Synapse limits
 * messages, edits, reactions and redactions alike, which a streamed answer
 * reaches.
 * @param call - the request.
 * @param options - `{ stopped, sleep }`: `stopped()` ends the retries; `sleep(ms)` waits.
 * @returns the request's result.
 */
export async function whileRateLimited(call, { stopped = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      const limited = error?.statusCode === 429 || errcodeOf(error) === 'M_LIMIT_EXCEEDED'
      if (!limited || attempt >= RATE_LIMIT_ATTEMPTS || stopped()) throw error
      const asked = Number(error?.retryAfterMs ?? error?.body?.retry_after_ms)
      await sleep(Math.min(RATE_LIMIT_MAX_WAIT_MS, asked > 0 ? asked : RATE_LIMIT_DEFAULT_MS))
      if (stopped()) throw error
    }
  }
}

/**
 * Read a secret file, trimmed, or undefined when it is missing or empty.
 * @param path - file path.
 */
export async function readSecret(path) {
  if (!path) return undefined
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value.length > 0 ? value : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Write a secret file with mode 0600, its directory 0700, atomically. */
export async function writeSecret(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${value}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/**
 * Log in with a password.
 * @param options - `{ homeserver, userId, password, deviceName, deviceId }`;
 *   `deviceId` asks the server to keep using an existing device.
 * @returns `{ userId, deviceId, accessToken }`.
 */
export async function passwordLogin({ homeserver, userId, password, deviceName, deviceId }) {
  // A redirect would send the password on to wherever it points.
  const response = await fetch(new URL('/_matrix/client/v3/login', homeserver), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: deviceName,
      ...(deviceId ? { device_id: deviceId } : {}),
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(`login failed: ${body.errcode ?? response.status} ${body.error ?? ''}`.trim()), { errcode: body.errcode })
  return { userId: body.user_id, deviceId: body.device_id, accessToken: body.access_token }
}

/**
 * The stored login, reused while it belongs to the configured account and
 * server; otherwise a new password login. The account is matched as
 * configured, not as the server spells the user id, since a mismatch would
 * make a new device on every start.
 * @param options - `{ dir, homeserver, userId, passwordFile, deviceName, renew, info }`;
 *   `renew` logs in again on the stored device.
 * @returns `{ account, userId, deviceId, accessToken, homeserver }`.
 */
export async function loadLogin({ dir, homeserver, userId, passwordFile, deviceName, renew, info }) {
  const path = join(dir, 'session.json')
  let stored
  try {
    stored = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    stored = undefined
  }
  const same = stored?.homeserver === homeserver && stored?.account === userId && typeof stored?.accessToken === 'string'
  if (same && !renew) return stored
  const password = await readSecret(passwordFile)
  if (password === undefined) throw new Error(`no password in passwordFile (${passwordFile || 'not set'})`)
  const login = await passwordLogin({ homeserver, userId, password, deviceName, deviceId: same ? stored.deviceId : undefined })
  const record = { homeserver, account: userId, ...login }
  await writeSecret(path, JSON.stringify(record, null, 2))
  info(`logged in as ${record.userId} on device ${record.deviceId}`)
  return record
}

/**
 * Route the SDK's log through ours, warnings and errors only. The SDK logs
 * every failed request; a missing state event or account data entry is an
 * answer the caller expects (it reads them to find out), so those stay out.
 */
function quietSdk(warn) {
  const line = (module, parts) => {
    if (parts.some((part) => errcodeOf(part) === 'M_NOT_FOUND')) return
    warn(`sdk ${module}: ${parts.map(describe).join(' ')}`)
  }
  LogService.setLevel(LogLevel.WARN)
  LogService.setLogger({
    trace() {},
    debug() {},
    info() {},
    warn: (module, ...parts) => line(module, parts),
    error: (module, ...parts) => line(module, parts),
  })
}

function describe(part) {
  if (part instanceof Error) return part.message
  if (typeof part === 'string') return part
  return part?.message ?? part?.errcode ?? String(part)
}

/**
 * Set up the account's cross-signing, secret storage and key backup, or join
 * this device to the ones the account has.
 * @param client - started client with crypto.
 * @param options - `{ recoveryKeyFile, info, warn }`.
 * @returns `{ verified, backup }`.
 */
export async function bootstrapEncryption(client, { recoveryKeyFile, info, warn }) {
  const crypto = client.crypto
  const machine = crypto.engine.machine
  const userId = await client.getUserId()
  const local = await machine.crossSigningStatus()
  let recoveryKey = await readSecret(recoveryKeyFile)
  if (!(local.hasMaster && local.hasSelfSigning && local.hasUserSigning)) {
    const query = await client.doRequest('POST', '/_matrix/client/v3/keys/query', null, { device_keys: { [userId]: [] } })
    if (query?.master_keys?.[userId] === undefined) {
      if (recoveryKey !== undefined && await openSecretStorage(client, recoveryKey).catch(() => undefined) === undefined) {
        // Overwriting it would lose the key for good; it may be another account's.
        warn(`encryption not set up: ${recoveryKeyFile} holds a recovery key that does not open this account's secret storage; move that file away or point recoveryKeyFile elsewhere`)
        return { verified: false, backup: false }
      }
      if (recoveryKey === undefined) {
        // A new identity: the recovery key is on disk before anything uses it.
        const key = SecretStorageKey.createRandomKey()
        recoveryKey = key.toBase58()
        await writeSecret(recoveryKeyFile, recoveryKey)
        await client.setAccountData(key.eventType(), JSON.parse(key.accountDataContent()))
        await client.setAccountData('m.secret_storage.default_key', { key: key.keyId() })
      }
      await crypto.createIdentity(recoveryKey)
      info(`created the account's cross-signing keys; recovery key written to ${recoveryKeyFile}`)
    } else if (recoveryKey === undefined) {
      warn(`this device is not verified: the account has cross-signing keys and ${recoveryKeyFile} holds no recovery key`)
      return { verified: false, backup: false }
    } else {
      await importIdentity(client, recoveryKey)
      info('verified this device with the recovery key')
    }
  }
  return { verified: true, backup: await ensureBackup(client, recoveryKey, warn) }
}

/**
 * Take the account's cross-signing keys from secret storage and sign this
 * device with them. The SDK's own version holds a native device object that,
 * still alive at exit, makes the crypto library abort the process.
 */
async function importIdentity(client, recoveryKey) {
  const engine = client.crypto.engine
  const machine = engine.machine
  await engine.processOutgoingRequests([machine.queryKeysForUsers([machine.userId])])
  const storage = await openSecretStorage(client, recoveryKey)
  if (storage === undefined) throw new Error('the account has no default secret storage key')
  const secret = async (name) => JSON.stringify(await client.getAccountData(name))
  const items = new SecretStorageItems({
    masterKey: await secret('m.cross_signing.master'),
    userSigningKey: await secret('m.cross_signing.user_signing'),
    selfSigningKey: await secret('m.cross_signing.self_signing'),
  })
  await engine.processOutgoingRequests([await machine.importSecretsFromSecretStorage(storage, items)])
}

/** @returns the default secret storage key opened with the recovery key, or undefined. */
async function openSecretStorage(client, recoveryKey) {
  if (recoveryKey === undefined) return undefined
  const { key: keyId } = await client.getSafeAccountData('m.secret_storage.default_key', {})
  if (typeof keyId !== 'string') return undefined
  const name = `m.secret_storage.key.${keyId}`
  const content = await client.getSafeAccountData(name, undefined)
  if (content === undefined) return undefined
  return SecretStorageKey.fromAccountData(recoveryKey, name, JSON.stringify(content))
}

/**
 * Back up room keys to the server: use the account's backup, or create one
 * whose key goes into secret storage.
 * @returns true when backups run.
 */
async function ensureBackup(client, recoveryKey, warn) {
  const storage = await openSecretStorage(client, recoveryKey)
  let backup = await client.getKeyBackupVersion()
  if (backup === null || backup === undefined) {
    if (storage === undefined) {
      warn('no key backup: secret storage cannot be opened')
      return false
    }
    const key = BackupDecryptionKey.createRandomKey()
    const authData = { public_key: key.megolmV1PublicKey.publicKeyBase64 }
    authData.signatures = await client.crypto.sign(authData)
    const { version } = await client.doRequest('POST', '/_matrix/client/v3/room_keys/version', null, { algorithm: BACKUP_ALGORITHM, auth_data: authData })
    await client.setAccountData(BACKUP_SECRET, JSON.parse(storage.encrypt(key.toBase64(), BACKUP_SECRET)))
    await client.crypto.engine.machine.saveBackupDecryptionKey(key, version)
    backup = await client.getKeyBackupVersion()
  }
  if (backup?.algorithm !== BACKUP_ALGORITHM) {
    warn(`key backup ${backup?.version} uses ${backup?.algorithm}, which this bot cannot write`)
    return false
  }
  await client.enableKeyBackup(backup)
  return true
}

/**
 * Count the calls running in a crypto machine, so it can be closed when none
 * does. After `drain` starts, new calls fail at once.
 * @param machine - the SDK's `OlmMachine`.
 * @returns `{ drain }`: resolves when no call runs any more.
 */
export function trackCalls(machine) {
  let running = 0
  let draining = false
  const idle = []
  const proto = Object.getPrototypeOf(machine)
  for (const name of Object.getOwnPropertyNames(proto)) {
    const original = Object.getOwnPropertyDescriptor(proto, name)?.value
    if (name === 'constructor' || name === 'close' || typeof original !== 'function') continue
    Object.defineProperty(machine, name, {
      configurable: true,
      writable: true,
      value(...args) {
        if (draining) throw new Error('the crypto store is closing')
        const result = original.apply(machine, args)
        if (typeof result?.then !== 'function') return result
        running += 1
        return Promise.resolve(result).finally(() => {
          running -= 1
          if (running === 0) for (const resolve of idle.splice(0)) resolve()
        })
      },
    })
  }
  return {
    async drain() {
      draining = true
      while (running > 0) await new Promise((resolve) => idle.push(resolve))
    },
  }
}

/**
 * Connect to the homeserver.
 * @param options - `{ dir, homeserver, userId, passwordFile, deviceName, recoveryKeyFile, info, warn }`.
 * @returns the connection; call `start(handlers)` to begin syncing.
 */
export async function connect(options) {
  const { dir, homeserver, info, warn } = options
  await globalThis[STOPPING].get(dir)
  quietSdk(warn)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  let login = await loadLogin({ ...options, renew: false })
  const build = () => new MatrixClient(
    homeserver,
    login.accessToken,
    new SimpleFsStorageProvider(join(dir, 'sync.json')),
    new RustSdkCryptoStorageProvider(join(dir, 'crypto'), StoreType.Sqlite),
  )
  let client = build()
  try {
    await client.getWhoAmI()
  } catch (error) {
    if (errcodeOf(error) !== 'M_UNKNOWN_TOKEN') throw error
    warn('the stored login stopped working; logging in again on the same device')
    login = await loadLogin({ ...options, renew: true })
    client = build()
  }
  return wrapClient(client, login, options)
}

/**
 * The bot's view of a started client.
 * @param client - bot-sdk client.
 * @param login - `{ userId, deviceId, accessToken, homeserver }`.
 * @param options - connect options.
 */
function wrapClient(client, login, { dir, recoveryKeyFile, info, warn }) {
  let encryption = { verified: false, backup: false }
  const encrypted = new Map()
  // The SDK's stop only ends the sync loop after the request in flight, and
  // would still process its answer. A stopping client processes nothing and
  // saves no sync token, so the next run gets those events again. The crypto
  // store is closed only when no call into it runs: closing it under a
  // running call corrupts memory, and one dropped by the garbage collector or
  // at exit, outside the library's runtime, aborts the process.
  let stopping
  let processing = Promise.resolve()
  let calls
  client.persistTokenAfterSync = true
  client.once('crypto.ready', () => { calls = trackCalls(client.crypto.engine.machine) })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    process.off('exit', close)
    client.crypto?.engine?.machine?.close?.()
  }
  process.on('exit', close)
  const processSync = client.processSync.bind(client)
  client.processSync = (raw, emitFn) => {
    if (stopping !== undefined) return Promise.reject(new Error('stopping'))
    processing = processSync(raw, emitFn)
    return processing
  }

  const limits = { stopped: () => stopping !== undefined }

  async function isEncrypted(roomId) {
    if (!encrypted.has(roomId)) encrypted.set(roomId, await client.crypto.isRoomEncrypted(roomId))
    return encrypted.get(roomId)
  }

  return {
    userId: login.userId,
    deviceId: login.deviceId,
    /** @returns `{ verified, backup }` of this device. */
    encryption: () => ({ ...encryption }),

    /**
     * Start syncing and set up encryption.
     * @param handlers - `{ onEvent(roomId, event), onInvite(roomId, event), onLeave(roomId, event) }`;
     *   `onEvent` gets every timeline event, decrypted when it can be.
     */
    async start({ onEvent, onInvite, onLeave }) {
      client.on('room.event', (roomId, event) => onEvent(roomId, event))
      client.on('room.invite', (roomId, event) => onInvite(roomId, event))
      client.on('room.leave', (roomId, event) => onLeave(roomId, event))
      client.on('room.failed_decryption', (roomId, event, error) => warn(`could not decrypt ${event?.event_id} in ${roomId}: ${describe(error)}`))
      await client.start()
      try {
        encryption = await bootstrapEncryption(client, { recoveryKeyFile, info, warn })
      } catch (error) {
        warn(`encryption setup failed: ${describe(error)}`)
      }
    },
    /** Stop syncing; resolves once the client is idle and its crypto store closed. */
    stop() {
      if (stopping !== undefined) return stopping
      stopping = (async () => {
        client.stop()
        await Promise.allSettled([processing, client.crypto?.engine?.keyBackupWaiter])
        await calls?.drain()
        close()
      })()
      const registry = globalThis[STOPPING]
      const done = stopping.finally(() => { if (registry.get(dir) === done) registry.delete(dir) })
      registry.set(dir, done)
      return stopping
    },

    async sendEvent(roomId, type, content) {
      return whileRateLimited(() => client.sendEvent(roomId, type, content), limits)
    },
    async sendState(roomId, type, stateKey, content) {
      return whileRateLimited(() => client.sendStateEvent(roomId, type, stateKey, content), limits)
    },
    /** @returns a state event's content, or undefined when the room has none. */
    async getState(roomId, type, stateKey = '') {
      try {
        return await client.getRoomStateEvent(roomId, type, stateKey)
      } catch (error) {
        if (errcodeOf(error) === 'M_NOT_FOUND') return undefined
        throw error
      }
    },
    /** @returns every state event of a room. */
    async roomState(roomId) {
      return client.getRoomState(roomId)
    },
    /** @returns one event, decrypted when it can be. */
    async getEvent(roomId, eventId) {
      const event = await client.getEvent(roomId, eventId)
      return event?.raw ?? event
    },
    async redact(roomId, eventId) {
      return whileRateLimited(() => client.redactEvent(roomId, eventId), limits)
    },
    async setTyping(roomId, typing, timeoutMs) {
      return client.setTyping(roomId, typing, timeoutMs)
    },
    async readReceipt(roomId, eventId) {
      return client.sendReadReceipt(roomId, eventId)
    },
    async createRoom(options) {
      return client.createRoom(options)
    },
    async join(roomId, via = []) {
      return client.joinRoom(roomId, via)
    },
    async leave(roomId) {
      encrypted.delete(roomId)
      return client.leaveRoom(roomId)
    },
    async invite(roomId, userId) {
      return client.inviteUser(userId, roomId)
    },
    /** @returns `{ userId, membership }` for everyone with a membership in the room. */
    async members(roomId) {
      const events = await client.getRoomMembers(roomId)
      return events.map((event) => ({ userId: event.membershipFor, membership: event.effectiveMembership }))
    },
    async joinedRooms() {
      return client.getJoinedRooms()
    },
    /**
     * Upload a file for a room: encrypted when the room is.
     * @returns `{ url }` for a plain upload or `{ file }` for an encrypted one.
     */
    async upload(roomId, buffer, { name, mimetype }) {
      if (await isEncrypted(roomId)) {
        const { buffer: data, file } = await client.crypto.encryptMedia(buffer)
        const url = await client.uploadContent(data, 'application/octet-stream')
        return { file: { ...file, url } }
      }
      return { url: await client.uploadContent(buffer, mimetype, name) }
    },
    /** @returns the bytes of a message's media (`content.file` or `content.url`). */
    async download(content) {
      if (content?.file?.url) return Buffer.from(await client.crypto.decryptMedia(content.file))
      if (typeof content?.url !== 'string') throw new Error('the message has no media')
      const { data } = await client.downloadContent(content.url)
      return Buffer.from(data)
    },
    async setProfile({ displayName, avatar }) {
      if (displayName) {
        const current = await client.getUserProfile(login.userId).catch(() => ({}))
        if (current?.displayname !== displayName) await client.setDisplayName(displayName)
      }
      if (avatar) {
        const data = await readFile(avatar)
        await client.setAvatarUrl(await client.uploadContent(data, mimeOf(avatar), avatar.split('/').pop()))
      }
    },
    async displayName() {
      const profile = await client.getUserProfile(login.userId).catch(() => ({}))
      return profile?.displayname ?? login.userId
    },
  }
}

/** @returns a picture's MIME type from its name. */
function mimeOf(path) {
  const extension = path.split('.').pop().toLowerCase()
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[extension] ?? 'application/octet-stream'
}
