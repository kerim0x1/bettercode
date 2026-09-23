import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  detectCodexCliAsync,
  isCodexCliAuthenticatedAsync,
} from "../cli/detect"
import { logger } from "../observability/logger"
import { resolveCodexHomeLayout } from "../provider/runtime/codex/CodexHomeLayout"
import { sanitizedChildEnvironment } from "../security/childEnvironment"
import { ensurePosixProcessGroupTerminated } from "./shell"
import { runWindowsTaskkill } from "./process-termination"

import { buildWindowsCmdArgs } from "../security/windowsCommandLine"
/**
 * Image-asset generation for coding agents, backed by the user's local
 * Codex CLI (ChatGPT login — no API key). Every run is pinned to
 * gpt-5.5 @ xhigh regardless of what model the chat session uses; Codex's
 * native `image_generation` capability (gpt-image-2) renders the PNG and
 * writes it into the workspace itself — this service never touches the
 * image bytes.
 */

export interface GenerateImageRequest {
  /** What the image should show. Forwarded verbatim to gpt-5.5. */
  readonly prompt: string
  /** Target file, relative to `workspaceDir`. Must end in `.png`. */
  readonly savePath: string
  /** Session workspace the PNG must land in (also the codex exec cwd). */
  readonly workspaceDir: string
  readonly size?: string
  readonly styleHint?: string
  /** Existing files are preserved unless the caller explicitly opts in. */
  readonly overwrite?: boolean
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type ImageGenErrorCode =
  | "codex_not_installed"
  | "codex_not_authenticated"
  | "codex_version_too_old"
  | "invalid_save_path"
  | "target_exists"
  | "generation_failed"
  | "file_not_created"
  | "timeout"

export type GenerateImageResult =
  | {
      readonly ok: true
      readonly absolutePath: string
      readonly relativePath: string
      readonly bytes: number
    }
  | {
      readonly ok: false
      readonly code: ImageGenErrorCode
      readonly message: string
    }

/** Test seam: lets unit tests point at a fake codex binary. */
export interface GenerateImageDeps {
  /**
   * Codex home of the provider instance driving this session. Resolved
   * through the same layout helper as native text generation so a shadow
   * home or a configured `homePath` is honoured; otherwise `CODEX_HOME` from
   * the backend environment applies, and finally Codex's own default.
   */
  readonly codexHome?: {
    readonly homePath?: string | null
    readonly shadowHomePath?: string | null
  }
  readonly detect?: () =>
    | {
        readonly installed: boolean
        readonly version: string | null
        readonly binaryPath: string
        readonly authenticated: boolean
      }
    | Promise<{
        readonly installed: boolean
        readonly version: string | null
        readonly binaryPath: string
        readonly authenticated: boolean
      }>
}

export const IMAGEGEN_MODEL = "gpt-5.5"
export const IMAGEGEN_REASONING_EFFORT = "xhigh"
/** First Codex release with stable image_generation (April 2026 line). */
export const IMAGEGEN_MIN_CODEX_VERSION = "0.140.0"

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_CONCURRENT_GENERATIONS = 2
const DIAGNOSTIC_TAIL_LINES = 12
const IMAGE_PROCESS_SETTLEMENT_TIMEOUT_MS = 7_000

interface ActiveImageGeneration {
  readonly id: string
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
  slotAcquired: boolean
  stagingDir: string | null
  child: ChildProcess | null
  processTreeSettled: boolean
  unsafeFailure: Error | null
  cleanup: Promise<void> | null
}

const activeImageGenerations = new Map<string, ActiveImageGeneration>()
let imageGenerationAdmissionsOpen = true
let imageGenerationShuttingDown = false
let imageGenerationRecoveryTimer: ReturnType<typeof setTimeout> | null = null

/** How often a quarantined process tree is re-checked. */
const IMAGE_GENERATION_RECOVERY_INTERVAL_MS = 5_000

export function resumeImageGenerationAdmissions(): void {
  if (activeImageGenerations.size > 0) {
    throw new Error(
      "Cannot reopen image generation while a previous process tree remains active."
    )
  }
  if (imageGenerationRecoveryTimer) {
    clearTimeout(imageGenerationRecoveryTimer)
    imageGenerationRecoveryTimer = null
  }
  imageGenerationShuttingDown = false
  imageGenerationAdmissionsOpen = true
}

export function beginImageGenerationShutdown(): void {
  imageGenerationShuttingDown = true
  imageGenerationAdmissionsOpen = false
  if (imageGenerationRecoveryTimer) {
    clearTimeout(imageGenerationRecoveryTimer)
    imageGenerationRecoveryTimer = null
  }
  for (const generation of activeImageGenerations.values()) {
    generation.controller.abort()
  }
}

function isImageGenerationQuarantined(): boolean {
  return !imageGenerationAdmissionsOpen && !imageGenerationShuttingDown
}

/**
 * Close admission because a process tree could not be confirmed terminated,
 * and start recovering. Before this existed the flag latched closed until
 * restart: one lost kill race disabled image generation for the whole
 * session. Recovery re-checks the quarantined trees periodically and reopens
 * once every one is confirmed gone. Elapsed time cannot prove settlement.
 */
function quarantineImageGeneration(
  generation: ActiveImageGeneration,
  failure: Error
): void {
  generation.unsafeFailure = failure
  imageGenerationAdmissionsOpen = false
  logger.warn(
    {
      generationId: generation.id,
      pid: generation.child?.pid ?? null,
      err: failure.message,
    },
    "image generation: process tree unconfirmed; admission closed until it is recovered"
  )
  scheduleImageGenerationRecovery()
}

function quarantinedImageGenerations(): ActiveImageGeneration[] {
  return [...activeImageGenerations.values()].filter(
    (generation) => generation.unsafeFailure && !generation.processTreeSettled
  )
}

function scheduleImageGenerationRecovery(): void {
  if (imageGenerationRecoveryTimer || imageGenerationShuttingDown) return
  imageGenerationRecoveryTimer = setTimeout(() => {
    imageGenerationRecoveryTimer = null
    void recoverImageGenerationAdmissions()
  }, IMAGE_GENERATION_RECOVERY_INTERVAL_MS)
  imageGenerationRecoveryTimer.unref?.()
}

async function recoverImageGenerationAdmissions(): Promise<void> {
  if (imageGenerationShuttingDown || imageGenerationAdmissionsOpen) return
  for (const generation of quarantinedImageGenerations()) {
    await retryQuarantinedImageGeneration(generation)
  }
  const remaining = quarantinedImageGenerations()
  if (remaining.length > 0) {
    scheduleImageGenerationRecovery()
    return
  }
  if (imageGenerationShuttingDown) return
  imageGenerationAdmissionsOpen = true
  logger.info(
    "image generation: admission reopened after process-tree recovery"
  )
}

/** Test seam: quarantine a synthetic tree whose settlement cannot be confirmed. */
export function __quarantineImageGenerationForTests(): string {
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  const generation: ActiveImageGeneration = {
    id: randomUUID(),
    controller: new AbortController(),
    settled,
    resolveSettled,
    slotAcquired: false,
    stagingDir: null,
    child: null,
    processTreeSettled: false,
    unsafeFailure: null,
    cleanup: null,
  }
  activeImageGenerations.set(generation.id, generation)
  quarantineImageGeneration(
    generation,
    new ImageProcessTreeUnsettledError(0, "synthetic quarantine")
  )
  return generation.id
}

/** Test seam: drop synthetic generations and reopen admission. */
export function __resetImageGenerationForTests(): void {
  for (const generation of activeImageGenerations.values()) {
    generation.resolveSettled()
  }
  activeImageGenerations.clear()
  resumeImageGenerationAdmissions()
}

export function activeImageGenerationCount(): number {
  return activeImageGenerations.size
}

export async function shutdownAllImageGenerations(
  timeoutMs = IMAGE_PROCESS_SETTLEMENT_TIMEOUT_MS
): Promise<number> {
  beginImageGenerationShutdown()
  const generations = [...activeImageGenerations.values()]
  if (generations.length === 0) return 0

  for (const generation of generations) {
    if (
      generation.unsafeFailure &&
      generation.child &&
      !generation.processTreeSettled
    ) {
      void retryQuarantinedImageGeneration(generation)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(
            new Error(
              `${activeImageGenerations.size} image generation process tree(s) did not settle during shutdown.`
            ),
            {
              code: "IMAGE_GENERATION_SHUTDOWN_INCOMPLETE",
              activeGenerationIds: [...activeImageGenerations.keys()],
            }
          )
        ),
      Math.max(1, timeoutMs)
    )
    timer.unref?.()
  })
  try {
    await Promise.race([
      Promise.all(generations.map((generation) => generation.settled)),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return generations.length
}

/**
 * Exact `codex exec` argv. Kept pure for unit tests — the gpt-5.5/xhigh pin
 * lives here and nowhere else. The prompt itself goes in via stdin (`-`) so
 * no user text ever needs Windows-cmd quoting.
 */
export function buildCodexExecArgs(input: {
  readonly workspaceDir: string
  readonly lastMessageFile: string
}): string[] {
  return [
    "exec",
    "-",
    "-m",
    IMAGEGEN_MODEL,
    "-c",
    `model_reasoning_effort='${IMAGEGEN_REASONING_EFFORT}'`,
    "-c",
    "approval_policy='never'",
    "-s",
    "workspace-write",
    "-C",
    input.workspaceDir,
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-o",
    input.lastMessageFile,
  ]
}

export function buildImageGenerationPrompt(input: {
  readonly prompt: string
  readonly relativePath: string
  readonly size?: string
  readonly styleHint?: string
}): string {
  const hints = [
    input.size ? `Size: ${input.size}.` : null,
    input.styleHint ? `Style: ${input.styleHint}.` : null,
  ]
    .filter(Boolean)
    .join(" ")
  return [
    "Generate one PNG image using your image_generation capability.",
    `Description: ${input.prompt}`,
    hints,
    `Save it to exactly \`${input.relativePath}\` inside the current working directory.`,
    "Create parent directories if needed. Do not modify any other files.",
    `Reply with SAVED: ${input.relativePath} when done.`,
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Resolves `savePath` against the workspace and rejects anything that
 * escapes it (same containment contract as `safeResolveInside` in
 * workspace.ts) or that isn't a `.png` target.
 */
export function resolveImageSavePath(
  workspaceDir: string,
  savePath: string
): { absolutePath: string; relativePath: string } | null {
  const trimmed = savePath.trim().replace(/^\.[\\/]/, "")
  if (
    !trimmed ||
    path.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed)
  ) {
    return null
  }
  const normalized = trimmed.replace(/[\\/]+/g, path.sep)
  if (!/\.png$/i.test(normalized)) return null
  const root = path.resolve(workspaceDir)
  const absolutePath = path.resolve(root, normalized)
  const relative = path.relative(root, absolutePath)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }
  return { absolutePath, relativePath: relative.split(path.sep).join("/") }
}

function parseVersionTuple(
  version: string | null
): [number, number, number] | null {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionAtLeast(version: string | null, minimum: string): boolean {
  const have = parseVersionTuple(version)
  const want = parseVersionTuple(minimum)
  if (!have || !want) return false
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!
  }
  return true
}

/** Same cmd.exe wrapping contract as CodexRpcClient.spawnChild (rpc.ts) —
 *  Node ≥18.20 refuses to spawn `.cmd`/extension-less npm shims directly. */

function codexChildEnvironment(
  codexHome: GenerateImageDeps["codexHome"]
): NodeJS.ProcessEnv {
  const layout = resolveCodexHomeLayout(codexHome ?? {})
  return sanitizedChildEnvironment(
    layout.runtimeHome ? { CODEX_HOME: layout.runtimeHome } : {}
  )
}

function spawnCodex(
  binaryPath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const isWindows = process.platform === "win32"
  const directExe =
    isWindows && path.isAbsolute(binaryPath) && /\.exe$/i.test(binaryPath)
  const viaCmd = isWindows && !directExe
  const spawnCommand = viaCmd
    ? process.env.ComSpec && process.env.ComSpec.length > 0
      ? process.env.ComSpec
      : "cmd.exe"
    : binaryPath
  const spawnArgs = viaCmd ? buildWindowsCmdArgs(binaryPath, args) : args
  return spawn(spawnCommand, spawnArgs, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: viaCmd,
    detached: process.platform !== "win32",
  })
}

class ImageProcessTreeUnsettledError extends Error {
  readonly code = "IMAGE_PROCESS_TREE_INCOMPLETE"

  constructor(
    readonly pid: number | null,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "ImageProcessTreeUnsettledError"
  }
}

async function terminateImageProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid == null) {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL")
      } catch (error) {
        throw new ImageProcessTreeUnsettledError(
          null,
          "Image generation process could not be terminated.",
          { cause: error }
        )
      }
    }
    return
  }

  try {
    if (process.platform === "win32") {
      // taskkill /T must be started while the root PID is still owned by this
      // ChildProcess. Once it exits, PID reuse makes a later tree kill unsafe.
      if (child.exitCode !== null) {
        throw new ImageProcessTreeUnsettledError(
          pid,
          `Image generation root process ${pid} exited before its Windows process tree could be confirmed.`
        )
      }
      await runWindowsTaskkill(pid, true)
      return
    }

    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      // ESRCH: already gone. EPERM: on macOS, the group's members have exited
      // but are not reaped yet; ensurePosixProcessGroupTerminated waits that
      // out and still fails closed on a genuine permission denial.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ESRCH" && code !== "EPERM") throw error
    }
    await ensurePosixProcessGroupTerminated(pid)
  } catch (error) {
    if (error instanceof ImageProcessTreeUnsettledError) throw error
    throw new ImageProcessTreeUnsettledError(
      pid,
      `Image generation process tree ${pid} could not be terminated safely.`,
      { cause: error }
    )
  }
}

async function confirmImageProcessTreeAfterNaturalExit(
  child: ChildProcess
): Promise<void> {
  if (process.platform === "win32" || child.pid == null) return
  try {
    await ensurePosixProcessGroupTerminated(child.pid)
  } catch (error) {
    throw new ImageProcessTreeUnsettledError(
      child.pid,
      `Image generation process group ${child.pid} survived root-process exit.`,
      { cause: error }
    )
  }
}

// Generation runs are minutes-long and each one is a full codex agent —
async function waitForImageRootOutcome(
  rootOutcome: Promise<unknown>,
  pid: number | null
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ImageProcessTreeUnsettledError(
            pid,
            `Image generation root process ${pid ?? "unknown"} did not close after tree termination.`
          )
        ),
      1_500
    )
    timer.unref?.()
  })
  try {
    await Promise.race([rootOutcome, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// cap concurrency so a UI build requesting a dozen assets doesn't fork-bomb
// the machine. FIFO so tool calls resolve in request order.
let activeGenerations = 0
const MAX_QUEUED_GENERATIONS = 32
interface QueuedGeneration {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}
const generationQueue: QueuedGeneration[] = []

async function acquireGenerationSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("image generation cancelled")
  if (activeGenerations < MAX_CONCURRENT_GENERATIONS) {
    activeGenerations += 1
    return
  }
  if (generationQueue.length >= MAX_QUEUED_GENERATIONS) {
    throw new Error("image generation queue is full")
  }
  await new Promise<void>((resolve, reject) => {
    const queued: QueuedGeneration = signal
      ? {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = generationQueue.indexOf(queued)
            if (index >= 0) generationQueue.splice(index, 1)
            reject(new Error("image generation cancelled"))
          },
        }
      : { resolve, reject }
    generationQueue.push(queued)
    if (signal && queued.onAbort) {
      signal.addEventListener("abort", queued.onAbort, { once: true })
    }
  })
}

function releaseGenerationSlot(): void {
  const next = generationQueue.shift()
  if (!next) {
    activeGenerations = Math.max(0, activeGenerations - 1)
    return
  }
  if (next.signal && next.onAbort) {
    next.signal.removeEventListener("abort", next.onAbort)
  }
  next.resolve()
}

async function settleActiveImageGeneration(
  generation: ActiveImageGeneration
): Promise<void> {
  if (generation.cleanup) return await generation.cleanup
  generation.cleanup = (async () => {
    if (generation.stagingDir) {
      await fs
        .rm(generation.stagingDir, { recursive: true, force: true })
        .catch(() => {})
      generation.stagingDir = null
    }
    if (generation.slotAcquired) {
      generation.slotAcquired = false
      releaseGenerationSlot()
    }
    if (activeImageGenerations.get(generation.id) === generation) {
      activeImageGenerations.delete(generation.id)
    }
    generation.resolveSettled()
  })()
  return await generation.cleanup
}

async function retryQuarantinedImageGeneration(
  generation: ActiveImageGeneration
): Promise<void> {
  const child = generation.child
  if (!child || generation.processTreeSettled) return
  try {
    if (
      process.platform === "win32" &&
      (child.exitCode !== null || child.signalCode !== null)
    ) {
      // The root is confirmed gone. Its Windows descendants cannot be
      // addressed without a Job Object. Keep the staging directory and slot
      // quarantined instead of claiming that elapsed time proves settlement.
      return
    }
    await terminateImageProcessTree(child)
    generation.processTreeSettled = true
    generation.unsafeFailure = null
    await settleActiveImageGeneration(generation)
  } catch (error) {
    generation.unsafeFailure =
      error instanceof Error ? error : new Error(String(error))
  }
}

function tail(lines: string[], text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    lines.push(line)
    if (lines.length > DIAGNOSTIC_TAIL_LINES) lines.shift()
  }
}

export function generateImage(
  req: GenerateImageRequest,
  deps: GenerateImageDeps = {}
): Promise<GenerateImageResult> {
  if (!imageGenerationAdmissionsOpen) {
    return Promise.resolve({
      ok: false,
      code: "generation_failed",
      message: isImageGenerationQuarantined()
        ? "Image generation is recovering from an unconfirmed process cleanup; try again shortly."
        : "Image generation is shutting down.",
    })
  }

  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  req.signal?.addEventListener("abort", onCallerAbort, { once: true })
  if (req.signal?.aborted) controller.abort()
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  const generation: ActiveImageGeneration = {
    id: randomUUID(),
    controller,
    settled,
    resolveSettled,
    slotAcquired: false,
    stagingDir: null,
    child: null,
    processTreeSettled: true,
    unsafeFailure: null,
    cleanup: null,
  }
  activeImageGenerations.set(generation.id, generation)

  const running = generateImageInternal(
    {
      ...req,
      signal: controller.signal,
    },
    deps,
    generation
  )
  return running.finally(async () => {
    req.signal?.removeEventListener("abort", onCallerAbort)
    if (generation.processTreeSettled) {
      await settleActiveImageGeneration(generation)
    }
  })
}

async function generateImageInternal(
  req: GenerateImageRequest,
  deps: GenerateImageDeps,
  generation: ActiveImageGeneration
): Promise<GenerateImageResult> {
  const resolved = resolveImageSavePath(req.workspaceDir, req.savePath)
  if (!resolved) {
    await settleActiveImageGeneration(generation)
    return {
      ok: false,
      code: "invalid_save_path",
      message: `save_path must be a relative .png path inside the workspace (got "${req.savePath}")`,
    }
  }

  const detect =
    deps.detect ??
    (() =>
      detectCodexCliAsync(null, {
        isAuthenticated: isCodexCliAuthenticatedAsync,
        authType: "cli",
      }))
  const cli = await detect()
  if (!cli.installed) {
    return {
      ok: false,
      code: "codex_not_installed",
      message:
        "Codex CLI is not installed. Image generation uses the local Codex CLI (`npm i -g @openai/codex`).",
    }
  }
  if (!versionAtLeast(cli.version, IMAGEGEN_MIN_CODEX_VERSION)) {
    return {
      ok: false,
      code: "codex_version_too_old",
      message: `Codex CLI ${cli.version ?? "unknown"} lacks image generation — need >= ${IMAGEGEN_MIN_CODEX_VERSION}. Update with \`npm i -g @openai/codex\`.`,
    }
  }
  if (!cli.authenticated) {
    return {
      ok: false,
      code: "codex_not_authenticated",
      message:
        "Codex CLI is not logged in. Run `codex login` (ChatGPT account) to enable image generation.",
    }
  }

  try {
    await acquireGenerationSlot(req.signal)
    generation.slotAcquired = true
  } catch (error) {
    await settleActiveImageGeneration(generation)
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: message.includes("cancelled") ? "timeout" : "generation_failed",
      message: message.includes("cancelled")
        ? "Image generation was cancelled."
        : "Image generation is busy; try again after another request finishes.",
    }
  }

  // Codex runs inside a throwaway staging dir, not the user's project:
  // codex exec drops session metadata (`.omx/`) into its cwd, and staging
  // means the subprocess never needs write access to the repo. Only the
  // finished PNG is moved over.
  try {
    if (req.signal?.aborted) {
      return {
        ok: false,
        code: "timeout",
        message: "Image generation was cancelled.",
      }
    }
    generation.stagingDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "betterc0de-imagegen-")
    )
    return await runCodexGeneration(
      req,
      resolved,
      cli.binaryPath,
      generation.stagingDir,
      generation,
      codexChildEnvironment(deps.codexHome)
    )
  } catch (error) {
    if (
      error instanceof ImageProcessTreeUnsettledError ||
      !generation.processTreeSettled
    ) {
      const failure = error instanceof Error ? error : new Error(String(error))
      quarantineImageGeneration(generation, failure)
      return {
        ok: false,
        code: "generation_failed",
        message: `Image generation process cleanup could not be confirmed: ${failure.message}`,
      }
    }
    throw error
  } finally {
    if (generation.processTreeSettled) {
      await settleActiveImageGeneration(generation)
    }
  }
}

const STAGING_FILE_NAME = "asset.png"
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

class ImageDestinationError extends Error {
  constructor(
    readonly code: "invalid_save_path" | "target_exists",
    message: string
  ) {
    super(message)
    this.name = "ImageDestinationError"
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

/**
 * Resolve every destination directory through the real filesystem, creating
 * missing directories one component at a time. This prevents an existing
 * symlink/junction from redirecting mkdir or the final copy outside the
 * workspace. The returned path uses the checked real parent, not the original
 * lexical path, so replacing an earlier symlink cannot retarget the write.
 */
async function resolveRealImageDestination(
  workspaceDir: string,
  relativePath: string,
  overwrite: boolean
): Promise<{ destination: string; realRoot: string }> {
  let realRoot: string
  try {
    realRoot = await fs.realpath(path.resolve(workspaceDir))
  } catch {
    throw new ImageDestinationError(
      "invalid_save_path",
      "The image workspace does not exist or cannot be resolved."
    )
  }

  const parts = relativePath.split("/").filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) {
    throw new ImageDestinationError(
      "invalid_save_path",
      "The image destination does not name a file."
    )
  }

  let realParent = realRoot
  for (const segment of parts) {
    const candidate = path.join(realParent, segment)
    await fs.mkdir(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    let resolvedDirectory: string
    try {
      resolvedDirectory = await fs.realpath(candidate)
      const stat = await fs.stat(resolvedDirectory)
      if (!stat.isDirectory()) throw new Error("not a directory")
    } catch {
      throw new ImageDestinationError(
        "invalid_save_path",
        `Image destination directory cannot be resolved: ${segment}`
      )
    }
    if (!isInside(realRoot, resolvedDirectory)) {
      throw new ImageDestinationError(
        "invalid_save_path",
        "Image destination escapes the workspace through a symlink or junction."
      )
    }
    realParent = resolvedDirectory
  }

  // Re-resolve containment immediately before selecting the final move path.
  realParent = await fs.realpath(realParent)
  if (!isInside(realRoot, realParent)) {
    throw new ImageDestinationError(
      "invalid_save_path",
      "Image destination escapes the workspace through a symlink or junction."
    )
  }
  const destination = path.join(realParent, fileName)
  const existing = await fs
    .lstat(destination)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
  if (existing?.isSymbolicLink()) {
    throw new ImageDestinationError(
      "invalid_save_path",
      "Refusing to replace an image destination symlink."
    )
  }
  if (existing && !overwrite) {
    throw new ImageDestinationError(
      "target_exists",
      "Image destination already exists; set overwrite=true to replace it."
    )
  }
  if (existing && !existing.isFile()) {
    throw new ImageDestinationError(
      "invalid_save_path",
      "Image destination exists but is not a regular file."
    )
  }
  return { destination, realRoot }
}

interface ImageFileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

function sameImageFileIdentity(
  left: ImageFileIdentity,
  right: ImageFileIdentity
): boolean {
  // Node reports `dev=0` for path-based Stats on Windows while a FileHandle
  // stat carries the volume serial. The file index (`ino`) remains stable and
  // unique on that volume, and source/destination are necessarily co-located.
  return (
    left.ino === right.ino &&
    (process.platform === "win32" || left.dev === right.dev)
  )
}

async function quarantineOwnedImageDestination(
  destination: string,
  identity: ImageFileIdentity
): Promise<void> {
  const current = await fs
    .lstat(destination, { bigint: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
  if (
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameImageFileIdentity(current, identity)
  ) {
    return
  }

  const quarantinePath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.rollback`
  )
  await fs.rename(destination, quarantinePath)
  const quarantined = await fs.lstat(quarantinePath, { bigint: true })
  if (
    !quarantined.isFile() ||
    quarantined.isSymbolicLink() ||
    !sameImageFileIdentity(quarantined, identity)
  ) {
    const destinationExists = await fs
      .lstat(destination)
      .then(() => true)
      .catch(() => false)
    if (!destinationExists) {
      await fs.rename(quarantinePath, destination).catch(() => {})
    }
    throw new Error(
      "Image destination changed while an unsafe commit was being rolled back."
    )
  }
  await fs.rm(quarantinePath, { force: false })
}

async function restoreOwnedImageBackup(
  backupPath: string,
  destination: string,
  identity: ImageFileIdentity
): Promise<void> {
  const backup = await fs.lstat(backupPath, { bigint: true })
  if (
    !backup.isFile() ||
    backup.isSymbolicLink() ||
    !sameImageFileIdentity(backup, identity)
  ) {
    throw new Error("Image overwrite backup identity changed before restore.")
  }
  const destinationExists = await fs
    .lstat(destination)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
  if (destinationExists) {
    throw new Error(
      `Image overwrite backup was preserved at ${backupPath} because the destination was recreated.`
    )
  }
  await fs.rename(backupPath, destination)
  const restored = await fs.lstat(destination, { bigint: true })
  if (
    !restored.isFile() ||
    restored.isSymbolicLink() ||
    !sameImageFileIdentity(restored, identity)
  ) {
    throw new Error("Image overwrite backup changed during restore.")
  }
}

async function moveIntoWorkspace(
  image: Buffer,
  workspaceDir: string,
  relativePath: string,
  overwrite: boolean
): Promise<string> {
  const resolved = await resolveRealImageDestination(
    workspaceDir,
    relativePath,
    overwrite
  )
  // This is deliberately the last path operation before the copy. If a
  // parent was swapped after the component walk, use its newly resolved path
  // only when it still remains inside the same real workspace root.
  const finalParent = await fs.realpath(path.dirname(resolved.destination))
  if (!isInside(resolved.realRoot, finalParent)) {
    throw new ImageDestinationError(
      "invalid_save_path",
      "Image destination changed to a path outside the workspace."
    )
  }
  const destination = path.join(
    finalParent,
    path.basename(resolved.destination)
  )
  const temporaryDestination = path.join(
    finalParent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`
  )
  let temporaryIdentity: ImageFileIdentity | null = null
  let backupPath: string | null = null
  let backupIdentity: ImageFileIdentity | null = null
  try {
    const temporaryHandle = await fs.open(temporaryDestination, "wx", 0o600)
    try {
      const temporaryState = await temporaryHandle.stat({ bigint: true })
      if (!temporaryState.isFile()) {
        throw new ImageDestinationError(
          "invalid_save_path",
          "Temporary image destination is not a regular file."
        )
      }
      temporaryIdentity = temporaryState
      await temporaryHandle.writeFile(image)
      await temporaryHandle.sync()
    } finally {
      await temporaryHandle.close()
    }

    // Re-check the concrete parent after the temporary file is created. The
    // final operation is a rename, which replaces a destination symlink as a
    // directory entry instead of following it.
    const checkedParent = await fs.realpath(path.dirname(temporaryDestination))
    if (
      checkedParent !== finalParent ||
      !isInside(resolved.realRoot, checkedParent)
    ) {
      throw new ImageDestinationError(
        "invalid_save_path",
        "Image destination changed before it could be written."
      )
    }

    const currentDestination = await fs
      .lstat(destination, { bigint: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
    if (
      currentDestination?.isSymbolicLink() ||
      (currentDestination && !currentDestination.isFile())
    ) {
      throw new ImageDestinationError(
        "invalid_save_path",
        "Refusing to replace a non-file image destination."
      )
    }
    if (currentDestination && !overwrite) {
      throw new ImageDestinationError(
        "target_exists",
        "Image destination already exists; set overwrite=true to replace it."
      )
    }
    if (currentDestination && overwrite) {
      backupPath = path.join(
        finalParent,
        `.${path.basename(destination)}.${randomUUID()}.overwrite-backup`
      )
      await fs.rename(destination, backupPath)
      const movedBackup = await fs.lstat(backupPath, { bigint: true })
      backupIdentity = movedBackup
      if (
        !movedBackup.isFile() ||
        movedBackup.isSymbolicLink() ||
        !sameImageFileIdentity(movedBackup, currentDestination)
      ) {
        throw new ImageDestinationError(
          "invalid_save_path",
          "Image destination changed while it was prepared for overwrite."
        )
      }
    }

    // Always publish with no-overwrite semantics. overwrite=true moves the
    // verified old entry aside first, so a parent swap or concurrent creator
    // can never be irreversibly clobbered by the final commit.
    await fs.link(temporaryDestination, destination)
    await fs.unlink(temporaryDestination)

    const committedState = await fs.lstat(destination, { bigint: true })
    const committedParent = await fs.realpath(path.dirname(destination))
    if (
      !temporaryIdentity ||
      !committedState.isFile() ||
      committedState.isSymbolicLink() ||
      !sameImageFileIdentity(committedState, temporaryIdentity) ||
      committedParent !== finalParent ||
      !isInside(resolved.realRoot, committedParent)
    ) {
      if (temporaryIdentity) {
        await quarantineOwnedImageDestination(destination, temporaryIdentity)
      }
      throw new ImageDestinationError(
        "invalid_save_path",
        "Image destination changed during the final commit."
      )
    }
    if (backupPath && backupIdentity) {
      await quarantineOwnedImageDestination(backupPath, backupIdentity)
      backupPath = null
      backupIdentity = null
    }
  } catch (error) {
    const cleanupFailures: unknown[] = []
    if (temporaryIdentity) {
      await quarantineOwnedImageDestination(
        destination,
        temporaryIdentity
      ).catch((cleanupError) => cleanupFailures.push(cleanupError))
    }
    if (backupPath && backupIdentity) {
      await restoreOwnedImageBackup(
        backupPath,
        destination,
        backupIdentity
      ).catch((cleanupError) => cleanupFailures.push(cleanupError))
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Image commit failed and its overwrite backup could not be fully restored."
      )
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ImageDestinationError(
        "target_exists",
        "Image destination changed before it could be written; retry the generation."
      )
    }
    throw error
  } finally {
    if (temporaryIdentity) {
      await quarantineOwnedImageDestination(
        temporaryDestination,
        temporaryIdentity
      ).catch(() => {})
    }
  }
  return destination
}

export async function readStagedPng(
  stagedFile: string
): Promise<Buffer | null> {
  const entry = await fs.lstat(stagedFile).catch(() => null)
  if (!entry || !entry.isFile() || entry.isSymbolicLink() || entry.size === 0) {
    return null
  }
  if (entry.size > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(
      `Generated image exceeds the ${MAX_GENERATED_IMAGE_BYTES}-byte limit.`
    )
  }

  const handle = await fs.open(
    stagedFile,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  )
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== entry.size) {
      throw new Error("Generated image changed while it was being validated.")
    }
    const image = await handle.readFile()
    if (
      image.length > MAX_GENERATED_IMAGE_BYTES ||
      image.length < PNG_SIGNATURE.length ||
      !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw new Error("Generated asset is not a valid PNG file.")
    }
    return image
  } finally {
    await handle.close()
  }
}

async function runCodexGeneration(
  req: GenerateImageRequest,
  resolved: { absolutePath: string; relativePath: string },
  binaryPath: string,
  stagingDir: string,
  generation: ActiveImageGeneration,
  env: NodeJS.ProcessEnv
): Promise<GenerateImageResult> {
  if (req.signal?.aborted) {
    return {
      ok: false,
      code: "timeout",
      message: "Image generation was cancelled.",
    }
  }
  const lastMessageFile = path.join(stagingDir, "last-message.txt")
  const args = buildCodexExecArgs({
    workspaceDir: stagingDir,
    lastMessageFile,
  })
  const prompt = buildImageGenerationPrompt({
    prompt: req.prompt,
    relativePath: STAGING_FILE_NAME,
    ...(req.size ? { size: req.size } : {}),
    ...(req.styleHint ? { styleHint: req.styleHint } : {}),
  })

  const child = spawnCodex(binaryPath, args, stagingDir, env)
  generation.child = child
  generation.processTreeSettled = false
  const diagnostics: string[] = []
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => tail(diagnostics, chunk))
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => tail(diagnostics, chunk))
  // A CLI may reject its options and close stdin before consuming the prompt.
  // Its close/error outcome below remains the authority for the result.
  child.stdin?.on("error", () => {})
  child.stdin?.end(prompt)

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  type RootOutcome =
    | { readonly kind: "close"; readonly code: number | null }
    | { readonly kind: "error" }
  let resolveRootOutcome!: (outcome: RootOutcome) => void
  let rootOutcomeObserved = false
  const rootOutcome = new Promise<RootOutcome>((resolve) => {
    resolveRootOutcome = (outcome) => {
      if (rootOutcomeObserved) return
      rootOutcomeObserved = true
      resolve(outcome)
    }
  })
  child.once("error", () => resolveRootOutcome({ kind: "error" }))
  child.once("close", (code) => resolveRootOutcome({ kind: "close", code }))

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const cancellation = new Promise<
    { readonly kind: "timeout" } | { readonly kind: "aborted" }
  >((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ kind: "timeout" }),
      Math.max(1, timeoutMs)
    )
    onAbort = () => resolve({ kind: "aborted" })
    req.signal?.addEventListener("abort", onAbort, { once: true })
    if (req.signal?.aborted) onAbort()
  })
  const first = await Promise.race([rootOutcome, cancellation])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (onAbort) req.signal?.removeEventListener("abort", onAbort)

  let exit:
    | { kind: "exit"; code: number | null }
    | { kind: "timeout" }
    | { kind: "aborted" }
  if (first.kind === "close") {
    await confirmImageProcessTreeAfterNaturalExit(child)
    generation.processTreeSettled = true
    exit = { kind: "exit", code: first.code }
  } else if (first.kind === "error") {
    if (child.pid != null && child.exitCode === null) {
      await terminateImageProcessTree(child)
      await waitForImageRootOutcome(rootOutcome, child.pid)
    }
    generation.processTreeSettled = true
    exit = { kind: "exit", code: null }
  } else {
    await terminateImageProcessTree(child)
    await waitForImageRootOutcome(rootOutcome, child.pid ?? null)
    generation.processTreeSettled = true
    exit = first
  }

  if (exit.kind === "timeout" || exit.kind === "aborted") {
    return {
      ok: false,
      code: "timeout",
      message:
        exit.kind === "aborted"
          ? "Image generation was cancelled."
          : `Image generation timed out after ${Math.round(timeoutMs / 1000)}s.`,
    }
  }

  const lastMessage = await fs
    .readFile(lastMessageFile, "utf8")
    .then((s) => s.trim())
    .catch(() => "")

  if (exit.code !== 0) {
    return {
      ok: false,
      code: "generation_failed",
      message:
        `codex exec exited with code ${exit.code ?? "unknown"}. ` +
        (lastMessage ||
          diagnostics.slice(-4).join(" | ") ||
          "No diagnostics captured."),
    }
  }

  const stagedFile = path.join(stagingDir, STAGING_FILE_NAME)
  let image: Buffer | null
  try {
    image = await readStagedPng(stagedFile)
  } catch (error) {
    return {
      ok: false,
      code: "generation_failed",
      message:
        error instanceof Error
          ? error.message
          : "Generated image validation failed.",
    }
  }
  if (!image) {
    return {
      ok: false,
      code: "file_not_created",
      message:
        "codex exec finished but no image was produced. " +
        (lastMessage || "No final message captured."),
    }
  }

  let destination: string
  try {
    destination = await moveIntoWorkspace(
      image,
      req.workspaceDir,
      resolved.relativePath,
      req.overwrite === true
    )
  } catch (error) {
    if (error instanceof ImageDestinationError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
  return {
    ok: true,
    absolutePath: destination,
    relativePath: resolved.relativePath,
    bytes: image.length,
  }
}
