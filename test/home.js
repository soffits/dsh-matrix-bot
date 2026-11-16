/**
 * Keep every test run away from a real DSH home: each test file runs in its
 * own process and imports this first, so it gets a fresh, empty DSH_HOME.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-deltachat-test-home-'))
const scratch = join(home, 'tmp')
mkdirSync(scratch)
process.env.DSH_HOME = home
process.env.TMPDIR = scratch
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
