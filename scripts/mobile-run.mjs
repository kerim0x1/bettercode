// Process helpers shared by the phone app's build scripts
// (scripts/mobile-android.mjs, scripts/mobile-ios.mjs).

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export const root = path.resolve(import.meta.dirname, "..")

function quoteForCmd(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg
}

/** Runs a program with its output shown, or a .bat/.cmd file through cmd.exe on Windows. */
export function run(file, args, { cwd = root, env = process.env, label = path.basename(file) } = {}) {
  process.stdout.write(`$ ${label} ${args.join(" ")}\n`)
  const result =
    process.platform === "win32" && /\.(bat|cmd)$/i.test(file)
      ? spawnSync([file, ...args].map(quoteForCmd).join(" "), { cwd, env, stdio: "inherit", shell: true })
      : spawnSync(file, args, { cwd, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? result.signal}.`)
}

/** Runs a program and returns what it printed; a failure throws unless `allowFailure`. */
export function capture(file, args, { cwd = root, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(file, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${path.basename(file)} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/** npm's CLI script, found the way scripts/release-check.mjs finds it. */
export function npm(args, options = {}) {
  const fromEnv = process.env.npm_execpath
  const nodeDir = path.dirname(process.execPath)
  const cli = [
    fromEnv && /npm-cli\.js$/.test(fromEnv) ? fromEnv : null,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate) => candidate && fs.existsSync(candidate))
  if (cli) run(process.execPath, [cli, ...args], { ...options, label: "npm" })
  else run(process.platform === "win32" ? "npm.cmd" : "npm", args, { ...options, label: "npm" })
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `check` every two seconds until it returns something truthy. */
export async function waitFor(description, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(2_000)
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}.`)
}

export function releaseVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
}
