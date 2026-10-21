import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import test from "node:test"

const {
  DARWIN_FALLBACK_PATH_ENTRIES,
  mergePathLists,
  parseMarkedOutput,
  resolveDarwinChildPath,
  resolveLoginShellPath,
} = createRequire(import.meta.url)("../apps/shell/shared/login-shell-path.cjs")

/** A fake `spawn` whose child prints `output` (with the real marker) and exits. */
function fakeShell({ output = (marker) => `${marker}/opt/homebrew/bin:/usr/bin${marker}`, exit = true, onSpawn } = {}) {
  return (file, args, options) => {
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.kill = () => {}
    onSpawn?.({ file, args, options })
    const marker = args.at(-1).match(/'(__BETTERC0DE_PATH_[0-9a-f]+__)'/)[1]
    setImmediate(() => {
      child.stdout.emit("data", `Welcome banner\n${output(marker)}\n`)
      if (exit) child.emit("close", 0)
    })
    return child
  }
}

test("reads PATH from an interactive login shell without a terminal", async () => {
  let spawned
  const value = await resolveLoginShellPath({
    shell: "/bin/zsh",
    env: { PATH: "/usr/bin" },
    spawnImpl: fakeShell({ onSpawn: (call) => { spawned = call } }),
  })
  assert.equal(value, "/opt/homebrew/bin:/usr/bin")
  assert.equal(spawned.file, "/bin/zsh")
  assert.deepEqual(spawned.args.slice(0, 3), ["-i", "-l", "-c"])
  assert.match(spawned.args[3], /\/usr\/bin\/printenv PATH/)
  assert.equal(spawned.options.stdio[0], "ignore")
  assert.equal(spawned.options.detached, true)
  assert.equal(spawned.options.env.BETTERC0DE_RESOLVING_ENVIRONMENT, "1")
})

test("falls back to zsh for a missing or relative SHELL", async () => {
  let file
  await resolveLoginShellPath({ shell: "bash", spawnImpl: fakeShell({ onSpawn: (call) => { file = call.file } }) })
  assert.equal(file, "/bin/zsh")
})

test("a hanging profile times out and its process group is killed", async () => {
  const killed = []
  const value = await resolveLoginShellPath({
    shell: "/bin/bash",
    timeoutMs: 20,
    spawnImpl: fakeShell({ exit: false, output: () => "still loading..." }),
    killProcessGroup: (pid, signal) => killed.push([pid, signal]),
  })
  assert.equal(value, null)
  assert.deepEqual(killed, [[4242, "SIGKILL"]])
})

test("unusable output resolves null", async () => {
  assert.equal(await resolveLoginShellPath({ spawnImpl: fakeShell({ output: () => "no markers" }) }), null)
  assert.equal(await resolveLoginShellPath({ spawnImpl: fakeShell({ output: (m) => `${m}relative/bin${m}` }) }), null)
  assert.equal(await resolveLoginShellPath({ spawnImpl: () => { throw new Error("EACCES") } }), null)
})

test("merges login, current and fallback entries without duplicates", () => {
  assert.equal(
    mergePathLists("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:relative", ["/usr/local/bin"]),
    "/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin",
  )
  assert.equal(parseMarkedOutput("noise M/a:/bM tail", "M"), "/a:/b")
})

test("the macOS child PATH always contains the Homebrew locations", async () => {
  const resolved = await resolveDarwinChildPath({
    env: { PATH: "/usr/bin:/bin" },
    spawnImpl: () => { throw new Error("no shell") },
  })
  assert.equal(resolved.fromLoginShell, false)
  for (const entry of DARWIN_FALLBACK_PATH_ENTRIES) assert.ok(resolved.path.split(":").includes(entry), entry)
  assert.ok(resolved.path.startsWith("/usr/bin:/bin"))
})
