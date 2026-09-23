#!/usr/bin/env node

// Installs what release/ contains the way a user would, launches the
// installed app through the packaged startup smoke, uninstalls it, and checks
// that nothing is left behind.
//
//   Windows  NSIS .exe   silent per-user install into a temp directory →
//                        launch → silent uninstall → files, registry entries
//                        and shortcuts are gone
//   macOS    .dmg        mount → copy the .app out → architecture and
//                        signature checks → launch → delete; the auto-update
//                        .zip gets the same architecture check
//   Linux    .deb        apt install (resolves the declared dependencies) →
//                        launch with the Chromium sandbox on → apt purge →
//                        files are gone
//            .AppImage   launch the way users do; the AppImage runtime
//                        decides about the sandbox
//            .tar.gz     extract → launch
//            .rpm        install, dynamic-library check and removal in a clean
//                        Fedora container when Docker is available;
//                        package metadata only otherwise
//
// This changes the machine it runs on: registry, shortcuts, system packages.
// It refuses to run where BetterC0de is already installed, and release:check
// only enables it by default in CI, where every runner starts clean.
//
// Usage: node scripts/installer-smoke.mjs [--arch x64|arm64] [--release-dir release]

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  assertSupportedArch,
  findLinuxExecutable,
  findUninstallEntries,
  isForeignNativeBuild,
  machOArchName,
  nsisInstallArgs,
  parseLipoArchs,
  parseRegQuery,
  selectInstallers,
  single,
} from "./installer-smoke-helpers.mjs"

const root = path.resolve(import.meta.dirname, "..")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const productName = manifest.build.productName
const packageName = manifest.name
// A clean Fedora for the rpm install test. Bump with the Fedora release cycle.
const FEDORA_IMAGE = "fedora:43"

const options = parseArgs(process.argv.slice(2))
const releaseDir = path.resolve(root, options.releaseDir)
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-installer-smoke-"))

try {
  const fileNames = fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const installers = selectInstallers(fileNames, process.platform, options.arch)
  if (installers.foreign.length > 0) {
    throw new Error(
      `release/ contains installers for another architecture than ${options.arch}: ${installers.foreign.join(", ")}. ` +
        "A native runner must only package its own architecture; check the target arch configuration."
    )
  }

  if (process.platform === "win32") await smokeWindows(installers)
  else if (process.platform === "darwin") await smokeMac(installers)
  else if (process.platform === "linux") await smokeLinux(installers)
  else throw new Error(`No installer smoke for ${process.platform}`)

  log(`Installer smoke passed (${process.platform} ${options.arch}).`)
} catch (error) {
  process.stderr.write(
    `\nInstaller smoke failed: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
} finally {
  // The async rm is the one that honours maxRetries for EBUSY on Windows,
  // while the just-stopped app may still be releasing its files.
  await fs.promises.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function smokeWindows(installers) {
  const installer = path.join(releaseDir, single(installers.nsis, "NSIS installer (.exe)"))
  const existing = readUninstallEntries()
  if (existing.length > 0) {
    throw new Error(
      `${productName} is already installed on this machine (${existing.map((entry) => entry.values.DisplayName).join(", ")}). ` +
        "The NSIS installer would replace that installation, so the install test only runs on a machine without it — normally a clean CI runner."
    )
  }

  const installDir = path.join(workDir, productName)
  const { desktop, programs } = windowsShellFolders()
  const shortcuts = [
    path.join(programs, `${productName}.lnk`),
    path.join(desktop, `${productName}.lnk`),
  ]
  const preexistingShortcuts = shortcuts.filter((file) => fs.existsSync(file))
  if (preexistingShortcuts.length > 0) {
    throw new Error(`Shortcuts from an earlier installation exist: ${preexistingShortcuts.join(", ")}`)
  }

  log(`Installing ${path.basename(installer)} into ${installDir}`)
  run(installer, nsisInstallArgs(installDir), {
    windowsVerbatimArguments: true,
    timeoutMs: 10 * 60_000,
  })

  const executable = path.join(installDir, `${productName}.exe`)
  const uninstaller = path.join(installDir, `Uninstall ${productName}.exe`)
  const createdShortcuts = shortcuts.filter((file) => fs.existsSync(file))
  let uninstallEntry = null
  try {
    for (const file of [executable, uninstaller]) {
      if (!fs.existsSync(file)) throw new Error(`The installer did not create ${file}`)
    }
    uninstallEntry = single(readUninstallEntries(), `${productName} uninstall registry entry`)
    const uninstallCommand = uninstallEntry.values.QuietUninstallString ?? ""
    if (!uninstallCommand.toLowerCase().includes(installDir.toLowerCase())) {
      throw new Error(
        `The uninstall entry points somewhere else than the install directory: ${uninstallCommand}`
      )
    }
    if (!createdShortcuts.includes(shortcuts[0])) {
      throw new Error(`The installer did not create the Start menu shortcut ${shortcuts[0]}`)
    }
    log(`Installed: ${executable}; shortcuts: ${createdShortcuts.join(", ")}`)

    verifyWindowsSignatures([installer, executable, uninstaller])
    launchPackagedApp(executable)
  } finally {
    if (fs.existsSync(uninstaller)) {
      log("Uninstalling")
      // The NSIS uninstaller copies itself to %TEMP% and returns at once, so
      // completion is observed through its effects rather than its exit.
      run(uninstaller, ["/S", "/currentuser"], { timeoutMs: 5 * 60_000 })
    }
  }

  const installKey = uninstallEntry
    ? `HKCU\\Software\\${uninstallEntry.key.split("\\").at(-1)}`
    : null
  await waitFor(() => {
    const leftovers = [installDir, ...createdShortcuts].filter((file) => fs.existsSync(file))
    if (leftovers.length > 0) return `still present: ${leftovers.join(", ")}`
    if (readUninstallEntries().length > 0) return "uninstall registry entry still present"
    if (installKey && registryKeyExists(installKey)) return `${installKey} still present`
    return true
  }, "the uninstaller to remove files, shortcuts and registry entries")
  log("Uninstall left no files, shortcuts or registry entries behind.")
}

function readUninstallEntries() {
  const uninstallRoot = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
  // /d searches value data; exit status 1 means no match.
  const search = run("reg", ["query", uninstallRoot, "/s", "/f", productName, "/d"], {
    capture: true,
    allowFailure: true,
    quiet: true,
  })
  if (search.status !== 0 && search.status !== 1) {
    throw new Error(`reg query failed: ${search.stderr}`)
  }
  // The search output only lists the values that matched; read each matching
  // key in full before judging it by its DisplayName.
  const keys = [...new Set(parseRegQuery(search.stdout).map((entry) => entry.key))]
  const entries = keys.flatMap((key) =>
    parseRegQuery(run("reg", ["query", key], { capture: true, quiet: true }).stdout)
  )
  return findUninstallEntries(entries, productName)
}

function registryKeyExists(key) {
  return run("reg", ["query", key], { capture: true, allowFailure: true, quiet: true }).status === 0
}

function verifyWindowsSignatures(files) {
  // electron-builder signs with WIN_CSC_LINK, falling back to CSC_LINK.
  const certificateConfigured = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK)
  const script = files
    .map((file) => `(Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}').Status`)
    .join("; ")
  const statuses = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    capture: true,
    quiet: true,
  })
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const report = files.map((file, index) => `${path.basename(file)}: ${statuses[index] ?? "unknown"}`)
  if (statuses.length === files.length && statuses.every((status) => status === "Valid")) {
    log(`Authenticode signatures are valid (${report.join(", ")}).`)
    return
  }
  if (certificateConfigured) {
    throw new Error(`A signing certificate is configured, but the signatures are not valid: ${report.join(", ")}`)
  }
  warn(
    `This build is not Authenticode-signed (${report.join(", ")}). SmartScreen warns users and the app ` +
      "disables its update check; see docs/development/code-signing.md."
  )
}

function windowsShellFolders() {
  // Desktop can be redirected (OneDrive, roaming profiles); ask the shell.
  const script =
    "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')"
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    capture: true,
    quiet: true,
  })
  const [desktop, programs] = result.stdout.split(/\r?\n/).map((line) => line.trim())
  if (!desktop || !programs) throw new Error("Could not resolve the Desktop and Start menu folders")
  return { desktop, programs }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function smokeMac(installers) {
  const dmg = path.join(releaseDir, single(installers.dmg, `${options.arch} .dmg`))
  const zip = path.join(releaseDir, single(installers.zip, `${options.arch} auto-update .zip`))
  const mountPoint = path.join(workDir, "dmg")
  const applications = path.join(workDir, "Applications")
  const appName = `${productName}.app`
  const installedApp = path.join(applications, appName)
  fs.mkdirSync(mountPoint)
  fs.mkdirSync(applications)

  log(`Mounting ${path.basename(dmg)}`)
  run("hdiutil", ["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mountPoint, dmg])
  try {
    const mountedApp = path.join(mountPoint, appName)
    if (!fs.existsSync(mountedApp)) throw new Error(`${appName} is missing from the disk image`)
    const dropTarget = path.join(mountPoint, "Applications")
    if (!fs.lstatSync(dropTarget, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("The disk image has no Applications shortcut to drag the app onto")
    }
    // The drag-and-drop install, into a scratch Applications folder so the
    // test never touches a real /Applications copy.
    run("ditto", [mountedApp, installedApp])
  } finally {
    detachDiskImage(mountPoint)
  }

  verifyMacBundle(installedApp, "installed app")
  verifyMacSignature(installedApp)
  launchPackagedApp(path.join(installedApp, "Contents", "MacOS", productName))

  log("Removing the installed app")
  fs.rmSync(installedApp, { recursive: true, force: true })
  if (fs.existsSync(installedApp)) throw new Error(`Could not remove ${installedApp}`)

  // electron-updater installs from this archive, so it must hold the same
  // architecture the metadata advertises.
  const unzipped = path.join(workDir, "zip")
  run("ditto", ["-x", "-k", zip, unzipped])
  verifyMacBundle(path.join(unzipped, appName), "auto-update archive")
  log("Disk image install, launch and removal passed; update archive matches the architecture.")
}

function detachDiskImage(mountPoint) {
  const first = run("hdiutil", ["detach", mountPoint], { allowFailure: true })
  if (first.status !== 0) run("hdiutil", ["detach", "-force", mountPoint])
}

function verifyMacBundle(appPath, label) {
  const expected = machOArchName(options.arch)
  const executable = path.join(appPath, "Contents", "MacOS", productName)
  const archs = lipoArchs(executable)
  if (archs.length !== 1 || archs[0] !== expected) {
    throw new Error(`${label}: ${productName} is built for ${archs.join(", ") || "nothing"}, expected ${expected}`)
  }

  const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked")
  const nativeModules = walkFiles(unpacked).filter(
    (file) =>
      file.endsWith(".node") &&
      !isForeignNativeBuild(path.relative(appPath, file), "darwin", options.arch)
  )
  if (nativeModules.length === 0) {
    throw new Error(`${label}: no native modules found below ${unpacked}`)
  }
  for (const file of nativeModules) {
    const moduleArchs = lipoArchs(file)
    if (!moduleArchs.includes(expected)) {
      throw new Error(
        `${label}: native module ${path.relative(appPath, file)} is built for ${moduleArchs.join(", ")}, expected ${expected}`
      )
    }
  }
  log(`${label}: ${productName} and ${nativeModules.length} native module(s) are ${expected}.`)
}

function verifyMacSignature(appPath) {
  const certificateConfigured = Boolean(process.env.CSC_LINK)
  const notarizationConfigured = Boolean(
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
  )
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    capture: true,
    allowFailure: true,
  })
  // Apple Silicon refuses to run code without at least an ad-hoc signature,
  // so a broken signature there is a broken app, certificate or not.
  if (verify.status !== 0 && (certificateConfigured || options.arch === "arm64")) {
    throw new Error(`codesign verification failed:\n${verify.stderr.trim()}`)
  }

  const assess = run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath], {
    capture: true,
    allowFailure: true,
  })
  if (assess.status === 0) {
    log("Gatekeeper accepts the app.")
    return
  }
  if (notarizationConfigured) {
    throw new Error(`Gatekeeper rejects the notarized app:\n${assess.stderr.trim()}`)
  }
  warn(
    "Gatekeeper rejects this build because it is not signed with a Developer ID and notarized. " +
      "Users will be blocked on first launch; see docs/development/code-signing.md."
  )
}

function lipoArchs(file) {
  return parseLipoArchs(run("lipo", ["-archs", file], { capture: true, quiet: true }).stdout)
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

async function smokeLinux(installers) {
  const deb = path.join(releaseDir, single(installers.deb, `${options.arch} .deb`))
  const appImage = path.join(releaseDir, single(installers.appImage, `${options.arch} .AppImage`))
  const tarball = path.join(releaseDir, single(installers.tarGz, `${options.arch} .tar.gz`))
  const rpm = path.join(releaseDir, single(installers.rpm, `${options.arch} .rpm`))

  await smokeDeb(deb)

  log(`Launching ${path.basename(appImage)}`)
  fs.chmodSync(appImage, 0o755)
  // No FUSE on CI runners; the runtime extracts to a temp dir instead.
  // PACKAGED_SANDBOX keeps --no-sandbox off the command line: AppRun adds it
  // only when user namespaces are unavailable, exactly as for a user.
  launchPackagedApp(appImage, { sandbox: true, env: { APPIMAGE_EXTRACT_AND_RUN: "1" } })

  const extracted = path.join(workDir, "tar")
  fs.mkdirSync(extracted)
  run("tar", ["-xzf", tarball, "-C", extracted])
  const executable = single(
    walkFiles(extracted).filter((file) => path.basename(file) === packageName),
    `${packageName} executable in the tarball`
  )
  // A user-extracted chrome-sandbox is not setuid root, so the tarball needs
  // --no-sandbox on hosts that restrict user namespaces (INSTALL.md).
  launchPackagedApp(executable)

  smokeRpm(rpm)
}

async function smokeDeb(deb) {
  requirePasswordlessSudo()
  const pkg = run("dpkg-deb", ["-f", deb, "Package"], { capture: true, quiet: true }).stdout.trim()
  if (pkg !== packageName) throw new Error(`The .deb package is named ${pkg}, expected ${packageName}`)
  if (run("dpkg", ["-s", pkg], { capture: true, allowFailure: true, quiet: true }).status === 0) {
    throw new Error(`${pkg} is already installed; the install test needs a machine without it.`)
  }

  const aptEnv = { DEBIAN_FRONTEND: "noninteractive" }
  if (process.env.CI) run("sudo", ["apt-get", "update", "-qq"], { env: aptEnv })
  log(`Installing ${path.basename(deb)} with apt (declared dependencies are resolved from the archive)`)
  run("sudo", ["-E", "apt-get", "install", "-y", "--no-install-recommends", deb], { env: aptEnv })

  const desktopEntry = `/usr/share/applications/${pkg}.desktop`
  const launcher = `/usr/bin/${pkg}`
  let executable = null
  try {
    const files = run("dpkg", ["-L", pkg], { capture: true, quiet: true }).stdout
    executable = findLinuxExecutable(files, pkg)
    for (const file of [launcher, desktopEntry]) {
      if (!fs.existsSync(file)) throw new Error(`The package did not install ${file}`)
    }
    log(`Installed: ${executable}`)
    launchPackagedApp(executable, { sandbox: true })
  } finally {
    log("Purging the package")
    run("sudo", ["-E", "apt-get", "purge", "-y", pkg], { env: aptEnv })
  }

  if (run("dpkg", ["-s", pkg], { capture: true, allowFailure: true, quiet: true }).status === 0) {
    throw new Error(`${pkg} is still registered with dpkg after purge`)
  }
  const leftovers = [path.dirname(executable), launcher, desktopEntry].filter((file) =>
    fs.existsSync(file)
  )
  if (leftovers.length > 0) throw new Error(`Purge left files behind: ${leftovers.join(", ")}`)
  log(".deb install, sandboxed launch and purge passed.")
}

function smokeRpm(rpm) {
  const pkg = run("rpm", ["-qp", "--queryformat", "%{NAME}", rpm], { capture: true, quiet: true })
    .stdout.trim()
  if (pkg !== packageName) throw new Error(`The .rpm package is named ${pkg}, expected ${packageName}`)
  const executable = findLinuxExecutable(
    run("rpm", ["-qlp", rpm], { capture: true, quiet: true }).stdout,
    pkg
  )

  if (run("docker", ["version"], { capture: true, allowFailure: true, quiet: true }).status !== 0) {
    warn(`Docker is unavailable: checked ${path.basename(rpm)} metadata only, not an install.`)
    return
  }
  log(`Installing ${path.basename(rpm)} in a clean ${FEDORA_IMAGE} container`)
  const script = [
    "set -euo pipefail",
    `dnf install -y -q "/release/${path.basename(rpm)}"`,
    `test -x "${executable}"`,
    `missing="$(ldd "${executable}" | grep 'not found' || true)"`,
    'if [ -n "$missing" ]; then echo "Unresolved libraries:"; echo "$missing"; exit 1; fi',
    `dnf remove -y -q ${pkg}`,
    `test ! -e "${path.posix.dirname(executable)}"`,
  ].join("\n")
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${releaseDir}:/release:ro`,
    FEDORA_IMAGE,
    "bash",
    "-c",
    script,
  ], { timeoutMs: 15 * 60_000 })
  log(".rpm install, library resolution and removal passed.")
}

function requirePasswordlessSudo() {
  if (run("sudo", ["-n", "true"], { capture: true, allowFailure: true, quiet: true }).status !== 0) {
    throw new Error(
      "The .deb install test needs passwordless sudo. It runs on CI runners; locally, skip it (release:check does by default)."
    )
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function launchPackagedApp(executable, { sandbox = false, env = {} } = {}) {
  log(`Launching ${executable}`)
  run(process.execPath, [path.join(root, "scripts", "packaged-startup-smoke.mjs")], {
    env: {
      ...env,
      PACKAGED_EXECUTABLE: executable,
      ...(sandbox ? { PACKAGED_SANDBOX: "1" } : {}),
    },
    timeoutMs: 5 * 60_000,
  })
}

function run(command, args, { capture = false, allowFailure = false, quiet = false, env, timeoutMs = 10 * 60_000, ...spawnOptions } = {}) {
  if (!quiet) log(`$ ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    ...spawnOptions,
  })
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}` : ""
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}${detail}`)
  }
  return result
}

async function waitFor(check, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = check()
    if (last === true) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${description}: ${last}`)
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(file))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

function parseArgs(argv) {
  const parsed = { arch: process.arch, releaseDir: process.env.PACKAGE_RELEASE_DIR || "release" }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === "--arch" && value) {
      parsed.arch = value
      index += 1
    } else if (argv[index] === "--release-dir" && value) {
      parsed.releaseDir = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`)
    }
  }
  assertSupportedArch(parsed.arch)
  return parsed
}

function log(message) {
  process.stdout.write(`[installer-smoke] ${message}\n`)
}

function warn(message) {
  process.stdout.write(`[installer-smoke] WARNING: ${message}\n`)
  if (process.env.GITHUB_ACTIONS) process.stdout.write(`::warning::${message}\n`)
}
