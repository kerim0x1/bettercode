/**
 * Correct argument quoting for the `cmd.exe /d /s /c "<line>"` +
 * `windowsVerbatimArguments: true` spawn pattern.
 *
 * Why this pattern exists at all: since the Node fix for CVE-2024-27980,
 * spawning a `.cmd`/`.bat` without a shell throws EINVAL, so every CLI we
 * launch through an npm-style shim has to go through `cmd.exe`. Node's own
 * `shell: true` re-escapes inner quotes as `\"`, which cmd does not
 * understand, so the command line has to be built by hand and passed
 * verbatim — which makes the escaping our problem.
 *
 * ── The bug this replaces ────────────────────────────────────────────────
 *
 * Eight copies of this helper existed, all doing:
 *
 *     `"${value.replace(/([()%!^"<>&|])/g, "^$1")}"`
 *
 * i.e. wrap in double quotes and caret-escape the metacharacters *inside* the
 * quotes. `^` is not an escape character inside a cmd quoted region — it is a
 * literal. So a value containing `"` produced `"abc^"def"`: the embedded quote
 * CLOSED the quoted region, and everything after it was parsed unquoted, where
 * `&`, `|` and `>` are command separators. Any call site whose arguments could
 * contain a quote plus a metacharacter was a command-injection sink, and the
 * approval/confirmation dialogs that display those arguments showed the
 * unescaped form — so what the user approved was not what ran.
 *
 * ── What this does instead ───────────────────────────────────────────────
 *
 * Two layers, applied in order:
 *
 *  1. **argv layer (MSVCRT rules)** — produce the token the *target program*
 *     will parse back into one argument: wrap in `"`, escape embedded `"` as
 *     `\"`, and double any backslash run that precedes a quote or ends the
 *     token.
 *
 *  2. **cmd layer** — make the token inert to cmd. Which form that takes
 *     depends on whether the value contains a `"`:
 *
 *     - **No `"` in the value** (paths, flags, most prompts): the argv quotes
 *       stay *real* quotes. Inside a genuine cmd quoted region every operator
 *       (`& | < > ^ ( )`) is inert, and — the reason this matters — the quotes
 *       survive a `.cmd`/`.bat` shim's `%*`. npm shims (`prettier.cmd`,
 *       `claude.cmd`, `codex.cmd`, …) re-parse their arguments when `%*` is
 *       expanded, and by then cmd has already stripped every caret, so a
 *       caret-escaped `a^&b` arrives at the batch as `a&b` and runs `b`.
 *       Only `%` cannot live inside the quotes: `%VAR%` expands even in a
 *       quoted region, and a caret is literal there. So each `%` is emitted
 *       *between* quoted regions as `^%` — MSVCRT quote-toggling glues
 *       `"50"^%" off"` back into the single argument `50% off`.
 *
 *     - **A `"` in the value**: caret-escape every cmd metacharacter in the
 *       argv token, *including the quotes layer 1 added*. Carets work outside
 *       quoted regions, and once the quotes themselves are caret-escaped there
 *       are no quoted regions left from cmd's point of view: the whole token
 *       is inert literal text. cmd strips the carets and hands the program the
 *       layer-1 token, which MSVCRT parses correctly.
 *
 * ── Why `^%` is enough (measured on Windows 11 cmd.exe 10.0.26100) ───────
 *
 * `%VAR%` expansion runs before caret removal, so a caret cannot protect a
 * `%` directly — but it does not need to. With every `%` written as `^%`,
 * each candidate variable name cmd scans (`OS^` in `^%OS^%`) ends in `^`,
 * which no defined variable ever matches, so the text is kept verbatim and
 * the carets are removed afterwards. `100^%OS^%x` reaches a direct exe *and*
 * a `.cmd` shim as `100%OS%x`; a batch's `%*` does not re-run percent
 * expansion on the substituted text. Real quotes, by contrast, do not help:
 * `"100%OS%x"` arrives as `100Windows_NTx`.
 *
 * ── Known residual limitation ────────────────────────────────────────────
 *
 * A value that contains a `"` *and* an operator or whitespace cannot be
 * delivered intact through a `.cmd`/`.bat` shim. The argv token has to carry
 * the embedded quote as `\"`, which is a real quote to cmd; when the batch
 * expands `%*`, that quote closes the region the surrounding quotes opened
 * and everything after it parses unquoted (`a"&b` runs `b`). The builder
 * therefore rejects quoted arguments unless the command is an absolute
 * `.exe`, which cannot resolve to a batch shim. A direct exe receives the
 * value intact, as the tests show. `!` is only special under delayed
 * expansion, which cmd has off by default and no npm shim enables.
 *
 * ── Hard limits no quoting can lift ──────────────────────────────────────
 *
 * - **Newlines.** cmd reads the `/c` line up to the first CR or LF and
 *   discards the rest; a quoted region does not protect it. A value that
 *   contains a newline is therefore TRUNCATED at the newline — the tail is
 *   never executed as a second command, but the program receives a cut-off
 *   argument and every argument after it is dropped. Callers that can see
 *   user-supplied values with line breaks must reject them before spawning
 *   (`buildProjectFormatterSpawn` does).
 * - **Length.** The whole `cmd.exe /d /s /c "<line>"` command line must stay
 *   under 8191 characters (cmd's own limit, below the 32767-character
 *   CreateProcess limit). Longer lines fail with "The input line is too
 *   long" or are cut silently by older shells. Quoting inflates values, so
 *   a caller that builds a line from many paths has to budget the *quoted*
 *   length and chunk or refuse — it cannot be solved here.
 *
 * `apps/shell/shared/spawn-cli.cjs` carries a verbatim copy of the three
 * exported functions below for the Electron main process;
 * `scripts/spawn-cli-quoting.test.mjs` asserts the two stay identical.
 */

import path from "node:path"

/** cmd.exe metacharacters that must be caret-escaped outside a quoted region. */
const CMD_METACHARACTERS = /([()%!^"<>&|])/g

/**
 * Characters that force quoting of an argv token: whitespace and `"` for
 * MSVCRT, plus every cmd operator and expansion character — a bare `a&b` is
 * one MSVCRT token, but a `.cmd` shim's `%*` would run it as two commands.
 */
const ARGV_NEEDS_QUOTING = /[\s"&|<>^()%!]/

/** Characters that require a `%`-free segment to sit inside real quotes. */
const SEGMENT_NEEDS_QUOTING = /[\s&|<>^()!]/

/**
 * Quote one argument for a verbatim `cmd.exe /s /c "..."` command line.
 *
 * The returned token is safe to join with spaces into the line that goes
 * inside the outer `"..."`, and survives a `.cmd`/`.bat` shim's `%*` unless
 * the value combines a `"` with an operator (see the header).
 */
export function quoteWindowsCmdArg(value: string): string {
  // Empty argument: `""` at the argv layer, both quotes caret-escaped so cmd
  // does not open a quoted region.
  if (value.length === 0) return '^"^"'
  if (!ARGV_NEEDS_QUOTING.test(value)) return value
  if (value.includes('"')) return escapeForCmd(quoteForArgv(value))
  return quoteSegmentsAroundPercent(value)
}

/**
 * Real-quote form for a value without `"`: every `%` is emitted as `^%`
 * outside the quoted regions, everything else stays inside them. MSVCRT
 * toggles quote mode at each `"` within one token, so `"a"^%"b c"` is the
 * single argument `a%b c` to the program.
 */
function quoteSegmentsAroundPercent(value: string): string {
  return value
    .split("%")
    .map((segment) => {
      if (segment.length === 0) return ""
      if (!SEGMENT_NEEDS_QUOTING.test(segment)) return segment
      return quoteForArgv(segment)
    })
    .join("^%")
}

/** MSVCRT argv quoting — what the target program's own parser expects. */
function quoteForArgv(value: string): string {
  // Double every backslash run that immediately precedes a quote, then escape
  // the quote. Also double a trailing backslash run so it does not escape the
  // closing quote we are about to add.
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")
  return `"${escaped}"`
}

/**
 * Make the token literal to cmd. Quotes are escaped too, so cmd never enters a
 * quoted region and every metacharacter stays inert.
 */
function escapeForCmd(token: string): string {
  return token.replace(CMD_METACHARACTERS, "^$1")
}

/**
 * Quote the COMMAND token — the executable path cmd itself has to resolve.
 *
 * This is deliberately different from {@link quoteWindowsCmdArg}. Arguments are
 * consumed by the target program, so they can be caret-escaped into inert
 * literal text. The command name is consumed by *cmd*, which must see real
 * quote delimiters to treat a path containing spaces as one token — a
 * caret-escaped `^"` is a literal quote character, so cmd would look for a file
 * whose name actually begins with `"` and fail with "not recognized".
 *
 * Real quoting is safe here precisely because a Windows path cannot contain
 * `"`; metacharacters inside a genuine quoted region are inert to cmd. An
 * embedded quote is rejected rather than escaped, because there is no correct
 * escape for it in this position and silently mangling an executable path is
 * worse than a clear failure.
 */
export function quoteWindowsCmdPath(command: string): string {
  if (/["\r\n\0%!]/.test(command)) {
    throw Object.assign(
      new Error(
        "Executable path must not contain a quote, control, or expansion character."
      ),
      { statusCode: 400 }
    )
  }
  return /[\s()%!^<>&|]/.test(command) ? `"${command}"` : command
}

/**
 * Build the full `["/d", "/s", "/c", "\"<line>\""]` argument vector for a
 * verbatim cmd spawn. Centralized so call sites cannot reassemble the line
 * with different escaping — the command/argument asymmetry above is easy to
 * get wrong by hand.
 */
export function buildWindowsCmdArgs(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  for (const value of [command, ...args]) {
    if (/[\r\n\0]/.test(value)) {
      throw Object.assign(
        new Error("Windows command arguments must not contain CR, LF, or NUL."),
        { statusCode: 400 }
      )
    }
  }
  const directExecutable =
    /\.exe$/i.test(command) && path.win32.isAbsolute(command)
  if (!directExecutable && args.some((value) => value.includes('"'))) {
    throw Object.assign(
      new Error(
        "Quoted arguments require an absolute executable rather than a batch shim."
      ),
      { statusCode: 400 }
    )
  }
  const line = [
    quoteWindowsCmdPath(command),
    ...args.map(quoteWindowsCmdArg),
  ].join(" ")
  return ["/d", "/s", "/c", `"${line}"`]
}

/** Absolute ComSpec, falling back to `cmd.exe` on PATH. */
export function resolveComSpec(): string {
  const comSpec = process.env.ComSpec
  return comSpec && comSpec.length > 0 ? comSpec : "cmd.exe"
}

/**
 * Whether this binary has to be launched through cmd.exe. A direct absolute
 * `.exe` never does; `.cmd`/`.bat` shims and bare names always do.
 */
export function requiresWindowsCmdWrapper(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return false
  return !(/\.exe$/i.test(binaryPath) && path.win32.isAbsolute(binaryPath))
}
