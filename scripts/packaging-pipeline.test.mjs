import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const { createSubprocessRunner, main: packageMain, buildSigningMetadataArgs } = require("./pack-electron.cjs")
const { configureBuildCommand, normalizeOptions } = require("electron-builder/out/builder")
const { getMainFileMatchers, getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher")
const {
  getConfig: loadElectronBuilderConfig,
} = require("app-builder-lib/out/util/config/config")
const postinstall = require("./postinstall.cjs")
const root = path.resolve(import.meta.dirname, "..")

test("electron-builder files cover the shell main-process relative-require closure", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const patterns = manifest.build.files.filter(
    (entry) => typeof entry === "string" && !entry.startsWith("!")
  )
  const closure = collectRelativeRequireClosure(path.join(root, manifest.main))
    .map((file) => path.relative(root, file).replaceAll("\\", "/"))
    .filter((file) => file.startsWith("apps/shell/"))
  const missing = closure.filter(
    (file) => !patterns.some((pattern) => matchesGlob(file, pattern))
  )

  assert.deepEqual(
    missing,
    [],
    `packaged shell require closure is missing: ${missing.join(", ")}`
  )
})

test("backend runtime dependencies are roots of the packaged production graph", () => {
  const manifest = readJson("package.json")
  const backendManifest = readJson("apps/backend/package.json")
  const packagedRootDependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  const explicitlyPackaged = explicitNodeModuleDestinations(manifest.build.files)
  const missing = Object.keys(backendManifest.dependencies ?? {})
    .filter((dependency) => !dependency.startsWith("@types/"))
    .filter(
      (dependency) =>
        !packagedRootDependencies.has(dependency) &&
        !explicitlyPackaged.has(dependency)
    )

  assert.deepEqual(
    missing,
    [],
    `electron-builder cannot discover backend runtime dependencies: ${missing.join(", ")}`
  )
})

test("effective Windows files stay allowlisted after electron-builder normalization", async () => {
  const config = await loadElectronBuilderConfig(root, null, null)
  const matchers = getMainFileMatchers(
    root,
    path.join(root, ".packaging-test-app"),
    (pattern) => pattern,
    config.win,
    {
      info: {
        projectDir: root,
        buildResourcesDir: path.resolve(
          root,
          config.directories.buildResources
        ),
        isPrepackedAppAsar: false,
        config,
        debugLogger: { isEnabled: false },
      },
    },
    path.resolve(root, config.directories.output),
    false
  )

  assert.equal(
    matchers.some((matcher) => matcher.patterns.includes("**/*")),
    false,
    "a negative-only platform matcher makes electron-builder synthesize a broad **/* include"
  )

  for (const forbidden of [
    "Example/reference-fixture/package.json",
    "Another_Example/reference-fixture/package.json",
    "apps/mobile/dist/index.js",
    "apps/ui/public/index.html",
    "apps/ui/dist/sounds/mechvibes/cherrymx-black-abs/config.json",
    "apps/ui/public/sounds/mechvibes/cherrymx-black-abs/config.json",
    "apps/backend/dist/index.js.map",
    "apps/ui/dist/assets/index.js.map",
    "packages/schema/dist/index.js.map",
    "node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-linux/rg",
    "node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-win32/rg.exe",
  ]) {
    assert.equal(
      isIncludedByMatchers(matchers, forbidden),
      false,
      `Windows package unexpectedly includes ${forbidden}`
    )
  }

  for (const required of [
    "package.json",
    "apps/shell/main.cjs",
    "apps/shell/preview-request-capture.cjs",
    "apps/ui/dist/index.html",
    "apps/backend/dist/index.js",
    "packages/schema/dist/index.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-win32/rg.exe",
  ]) {
    assert.equal(
      isIncludedByMatchers(matchers, required),
      true,
      `Windows package allowlist unexpectedly excludes ${required}`
    )
  }
})

test("Linux dependency packaging keeps the glibc Claude binary and excludes musl copies", async () => {
  const config = await loadElectronBuilderConfig(root, null, null)
  const matcher = getNodeModuleFileMatcher(
    root,
    path.join(root, ".packaging-test-app"),
    (pattern) => pattern,
    config.linux,
    { config, debugLogger: { isEnabled: false } }
  )
  const filter = matcher.createFilter()
  // The official Electron Linux build uses glibc. npm installs both libc
  // variants of the SDK, adding an unused ~216 MiB binary without this filter.
  for (const prefix of ["node_modules", "apps/backend/node_modules"]) {
    for (const arch of ["x64", "arm64"]) {
      const base = `${prefix}/@anthropic-ai/claude-agent-sdk-linux-${arch}`
      for (const file of ["package.json", "claude"]) {
        assert.equal(isIncludedByMatchers([matcher], `${base}/${file}`), true)
        assert.equal(isIncludedByMatchers([matcher], `${base}-musl/${file}`), false)
      }
      assert.equal(
        filter(path.resolve(root, `${base}-musl`), { isDirectory: () => true }),
        false,
        "the unused package directory must be pruned during traversal"
      )
    }
  }
})

for (const result of [
  { status: null, signal: "SIGTERM" },
  { status: null, signal: null },
]) {
  test(`packaging subprocess stages fail on ${JSON.stringify(result)}`, () => {
    const runner = createSubprocessRunner({
      spawnSyncImpl: () => result,
      logger: silentLogger(),
    })

    assert.equal(runner.run("vendor-workspace-deps.cjs"), 1)
    assert.equal(runner.runNpm(["run", "backend:rebuild"]), 1)
    assert.equal(runner.runElectronBuilder(["--win"]), 1)
  })
}

test("postinstall fails closed when the rebuild exits non-zero", () => {
  assert.throws(
    () =>
      postinstall.main({
        env: {},
        existsSync: () => true,
        spawnSyncImpl: () => ({ status: 7, signal: null }),
        logger: silentLogger(),
        repoRoot: root,
      }),
    /npm exited 7/
  )
})

test("postinstall CLI reports a failing exit code for top-level errors", () => {
  assert.equal(
    postinstall.runCli({
      env: {},
      existsSync: () => {
        throw new Error("filesystem unavailable")
      },
      logger: silentLogger(),
      repoRoot: root,
    }),
    1
  )
})

test("postinstall fails closed when the rebuild is signal-terminated", () => {
  assert.throws(
    () =>
      postinstall.main({
        env: {},
        existsSync: () => true,
        spawnSyncImpl: () => ({ status: null, signal: "SIGTERM" }),
        logger: silentLogger(),
        repoRoot: root,
      }),
    /terminated without an exit code \(SIGTERM\)/
  )
})

test("postinstall explicit opt-out avoids the rebuild", () => {
  let spawned = false
  postinstall.main({
    env: { BETTERC0DE_SKIP_POSTINSTALL: "1" },
    existsSync: () => true,
    spawnSyncImpl: () => {
      spawned = true
      return { status: 0, signal: null }
    },
    logger: silentLogger(),
    repoRoot: root,
  })

  assert.equal(spawned, false)
})

test("postinstall does not silently opt out merely because CI is set", () => {
  assert.equal(postinstall.shouldSkip({ CI: "true" }), null)
})

function collectRelativeRequireClosure(entry) {
  const seen = new Set()

  function visit(file) {
    const absolute = path.resolve(file)
    if (seen.has(absolute)) return
    seen.add(absolute)

    const source = fs.readFileSync(absolute, "utf8")
    const relativeRequire = /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g
    for (const match of source.matchAll(relativeRequire)) {
      visit(resolveRelativeModule(path.dirname(absolute), match[1]))
    }
  }

  visit(entry)
  return [...seen].sort()
}

function resolveRelativeModule(directory, request) {
  const unresolved = path.resolve(directory, request)
  for (const candidate of [
    unresolved,
    `${unresolved}.cjs`,
    `${unresolved}.js`,
    path.join(unresolved, "index.cjs"),
    path.join(unresolved, "index.js"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  throw new Error(`Cannot resolve relative require ${request} from ${directory}`)
}

function matchesGlob(file, pattern) {
  const normalized = pattern.replaceAll("\\", "/")
  let expression = "^"
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (
      char === "*" &&
      normalized[index + 1] === "*" &&
      normalized[index + 2] === "/"
    ) {
      expression += "(?:.*/)?"
      index += 2
    } else if (char === "*" && normalized[index + 1] === "*") {
      expression += ".*"
      index += 1
    } else if (char === "*") {
      expression += "[^/]*"
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    }
  }
  return new RegExp(`${expression}$`).test(file)
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"))
}

function explicitNodeModuleDestinations(files) {
  const destinations = new Set()
  for (const entry of files) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.to !== "string" ||
      !entry.to.startsWith("node_modules/")
    ) {
      continue
    }
    const segments = entry.to.slice("node_modules/".length).split("/")
    destinations.add(
      segments[0].startsWith("@")
        ? `${segments[0]}/${segments[1]}`
        : segments[0]
    )
  }
  return destinations
}

function isIncludedByMatchers(matchers, relativePath) {
  const absolutePath = path.resolve(root, ...relativePath.split("/"))
  const fileStat = { isDirectory: () => false }
  return matchers.some((matcher) => {
    const relativeToSource = path.relative(matcher.from, absolutePath)
    if (
      relativeToSource === ".." ||
      relativeToSource.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToSource)
    ) {
      return false
    }
    return matcher.createFilter()(absolutePath, fileStat)
  })
}

function silentLogger() {
  return { log() {}, error() {} }
}

test("packaging restores workspace links even when vendoring or native rebuild fails", () => {
  for (const failure of ["vendor", "native"]) {
    const calls = []
    const runner = {
      run(file) {
        const stage = file.includes("restore-workspace") ? "restore" : "vendor"
        calls.push(stage)
        return stage === failure ? 7 : 0
      },
      runNpm(args) {
        const stage = args[0] === "run" ? "native" : "node-restore"
        calls.push(stage)
        if (stage === failure) throw new Error("rebuild unavailable")
        return 0
      },
      runElectronBuilder() { calls.push("builder"); return 0 },
    }
    if (failure === "vendor") assert.equal(packageMain(["--win"], runner), 7)
    else assert.throws(() => packageMain(["--win"], runner), /rebuild unavailable/)
    assert.ok(calls.includes("restore"), failure)
    assert.ok(calls.includes("node-restore"), failure)
    assert.equal(calls.includes("builder"), false)
  }
})

test("packaging reports failed restoration and attempts both cleanup stages", () => {
  let restoredNode = false
  const runner = {
    run(file) { if (file.includes("restore-workspace")) throw new Error("restore unavailable"); return 0 },
    runNpm(args) { if (args[0] === "rebuild") restoredNode = true; return 0 },
    runElectronBuilder() { return 0 },
  }
  assert.equal(packageMain(["--win"], runner), 1)
  assert.equal(restoredNode, true)
})

test("release builds include signing metadata and electron-builder preserves its boolean type", () => {
  // CI and releases package through release:check (the former
  // package-platform action), which must bake the signing posture in.
  const releaseCheck = fs.readFileSync(path.join(root, "scripts/release-check.mjs"), "utf8")
  assert.match(
    releaseCheck,
    /"--dir", "--publish", "never", \.\.\.buildSigningMetadataArgs\(signingEnv\(\)\)/
  )
  for (const workflow of ["ci.yml", "release.yml"]) {
    const source = fs.readFileSync(path.join(root, ".github/workflows", workflow), "utf8")
    assert.match(source, /npm run release:check -- --arch/, `${workflow} packages through release:check`)
    assert.doesNotMatch(
      source,
      /^\s*(?:-\s*)?(?:run:\s*)?(?:npx\s+)?electron-builder\s/m,
      `${workflow} must not call electron-builder around release:check`
    )
  }
  for (const env of [{}, { WIN_CSC_LINK: "test-cert", CSC_LINK: "test-cert" }]) {
    const args = buildSigningMetadataArgs(env)
    const parsed = configureBuildCommand(require("yargs/yargs")([])).parse(args)
    const normalized = normalizeOptions(parsed)
    assert.equal(typeof normalized.config.extraMetadata.betterc0deCodeSigned, "boolean")
  }
})

// Regression guard for the 0.1.0-beta.2 Windows installer crash. Through
// app-builder-lib 26.11.1 the per-user install-mode path read a fixed
// NSIS_MAX_STRLEN-sized block (16 KB, since electron-builder ships the large
// string NSIS build) out of the much smaller CoTaskMem buffer returned by
// SHGetKnownFolderPath. Whenever that allocation landed near the end of a heap
// region the over-read faulted inside $PLUGINSDIR\System.dll and killed the
// installer in .onInit, before anything was unpacked. 26.12.0 replaced it with
// a bounded lstrcpynW copy.
test("bundled NSIS per-user install mode reads the known folder path within bounds", () => {
  const template = fs.readFileSync(
    require.resolve("app-builder-lib/templates/nsis/multiUser.nsh"),
    "utf8"
  )
  assert.match(template, /SHELL32::SHGetKnownFolderPath/)
  assert.doesNotMatch(
    template,
    /\*\$\w+\(&w\$\{NSIS_MAX_STRLEN\}/,
    "app-builder-lib reintroduced the unbounded SHGetKnownFolderPath struct read"
  )
  assert.match(
    template,
    /KERNEL32::lstrcpynW/,
    "app-builder-lib dropped the bounded copy of the per-user install root"
  )
})

// Regression guard for the 0.1.0-beta.2 macOS release. An `arch` list on a
// target overrides the --x64/--arm64 build flag, so each single-arch runner
// packaged its one app under both architectures' file names and the last
// upload won: `arm64.dmg` shipped an Intel build. Targets must take the
// architecture from the command line.
test("installer targets take their architecture from the build command", () => {
  const manifest = readJson("package.json")
  for (const platform of ["mac", "win", "linux"]) {
    const targets = manifest.build[platform]?.target ?? []
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      if (typeof target === "string") continue
      assert.equal(target.arch, undefined, `${platform} target ${target.target} pins an arch list`)
      assert.doesNotMatch(String(target.target), /:/, `${platform} target ${target.target} pins an arch suffix`)
    }
  }
})

// GitHub replaces spaces in uploaded asset names, while latest.yml and the
// checksum files keep the local name; the default NSIS name has spaces.
test("installer file names contain no spaces", () => {
  const manifest = readJson("package.json")
  assert.equal(manifest.build.nsis.artifactName, "${productName}-Setup-${version}.${ext}")
  for (const platform of ["mac", "win", "linux", "nsis", "dmg"]) {
    const artifactName = manifest.build[platform]?.artifactName
    if (artifactName) assert.doesNotMatch(artifactName, /\s/, `${platform}.artifactName`)
  }
  assert.doesNotMatch(manifest.build.productName, /\s/, "productName is part of most artifact names")
})
