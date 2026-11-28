import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../shared/claude/project-claude-account-preference'

/**
 * Which managed account each pinned Claude PTY runs on, or ACTIVE_CLAUDE_ACCOUNT for one launched on
 * the active account. Persisted so a restored pane keeps its label and restarts on the same choice.
 */
const accountIdByPtyId = new Map<string, string>()
// Why: restored at startup but not yet confirmed against the daemon, which drops the dead ones.
const seededUnconfirmedPtyIds = new Set<string>()

export type ClaudePinnedPtyPersistence = {
  write(entries: Record<string, string>): void | Promise<void>
}

let persistence: ClaudePinnedPtyPersistence | null = null

export function attachClaudePinnedPtyPersistence(target: ClaudePinnedPtyPersistence | null): void {
  persistence = target
}

export function getPinnedClaudeAccountIdForPty(ptyId: string): string | undefined {
  const accountId = accountIdByPtyId.get(ptyId)
  return accountId === ACTIVE_CLAUDE_ACCOUNT ? undefined : accountId
}

/** The pinned account id, or ACTIVE_CLAUDE_ACCOUNT for a launch that chose the active account. */
export function getClaudeAccountChoiceForPty(ptyId: string): string | undefined {
  return accountIdByPtyId.get(ptyId)
}

export function markClaudePtySpawnedOnActiveAccount(ptyId: string): void {
  markPinnedClaudePtySpawned(ptyId, ACTIVE_CLAUDE_ACCOUNT)
}

export function markPinnedClaudePtySpawned(ptyId: string, accountId: string): void {
  accountIdByPtyId.set(ptyId, accountId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persist()
}

/** A no-op for unpinned PTYs, so every exit can call it. */
export function markPinnedClaudePtyExited(ptyId: string): void {
  seededUnconfirmedPtyIds.delete(ptyId)
  if (accountIdByPtyId.delete(ptyId)) {
    persist()
  }
}

export function seedPinnedClaudePtysFromPersistence(entries: Record<string, string>): void {
  for (const [ptyId, accountId] of Object.entries(entries)) {
    accountIdByPtyId.set(ptyId, accountId)
    seededUnconfirmedPtyIds.add(ptyId)
  }
}

export function hasSeededUnconfirmedPinnedClaudePtys(): boolean {
  return seededUnconfirmedPtyIds.size > 0
}

/** Drops seeded ids the daemon no longer knows. */
export function confirmSeededPinnedClaudePtys(aliveSessionIds: readonly string[]): void {
  const alive = new Set(aliveSessionIds)
  let dropped = false
  for (const ptyId of seededUnconfirmedPtyIds) {
    if (!alive.has(ptyId) && accountIdByPtyId.delete(ptyId)) {
      dropped = true
    }
  }
  seededUnconfirmedPtyIds.clear()
  if (dropped) {
    persist()
  }
}

function persist(): void {
  try {
    void Promise.resolve(persistence?.write(Object.fromEntries(accountIdByPtyId))).catch(
      warnPersistFailure
    )
  } catch (error) {
    warnPersistFailure(error)
  }
}

// Why: the record only keeps labels across a restart; losing it must never fail a spawn or an exit.
function warnPersistFailure(error: unknown): void {
  console.warn('[claude-pinned-pty] Failed to persist pinned Claude PTYs:', error)
}

export async function readClaudePinnedPtyRegistryFile(
  filePath: string
): Promise<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {
    return {}
  }
  const panes = parsed && typeof parsed === 'object' && 'panes' in parsed ? parsed.panes : undefined
  if (!panes || typeof panes !== 'object' || Array.isArray(panes)) {
    return {}
  }
  const entries: Record<string, string> = {}
  for (const [ptyId, accountId] of Object.entries(panes)) {
    if (typeof accountId === 'string' && accountId) {
      entries[ptyId] = accountId
    }
  }
  return entries
}

export function createClaudePinnedPtyFilePersistence(filePath: string): ClaudePinnedPtyPersistence {
  // Why chained: a later write must never land before an earlier one.
  let pending: Promise<void> = Promise.resolve()
  return {
    write(entries) {
      const contents = `${JSON.stringify({ version: 1, panes: entries })}\n`
      pending = pending
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(filePath), { recursive: true })
          await writePluginFileAtomically(filePath, contents, { mode: 0o600 })
        })
      return pending
    }
  }
}

export const _internals = {
  reset(): void {
    accountIdByPtyId.clear()
    seededUnconfirmedPtyIds.clear()
    persistence = null
  }
}
