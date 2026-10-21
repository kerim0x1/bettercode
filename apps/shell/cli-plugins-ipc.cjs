/**
 * IPC surface for the CLI-plugin inventory + mutations (Claude Code and
 * Codex plugins). Namespaced `cliPlugin:*` to stay clear of the `plugin:*`
 * channels that belong to BetterC0de's own provider-plugin system.
 *
 * Toggle and uninstall are confirmed in the app by the renderer
 * (ConfirmActionDialog in marketplace-cli-plugins-tab.tsx). Install is
 * confirmed here, in a native main-process dialog that shows the exact CLI
 * command: an installed plugin brings hooks, MCP servers and commands that
 * the CLI runs in later sessions, so a renderer alone must not be able to
 * add one. Argument validation stays here as the last line of defense.
 */

const path = require("path")
const { BrowserWindow, dialog } = require("electron")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { confirmCommandApproval } = require("./shared/command-approval.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")
const {
  getCliPluginInventory,
  getAvailableCliPlugins,
  setClaudePluginEnabled,
  claudePluginInstall,
  claudePluginUninstall,
  codexPluginAdd,
  codexPluginRemove,
  setCodexPluginEnabled,
  validateCliPluginId,
} = require("./cli-plugins.cjs")
const { resolveCliBinary } = require("./shared/spawn-cli.cjs")

const EMPTY_INVENTORY = Object.freeze({
  claude: { cliDetected: false, plugins: [] },
  codex: { cliDetected: false, plugins: [] },
  scannedAt: 0,
})

function validateSource(source) {
  if (source !== "claude" && source !== "codex") {
    throw new Error(`Unknown CLI plugin source: ${source}`)
  }
  return source
}

/** The command line `claudePluginInstall` / `codexPluginAdd` runs. */
function cliPluginInstallCommand(cli, pluginId) {
  return cli === "claude"
    ? `claude plugin install ${pluginId}`
    : `codex plugin add ${pluginId}`
}

/**
 * Ask the user, in a native dialog, to allow installing `pluginId` into
 * the `cli` CLI. Resolves true only on an explicit "Install".
 */
async function confirmCliPluginInstall(
  cli,
  pluginId,
  { parent = null, dialogImpl = dialog, resolveBinary = resolveCliBinary } = {},
) {
  const cliLabel = cli === "claude" ? "Claude Code" : "Codex"
  let binary = null
  try {
    binary = resolveBinary(cli)
  } catch {
    binary = null
  }
  return confirmCommandApproval(dialogImpl, parent, {
    title: `Install ${cliLabel} plugin?`,
    message: `Install the ${cliLabel} plugin ${JSON.stringify(pluginId)}?`,
    command: cliPluginInstallCommand(cli, pluginId),
    context: binary ? `Runs: ${path.normalize(binary)}` : undefined,
    notice:
      `A plugin can add hooks, MCP servers, skills and commands that ${cliLabel} ` +
      "runs in every later session on this computer. Only install plugins you trust.",
    allowLabel: "Install",
  })
}

function parentWindowOf(event) {
  try {
    return event?.sender && BrowserWindow
      ? BrowserWindow.fromWebContents(event.sender)
      : null
  } catch {
    return null
  }
}

let registered = false

function registerCliPluginHandlers() {
  if (registered) return
  registered = true

  rawHandle(
    IpcChannel.CliPluginInventory,
    async (_event, { force } = {}) =>
      getCliPluginInventory({ force: force === true }),
    { fallback: EMPTY_INVENTORY, warnTag: "cli-plugins-ipc" }
  )

  rawHandle(
    IpcChannel.CliPluginAvailable,
    async () => getAvailableCliPlugins(),
    { fallback: { claude: [], codex: [] }, warnTag: "cli-plugins-ipc" }
  )

  safeHandle(
    IpcChannel.CliPluginToggle,
    async (_event, { source, id, enabled } = {}) => {
      const cli = validateSource(source)
      const pluginId = validateCliPluginId(id)
      const nextEnabled = enabled === true
      if (cli === "claude") {
        await setClaudePluginEnabled(pluginId, nextEnabled)
      } else {
        await setCodexPluginEnabled(pluginId, nextEnabled)
      }
      return { inventory: await getCliPluginInventory({ force: true }) }
    }
  )

  safeHandle(
    IpcChannel.CliPluginInstall,
    async (event, { source, id } = {}) => {
      const cli = validateSource(source)
      const pluginId = validateCliPluginId(id)
      const allowed = await confirmCliPluginInstall(cli, pluginId, {
        parent: parentWindowOf(event),
      })
      // "cancelled": the renderer treats it as the user's choice, not an error.
      if (!allowed) throw new Error("Plugin installation was cancelled.")
      if (cli === "claude") {
        await claudePluginInstall(pluginId)
      } else {
        await codexPluginAdd(pluginId)
      }
      return { inventory: await getCliPluginInventory({ force: true }) }
    }
  )

  safeHandle(
    IpcChannel.CliPluginUninstall,
    async (_event, { source, id } = {}) => {
      const cli = validateSource(source)
      const pluginId = validateCliPluginId(id)
      if (cli === "claude") {
        await claudePluginUninstall(pluginId)
      } else {
        await codexPluginRemove(pluginId)
      }
      return { inventory: await getCliPluginInventory({ force: true }) }
    }
  )

  console.log("[cli-plugins-ipc] Handlers registered")
}

module.exports = {
  registerCliPluginHandlers,
  cliPluginInstallCommand,
  confirmCliPluginInstall,
}
