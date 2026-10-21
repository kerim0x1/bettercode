/**
 * Entry point of the plugin host process.
 *
 * In the app this runs in an Electron `utilityProcess` started by
 * shared/plugin-host-client.cjs and talks to the main process through
 * `process.parentPort`. Under plain Node (tests start it with
 * `child_process.fork`) it uses the fork IPC channel instead. Either way the
 * protocol is shared/plugin-host-runtime.cjs.
 */

const { createPluginHostRuntime } = require("./plugin-host-runtime.cjs")

const parentPort = process.parentPort || null

function post(message) {
  if (parentPort) {
    parentPort.postMessage(message)
    return
  }
  if (typeof process.send !== "function") {
    throw new Error("The plugin host has no channel to the main process")
  }
  process.send(message)
}

const runtime = createPluginHostRuntime({ post })

if (parentPort) {
  parentPort.on("message", (messageEvent) => runtime.handle(messageEvent?.data))
} else {
  process.on("message", (message) => runtime.handle(message))
  // The test or parent process went away: nothing can talk to us any more.
  process.on("disconnect", () => process.exit(0))
}

process.on("uncaughtException", (error) => {
  runtime.handleUncaughtException(error)
})
// As in the main process, a rejected promise nobody handled is logged, not
// treated as a crash.
process.on("unhandledRejection", (reason) => {
  console.error("[plugin-host] Unhandled promise rejection:", reason)
})
