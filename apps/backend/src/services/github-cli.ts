import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HttpError } from "../errors"
import { boundedRedactedText } from "../observability/redact"
import { resolveExecutableOnPath } from "../security/executablePath"
import { runCommand, type CommandResult } from "./provider-usage/command"

/**
 * The user's GitHub CLI (`gh`), run without a shell, with an argument
 * array, a timeout and bounded output (`runCommand`). Every call names its
 * repository with `--repo`, so `gh` reads no repository config and runs
 * nothing from a workspace. Free text (a pull request body, a comment) goes
 * through a private temporary file (`--body-file`), never the command line:
 * Windows' `cmd.exe` cannot carry line breaks in an argument.
 *
 * Failures become public `HttpError`s that say what to do: install `gh`,
 * sign in with `gh auth login`, or what GitHub answered.
 */

export const GH_TIMEOUT_MS = 20_000
/** Longest a GitHub answer may take for a mutation (merge, create). */
export const GH_MUTATION_TIMEOUT_MS = 60_000

const MESSAGE_MAX_CHARS = 400

export const GH_MISSING_MESSAGE =
  "GitHub CLI (gh) isn't installed. Install it from https://cli.github.com, run `gh auth login`, then try again."
export const GH_SIGNED_OUT_MESSAGE =
  "GitHub CLI isn't signed in. Run `gh auth login` in a terminal, then try again."
export const NO_GITHUB_REMOTE_MESSAGE =
  "This repository has no GitHub remote. Add one (for example `origin`) and push the branch, then try again."

export function ghMissingError(): HttpError {
  return new HttpError(412, GH_MISSING_MESSAGE, "github_cli_missing")
}

export function noGitHubRemoteError(): HttpError {
  return new HttpError(412, NO_GITHUB_REMOTE_MESSAGE, "github_no_remote")
}

/** Absolute path of `gh`, never resolved from a workspace folder. */
export function resolveGh(): string | null {
  // Windows installs may provide a `.cmd` shim; `runCommand` wraps it.
  return resolveExecutableOnPath("gh", {
    allowScripts: process.platform === "win32",
  })
}

export type GhFailureKind =
  | "signed_out"
  | "not_found"
  | "network"
  | "rate_limited"
  | "failed"

/** What a failed `gh` run means, from what it printed. */
export function classifyGhFailure(output: string): GhFailureKind {
  const text = output.toLowerCase()
  if (
    text.includes("gh auth login") ||
    text.includes("not logged in") ||
    text.includes("authentication required") ||
    text.includes("bad credentials") ||
    text.includes("http 401") ||
    text.includes("gh_token")
  ) {
    return "signed_out"
  }
  if (text.includes("rate limit")) return "rate_limited"
  if (
    text.includes("could not resolve to a") ||
    text.includes("http 404") ||
    text.includes("not found")
  ) {
    return "not_found"
  }
  if (
    text.includes("error connecting to") ||
    text.includes("could not resolve host") ||
    text.includes("network is unreachable") ||
    text.includes("connection refused") ||
    text.includes("i/o timeout") ||
    text.includes("tls handshake")
  ) {
    return "network"
  }
  return "failed"
}

/**
 * The first meaningful lines `gh` printed, redacted and bounded: GitHub's
 * own reason ("Pull request is not mergeable"), without the usage text.
 */
export function ghFailureSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^usage:/i.test(line) &&
        !/^flags:/i.test(line) &&
        !line.startsWith("--")
    )
  const summary = lines.slice(0, 3).join(" ")
  return boundedRedactedText(summary, MESSAGE_MAX_CHARS)
}

/** The public error for a failed `gh` run. */
export function ghFailureError(result: CommandResult): HttpError {
  if (result.status === null && !result.stderr.trim()) {
    return new HttpError(
      504,
      "GitHub didn't answer in time. Check your connection and try again.",
      "github_cli_timeout"
    )
  }
  const output = `${result.stderr}\n${result.stdout}`
  switch (classifyGhFailure(output)) {
    case "signed_out":
      return new HttpError(412, GH_SIGNED_OUT_MESSAGE, "github_cli_signed_out")
    case "rate_limited":
      return new HttpError(
        429,
        "GitHub's API rate limit is used up for now. Try again in a few minutes.",
        "github_rate_limited"
      )
    case "network":
      return new HttpError(
        502,
        "Couldn't reach GitHub. Check your connection and try again.",
        "github_unreachable"
      )
    case "not_found":
      return new HttpError(
        404,
        `GitHub couldn't find it: ${ghFailureSummary(output) || "not found"}`,
        "github_not_found"
      )
    default:
      return new HttpError(
        502,
        ghFailureSummary(output) || "GitHub CLI failed.",
        "github_cli_failed"
      )
  }
}

export interface GhRunOptions {
  readonly timeoutMs?: number
  /** Byte limit for what `gh` prints; 256 KiB unless set. */
  readonly maxOutputBytes?: number
}

/**
 * Like `runGh`, but hands back a failed run instead of throwing, for callers
 * that read GitHub's answer themselves (`gh pr create` names an existing
 * pull request in its error).
 */
export async function runGhResult(
  args: readonly string[],
  options: GhRunOptions = {}
): Promise<CommandResult> {
  const gh = resolveGh()
  if (!gh) throw ghMissingError()
  return runCommand(gh, args, options.timeoutMs ?? GH_TIMEOUT_MS, {
    maxOutputBytes: options.maxOutputBytes,
    // Never inside a repository: with `--repo` gh needs none, and a local
    // checkout (the backend's own folder in development) must not be read
    // or changed, e.g. by `gh pr merge --delete-branch`.
    cwd: os.tmpdir(),
  })
}

/**
 * Runs `gh` and returns what it printed; throws the public error when `gh`
 * is missing or the command failed.
 */
export async function runGh(
  args: readonly string[],
  options: GhRunOptions = {}
): Promise<CommandResult> {
  const result = await runGhResult(args, options)
  if (result.status !== 0) throw ghFailureError(result)
  return result
}

/**
 * Writes `body` to a file only this user can read, runs `run` with its
 * path and removes it again, whatever happens.
 */
export async function withBodyFile<T>(
  body: string,
  run: (file: string) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterc0de-gh-"))
  const file = path.join(dir, "body.md")
  try {
    await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 })
    return await run(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Parses JSON that `gh --json` printed; null when it is not JSON. */
export function parseGhJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}
