// Pure helpers for scripts/installer-smoke.mjs. They take strings and file
// names so the parsing and selection rules are testable on any OS.

const LINUX_ARCH = {
  x64: { deb: "amd64", rpm: "x86_64" },
  arm64: { deb: "arm64", rpm: "aarch64" },
}

export function assertSupportedArch(arch) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported architecture "${arch}". Expected x64 or arm64.`)
  }
}

/**
 * Picks the installers for one platform/arch out of the file names in
 * release/. Artifacts whose name says they belong to the other architecture
 * are returned as `foreign`: a native runner must only ever produce its own
 * architecture, and 0.1.0-beta.2 shipped an Intel build under the arm64 name
 * precisely because nothing checked this.
 */
export function selectInstallers(fileNames, platform, arch) {
  assertSupportedArch(arch)
  const names = [...fileNames].sort()
  const isArm = (name) => /[-_.]arm64[-_.]|[-_.]aarch64[-_.]/i.test(name)
  const forArch = (name) => (arch === "arm64" ? isArm(name) : !isArm(name))

  if (platform === "win32") {
    const installers = names.filter(
      (name) => /\.exe$/i.test(name) && !/uninstall/i.test(name)
    )
    return {
      nsis: installers.filter(forArch),
      foreign: installers.filter((name) => !forArch(name)),
    }
  }

  if (platform === "darwin") {
    const dmgs = names.filter((name) => /\.dmg$/i.test(name))
    const zips = names.filter((name) => /-mac\.zip$/i.test(name))
    return {
      dmg: dmgs.filter(forArch),
      zip: zips.filter(forArch),
      foreign: [...dmgs, ...zips].filter((name) => !forArch(name)),
    }
  }

  if (platform === "linux") {
    const { deb, rpm } = LINUX_ARCH[arch]
    const other = LINUX_ARCH[arch === "x64" ? "arm64" : "x64"]
    const appImages = names.filter((name) => /\.AppImage$/i.test(name))
    const tarballs = names.filter((name) => /\.tar\.gz$/i.test(name))
    return {
      deb: names.filter((name) => name.endsWith(`_${deb}.deb`)),
      rpm: names.filter((name) => name.endsWith(`.${rpm}.rpm`)),
      appImage: appImages.filter(forArch),
      tarGz: tarballs.filter(forArch),
      foreign: [
        ...names.filter(
          (name) =>
            name.endsWith(`_${other.deb}.deb`) || name.endsWith(`.${other.rpm}.rpm`)
        ),
        ...appImages.filter((name) => !forArch(name)),
        ...tarballs.filter((name) => !forArch(name)),
      ],
    }
  }

  throw new Error(`Unsupported platform "${platform}"`)
}

/** Exactly one match, or an error naming what was found. */
export function single(matches, description) {
  if (matches.length === 1) return matches[0]
  const found = matches.length === 0 ? "none" : matches.join(", ")
  throw new Error(`Expected exactly one ${description}, found ${found}.`)
}

/** `lipo -archs` prints space-separated Mach-O architecture names. */
export function parseLipoArchs(output) {
  return String(output ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * node-pty ships prebuilt binaries for every platform (prebuilds/<os>-<arch>/)
 * and electron-rebuild writes bin/<os>-<arch>-<abi>/. Only the ones for the
 * target load at runtime; the rest are inert passengers and not evidence of
 * a wrong-architecture build.
 */
export function isForeignNativeBuild(relativePath, platform, arch) {
  const match = relativePath
    .replaceAll("\\", "/")
    .match(/\/(?:prebuilds|bin)\/(darwin|linux|win32|freebsd|android)-([a-z0-9+]+?)(?:-\d+)?\//i)
  if (!match) return false
  const [, targetPlatform, targetArchs] = match
  return targetPlatform !== platform || !targetArchs.split("+").includes(arch)
}

export function machOArchName(arch) {
  assertSupportedArch(arch)
  return arch === "x64" ? "x86_64" : "arm64"
}

/**
 * Parses `reg query <key> /s` output into entries of { key, values }.
 * Value lines are indented by four spaces and separated by runs of four or
 * more spaces: `    DisplayName    REG_SZ    BetterC0de 0.1.0`.
 */
export function parseRegQuery(output) {
  const entries = []
  let current = null
  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    if (/^HKEY_/i.test(rawLine)) {
      current = { key: rawLine.trim(), values: {} }
      entries.push(current)
      continue
    }
    if (!current || !/^ {4}\S/.test(rawLine)) continue
    const [name, type, ...rest] = rawLine.trim().split(/ {4,}/)
    if (!name || !type?.startsWith("REG_")) continue
    current.values[name] = rest.join("    ")
  }
  return entries
}

/** Uninstall entries whose display name is the product, with or without version. */
export function findUninstallEntries(entries, productName) {
  return entries.filter((entry) => {
    const displayName = entry.values.DisplayName ?? ""
    return displayName === productName || displayName.startsWith(`${productName} `)
  })
}

/**
 * NSIS reads /D= verbatim to the end of the command line, so it must come
 * last and must not be quoted, even when the path contains spaces.
 */
export function nsisInstallArgs(installDir) {
  if (/["\r\n]/.test(installDir)) {
    throw new Error(`Install directory cannot be passed to NSIS: ${installDir}`)
  }
  return ["/S", "/currentuser", `/D=${installDir}`]
}

export function samePath(left, right, platform = process.platform) {
  const normalize = (value) => {
    const unified = String(value ?? "")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
    return platform === "win32" ? unified.toLowerCase() : unified
  }
  return normalize(left) === normalize(right)
}

/**
 * The installed Linux binary from `dpkg -L` / `rpm -qlp` output: the file
 * named after the package directly below /opt/<product>/.
 */
export function findLinuxExecutable(fileList, packageName) {
  const matches = String(fileList ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/opt/"))
    .filter((line) => {
      const parts = line.split("/")
      return parts.length === 4 && parts[3] === packageName
    })
  return single(matches, `/opt/<product>/${packageName} executable in the package`)
}
