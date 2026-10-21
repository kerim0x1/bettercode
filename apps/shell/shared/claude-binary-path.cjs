"use strict";

// Resolves the path to the Claude Code native binary shipped by
// `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`. Must be passed to
// `sdk.query({ options: { pathToClaudeCodeExecutable } })` because the SDK's
// own `require.resolve` returns a path INSIDE `app.asar` in the packaged
// build — Electron's asar mapping makes it readable to `fs.statSync`, but
// `child_process.spawn` bypasses asar mapping and the OS fails ENOENT trying
// to launch a binary out of a virtual archive. Resolving against
// `process.resourcesPath/app.asar.unpacked/...` returns a real on-disk path
// that the OS can actually exec.

const fs = require("fs");
const path = require("path");
const os = require("os");

// On macOS the OAuth token in Keychain is access-listed by the EXACT
// signing identity of the binary that wrote it — usually the user's
// installed `claude` CLI. The Anthropic SDK ships its own `claude`
// binary, which has a different identity and therefore can't read the
// already-stored token. Spawning the bundled binary on a machine where
// the user has logged in via `claude auth login` results in a hang at
// "Node backend ready" → `turn_started` → no output, because the
// bundled binary blocks on a Keychain prompt the renderer never sees.
//
// To fix that without forcing the user to re-login through the bundled
// binary, the resolver now prefers an installed system `claude` (which
// IS on the Keychain ACL) over the bundled SDK binary. The bundled
// binary stays as a fallback for users who never installed Claude Code
// locally — those users will see a Keychain prompt on first chat and
// can click "Always Allow".
//
// Known caveats:
//   • If the system `claude` is older than what the SDK expects, the
//     SDK protocol could mismatch. Empirically the SDK is forward- and
//     backward-compatible across a few minor versions of Claude Code,
//     so picking the user's version is the lesser evil vs. the
//     Keychain hang.
//   • `BETTERC0DE_CLAUDE_CODE_PATH` set in the env always wins — gives
//     CI / power users an explicit escape hatch.

function tryEnvOverride() {
  const override = process.env.BETTERC0DE_CLAUDE_CODE_PATH;
  if (!override) return null;
  try {
    if (fs.statSync(override).isFile()) return override;
  } catch { /* override path doesn't exist, ignore */ }
  return null;
}

// No `where`/`which` process: resolution runs on the Electron main thread
// right before the backend starts, and a synchronous spawn there froze every
// window for up to its 2 s timeout. A PATH walk is a few `stat` calls.
// Relative and empty PATH entries are skipped: `where` also searched the
// current directory, which let a `claude.exe` dropped into it win.
//
// The locations and their order match the backend's own lookup
// (apps/backend/src/provider/runtime/claude/claudeLaunch.ts,
// `knownClaudeInstallPaths`), so the binary handed over in
// BETTERC0DE_CLAUDE_CODE_PATH is the one the backend would find itself.
// On Windows a real `claude.exe` (native installer, npm's bundled binary)
// beats any `claude.cmd` shim; a shim is still accepted last, and the
// backend resolves it to the cli.js or .exe it starts.
function systemClaudeCandidates() {
  const separator = process.platform === "win32" ? ";" : ":";
  const pathDirs = String(process.env.PATH || "")
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry && path.isAbsolute(entry))
    .slice(0, 256);

  // Known macOS / Linux / Windows install locations the user's shell rc
  // files would have on PATH — covers a Finder-launched packaged app, whose
  // PATH is the minimal `/usr/bin:/bin:/usr/sbin:/sbin`.
  const home = os.homedir();
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || home;
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");
    return [
      ...pathDirs.map((dir) => path.join(dir, "claude.exe")),
      // Native installer.
      path.join(userProfile, ".local", "bin", "claude.exe"),
      path.join(localAppData, "Programs", "Anthropic", "claude", "claude.exe"),
      path.join(appData, "npm", "claude.exe"),
      path.join(userProfile, ".bun", "bin", "claude.exe"),
      // npm / pnpm command shims, only when no binary was found.
      ...pathDirs.map((dir) => path.join(dir, "claude.cmd")),
      path.join(appData, "npm", "claude.cmd"),
    ];
  }
  const candidates = pathDirs.map((dir) => path.join(dir, "claude"));
  candidates.push(
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
  );
  if (process.platform === "darwin") candidates.push("/opt/homebrew/bin/claude");
  candidates.push("/usr/local/bin/claude");
  if (process.platform === "linux") candidates.push("/usr/bin/claude");
  candidates.push(
    path.join(home, ".bun", "bin", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
  );
  return candidates;
}

function isRunnableFileSync(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isRunnableFile(candidate) {
  try {
    if (!(await fs.promises.stat(candidate)).isFile()) return false;
    if (process.platform !== "win32") await fs.promises.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function trySystemClaude() {
  return systemClaudeCandidates().find(isRunnableFileSync) ?? null;
}

async function trySystemClaudeAsync() {
  for (const candidate of systemClaudeCandidates()) {
    if (await isRunnableFile(candidate)) return candidate;
  }
  return null;
}

async function tryEnvOverrideAsync() {
  const override = process.env.BETTERC0DE_CLAUDE_CODE_PATH;
  if (!override) return null;
  try {
    if ((await fs.promises.stat(override)).isFile()) return override;
  } catch { /* override path doesn't exist, ignore */ }
  return null;
}

function tryBundledSdk() {
  const ext = process.platform === "win32" ? ".exe" : "";
  const arch = process.arch;
  const platform = process.platform;

  const pkgs = [];
  if (platform === "linux") pkgs.push(`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`);
  pkgs.push(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`);

  // Packaged: `<resourcesPath>/app.asar.unpacked/node_modules/<pkg>/claude<ext>`.
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    for (const pkg of pkgs) {
      const candidate = path.join(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        ...pkg.split("/"),
        `claude${ext}`,
      );
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not present, try next candidate */ }
    }
  }

  // Dev: `node_modules/<pkg>/claude<ext>` via Node's resolver.
  for (const pkg of pkgs) {
    try {
      return require.resolve(`${pkg}/claude${ext}`);
    } catch { /* not installed for this platform/arch — try next */ }
  }
  return null;
}

// Called again on every backend restart, so the answer is memoized — the
// binary does not move while the app is running. `resolveClaudeCodeBinaryPathAsync`
// fills the same cache off the main thread's critical path (main.cjs starts it
// before the window), so the synchronous call usually just reads the cache.
let cachedBinaryPath;
let pendingResolution = null;

function resolveClaudeCodeBinaryPath() {
  if (cachedBinaryPath === undefined) {
    cachedBinaryPath = tryEnvOverride() ?? trySystemClaude() ?? tryBundledSdk();
  }
  return cachedBinaryPath;
}

function resolveClaudeCodeBinaryPathAsync() {
  if (cachedBinaryPath !== undefined) return Promise.resolve(cachedBinaryPath);
  pendingResolution ??= (async () => {
    const resolved =
      (await tryEnvOverrideAsync()) ?? (await trySystemClaudeAsync()) ?? tryBundledSdk();
    // A synchronous call may have resolved meanwhile; keep its answer.
    if (cachedBinaryPath === undefined) cachedBinaryPath = resolved;
    return cachedBinaryPath;
  })().finally(() => {
    pendingResolution = null;
  });
  return pendingResolution;
}

/** Lets a reinstall be picked up without restarting the app. */
function clearClaudeCodeBinaryPathCache() {
  cachedBinaryPath = undefined;
}

module.exports = {
  resolveClaudeCodeBinaryPath,
  resolveClaudeCodeBinaryPathAsync,
  clearClaudeCodeBinaryPathCache,
};
