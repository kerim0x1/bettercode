// @ts-check
/**
 * POSIX process-tree helpers for forced backend shutdown.
 *
 * The backend starts provider CLIs, shells, git and formatters `detached`,
 * so each lives in its own process group. Killing the backend's group
 * therefore misses them, and once the backend is gone they are re-parented
 * to init and can no longer be found through it. A forced shutdown takes a
 * snapshot of the tree first, then kills the backend, then every group the
 * snapshot found. (Windows uses `taskkill /T`, which walks the tree itself.)
 */

const { execFile } = require("node:child_process")

/**
 * One row of the process table.
 * @typedef {{ pid: number, ppid: number, pgid: number }} ProcessRow
 */

/**
 * Parse `ps -A -o pid=,ppid=,pgid=` output.
 * @param {unknown} output
 * @returns {ProcessRow[]}
 */
function parseProcessTable(output) {
  /** @type {ProcessRow[]} */
  const rows = []
  for (const line of String(output).split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3) continue
    const [pid, ppid, pgid] = fields.map((value) => Number.parseInt(value, 10))
    if ([pid, ppid, pgid].every((value) => Number.isInteger(value) && value >= 0)) {
      rows.push({ pid, ppid, pgid })
    }
  }
  return rows
}

/**
 * Every process below `rootPid`, breadth first.
 * @param {ProcessRow[]} rows
 * @param {number} rootPid
 * @returns {ProcessRow[]}
 */
function collectDescendants(rows, rootPid) {
  /** @type {Map<number, ProcessRow[]>} */
  const children = new Map()
  for (const row of rows) {
    if (row.pid === row.ppid) continue
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  /** @type {ProcessRow[]} */
  const result = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = /** @type {number} */ (queue.shift())
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.pid)) continue
      seen.add(row.pid)
      result.push(row)
      queue.push(row.pid)
    }
  }
  return result
}

/**
 * Snapshot the descendants of `rootPid`. Resolves [] when `ps` is unavailable.
 * @param {number} rootPid
 * @param {object} [options]
 * @param {typeof execFile} [options.execFileImpl]
 * @param {number} [options.timeoutMs]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {Promise<ProcessRow[]>}
 */
function listDescendantProcesses(
  rootPid,
  { execFileImpl = execFile, timeoutMs = 2_000, platform = process.platform } = {},
) {
  if (platform === "win32" || !Number.isInteger(rootPid) || rootPid <= 1) {
    return Promise.resolve([])
  }
  return new Promise((resolve) => {
    try {
      execFileImpl(
        "/bin/ps",
        ["-A", "-o", "pid=,ppid=,pgid="],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" } },
        (error, stdout) => {
          if (error) {
            resolve([])
            return
          }
          resolve(collectDescendants(parseProcessTable(stdout), rootPid))
        },
      )
    } catch {
      resolve([])
    }
  })
}

/**
 * SIGKILL the groups and processes from a snapshot. Never signals the
 * caller's own process or group, or init. Returns the number of process
 * groups signalled.
 * @param {ProcessRow[]} processes
 * @param {object} [options]
 * @param {NodeJS.Signals} [options.signal]
 * @param {number} [options.ownPid]
 * @param {number | null} [options.ownGroup]
 * @param {(pid: number, signal: NodeJS.Signals) => void} [options.kill]
 * @returns {number}
 */
function killProcesses(processes, {
  signal = "SIGKILL",
  ownPid = process.pid,
  ownGroup = null,
  kill = (pid, sig) => process.kill(pid, sig),
} = {}) {
  /** @type {Set<number>} */
  const groups = new Set()
  for (const { pid, pgid } of processes) {
    if (pgid > 1 && pgid !== ownPid && pgid !== ownGroup) groups.add(pgid)
    if (pid > 1 && pid !== ownPid) {
      try { kill(pid, signal) } catch { /* already gone */ }
    }
  }
  for (const group of groups) {
    try { kill(-group, signal) } catch { /* already gone */ }
  }
  return groups.size
}

module.exports = {
  collectDescendants,
  killProcesses,
  listDescendantProcesses,
  parseProcessTable,
}
