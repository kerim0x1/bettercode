import test from "node:test"
import assert from "node:assert/strict"
import {
  findPackagedExecutableFiles,
  parseDevToolsWebSocketUrl,
  removeDirectoryWithRetries,
  selectRendererTarget,
  taskkillOutcome,
  validateRendererSnapshot,
} from "./packaged-smoke-helpers.mjs"

test("Linux smoke selects the executable, not adjacent licenses or Chromium helpers", async () => {
  const root = "/release/linux-unpacked/"
  const modes = {
    betterc0de: 0o755,
    LICENSE: 0o644,
    "LICENSES.chromium.html": 0o644,
    version: 0o644,
    "chrome-sandbox": 0o4755,
    chrome_crashpad_handler: 0o755,
    "libEGL.so": 0o755,
    "libvk_swiftshader.so": 0o755,
    "resources.pak": 0o644,
    "resources/app.asar.unpacked/claude": 0o755,
  }
  const files = Object.keys(modes).map((name) => root + name)
  const readStat = async (file) => ({ mode: modes[file.slice(root.length)] })
  assert.deepEqual(await findPackagedExecutableFiles(files, "linux", readStat), [root + "betterc0de"])
  modes.betterc0de = 0o644
  assert.deepEqual(await findPackagedExecutableFiles(files, "linux", readStat), [])
})

test("package discovery retains multiple architectures for the ambiguity check", async () => {
  const files = ["/release/linux-unpacked/betterc0de", "/release/linux-arm64-unpacked/betterc0de"]
  assert.deepEqual(await findPackagedExecutableFiles(files, "linux", async () => ({ mode: 0o755 })), files)
})

test("Windows and macOS package discovery selects only the main executable", async () => {
  assert.deepEqual(await findPackagedExecutableFiles([
    "C:\\release\\win-unpacked\\BetterC0de.exe",
    "C:\\release\\win-unpacked\\elevate.exe",
    "C:\\release\\win-unpacked\\resources\\claude.exe",
  ], "win32"), ["C:\\release\\win-unpacked\\BetterC0de.exe"])
  const binary = "/release/mac-arm64/BetterC0de.app/Contents/MacOS/BetterC0de"
  assert.deepEqual(await findPackagedExecutableFiles([
    binary,
    "/release/mac-arm64/BetterC0de.app/Contents/Resources/app.asar",
    "/release/mac-arm64/BetterC0de.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
  ], "darwin"), [binary])
})

test("extracts the Chromium DevTools browser endpoint from diagnostics", () => {
  assert.equal(
    parseDevToolsWebSocketUrl(
      "noise\nDevTools listening on ws://127.0.0.1:43123/devtools/browser/abc-def\n"
    ),
    "ws://127.0.0.1:43123/devtools/browser/abc-def"
  )
})

test("selects a real renderer page instead of blank and DevTools targets", () => {
  const renderer = {
    id: "renderer",
    type: "page",
    title: "BetterC0de",
    url: "file:///app/apps/ui/dist/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/renderer",
  }
  assert.deepEqual(
    selectRendererTarget([
      {
        id: "blank",
        type: "page",
        title: "",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/blank",
      },
      { id: "devtools", type: "other", title: "DevTools", url: "devtools://" },
      {
        id: "preview",
        type: "page",
        title: "Preview",
        url: "https://example.test/",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/preview",
      },
      renderer,
    ]),
    renderer
  )
})

test("requires the BetterC0de document and a mounted React root", () => {
  assert.deepEqual(
    validateRendererSnapshot({
      readyState: "complete",
      title: "BetterC0de",
      url: "file:///app/apps/ui/dist/index.html",
      rootChildCount: 1,
    }),
    { ok: true }
  )
  assert.match(
    validateRendererSnapshot({
      readyState: "complete",
      title: "BetterC0de",
      url: "file:///app/apps/ui/dist/index.html",
      rootChildCount: 0,
    }).reason,
    /root/i
  )
  assert.match(
    validateRendererSnapshot({
      readyState: "complete",
      title: "Error",
      url: "chrome-error://chromewebdata/",
      rootChildCount: 1,
    }).reason,
    /error page/i
  )
})

test("retries transient Windows directory removal failures with a bound", async () => {
  const attempts = []
  const waits = []

  await removeDirectoryWithRetries("temporary-smoke-profile", {
    maxAttempts: 4,
    retryDelayMs: 25,
    remove: async (directory) => {
      attempts.push(directory)
      if (attempts.length < 3) {
        throw Object.assign(new Error("directory is still locked"), {
          code: "EBUSY",
        })
      }
    },
    wait: async (ms) => {
      waits.push(ms)
    },
  })

  assert.deepEqual(attempts, [
    "temporary-smoke-profile",
    "temporary-smoke-profile",
    "temporary-smoke-profile",
  ])
  assert.deepEqual(waits, [25, 50])
})

test("preserves terminal directory removal failures", async () => {
  const persistentBusy = Object.assign(new Error("directory stayed locked"), {
    code: "EBUSY",
  })
  let attempts = 0

  await assert.rejects(
    removeDirectoryWithRetries("temporary-smoke-profile", {
      maxAttempts: 3,
      retryDelayMs: 0,
      remove: async () => {
        attempts += 1
        throw persistentBusy
      },
      wait: async () => {},
    }),
    persistentBusy
  )
  assert.equal(attempts, 3)

  const permissionFailure = Object.assign(new Error("access denied"), {
    code: "EACCES",
  })
  attempts = 0
  await assert.rejects(
    removeDirectoryWithRetries("temporary-smoke-profile", {
      remove: async () => {
        attempts += 1
        throw permissionFailure
      },
      wait: async () => {
        assert.fail("non-retryable failures must not wait")
      },
    }),
    permissionFailure
  )
  assert.equal(attempts, 1)
})

test("taskkill's exit code says whether the app's process tree is gone", () => {
  assert.equal(taskkillOutcome(0, 1), "ended")
  // The app had ended on its own; the smoke reports that.
  assert.equal(taskkillOutcome(128, 1), "exited-before")
  // Part of the tree could not be ended: taskkill runs once more.
  assert.equal(taskkillOutcome(255, 1), "retry")
  assert.equal(taskkillOutcome(0, 2), "ended")
  // The first pass had ended the app itself.
  assert.equal(taskkillOutcome(128, 2), "ended")
  assert.equal(taskkillOutcome(255, 2), "failed")
  assert.equal(taskkillOutcome(1, 1), "failed")
  assert.equal(taskkillOutcome(null, 1), "failed")
})
