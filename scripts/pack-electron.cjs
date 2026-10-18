#!/usr/bin/env node

// [PACKAGING] Orchestrates the electron-builder run with vendor/restore and
// native-module ABI bracketing so packaging never leaves the repo with broken
// workspace symlinks or Electron-built native modules in the dev install.
//
// Usage: pack-electron.cjs --win | --mac | --linux [--dir]

const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const vendorScript = path.join(__dirname, "vendor-workspace-deps.cjs");
const restoreScript = path.join(__dirname, "restore-workspace-deps.cjs");

function classifySpawnResult(result, stage, logger = console) {
  if (result.error) throw result.error;
  if (Number.isInteger(result.status)) return result.status;

  const signal = result.signal ? ` (${result.signal})` : "";
  logger.error(`[pack-electron] ${stage} terminated without an exit code${signal}`);
  return 1;
}

function createSubprocessRunner({ spawnSyncImpl = spawnSync, logger = console } = {}) {
  function run(file, runtimeArgs = [], options = {}) {
    const result = spawnSyncImpl(process.execPath, [file, ...runtimeArgs], {
      cwd: repoRoot,
      stdio: "inherit",
      ...options,
    });
    return classifySpawnResult(result, "vendor/restore script", logger);
  }

  function runCommand(command, runtimeArgs = [], options = {}) {
    const result = spawnSyncImpl(command, runtimeArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    return classifySpawnResult(result, "native-module rebuild", logger);
  }

  function runNpm(runtimeArgs) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    return runCommand(npmCmd, runtimeArgs);
  }

  function runElectronBuilder(builderArgs) {
    // Invoke the electron-builder CLI script directly under Node. This avoids
    // Windows `.cmd` shim spawning problems and is portable across platforms.
    const cliScript = require.resolve("electron-builder/out/cli/cli.js", {
      paths: [repoRoot],
    });
    const result = spawnSyncImpl(process.execPath, [cliScript, ...builderArgs], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    return classifySpawnResult(result, "electron-builder", logger);
  }

  return { run, runNpm, runElectronBuilder };
}

function main(args, runner = createSubprocessRunner()) {
  if (args.length === 0) {
    console.error("[pack-electron] target flag required: --win | --mac | --linux [--dir]");
    return 2;
  }

  const { run, runNpm, runElectronBuilder } = runner;
  let builderStatus = 1;
  try {
    builderStatus = run(vendorScript);
    if (builderStatus === 0) builderStatus = runNpm(["run", "backend:rebuild"]);
    if (builderStatus === 0) builderStatus = runElectronBuilder([
      ...args,
      // Bake the signing posture into the packaged app.json/package.json.
      // `main.cjs` used to gate the Windows update check on
      // `process.env.WIN_CSC_LINK`, which is a BUILD-time variable — at
      // runtime in an installed app it is never set, so every shipped Windows
      // build silently never checked for updates, including security fixes.
      // A runtime check needs a value that survives packaging.
      ...buildSigningMetadataArgs(),
    ]);
  } finally {
    // Vendor/rebuild can partially mutate the install before failing, too.
    const restoreStatus = restoreDevelopmentInstall(run, runNpm);
    if (builderStatus === 0) builderStatus = restoreStatus;
  }
  return builderStatus;
}

/**
 * `--config.extraMetadata.betterc0deCodeSigned=<bool>` — electron-builder
 * merges `extraMetadata` into the packaged `package.json`, so the renderer
 * process can read the build's signing posture at runtime.
 *
 * Windows is signed when a certificate was supplied; macOS is signed when a
 * Developer ID certificate was supplied (release:check refuses a certificate
 * without notarization credentials, so a signed Mac build is also notarized).
 */
function buildSigningMetadataArgs(env = process.env) {
  const hasWindowsCert = Boolean(env.WIN_CSC_LINK || env.CSC_LINK);
  const hasMacCert = Boolean(env.CSC_LINK || env.CSC_NAME);
  const signed =
    process.platform === "win32"
      ? hasWindowsCert
      : process.platform === "darwin"
        ? hasMacCert
        : true; // Linux packages are verified by the distro/AppImage channel.
  return [`--config.extraMetadata.betterc0deCodeSigned=${signed ? "true" : "false"}`];
}

function restoreDevelopmentInstall(run, runNpm) {
  let failed = false;
  try {
    const restoreStatus = run(restoreScript);
    if (restoreStatus !== 0) throw new Error(`restore step exited ${restoreStatus}`);
  } catch (error) {
    failed = true;
    console.error(`[pack-electron] workspace restore failed: ${error.message}`);
  }
  try {
    const nodeRebuildStatus = runNpm(["rebuild", "better-sqlite3"]);
    if (nodeRebuildStatus !== 0) throw new Error(`Node native-module restore exited ${nodeRebuildStatus}`);
  } catch (error) {
    failed = true;
    console.error(`[pack-electron] native restore failed: ${error.message}`);
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error("[pack-electron] unexpected error:", error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  buildSigningMetadataArgs,
  classifySpawnResult,
  createSubprocessRunner,
  main,
};
