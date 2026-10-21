/**
 * The records this process sends for `hooks.json` and `mcp-servers.json` (the
 * backend owns and writes the files; see desktop-config-client.cjs),
 * checked against the shared schemas the backend's readers and the
 * renderer's views are built on (`@betterc0de/schema/runtime-records`).
 * The IPC handlers normalize renderer input first; this is the last check
 * before a record reaches the disk, so a drift between the shell and the
 * shared definition refuses the write instead of storing a record another
 * reader would misread.
 *
 * The schema package (and zod) loads on the first write, not at startup.
 * Packaged builds ship it as `node_modules/@betterc0de/schema` (dist only).
 */

/** @type {typeof import("@betterc0de/schema/runtime-records") | null} */
let records = null

function sharedRecords() {
  if (!records) records = require("@betterc0de/schema/runtime-records")
  return records
}

/**
 * @param {import("zod").ZodType} schema
 * @param {string} label
 * @param {unknown} entry
 */
function assertRecord(schema, label, entry) {
  const result = schema.safeParse(entry)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path?.length ? ` (${issue.path.join(".")})` : ""
    throw new TypeError(
      `${label} does not match the stored record${where}: ${issue?.message || "invalid"}`,
    )
  }
  // The entry as built, not the parsed copy: what is written stays exactly
  // what the handler produced.
  return entry
}

/** Throws unless `entry` is a valid `hooks.json` record; returns it unchanged. */
function assertHookRecord(entry) {
  return assertRecord(sharedRecords().runtimeHookRecordSchema, "Hook", entry)
}

/** Throws unless `entry` is a valid `mcp-servers.json` record; returns it unchanged. */
function assertMcpServerRecord(entry) {
  return assertRecord(
    sharedRecords().runtimeMcpServerRecordSchema,
    "MCP server",
    entry,
  )
}

/** The shared bounds, for handlers that enforce them before building a record. */
function runtimeRecordLimits() {
  const { RUNTIME_HOOK_LIMITS, RUNTIME_MCP_LIMITS } = sharedRecords()
  return { hooks: RUNTIME_HOOK_LIMITS, mcp: RUNTIME_MCP_LIMITS }
}

module.exports = {
  assertHookRecord,
  assertMcpServerRecord,
  runtimeRecordLimits,
}
