import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerConfig } from "../config";
import { sanitizedChildEnvironment } from "../security/childEnvironment";
import { buildWindowsCmdArgs } from "../security/windowsCommandLine";
import { runWindowsTaskkillDetailed } from "../services/process-termination";
export interface CliStatus {
  installed: boolean;
  version: string | null;
  binaryPath: string;
  authenticated: boolean;
  authType: string | null;
}

interface AsyncDetectOptions {
  refresh?: boolean;
  isAuthenticated?: () => boolean | Promise<boolean>;
  authType?: string;
}

interface CachedBinary {
  installed: boolean;
  version: string | null;
  binaryPath: string;
  ts: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
export const CLI_DETECTION_CACHE_MAX_ENTRIES = 128;
const CLI_VERSION_CACHE_MAX_ENTRIES = 256;
const cache = new Map<string, CachedBinary>();
const asyncCache = new Map<string, Promise<CachedBinary>>();
const asyncVersionCache = new Map<string, VersionCacheEntry>();

const VERSION_RE = /(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/i;
const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const SAFE_BARE_BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function setBoundedMapEntry<K, V>(
  target: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  target.delete(key);
  target.set(key, value);
  while (target.size > maxEntries) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    target.delete(oldest);
  }
}

function getFreshCachedBinary(key: string): CachedBinary | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts >= CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  setBoundedMapEntry(
    cache,
    key,
    hit,
    CLI_DETECTION_CACHE_MAX_ENTRIES,
  );
  return hit;
}

function getAsyncInFlight(key: string): Promise<CachedBinary> | null {
  const hit = asyncCache.get(key);
  if (!hit) return null;
  setBoundedMapEntry(
    asyncCache,
    key,
    hit,
    CLI_DETECTION_CACHE_MAX_ENTRIES,
  );
  return hit;
}

async function fnmCandidatePathsAsync(bin: string): Promise<string[]> {
  if (IS_WIN) return [];
  const roots = [
    process.env.FNM_DIR,
    process.platform === "darwin"
      ? path.join(HOME, "Library", "Application Support", "fnm")
      : null,
    path.join(HOME, ".local", "share", "fnm"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const versionsDir = path.join(root, "node-versions");
    let versions: string[] = [];
    try {
      versions = await fs.promises.readdir(versionsDir);
    } catch {
      continue;
    }
    for (const version of versions) {
      const install = path.join(versionsDir, version, "installation");
      out.push(path.join(install, "bin", bin));
      if (bin === "codex") {
        out.push(
          path.join(
            install,
            "lib",
            "node_modules",
            "@openai",
            "codex",
            "bin",
            "codex.js",
          ),
        );
      }
      if (bin === "claude") {
        out.push(
          path.join(
            install,
            "lib",
            "node_modules",
            "@anthropic-ai",
            "claude-code",
            "cli.js",
          ),
        );
      }
    }
  }
  return out;
}

function windowsKnownPathsFor(bin: string): string[] {
  const userProfile = process.env.USERPROFILE || HOME;
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");
  return [
    path.join(localAppData, "Programs", "Anthropic", "claude", `${bin}.exe`),
    path.join(localAppData, "Programs", bin, `${bin}.exe`),
    path.join(appData, "npm", `${bin}.cmd`),
    path.join(appData, "npm", `${bin}.exe`),
    path.join(userProfile, ".bun", "bin", `${bin}.exe`),
    path.join(localAppData, "pnpm", `${bin}.exe`),
    path.join(userProfile, ".volta", "bin", `${bin}.exe`),
  ];
}

async function knownPathsForAsync(bin: string): Promise<string[]> {
  if (IS_WIN) return windowsKnownPathsFor(bin);
  const fnmPaths = await fnmCandidatePathsAsync(bin);
  if (process.platform === "linux") {
    return [
      `/usr/local/bin/${bin}`,
      `/usr/bin/${bin}`,
      `/snap/bin/${bin}`,
      path.join(HOME, ".claude", "local", bin),
      path.join(HOME, ".bun", "bin", bin),
      path.join(HOME, ".local", "bin", bin),
      path.join(HOME, ".npm-global", "bin", bin),
      path.join(HOME, ".local", "share", "pnpm", bin),
      path.join(HOME, ".volta", "bin", bin),
      ...fnmPaths,
    ];
  }
  return [
    ...(bin === "codex"
      ? [path.join("/Applications", "Codex.app", "Contents", "Resources", "codex")]
      : []),
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/opt/local/bin/${bin}`,
    path.join(HOME, ".claude", "local", bin),
    path.join(HOME, ".bun", "bin", bin),
    path.join(HOME, ".local", "bin", bin),
    path.join(HOME, ".npm-global", "bin", bin),
    path.join(HOME, "Library", "pnpm", bin),
    path.join(HOME, ".volta", "bin", bin),
    ...fnmPaths,
  ];
}

async function isExecutableAsync(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(
      candidate,
      IS_WIN ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function isSafeBareBinaryName(value: string): boolean {
  return SAFE_BARE_BINARY_RE.test(value);
}

async function uniqueExecutablePathsAsync(
  values: Array<string | null | undefined>,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || !(await isExecutableAsync(value))) continue;
    const executablePath = await canonicalExecutablePathAsync(value);
    if (seen.has(executablePath)) continue;
    seen.add(executablePath);
    out.push(executablePath);
  }
  return out;
}

async function canonicalExecutablePathAsync(value: string): Promise<string> {
  try {
    const realPath = await fs.promises.realpath(value);
    return (await isExecutableAsync(realPath)) ? realPath : value;
  } catch {
    return value;
  }
}

/**
 * Persistent `--version` cache. Spawning a Node-based CLI shim on Windows
 * costs 1-3s per binary, and /cli/status probes claude + every codex
 * candidate synchronously — on a cold in-memory cache (i.e. every app
 * start) that serialized into a 5-10s stall that users saw as "Import
 * from CLI takes forever". A binary's version can only change when the
 * file itself changes, so we key on (mtime, size) and skip the spawn
 * entirely when they match. Failed reads are NOT persisted — a null can
 * be a transient 3s-timeout on a cold Node start and must not stick.
 */
interface VersionCacheEntry {
  version: string;
  mtimeMs: number;
  size: number;
}

const versionCacheFile = path.join(
  createServerConfig().dataDir,
  "cli-version-cache.json",
);
let versionCacheState: Record<string, VersionCacheEntry> | null = null;
let versionCacheLoad: Promise<Record<string, VersionCacheEntry>> | null = null;
// Writes are serialized so two concurrent probes cannot interleave partial
// files; the detector itself is async and must not block the event loop on
// the cache file (it sits on the /cli/status request path).
let versionCacheWrite: Promise<void> = Promise.resolve();

function loadVersionCache(): Promise<Record<string, VersionCacheEntry>> {
  if (versionCacheState) return Promise.resolve(versionCacheState);
  if (versionCacheLoad) return versionCacheLoad;
  versionCacheLoad = fs.promises
    .readFile(versionCacheFile, "utf8")
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, VersionCacheEntry>)
        : {};
    })
    .catch(() => ({}) as Record<string, VersionCacheEntry>)
    .then((state) => {
      versionCacheState = state;
      versionCacheLoad = null;
      return state;
    });
  return versionCacheLoad;
}

function saveVersionCache(): Promise<void> {
  const state = versionCacheState;
  if (!state) return Promise.resolve();
  versionCacheWrite = versionCacheWrite
    .then(async () => {
      // Prune entries whose binary is gone (uninstalls, temp dirs from tests)
      // so the file doesn't accumulate dead paths.
      await Promise.all(
        Object.keys(state).map(async (key) => {
          try {
            await fs.promises.access(key);
          } catch {
            delete state[key];
          }
        }),
      );
      await fs.promises.mkdir(path.dirname(versionCacheFile), { recursive: true });
      await fs.promises.writeFile(versionCacheFile, JSON.stringify(state));
    })
    .catch(() => {
      /* best-effort cache */
    });
  return versionCacheWrite;
}

export async function isClaudeCliAuthenticatedAsync(): Promise<boolean> {
  if (
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  ) {
    return true;
  }
  const claudeDir = path.join(HOME, ".claude");
  for (const name of [
    "credentials.json",
    "auth.json",
    ".credentials.json",
  ]) {
    try {
      await fs.promises.access(path.join(claudeDir, name));
      return true;
    } catch {
      // Try the next file, then the platform credential store.
    }
  }

  if (process.platform === "darwin") {
    const probe = await runProbe(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      2_000,
    );
    return probe.status === 0 && probe.stdout.trim().length > 0;
  }
  if (process.platform === "linux") {
    const probe = await runProbe(
      "secret-tool",
      ["lookup", "service", "Claude Code-credentials"],
      2_000,
    );
    return probe.status === 0 && probe.stdout.trim().length > 0;
  }
  if (process.platform === "win32") {
    const probe = await runProbe("cmdkey", ["/list"], 2_000);
    return (
      probe.status === 0 &&
      /Claude Code-credentials/i.test(probe.stdout)
    );
  }
  return false;
}

/**
 * opencode stores its `auth login` credentials in `auth.json` under its data
 * home. opencode always uses `~/.local/share/opencode/` — including on
 * Windows — unless XDG_DATA_HOME overrides it, so the legacy `~/.opencode`
 * location and OPENCODE_API_KEY are the only other accepted states.
 */
export async function isOpencodeCliAuthenticatedAsync(): Promise<boolean> {
  if (process.env.OPENCODE_API_KEY?.trim()) {
    return true;
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim()
    ? path.join(process.env.XDG_DATA_HOME.trim(), "opencode")
    : path.join(HOME, ".local", "share", "opencode");
  for (const candidate of [
    path.join(dataHome, "auth.json"),
    path.join(HOME, ".opencode", "auth.json"),
  ]) {
    try {
      await fs.promises.access(candidate);
      return true;
    } catch {
      // Try the next candidate location.
    }
  }
  return false;
}

export async function isCodexCliAuthenticatedAsync(): Promise<boolean> {
  try {
    await fs.promises.access(path.join(HOME, ".codex", "auth.json"));
    return true;
  } catch {
    // On macOS Codex may keep the credential exclusively in Keychain.
  }
  if (process.platform !== "darwin") return false;
  const probes = await Promise.all(
    ["codex-credentials", "OpenAI Codex"].map((service) =>
      runProbe(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        2_000,
      ),
    ),
  );
  return probes.some(
    (probe) => probe.status === 0 && probe.stdout.trim().length > 0,
  );
}

function versionTuple(version: string | null): [number, number, number] | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function compareVersionTuples(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    const delta = a[i]! - b[i]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function supportsCodexAppServer(version: string | null): boolean {
  const parsed = versionTuple(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major > 0 || minor >= 130;
}

export async function detectCliAsync(
  bin: string,
  opts: AsyncDetectOptions = {},
): Promise<CliStatus> {
  const cached = await resolveCachedBinaryAsync(bin, opts.refresh ?? false);
  if (!cached.installed) {
    return {
      installed: false,
      version: null,
      binaryPath: "",
      authenticated: false,
      authType: null,
    };
  }
  // Auth state is recomputed on every call — cheaper than the binary probe
  // and more volatile (user can `claude logout` without uninstalling).
  const authenticated = opts.isAuthenticated
    ? Boolean(await opts.isAuthenticated())
    : false;
  return {
    installed: true,
    version: cached.version,
    binaryPath: cached.binaryPath,
    authenticated,
    authType: authenticated ? (opts.authType ?? "cli") : null,
  };
}

export async function detectCodexCliAsync(
  preferredBinaryPath?: string | null,
  opts: AsyncDetectOptions = {},
): Promise<CliStatus> {
  const cached = await resolveCachedCodexBinaryAsync(
    preferredBinaryPath,
    opts.refresh ?? false,
  );
  if (!cached.installed) {
    return {
      installed: false,
      version: null,
      binaryPath: "",
      authenticated: false,
      authType: null,
    };
  }
  const authenticated = opts.isAuthenticated
    ? Boolean(await opts.isAuthenticated())
    : false;
  return {
    installed: true,
    version: cached.version,
    binaryPath: cached.binaryPath,
    authenticated,
    authType: authenticated ? (opts.authType ?? "cli") : null,
  };
}

async function resolveCachedBinaryAsync(
  bin: string,
  refresh: boolean,
): Promise<CachedBinary> {
  const pathLike =
    path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\");
  if (!pathLike && !isSafeBareBinaryName(bin)) {
    return {
      installed: false,
      version: null,
      binaryPath: "",
      ts: Date.now(),
    };
  }
  if (!refresh) {
    const hit = getFreshCachedBinary(bin);
    if (hit) return hit;
    const inFlight = getAsyncInFlight(bin);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    const binaryPath = pathLike
      ? await resolveConfiguredBinaryCandidateAsync(bin)
      : await resolveBinaryAsync(bin);
    const entry: CachedBinary = binaryPath
      ? {
          installed: true,
          version: await readVersionCachedAsync(binaryPath),
          binaryPath,
          ts: Date.now(),
        }
      : {
          installed: false,
          version: null,
          binaryPath: "",
          ts: Date.now(),
        };
    setBoundedMapEntry(
      cache,
      bin,
      entry,
      CLI_DETECTION_CACHE_MAX_ENTRIES,
    );
    return entry;
  })();
  setBoundedMapEntry(
    asyncCache,
    bin,
    promise,
    CLI_DETECTION_CACHE_MAX_ENTRIES,
  );
  try {
    return await promise;
  } finally {
    if (asyncCache.get(bin) === promise) asyncCache.delete(bin);
  }
}

async function resolveCachedCodexBinaryAsync(
  preferredBinaryPath: string | null | undefined,
  refresh: boolean,
): Promise<CachedBinary> {
  const preferred = preferredBinaryPath?.trim() || null;
  const cacheKey = `codex-app-server:${preferred ?? ""}`;
  if (!refresh) {
    const hit = getFreshCachedBinary(cacheKey);
    if (hit) return hit;
    const inFlight = getAsyncInFlight(cacheKey);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    const preferredCandidate = preferred
      ? await resolveConfiguredBinaryCandidateAsync(preferred)
      : null;
    const candidates = await uniqueExecutablePathsAsync([
      preferredCandidate,
      ...(await resolveBinaryCandidatesAsync("codex")),
    ]);
    const probed = await mapWithConcurrency(candidates, 4, async (binaryPath) => {
      const version = await readVersionCachedAsync(binaryPath);
      return {
        binaryPath,
        version,
        supportsAppServer: supportsCodexAppServer(version),
        versionTuple: versionTuple(version),
      };
    });
    const preferredProbe = preferredCandidate
      ? probed.find((candidate) => candidate.binaryPath === preferredCandidate)
      : null;
    const preferredIsSpecific =
      Boolean(preferred) && preferred !== "codex" && preferred !== "codex-cli";
    const selected =
      preferredIsSpecific && preferredProbe?.supportsAppServer
        ? preferredProbe
        : probed
            .filter((candidate) => candidate.supportsAppServer)
            .sort((a, b) =>
              compareVersionTuples(b.versionTuple, a.versionTuple),
            )[0] ??
          preferredProbe ??
          probed[0];
    const entry: CachedBinary = selected
      ? {
          installed: true,
          version: selected.version,
          binaryPath: selected.binaryPath,
          ts: Date.now(),
        }
      : {
          installed: false,
          version: null,
          binaryPath: "",
          ts: Date.now(),
        };
    setBoundedMapEntry(
      cache,
      cacheKey,
      entry,
      CLI_DETECTION_CACHE_MAX_ENTRIES,
    );
    return entry;
  })();
  setBoundedMapEntry(
    asyncCache,
    cacheKey,
    promise,
    CLI_DETECTION_CACHE_MAX_ENTRIES,
  );
  try {
    return await promise;
  } finally {
    if (asyncCache.get(cacheKey) === promise) asyncCache.delete(cacheKey);
  }
}

async function resolveConfiguredBinaryCandidateAsync(
  binaryPath: string,
): Promise<string | null> {
  const trimmed = binaryPath.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      await fs.promises.access(
        trimmed,
        IS_WIN ? fs.constants.F_OK : fs.constants.X_OK,
      );
      return await canonicalExecutablePathAsync(trimmed);
    } catch {
      return null;
    }
  }
  return resolveBinaryAsync(trimmed);
}

async function resolveBinaryAsync(bin: string): Promise<string | null> {
  if (!isSafeBareBinaryName(bin)) return null;
  const [pathLookup, loginShell, knownPath] = await Promise.all([
    tryPathLookupAsync(bin),
    tryLoginShellAsync(bin),
    tryKnownPathsAsync(bin),
  ]);
  return pathLookup ?? loginShell ?? knownPath;
}

async function resolveBinaryCandidatesAsync(bin: string): Promise<string[]> {
  if (!isSafeBareBinaryName(bin)) return [];
  const [pathLookup, loginShell, knownPaths] = await Promise.all([
    tryPathLookupAsync(bin),
    tryLoginShellAsync(bin),
    knownPathsForAsync(bin),
  ]);
  return await uniqueExecutablePathsAsync([
    pathLookup,
    loginShell,
    ...knownPaths,
  ]);
}

async function tryKnownPathsAsync(bin: string): Promise<string | null> {
  if (!isSafeBareBinaryName(bin)) return null;
  for (const candidate of await knownPathsForAsync(bin)) {
    if (await isExecutableAsync(candidate)) {
      return await canonicalExecutablePathAsync(candidate);
    }
  }
  return null;
}

async function tryPathLookupAsync(bin: string): Promise<string | null> {
  if (!isSafeBareBinaryName(bin)) return null;
  const result = await runProbe(IS_WIN ? "where" : "which", [bin], 2_000);
  if (result.status !== 0) return null;
  const candidate = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!candidate || !(await isExecutableAsync(candidate))) return null;
  return await canonicalExecutablePathAsync(candidate);
}

async function tryLoginShellAsync(bin: string): Promise<string | null> {
  if (IS_WIN || !isSafeBareBinaryName(bin)) return null;
  const shell = process.env.SHELL || "/bin/bash";
  const result = await runProbe(
    shell,
    ["-ilc", 'command -v -- "$1"', "betterc0de-cli-detect", bin],
    2_000,
  );
  if (result.status !== 0) return null;
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
  const candidate = candidates.at(-1);
  if (!candidate || !(await isExecutableAsync(candidate))) return null;
  return await canonicalExecutablePathAsync(candidate);
}

async function readVersionCachedAsync(binaryPath: string): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(binaryPath);
  } catch {
    return readVersionAsync(binaryPath);
  }
  const hit = asyncVersionCache.get(binaryPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    setBoundedMapEntry(
      asyncVersionCache,
      binaryPath,
      hit,
      CLI_VERSION_CACHE_MAX_ENTRIES,
    );
    return hit.version;
  }
  // Fall back to the persistent on-disk cache. Without this the in-memory cache
  // is cold on every app start, so `/cli/status` re-spawns `--version` for
  // claude + every codex candidate (1-3s each on Windows) — the "Import from
  // CLI takes forever" stall. Validated by (mtime, size) like the sync path.
  const disk = await loadVersionCache();
  const diskHit = disk[binaryPath];
  if (diskHit && diskHit.mtimeMs === stat.mtimeMs && diskHit.size === stat.size) {
    setBoundedMapEntry(
      asyncVersionCache,
      binaryPath,
      diskHit,
      CLI_VERSION_CACHE_MAX_ENTRIES,
    );
    return diskHit.version;
  }
  const version = await readVersionAsync(binaryPath);
  if (version) {
    const entry = { version, mtimeMs: stat.mtimeMs, size: stat.size };
    setBoundedMapEntry(
      asyncVersionCache,
      binaryPath,
      entry,
      CLI_VERSION_CACHE_MAX_ENTRIES,
    );
    // Persist so the next app start reads the version instead of re-spawning.
    disk[binaryPath] = entry;
    void saveVersionCache();
  }
  return version;
}

async function readVersionAsync(binaryPath: string): Promise<string | null> {
  const directExe =
    IS_WIN && path.isAbsolute(binaryPath) && /\.exe$/i.test(binaryPath);
  const viaCmd = IS_WIN && !directExe;
  const command = viaCmd
    ? process.env.ComSpec?.trim() || "cmd.exe"
    : binaryPath;
  const args = viaCmd
    ? buildWindowsCmdArgs(binaryPath, ["--version"])
    : ["--version"];
  const result = await runProbe(command, args, 3_000, viaCmd);
  const match = `${result.stdout}\n${result.stderr}`.match(VERSION_RE);
  return match?.[1] ?? null;
}

function runProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  windowsVerbatimArguments = false,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Probes run `where`, login shells and credential-store CLIs; none of
      // them may inherit the backend's provider API keys.
      child = spawn(command, [...args], {
        env: sanitizedChildEnvironment(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        detached: !IS_WIN,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ status: null, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status, stdout, stderr });
    };
    const append = (current: string, chunk: unknown) =>
      (current + String(chunk)).slice(0, 64 * 1024);
    const onStdout = (chunk: unknown) => {
      stdout = append(stdout, chunk);
    };
    const onStderr = (chunk: unknown) => {
      stderr = append(stderr, chunk);
    };
    const terminateAndFinish = () => {
      if (settled || terminating) return;
      terminating = true;
      void terminateProbeProcessTree(child).finally(() => finish(null));
    };
    const onError = () => terminateAndFinish();
    const onClose = (status: number | null) => {
      if (terminating) return;
      finish(timedOut ? null : status);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(() => {
      timedOut = true;
      terminateAndFinish();
    }, timeoutMs);
    timer.unref?.();
  });
}

async function terminateProbeProcessTree(child: ChildProcess): Promise<boolean> {
  if (hasChildExited(child)) return true;
  await signalProbeProcessTree(child, "SIGTERM");
  if (await waitForProbeChildExit(child, 250)) return true;
  await signalProbeProcessTree(child, "SIGKILL");
  return await waitForProbeChildExit(child, 2_000);
}

async function signalProbeProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (hasChildExited(child)) return;
  if (IS_WIN && child.pid) {
    const killed =
      (await runWindowsTaskkillDetailed(child.pid, signal === "SIGKILL", {
        timeoutMs: 2_000,
      })).status === "closed";
    if (killed || hasChildExited(child)) return;
    if (signal !== "SIGKILL") return;
  } else if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the state check and signal.
  }
}

function waitForProbeChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    child.once("close", onExit);
    timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs);
    timer.unref?.();
  });
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      worker,
    ),
  );
  return output;
}

export function __cliDetectionCacheStateForTests(): {
  readonly detectionEntries: number;
  readonly inFlightEntries: number;
  readonly asyncVersionEntries: number;
} {
  return {
    detectionEntries: cache.size,
    inFlightEntries: asyncCache.size,
    asyncVersionEntries: asyncVersionCache.size,
  };
}

export function __resetCliDetectionCachesForTests(): void {
  cache.clear();
  asyncCache.clear();
  asyncVersionCache.clear();
}

/** Awaits any in-flight persistent cache write. */
export function __flushCliVersionCacheForTests(): Promise<void> {
  return versionCacheWrite;
}
