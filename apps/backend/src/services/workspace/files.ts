import { createHash, randomUUID } from "node:crypto"
import fsSync, { type Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * Ensures `relative` resolves inside `cwd`. Rejects absolute paths, path-
 * traversal (`..`), and drive-letter-reroots. Throws with status 403 semantics.
 */
export function safeResolveInside(cwd: string, relative: string): string {
  const absCwd = path.resolve(cwd)
  const abs = path.resolve(absCwd, relative)
  const rel = path.relative(absCwd, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw Object.assign(new Error("path escapes project root"), {
      statusCode: 403,
    })
  }
  return abs
}

export async function resolveWorkspaceOperationPath(
  cwd: string,
  relative: string,
  options: { allowMissingTail?: boolean } = {}
): Promise<{ root: string; target: string }> {
  const root = await fs.realpath(path.resolve(cwd)).catch((cause) => {
    throw Object.assign(new Error("workspace root is unavailable", { cause }), {
      statusCode: 403,
    })
  })
  const lexicalTarget = safeResolveInside(root, relative)
  const segments = path
    .relative(root, lexicalTarget)
    .split(path.sep)
    .filter(Boolean)
  let current = root

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(current, segments[index])
    let entry: Stats
    try {
      entry = await fs.lstat(candidate)
    } catch (error) {
      if (
        options.allowMissingTail &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { root, target: path.join(current, ...segments.slice(index)) }
      }
      throw error
    }
    if (entry.isSymbolicLink()) {
      throw Object.assign(
        new Error("workspace path crosses a symbolic link or junction"),
        { statusCode: 403 }
      )
    }
    current = candidate
  }

  return { root, target: current }
}

export function assertMutableRelativePath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!normalized || normalized === ".") {
    throw Object.assign(new Error("refusing to mutate project root"), {
      statusCode: 400,
    })
  }
}

type WorkspaceMutationTestPhase =
  | "write:before-commit"
  | "move:before-commit"
  | "delete:before-quarantine"
  | "format:before-spawn"
  | "format:before-commit"

type WorkspaceMutationTestHook = (
  phase: WorkspaceMutationTestPhase,
  paths: Readonly<{ root: string; source?: string; target: string }>
) => Promise<void> | void

export let workspaceMutationTestHook: WorkspaceMutationTestHook | null = null

/** Deterministic seam for exercising path-swap races without weakening production checks. */
export function __setWorkspaceMutationTestHookForTests(
  hook: WorkspaceMutationTestHook | null
): void {
  workspaceMutationTestHook = hook
}

const workspaceMutationTails = new Map<string, Promise<void>>()

/**
 * The recovery gate outside these service calls deliberately uses shared
 * leases so editors and long-lived shells remain usable. Serialize only the
 * short filesystem commit windows here, preventing two backend mutations
 * from invalidating each other's path revalidation.
 */
export async function withSerializedWorkspaceMutation<T>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  workspaceMutationTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (workspaceMutationTails.get(key) === tail) {
      workspaceMutationTails.delete(key)
    }
  }
}

export interface WorkspacePathIdentity {
  readonly dev: number
  readonly ino: number
  readonly birthtimeMs: number
  readonly mode: number
  readonly kind: "file" | "directory" | "other"
}

export interface WorkspaceDirectoryIdentity extends WorkspacePathIdentity {
  readonly kind: "directory"
  readonly path: string
}

type WorkspaceTargetState =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly identity: WorkspacePathIdentity }

export function workspacePathIdentity(stat: Stats): WorkspacePathIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    mode: stat.mode,
    kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
  }
}

export function sameWorkspacePathIdentity(
  left: WorkspacePathIdentity,
  right: WorkspacePathIdentity
): boolean {
  if (left.kind !== right.kind) return false
  if (left.ino !== 0 || right.ino !== 0) {
    return (
      left.ino === right.ino &&
      (left.dev === 0 || right.dev === 0 || left.dev === right.dev)
    )
  }
  if (left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false
  // Some Windows filesystems report inode 0. Birth time is not a security
  // primitive, but it still detects the ordinary junction/directory swaps
  // that can be observed through Node on those volumes.
  return left.birthtimeMs === right.birthtimeMs
}

export function workspacePathChanged(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 409,
    code: "WORKSPACE_PATH_CHANGED",
  })
}

export async function captureWorkspaceTargetState(
  target: string
): Promise<WorkspaceTargetState> {
  try {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) {
      throw Object.assign(
        new Error("workspace path crosses a symbolic link or junction"),
        { statusCode: 403 }
      )
    }
    return { kind: "present", identity: workspacePathIdentity(stat) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" }
    }
    throw error
  }
}

async function assertWorkspaceTargetStateUnchanged(
  target: string,
  expected: WorkspaceTargetState
): Promise<void> {
  const current = await captureWorkspaceTargetState(target)
  if (current.kind !== expected.kind) {
    throw workspacePathChanged("workspace target changed during validation")
  }
  if (
    current.kind === "present" &&
    expected.kind === "present" &&
    !sameWorkspacePathIdentity(current.identity, expected.identity)
  ) {
    throw workspacePathChanged("workspace target changed during validation")
  }
}

export async function ensureWorkspaceDirectory(
  root: string,
  absoluteDirectory: string
): Promise<WorkspaceDirectoryIdentity> {
  if (!isPathInside(root, absoluteDirectory)) {
    throw Object.assign(new Error("path escapes project root"), {
      statusCode: 403,
    })
  }
  const relative = path.relative(root, absoluteDirectory)
  const segments = relative.split(path.sep).filter(Boolean)
  let current = root

  for (const segment of segments) {
    current = path.join(current, segment)
    let stat: Stats
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      try {
        await fs.mkdir(current)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError
        }
      }
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink()) {
      throw Object.assign(
        new Error("workspace path crosses a symbolic link or junction"),
        { statusCode: 403 }
      )
    }
    if (!stat.isDirectory()) {
      throw Object.assign(
        new Error(`workspace path component is not a directory: ${current}`),
        { statusCode: 400 }
      )
    }
    const realCurrent = await fs.realpath(current)
    if (!isPathInside(root, realCurrent)) {
      throw Object.assign(new Error("path escapes project root"), {
        statusCode: 403,
      })
    }
  }

  const stat = await fs.lstat(absoluteDirectory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw workspacePathChanged("workspace parent changed during validation")
  }
  return {
    ...workspacePathIdentity(stat),
    kind: "directory",
    path: absoluteDirectory,
  }
}

export async function assertWorkspaceDirectoryUnchanged(
  root: string,
  expected: WorkspaceDirectoryIdentity
): Promise<void> {
  const relative = path.relative(root, expected.path)
  const resolved = await resolveWorkspaceOperationPath(root, relative)
  if (resolved.target !== expected.path) {
    throw workspacePathChanged("workspace parent changed during validation")
  }
  const stat = await fs.lstat(expected.path)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !sameWorkspacePathIdentity(expected, workspacePathIdentity(stat))
  ) {
    throw workspacePathChanged("workspace parent changed during validation")
  }
}

async function canonicalWorkspaceRoot(cwd: string): Promise<string> {
  return await fs.realpath(path.resolve(cwd)).catch((cause) => {
    throw Object.assign(new Error("workspace root is unavailable", { cause }), {
      statusCode: 403,
    })
  })
}

export async function removeOwnedTemporaryPath(
  root: string,
  parent: WorkspaceDirectoryIdentity,
  temporaryPath: string,
  identity: WorkspacePathIdentity | null
): Promise<void> {
  if (!identity) return
  try {
    await assertWorkspaceDirectoryUnchanged(root, parent)
    const state = await captureWorkspaceTargetState(temporaryPath)
    if (
      state.kind === "present" &&
      sameWorkspacePathIdentity(state.identity, identity)
    ) {
      await fs.rm(temporaryPath, { recursive: true, force: false })
    }
  } catch {
    // A changed parent must never redirect cleanup into a replacement tree.
    // The unpredictable same-parent temporary path is left for recovery.
  }
}

export const NO_FOLLOW_FLAG =
  typeof fsSync.constants.O_NOFOLLOW === "number"
    ? fsSync.constants.O_NOFOLLOW
    : 0

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

export interface ReadFileInput {
  cwd: string
  relative_path?: string
}

const BINARY_PREVIEW_MAX_BYTES = 25 * 1024 * 1024

const TEXT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

/** Read and validate the same opened file, never reopen a validated pathname. */
export async function readWorkspaceFile(
  cwd: string,
  relative: string,
  maxBytes: number,
  options: { expectedCanonicalRoot?: string } = {}
): Promise<{ content: Buffer; path: string }> {
  const { root, target } = await resolveWorkspaceOperationPath(cwd, relative)
  if (
    options.expectedCanonicalRoot !== undefined &&
    root !== options.expectedCanonicalRoot
  ) {
    throw workspacePathChanged("workspace root changed before read")
  }
  const rootIdentity = workspacePathIdentity(await fs.lstat(root))
  const expected = await fs.lstat(target)
  if (!expected.isFile()) {
    throw Object.assign(new Error("not a regular file"), { statusCode: 400 })
  }
  const handle = await fs.open(
    target,
    fsSync.constants.O_RDONLY |
      NO_FOLLOW_FLAG |
      (fsSync.constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      !sameWorkspacePathIdentity(
        workspacePathIdentity(expected),
        workspacePathIdentity(opened)
      )
    ) {
      throw workspacePathChanged("workspace file changed while opening")
    }
    // Recheck every ancestor after opening, and bind the final pathname to the
    // handle identity. Subsequent replacements cannot redirect handle.read().
    const checked = await resolveWorkspaceOperationPath(root, relative)
    const current = await fs.lstat(checked.target)
    if (
      checked.root !== root ||
      checked.target !== target ||
      !sameWorkspacePathIdentity(
        rootIdentity,
        workspacePathIdentity(await fs.lstat(root))
      ) ||
      !sameWorkspacePathIdentity(
        workspacePathIdentity(opened),
        workspacePathIdentity(current)
      )
    ) {
      throw workspacePathChanged("workspace path changed while opening")
    }
    if (opened.size > maxBytes) {
      throw Object.assign(new Error("file exceeds the read size limit"), {
        statusCode: 413,
      })
    }
    // One extra byte detects growth without allowing readFile() to allocate
    // indefinitely when another process appends to the file.
    const content = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < content.length) {
      const { bytesRead } = await handle.read(
        content,
        length,
        Math.min(64 * 1024, content.length - length),
        length
      )
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length > maxBytes || after.size > maxBytes) {
      throw Object.assign(new Error("file exceeds the read size limit"), {
        statusCode: 413,
      })
    }
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw workspacePathChanged("workspace file changed during read")
    }
    return { content: content.subarray(0, length), path: target }
  } finally {
    await handle.close()
  }
}

async function readPreview(input: ReadFileInput, maxBytes: number) {
  if (!input.relative_path) {
    throw Object.assign(new Error("relative_path is required"), {
      statusCode: 400,
    })
  }
  try {
    return await readWorkspaceFile(input.cwd, input.relative_path, maxBytes)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw Object.assign(new Error("file not found"), {
        statusCode: 404,
        code,
      })
    }
    throw error
  }
}

export async function readFile(
  input: ReadFileInput
): Promise<{ content: string; path: string }> {
  const result = await readPreview(input, TEXT_PREVIEW_MAX_BYTES)
  return { content: result.content.toString("utf8"), path: result.path }
}

export async function readBinaryFile(
  input: ReadFileInput
): Promise<{ base64: string; path: string; size: number }> {
  const result = await readPreview(input, BINARY_PREVIEW_MAX_BYTES)
  return {
    base64: result.content.toString("base64"),
    path: result.path,
    size: result.content.length,
  }
}

export async function writeFile(
  cwd: string,
  relativePath: string,
  contents: string,
  options: {
    /**
     * Optional optimistic preimage binding. `null` means the target must still
     * be absent; a hash means its exact bytes must still match.
     */
    expectedContentHash?: string | null
  } = {}
): Promise<void> {
  assertMutableRelativePath(relativePath)
  const root = await canonicalWorkspaceRoot(cwd)
  await withSerializedWorkspaceMutation(root, async () => {
    const { target: unresolvedTarget } = await resolveWorkspaceOperationPath(
      root,
      relativePath,
      {
        allowMissingTail: true,
      }
    )
    const parent = await ensureWorkspaceDirectory(
      root,
      path.dirname(unresolvedTarget)
    )
    const target = path.join(parent.path, path.basename(unresolvedTarget))
    const targetState = await captureWorkspaceTargetState(target)
    await assertExpectedWorkspaceFileHash(
      target,
      targetState,
      options.expectedContentHash
    )
    const temporaryPath = path.join(
      parent.path,
      `.betterc0de-write-${process.pid}-${randomUUID()}.tmp`
    )
    let temporaryIdentity: WorkspacePathIdentity | null = null
    let committed = false

    try {
      const handle = await fs.open(
        temporaryPath,
        fsSync.constants.O_CREAT |
          fsSync.constants.O_EXCL |
          fsSync.constants.O_WRONLY |
          NO_FOLLOW_FLAG,
        targetState.kind === "present"
          ? targetState.identity.mode & 0o777
          : 0o666
      )
      try {
        // Capture ownership before fallible I/O so write/fsync failures can
        // remove the exclusive temporary file without touching a replacement.
        temporaryIdentity = workspacePathIdentity(await handle.stat())
        await handle.writeFile(contents, "utf8")
        await handle.sync()
        const stat = await handle.stat()
        if (!stat.isFile()) {
          throw workspacePathChanged(
            "temporary workspace file changed during write"
          )
        }
        temporaryIdentity = workspacePathIdentity(stat)
      } finally {
        await handle.close()
      }

      await workspaceMutationTestHook?.("write:before-commit", {
        root,
        target,
      })
      await assertWorkspaceDirectoryUnchanged(root, parent)
      await assertWorkspaceTargetStateUnchanged(target, targetState)
      await assertExpectedWorkspaceFileHash(
        target,
        targetState,
        options.expectedContentHash
      )
      await fs.rename(temporaryPath, target)
      committed = true

      const resolved = await resolveWorkspaceOperationPath(root, relativePath)
      if (resolved.target !== target) {
        throw workspacePathChanged("workspace target changed during commit")
      }
      const committedState = await captureWorkspaceTargetState(target)
      if (
        committedState.kind !== "present" ||
        committedState.identity.kind !== "file" ||
        !temporaryIdentity ||
        !sameWorkspacePathIdentity(committedState.identity, temporaryIdentity)
      ) {
        throw workspacePathChanged("workspace target changed during commit")
      }
    } finally {
      if (!committed) {
        await removeOwnedTemporaryPath(
          root,
          parent,
          temporaryPath,
          temporaryIdentity
        )
      }
    }
  })
}

async function assertExpectedWorkspaceFileHash(
  target: string,
  targetState: WorkspaceTargetState,
  expectedContentHash: string | null | undefined
): Promise<void> {
  if (expectedContentHash === undefined) return
  if (targetState.kind === "missing") {
    if (expectedContentHash === null) return
    throw workspacePathChanged("file preimage is no longer available")
  }
  if (expectedContentHash === null || targetState.identity.kind !== "file") {
    throw workspacePathChanged("file preimage no longer matches")
  }
  const bytes = await fs.readFile(target)
  const actualContentHash = createHash("sha256").update(bytes).digest("hex")
  if (actualContentHash !== expectedContentHash) {
    throw workspacePathChanged("file content changed before write commit")
  }
}

export async function createDirectory(
  cwd: string,
  relativePath: string
): Promise<void> {
  assertMutableRelativePath(relativePath)
  const root = await canonicalWorkspaceRoot(cwd)
  await withSerializedWorkspaceMutation(root, async () => {
    const target = safeResolveInside(root, relativePath)
    await ensureWorkspaceDirectory(root, target)
    await resolveWorkspaceOperationPath(root, relativePath)
  })
}

export async function movePath(
  cwd: string,
  fromRelativePath: string,
  toRelativePath: string
): Promise<void> {
  assertMutableRelativePath(fromRelativePath)
  assertMutableRelativePath(toRelativePath)
  const root = await canonicalWorkspaceRoot(cwd)
  await withSerializedWorkspaceMutation(root, async () => {
    const { target: from } = await resolveWorkspaceOperationPath(
      root,
      fromRelativePath
    )
    const sourceParent = await ensureWorkspaceDirectory(
      root,
      path.dirname(from)
    )
    const sourceState = await captureWorkspaceTargetState(from)
    if (sourceState.kind !== "present") {
      throw Object.assign(new Error(`path not found: ${from}`), {
        statusCode: 404,
        code: "ENOENT",
      })
    }

    const { target: unresolvedTo } = await resolveWorkspaceOperationPath(
      root,
      toRelativePath,
      { allowMissingTail: true }
    )
    const destinationWithinSource = path.relative(from, unresolvedTo)
    if (
      destinationWithinSource &&
      destinationWithinSource !== ".." &&
      !destinationWithinSource.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(destinationWithinSource)
    ) {
      throw Object.assign(new Error("cannot move a path into itself"), {
        statusCode: 400,
        code: "EINVAL",
      })
    }
    const targetParent = await ensureWorkspaceDirectory(
      root,
      path.dirname(unresolvedTo)
    )
    const to = path.join(targetParent.path, path.basename(unresolvedTo))
    const targetState = await captureWorkspaceTargetState(to)

    // Explorer drops never imply replacing an existing entry. Retain case-only
    // renames on Windows, where both spellings refer to the same entry.
    if (targetState.kind === "present") {
      if (from === to) return
      const sameWindowsEntry =
        process.platform === "win32" &&
        from.toLowerCase() === to.toLowerCase() &&
        sameWorkspacePathIdentity(targetState.identity, sourceState.identity)
      if (!sameWindowsEntry) {
        throw Object.assign(
          new Error("a file or folder already exists at the destination"),
          {
            statusCode: 409,
            code: "EEXIST",
          }
        )
      }
    }

    await workspaceMutationTestHook?.("move:before-commit", {
      root,
      source: from,
      target: to,
    })
    await assertWorkspaceDirectoryUnchanged(root, sourceParent)
    await assertWorkspaceDirectoryUnchanged(root, targetParent)
    await assertWorkspaceTargetStateUnchanged(from, sourceState)
    await assertWorkspaceTargetStateUnchanged(to, targetState)
    await fs.rename(from, to)

    const resolved = await resolveWorkspaceOperationPath(root, toRelativePath)
    const movedState = await captureWorkspaceTargetState(resolved.target)
    if (
      resolved.target !== to ||
      movedState.kind !== "present" ||
      !sameWorkspacePathIdentity(movedState.identity, sourceState.identity)
    ) {
      throw workspacePathChanged("workspace target changed during move")
    }
  })
}

export async function deletePath(
  cwd: string,
  relativePath: string,
  options: { recursive?: boolean } = {}
): Promise<void> {
  assertMutableRelativePath(relativePath)
  const root = await canonicalWorkspaceRoot(cwd)
  await withSerializedWorkspaceMutation(root, async () => {
    const { target } = await resolveWorkspaceOperationPath(root, relativePath)
    const parent = await ensureWorkspaceDirectory(root, path.dirname(target))
    const targetState = await captureWorkspaceTargetState(target)
    if (targetState.kind !== "present") {
      throw Object.assign(new Error(`path not found: ${target}`), {
        statusCode: 404,
        code: "ENOENT",
      })
    }
    if (
      targetState.identity.kind === "directory" &&
      options.recursive !== true
    ) {
      throw Object.assign(new Error(`path is a directory: ${target}`), {
        code: "EISDIR",
        statusCode: 400,
      })
    }

    const quarantinePath = path.join(
      parent.path,
      `.betterc0de-delete-${process.pid}-${randomUUID()}.tmp`
    )
    await workspaceMutationTestHook?.("delete:before-quarantine", {
      root,
      target,
    })
    await assertWorkspaceDirectoryUnchanged(root, parent)
    await assertWorkspaceTargetStateUnchanged(target, targetState)
    await assertWorkspaceTargetStateUnchanged(quarantinePath, {
      kind: "missing",
    })
    await fs.rename(target, quarantinePath)

    try {
      await assertWorkspaceDirectoryUnchanged(root, parent)
      const quarantinedState = await captureWorkspaceTargetState(quarantinePath)
      if (
        quarantinedState.kind !== "present" ||
        !sameWorkspacePathIdentity(
          quarantinedState.identity,
          targetState.identity
        )
      ) {
        throw workspacePathChanged(
          "workspace target changed during delete quarantine"
        )
      }
      await fs.rm(quarantinePath, {
        recursive: options.recursive === true,
        force: false,
      })
    } catch (error) {
      try {
        await assertWorkspaceDirectoryUnchanged(root, parent)
        await assertWorkspaceTargetStateUnchanged(target, { kind: "missing" })
        const quarantinedState =
          await captureWorkspaceTargetState(quarantinePath)
        if (
          quarantinedState.kind === "present" &&
          sameWorkspacePathIdentity(
            quarantinedState.identity,
            targetState.identity
          )
        ) {
          await fs.rename(quarantinePath, target)
        }
      } catch {
        // Do not follow a changed parent merely to restore a failed delete.
      }
      throw error
    }
  })
}
