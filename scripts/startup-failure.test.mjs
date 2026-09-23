import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const {
  describeStartupFailure,
  projectLinks,
} = require("../apps/shell/shared/startup-failure.cjs")

const links = {
  releases: "https://example.test/releases",
  issues: "https://example.test/issues",
}

function exitError(stderr) {
  const error = new Error("Node backend exited (code=1 signal=none)")
  error.backendStderr = stderr
  return error
}

test("an ABI mismatch in an installed app points to a reinstall of the right build", () => {
  const { title, message } = describeStartupFailure({
    error: exitError([
      "node:internal/modules/cjs/loader:1921",
      "Error: The module '/opt/BetterC0de/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
      "was compiled against a different Node.js version using",
      "NODE_MODULE_VERSION 127. This version of Node.js requires",
      "NODE_MODULE_VERSION 145.",
    ]),
    isPackaged: true,
    links,
  })
  assert.equal(title, "BetterC0de could not start")
  assert.match(message, /Node backend exited \(code=1 signal=none\)/)
  assert.match(message, /Last messages from the service:\n {2}.*better_sqlite3\.node/)
  assert.match(message, /built for a different system or processor/)
  assert.match(message, /Install the latest version from https:\/\/example\.test\/releases/)
  assert.match(message, /report it at https:\/\/example\.test\/issues/)
})

test("the same mismatch in a checkout names the rebuild commands", () => {
  const { message } = describeStartupFailure({
    error: exitError(["Error: ... was compiled against a different Node.js version"]),
    isPackaged: false,
    links,
  })
  assert.match(message, /npm run backend:rebuild/)
  assert.doesNotMatch(message, /Install the latest version/)
})

test("a missing backend build or file gives build or reinstall advice", () => {
  const missingEntry = new Error("Could not load the backend at /repo/apps/backend/dist/index.js.")
  assert.match(
    describeStartupFailure({ error: missingEntry, isPackaged: false, links }).message,
    /npm run build:backend/
  )
  assert.match(
    describeStartupFailure({
      error: exitError(["Error: Cannot find module '@betterc0de/schema'"]),
      isPackaged: true,
      links,
    }).message,
    /installation is incomplete/
  )
})

test("permission, disk and database problems get their own advice", () => {
  const advice = (line) =>
    describeStartupFailure({ error: exitError([line]), isPackaged: true, links }).message
  assert.match(advice("Error: EACCES: permission denied, open '/home/u/.betterc0de/x'"), /BETTERC0DE_HOME/)
  assert.match(advice("Error: ENOSPC: no space left on device"), /disk is full/)
  assert.match(advice("SqliteError: database is locked"), /still using its database/)
})

test("an unrecognised failure suggests a restart, then a reinstall, then a report", () => {
  const { message } = describeStartupFailure({
    error: new Error("Node backend did not send its first startup heartbeat within 120000ms"),
    isPackaged: true,
    links,
  })
  const steps = message.slice(message.indexOf("What you can do:")).split("\n").slice(1)
  assert.equal(steps.length, 3)
  assert.match(steps[0], /Quit BetterC0de and start it again/)
  assert.match(steps[1], /If that does not help, install the latest version/)
  assert.match(steps[2], /report it at/)
  assert.doesNotMatch(message, /Last messages from the service/)
})

test("service output is trimmed to the lines that explain the failure", () => {
  const noise = Array.from({ length: 30 }, (_, index) => `info loading module ${index}`)
  const { message } = describeStartupFailure({
    error: exitError([
      ...noise,
      "\u001b[31mError: boom\u001b[39m",
      "Error: boom",
      `TypeError: ${"x".repeat(400)}`,
    ]),
    isPackaged: true,
    links,
  })
  const detail = message
    .slice(message.indexOf("Last messages from the service:"), message.indexOf("What you can do:"))
    .trim()
    .split("\n")
    .slice(1)
  assert.deepEqual(detail[0], "  Error: boom", "ANSI colour codes are removed and duplicates collapsed")
  assert.equal(detail.length, 2)
  assert.ok(detail[1].length < 320 && detail[1].endsWith("…"), "long lines are truncated")
  assert.doesNotMatch(message, /loading module/)
})

test("stderr attached to an aggregated start-up failure is found", () => {
  const aggregate = new AggregateError(
    [exitError(["Error: Cannot find module 'ws'"]), new Error("stop failed")],
    "Backend startup failed and its process did not stop cleanly"
  )
  const { message } = describeStartupFailure({ error: aggregate, isPackaged: false, links })
  assert.match(message, /did not stop cleanly\nNode backend exited/)
  assert.match(message, /Cannot find module 'ws'/)
  assert.match(message, /npm run build:backend/)
})

test("links come from package.json so forks report to their own repository", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.deepEqual(projectLinks(manifest), {
    releases: "https://github.com/kerim0x1/bettercode/releases",
    issues: "https://github.com/kerim0x1/bettercode/issues",
  })
  assert.deepEqual(
    projectLinks({ repository: "git+https://github.com/fork/app.git", bugs: { url: "https://x.test/bugs" } }),
    { releases: "https://github.com/fork/app/releases", issues: "https://x.test/bugs" }
  )
  assert.match(projectLinks(undefined).releases, /\/releases$/)
})

test("the shell attaches backend stderr to start-up failures and shows the described dialog", () => {
  const shell = readFileSync(new URL("../apps/shell/main.cjs", import.meta.url), "utf8")
  const spawned = shell.slice(
    shell.indexOf("async function startSpawnedBackend()"),
    shell.indexOf("async function startInProcessBackend()")
  )
  assert.match(spawned, /failure\.backendStderr = stderrTail/)
  assert.match(spawned, /stderrTail\.push\(line\)/)
  assert.doesNotMatch(shell, /cd node-backend && npm install/, "the old advice named a directory that does not exist")
  assert.match(shell, /dialog\.showErrorBox\(title, message\)/)
  assert.doesNotMatch(shell, /Failed to start backend: \$\{err\.message\}/)
})
