import fs from "node:fs"
import path from "node:path"

export type WorkspaceRecoveryLeaseMode = "shared" | "exclusive"

export interface WorkspaceRecoveryScope {
  readonly path: string
  readonly repositoryId: string | null
}

export interface WorkspaceRecoveryLease {
  readonly mode: WorkspaceRecoveryLeaseMode
  readonly scopes: readonly WorkspaceRecoveryScope[]
  release(): void
}

interface ActiveLease {
  readonly id: number
  readonly mode: WorkspaceRecoveryLeaseMode
  readonly scopes: readonly WorkspaceRecoveryScope[]
}

interface WaitingLease {
  readonly mode: WorkspaceRecoveryLeaseMode
  readonly scopes: readonly WorkspaceRecoveryScope[]
  readonly resolve: (lease: WorkspaceRecoveryLease) => void
}

/**
 * Coordinates filesystem and Git mutations with checkpoint recovery.
 *
 * Scopes conflict when their canonical paths overlap in either direction or
 * when both resolve to the same Git common directory. The latter makes linked
 * worktrees share one recovery boundary even though their filesystem paths are
 * siblings.
 */
export class WorkspaceRecoveryGate {
  private readonly active = new Map<number, ActiveLease>()
  private readonly waiting: WaitingLease[] = []
  private nextLeaseId = 1

  acquireShared(
    workspaces: string | readonly string[]
  ): Promise<WorkspaceRecoveryLease> {
    return this.acquire("shared", workspaces)
  }

  acquireExclusive(
    workspaces: string | readonly string[]
  ): Promise<WorkspaceRecoveryLease> {
    return this.acquire("exclusive", workspaces)
  }

  /**
   * Queue an exclusive barrier before draining long-lived shared resources.
   *
   * This prevents a new shell/PTY/workspace mutation from entering between
   * the drain and exclusive acquisition. If draining fails, the queued
   * waiter is removed (or an already granted lease is released) so a failed
   * recovery attempt cannot leave a ghost writer barrier behind.
   */
  async acquireExclusiveAfterQuiesce(
    workspaces: string | readonly string[],
    quiesce: () => Promise<void> | void,
    options: { readonly timeoutMs?: number } = {}
  ): Promise<WorkspaceRecoveryLease> {
    const scopes = resolveWorkspaceRecoveryScopes(workspaces)
    const grant: { lease: WorkspaceRecoveryLease | null } = { lease: null }
    let waiter!: WaitingLease
    const leasePromise = new Promise<WorkspaceRecoveryLease>((resolve) => {
      waiter = {
        mode: "exclusive",
        scopes,
        resolve: (lease) => {
          grant.lease = lease
          resolve(lease)
        },
      }
      this.waiting.push(waiter)
      this.drain()
    })
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30_000))
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(
                `Workspace recovery quiescence did not complete within ${timeoutMs}ms.`
              ),
              {
                code: "WORKSPACE_RECOVERY_QUIESCE_TIMEOUT",
                statusCode: 503,
              }
            )
          ),
        timeoutMs
      )
      timeoutHandle.unref?.()
    })

    try {
      await Promise.race([Promise.resolve().then(quiesce), timeout])
      return await Promise.race([leasePromise, timeout])
    } catch (error) {
      const waitingIndex = this.waiting.indexOf(waiter)
      if (waitingIndex >= 0) {
        this.waiting.splice(waitingIndex, 1)
        this.drain()
      } else {
        grant.lease?.release()
      }
      throw error
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  tryAcquireExclusive(
    workspaces: string | readonly string[]
  ): WorkspaceRecoveryLease | null {
    const scopes = resolveWorkspaceRecoveryScopes(workspaces)
    if (
      this.hasActiveConflict("exclusive", scopes) ||
      this.waiting.some((waiter) =>
        workspaceRecoveryScopesConflict(waiter.scopes, scopes)
      )
    ) {
      return null
    }
    return this.activate("exclusive", scopes)
  }

  async withShared<T>(
    workspaces: string | readonly string[],
    operation: () => Promise<T> | T
  ): Promise<T> {
    const lease = await this.acquireShared(workspaces)
    try {
      return await operation()
    } finally {
      lease.release()
    }
  }

  async withExclusive<T>(
    workspaces: string | readonly string[],
    operation: () => Promise<T> | T
  ): Promise<T> {
    const lease = await this.acquireExclusive(workspaces)
    try {
      return await operation()
    } finally {
      lease.release()
    }
  }

  activeLeaseCount(): number {
    return this.active.size
  }

  waitingLeaseCount(): number {
    return this.waiting.length
  }

  private acquire(
    mode: WorkspaceRecoveryLeaseMode,
    workspaces: string | readonly string[]
  ): Promise<WorkspaceRecoveryLease> {
    const scopes = resolveWorkspaceRecoveryScopes(workspaces)
    return new Promise((resolve) => {
      this.waiting.push({ mode, scopes, resolve })
      this.drain()
    })
  }

  private drain(): void {
    let granted = true
    while (granted) {
      granted = false
      for (let index = 0; index < this.waiting.length; index += 1) {
        const waiter = this.waiting[index]
        if (!waiter) continue
        const blockedByEarlier = this.waiting
          .slice(0, index)
          .some((earlier) =>
            workspaceRecoveryScopesConflict(earlier.scopes, waiter.scopes)
          )
        if (
          blockedByEarlier ||
          this.hasActiveConflict(waiter.mode, waiter.scopes)
        ) {
          continue
        }
        this.waiting.splice(index, 1)
        waiter.resolve(this.activate(waiter.mode, waiter.scopes))
        granted = true
        break
      }
    }
  }

  private hasActiveConflict(
    mode: WorkspaceRecoveryLeaseMode,
    scopes: readonly WorkspaceRecoveryScope[]
  ): boolean {
    for (const active of this.active.values()) {
      if (
        (mode === "exclusive" || active.mode === "exclusive") &&
        workspaceRecoveryScopesConflict(active.scopes, scopes)
      ) {
        return true
      }
    }
    return false
  }

  private activate(
    mode: WorkspaceRecoveryLeaseMode,
    scopes: readonly WorkspaceRecoveryScope[]
  ): WorkspaceRecoveryLease {
    const id = this.nextLeaseId++
    const active: ActiveLease = { id, mode, scopes }
    this.active.set(id, active)
    let released = false
    return {
      mode,
      scopes,
      release: () => {
        if (released) return
        released = true
        this.active.delete(id)
        this.drain()
      },
    }
  }
}

export const workspaceRecoveryGate = new WorkspaceRecoveryGate()

export function resolveWorkspaceRecoveryScopes(
  workspaces: string | readonly string[]
): WorkspaceRecoveryScope[] {
  const values = typeof workspaces === "string" ? [workspaces] : workspaces
  const byIdentity = new Map<string, WorkspaceRecoveryScope>()
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) continue
    const canonicalPath = canonicalizePath(value)
    const repositoryId = discoverGitCommonDirectory(canonicalPath)
    const identity = repositoryId
      ? `repository:${repositoryId}`
      : `path:${canonicalPath}`
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, {
        path: canonicalPath,
        repositoryId,
      })
    }
  }
  if (byIdentity.size === 0) {
    throw new Error("At least one workspace path is required")
  }
  return [...byIdentity.values()]
}

export function workspaceRecoveryScopesConflict(
  left: readonly WorkspaceRecoveryScope[],
  right: readonly WorkspaceRecoveryScope[]
): boolean {
  return left.some((leftScope) =>
    right.some((rightScope) => scopeConflict(leftScope, rightScope))
  )
}

function scopeConflict(
  left: WorkspaceRecoveryScope,
  right: WorkspaceRecoveryScope
): boolean {
  if (
    left.repositoryId &&
    right.repositoryId &&
    left.repositoryId === right.repositoryId
  ) {
    return true
  }
  return (
    isSameOrDescendant(left.path, right.path) ||
    isSameOrDescendant(right.path, left.path)
  )
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function canonicalizePath(value: string): string {
  const resolved = path.resolve(value)
  try {
    return comparablePath(fs.realpathSync.native(resolved))
  } catch {
    const missingSegments: string[] = []
    let cursor = resolved
    while (true) {
      const parent = path.dirname(cursor)
      if (parent === cursor) return comparablePath(resolved)
      missingSegments.unshift(path.basename(cursor))
      cursor = parent
      try {
        const existing = fs.realpathSync.native(cursor)
        return comparablePath(path.join(existing, ...missingSegments))
      } catch {
        // Continue until an existing ancestor can be canonicalized.
      }
    }
  }
}

function discoverGitCommonDirectory(workspacePath: string): string | null {
  let cursor = pathForRepositoryDiscovery(workspacePath)
  while (true) {
    const dotGitPath = path.join(cursor, ".git")
    try {
      const stat = fs.statSync(dotGitPath)
      if (stat.isDirectory()) return canonicalizePath(dotGitPath)
      if (stat.isFile()) {
        const gitDirectory = readGitDirectoryPointer(dotGitPath)
        if (gitDirectory) {
          const commonDirectory = readGitCommonDirectory(gitDirectory)
          return canonicalizePath(commonDirectory ?? gitDirectory)
        }
      }
    } catch {
      // This ancestor is not a Git worktree root.
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function pathForRepositoryDiscovery(workspacePath: string): string {
  try {
    return fs.statSync(workspacePath).isFile()
      ? path.dirname(workspacePath)
      : workspacePath
  } catch {
    return workspacePath
  }
}

function readGitDirectoryPointer(dotGitPath: string): string | null {
  const content = readBoundedUtf8File(dotGitPath)
  const match = /^gitdir:\s*(.+)\s*$/im.exec(content)
  if (!match?.[1]) return null
  const pointer = match[1].trim()
  return path.isAbsolute(pointer)
    ? pointer
    : path.resolve(path.dirname(dotGitPath), pointer)
}

function readGitCommonDirectory(gitDirectory: string): string | null {
  try {
    const content = readBoundedUtf8File(
      path.join(gitDirectory, "commondir")
    ).trim()
    if (!content) return null
    return path.isAbsolute(content)
      ? content
      : path.resolve(gitDirectory, content)
  } catch {
    return null
  }
}

function readBoundedUtf8File(filePath: string): string {
  const handle = fs.openSync(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(32_768)
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.byteLength, 0)
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    fs.closeSync(handle)
  }
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
