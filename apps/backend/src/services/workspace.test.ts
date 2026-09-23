import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  activeWorkspaceProcessCount,
  beginWorkspaceProcessShutdown,
  createDirectory,
  deletePath,
  formatProjectFile,
  getProjectShell,
  getProjectToolOutputLimits,
  listProjectConfigSettings,
  listProjectFormatters,
  listProjectAgents,
  listProjectCommands,
  listProjectInstructions,
  listProjectLspServers,
  listProjectMcpServers,
  listProjectPermissions,
  listProjectPlugins,
  listProjectProviders,
  listProjectReferences,
  listProjectSkills,
  listProjectTools,
  movePath,
  quickOpenFiles,
  queuedWorkspaceProcessCount,
  readBinaryFile,
  readFile,
  resumeWorkspaceProcessAdmissions,
  searchContent,
  searchEntries,
  shutdownAllWorkspaceProcesses,
  writeFile,
  workspaceMap,
} from "./workspace"
import {
  __projectFormatterAdmissionCountsForTests,
  __reserveProjectFormatterOperationForTests,
  __runBoundedWorkspaceCommandForTests,
} from "./workspace/processes"
import { __setWorkspaceMutationTestHookForTests } from "./workspace/files"
import { __setRemoteProjectFetchDependenciesForTests } from "./workspace/resources"

const tempRoots: string[] = []
let previousXdgConfigHome: string | undefined
let previousXdgDataHome: string | undefined
let previousXdgStateHome: string | undefined
let previousBetterC0deConfigDir: string | undefined
let previousUpperBetterC0deConfig: string | undefined
let previousBetterC0deConfig: string | undefined
let previousUpperBetterC0deConfigContent: string | undefined
let previousBetterC0deConfigContent: string | undefined
let previousBetterC0dePermission: string | undefined
let previousBetterC0deTuiConfig: string | undefined
let previousBetterC0deDisableAutocompact: string | undefined
let previousBetterC0deDisablePrune: string | undefined
let previousBetterC0deDisableProjectConfig: string | undefined
let previousBetterC0deDisableShare: string | undefined
let previousBetterC0deAutoShare: string | undefined
let previousBetterC0deDisableExternalSkills: string | undefined
let previousBetterC0deDisableClaudeCode: string | undefined
let previousBetterC0deDisableClaudeCodePrompt: string | undefined
let previousBetterC0deDisableClaudeCodeSkills: string | undefined
let previousBetterC0dePure: string | undefined
let previousBetterC0deDisableDefaultPlugins: string | undefined
let previousBetterC0deDisableAutoupdate: string | undefined
let previousBetterC0deAlwaysNotifyUpdate: string | undefined
let previousBetterC0deDisableModelsFetch: string | undefined
let previousBetterC0deModelsUrl: string | undefined
let previousBetterC0deModelsPath: string | undefined
let previousBetterC0deFakeVcs: string | undefined
let previousBetterC0deWorkspaceId: string | undefined
let previousBetterC0deAutoHeapSnapshot: string | undefined
let previousBetterC0deExperimentalFileWatcher: string | undefined
let previousBetterC0deExperimentalDisableFileWatcher: string | undefined
let previousBetterC0deExperimentalDisableCopyOnSelect: string | undefined
let previousBetterC0deExperimentalLspTy: string | undefined
let previousBetterC0deDirectTrace: string | undefined
let previousBetterC0deDisableMouse: string | undefined
let previousBetterC0deDisableTerminalTitle: string | undefined
let previousBetterC0deShowTtfd: string | undefined
let previousBetterC0deExperimentalBashDefaultTimeoutMs: string | undefined
let previousBetterC0deDisableLspDownload: string | undefined
let previousBetterC0deEnableParallel: string | undefined
let previousBetterC0deWebSearchProvider: string | undefined
let previousBetterC0deExperimentalOutputTokenMax: string | undefined
let previousBetterC0deClient: string | undefined
let previousBetterC0deRepoCloneGithubBaseUrl: string | undefined
let previousBetterC0dePluginMetaFile: string | undefined
let previousBetterC0deTestHome: string | undefined
let previousBetterC0deTestManagedConfigDir: string | undefined
let previousBetterC0deTestManagedPreferencesFile: string | undefined
let previousTestBetterC0deShell: string | undefined

async function makeWorkspace(): Promise<string> {
  const root = await makeCanonicalTemp("betterc0de-workspace-")
  tempRoots.push(root)
  return root
}

async function makeCanonicalTemp(prefix: string): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return await fs.realpath(raw)
}

beforeEach(async () => {
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  previousXdgDataHome = process.env.XDG_DATA_HOME
  previousXdgStateHome = process.env.XDG_STATE_HOME
  previousBetterC0deConfigDir = process.env.BetterC0de_CONFIG_DIR
  previousUpperBetterC0deConfig = process.env.BETTERC0DE_CONFIG
  previousBetterC0deConfig = process.env.BetterC0de_CONFIG
  previousUpperBetterC0deConfigContent = process.env.BETTERC0DE_CONFIG_CONTENT
  previousBetterC0deConfigContent = process.env.BetterC0de_CONFIG_CONTENT
  previousBetterC0dePermission = process.env.BetterC0de_PERMISSION
  previousBetterC0deTuiConfig = process.env.BetterC0de_TUI_CONFIG
  previousBetterC0deDisableAutocompact =
    process.env.BetterC0de_DISABLE_AUTOCOMPACT
  previousBetterC0deDisablePrune = process.env.BetterC0de_DISABLE_PRUNE
  previousBetterC0deDisableProjectConfig =
    process.env.BetterC0de_DISABLE_PROJECT_CONFIG
  previousBetterC0deDisableShare = process.env.BetterC0de_DISABLE_SHARE
  previousBetterC0deAutoShare = process.env.BetterC0de_AUTO_SHARE
  previousBetterC0deDisableExternalSkills =
    process.env.BetterC0de_DISABLE_EXTERNAL_SKILLS
  previousBetterC0deDisableClaudeCode =
    process.env.BetterC0de_DISABLE_CLAUDE_CODE
  previousBetterC0deDisableClaudeCodePrompt =
    process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT
  previousBetterC0deDisableClaudeCodeSkills =
    process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS
  previousBetterC0dePure = process.env.BetterC0de_PURE
  previousBetterC0deDisableDefaultPlugins =
    process.env.BetterC0de_DISABLE_DEFAULT_PLUGINS
  previousBetterC0deDisableAutoupdate =
    process.env.BetterC0de_DISABLE_AUTOUPDATE
  previousBetterC0deAlwaysNotifyUpdate =
    process.env.BetterC0de_ALWAYS_NOTIFY_UPDATE
  previousBetterC0deDisableModelsFetch =
    process.env.BetterC0de_DISABLE_MODELS_FETCH
  previousBetterC0deModelsUrl = process.env.BetterC0de_MODELS_URL
  previousBetterC0deModelsPath = process.env.BetterC0de_MODELS_PATH
  previousBetterC0deFakeVcs = process.env.BetterC0de_FAKE_VCS
  previousBetterC0deWorkspaceId = process.env.BetterC0de_WORKSPACE_ID
  previousBetterC0deAutoHeapSnapshot = process.env.BetterC0de_AUTO_HEAP_SNAPSHOT
  previousBetterC0deExperimentalFileWatcher =
    process.env.BetterC0de_EXPERIMENTAL_FILEWATCHER
  previousBetterC0deExperimentalDisableFileWatcher =
    process.env.BetterC0de_EXPERIMENTAL_DISABLE_FILEWATCHER
  previousBetterC0deExperimentalDisableCopyOnSelect =
    process.env.BetterC0de_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
  previousBetterC0deExperimentalLspTy =
    process.env.BetterC0de_EXPERIMENTAL_LSP_TY
  previousBetterC0deDirectTrace = process.env.BetterC0de_DIRECT_TRACE
  previousBetterC0deDisableMouse = process.env.BetterC0de_DISABLE_MOUSE
  previousBetterC0deDisableTerminalTitle =
    process.env.BetterC0de_DISABLE_TERMINAL_TITLE
  previousBetterC0deShowTtfd = process.env.BetterC0de_SHOW_TTFD
  previousBetterC0deExperimentalBashDefaultTimeoutMs =
    process.env.BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
  previousBetterC0deDisableLspDownload =
    process.env.BetterC0de_DISABLE_LSP_DOWNLOAD
  previousBetterC0deEnableParallel = process.env.BetterC0de_ENABLE_PARALLEL
  previousBetterC0deWebSearchProvider =
    process.env.BetterC0de_WEBSEARCH_PROVIDER
  previousBetterC0deExperimentalOutputTokenMax =
    process.env.BetterC0de_EXPERIMENTAL_OUTPUT_TOKEN_MAX
  previousBetterC0deClient = process.env.BetterC0de_CLIENT
  previousBetterC0deRepoCloneGithubBaseUrl =
    process.env.BetterC0de_REPO_CLONE_GITHUB_BASE_URL
  previousBetterC0dePluginMetaFile = process.env.BetterC0de_PLUGIN_META_FILE
  previousBetterC0deTestHome = process.env.BetterC0de_TEST_HOME
  previousBetterC0deTestManagedConfigDir =
    process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR
  previousBetterC0deTestManagedPreferencesFile =
    process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE
  previousTestBetterC0deShell = process.env.BETTERC0DE_TEST_BetterC0de_SHELL
  const configRoot = await makeCanonicalTemp("betterc0de-BetterC0de-config-")
  const homeRoot = await makeCanonicalTemp("betterc0de-BetterC0de-home-")
  const dataRoot = await makeCanonicalTemp("betterc0de-BetterC0de-data-")
  const stateRoot = await makeCanonicalTemp("betterc0de-BetterC0de-state-")
  tempRoots.push(configRoot)
  tempRoots.push(homeRoot)
  tempRoots.push(dataRoot)
  tempRoots.push(stateRoot)
  process.env.XDG_CONFIG_HOME = configRoot
  process.env.XDG_DATA_HOME = dataRoot
  process.env.XDG_STATE_HOME = stateRoot
  process.env.BetterC0de_TEST_HOME = homeRoot
  delete process.env.BetterC0de_CONFIG_DIR
  delete process.env.BETTERC0DE_CONFIG
  delete process.env.BetterC0de_CONFIG
  delete process.env.BETTERC0DE_CONFIG_CONTENT
  delete process.env.BetterC0de_CONFIG_CONTENT
  delete process.env.BetterC0de_PERMISSION
  delete process.env.BetterC0de_TUI_CONFIG
  delete process.env.BetterC0de_DISABLE_AUTOCOMPACT
  delete process.env.BetterC0de_DISABLE_PRUNE
  delete process.env.BetterC0de_DISABLE_PROJECT_CONFIG
  delete process.env.BetterC0de_DISABLE_SHARE
  delete process.env.BetterC0de_AUTO_SHARE
  delete process.env.BetterC0de_DISABLE_EXTERNAL_SKILLS
  delete process.env.BetterC0de_DISABLE_CLAUDE_CODE
  delete process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT
  delete process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS
  delete process.env.BetterC0de_PURE
  delete process.env.BetterC0de_DISABLE_DEFAULT_PLUGINS
  delete process.env.BetterC0de_DISABLE_AUTOUPDATE
  delete process.env.BetterC0de_ALWAYS_NOTIFY_UPDATE
  delete process.env.BetterC0de_DISABLE_MODELS_FETCH
  delete process.env.BetterC0de_MODELS_URL
  delete process.env.BetterC0de_MODELS_PATH
  delete process.env.BetterC0de_FAKE_VCS
  delete process.env.BetterC0de_WORKSPACE_ID
  delete process.env.BetterC0de_AUTO_HEAP_SNAPSHOT
  delete process.env.BetterC0de_EXPERIMENTAL_FILEWATCHER
  delete process.env.BetterC0de_EXPERIMENTAL_DISABLE_FILEWATCHER
  delete process.env.BetterC0de_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
  delete process.env.BetterC0de_EXPERIMENTAL_LSP_TY
  delete process.env.BetterC0de_DIRECT_TRACE
  delete process.env.BetterC0de_DISABLE_MOUSE
  delete process.env.BetterC0de_DISABLE_TERMINAL_TITLE
  delete process.env.BetterC0de_SHOW_TTFD
  delete process.env.BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
  delete process.env.BetterC0de_DISABLE_LSP_DOWNLOAD
  delete process.env.BetterC0de_ENABLE_PARALLEL
  delete process.env.BetterC0de_WEBSEARCH_PROVIDER
  delete process.env.BetterC0de_EXPERIMENTAL_OUTPUT_TOKEN_MAX
  delete process.env.BetterC0de_CLIENT
  delete process.env.BetterC0de_REPO_CLONE_GITHUB_BASE_URL
  delete process.env.BetterC0de_PLUGIN_META_FILE
  delete process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR
  delete process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE
  delete process.env.BETTERC0DE_TEST_BetterC0de_SHELL
})

afterEach(async () => {
  __setRemoteProjectFetchDependenciesForTests(null)
  __setWorkspaceMutationTestHookForTests(null)
  if (typeof previousXdgConfigHome === "string") {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome
  } else {
    delete process.env.XDG_CONFIG_HOME
  }
  if (typeof previousXdgDataHome === "string") {
    process.env.XDG_DATA_HOME = previousXdgDataHome
  } else {
    delete process.env.XDG_DATA_HOME
  }
  if (typeof previousXdgStateHome === "string") {
    process.env.XDG_STATE_HOME = previousXdgStateHome
  } else {
    delete process.env.XDG_STATE_HOME
  }
  if (typeof previousBetterC0deConfigDir === "string") {
    process.env.BetterC0de_CONFIG_DIR = previousBetterC0deConfigDir
  } else {
    delete process.env.BetterC0de_CONFIG_DIR
  }
  if (typeof previousUpperBetterC0deConfig === "string") {
    process.env.BETTERC0DE_CONFIG = previousUpperBetterC0deConfig
  } else {
    delete process.env.BETTERC0DE_CONFIG
  }
  if (typeof previousBetterC0deConfig === "string") {
    process.env.BetterC0de_CONFIG = previousBetterC0deConfig
  } else {
    delete process.env.BetterC0de_CONFIG
  }
  if (typeof previousBetterC0deConfigContent === "string") {
    process.env.BetterC0de_CONFIG_CONTENT = previousBetterC0deConfigContent
  } else {
    delete process.env.BetterC0de_CONFIG_CONTENT
  }
  if (typeof previousUpperBetterC0deConfigContent === "string") {
    process.env.BETTERC0DE_CONFIG_CONTENT = previousUpperBetterC0deConfigContent
  } else {
    delete process.env.BETTERC0DE_CONFIG_CONTENT
  }
  if (typeof previousBetterC0dePermission === "string") {
    process.env.BetterC0de_PERMISSION = previousBetterC0dePermission
  } else {
    delete process.env.BetterC0de_PERMISSION
  }
  if (typeof previousBetterC0deTuiConfig === "string") {
    process.env.BetterC0de_TUI_CONFIG = previousBetterC0deTuiConfig
  } else {
    delete process.env.BetterC0de_TUI_CONFIG
  }
  if (typeof previousBetterC0deDisableAutocompact === "string") {
    process.env.BetterC0de_DISABLE_AUTOCOMPACT =
      previousBetterC0deDisableAutocompact
  } else {
    delete process.env.BetterC0de_DISABLE_AUTOCOMPACT
  }
  if (typeof previousBetterC0deDisablePrune === "string") {
    process.env.BetterC0de_DISABLE_PRUNE = previousBetterC0deDisablePrune
  } else {
    delete process.env.BetterC0de_DISABLE_PRUNE
  }
  if (typeof previousBetterC0deDisableProjectConfig === "string") {
    process.env.BetterC0de_DISABLE_PROJECT_CONFIG =
      previousBetterC0deDisableProjectConfig
  } else {
    delete process.env.BetterC0de_DISABLE_PROJECT_CONFIG
  }
  if (typeof previousBetterC0deDisableShare === "string") {
    process.env.BetterC0de_DISABLE_SHARE = previousBetterC0deDisableShare
  } else {
    delete process.env.BetterC0de_DISABLE_SHARE
  }
  if (typeof previousBetterC0deAutoShare === "string") {
    process.env.BetterC0de_AUTO_SHARE = previousBetterC0deAutoShare
  } else {
    delete process.env.BetterC0de_AUTO_SHARE
  }
  if (typeof previousBetterC0deDisableExternalSkills === "string") {
    process.env.BetterC0de_DISABLE_EXTERNAL_SKILLS =
      previousBetterC0deDisableExternalSkills
  } else {
    delete process.env.BetterC0de_DISABLE_EXTERNAL_SKILLS
  }
  if (typeof previousBetterC0deDisableClaudeCode === "string") {
    process.env.BetterC0de_DISABLE_CLAUDE_CODE =
      previousBetterC0deDisableClaudeCode
  } else {
    delete process.env.BetterC0de_DISABLE_CLAUDE_CODE
  }
  if (typeof previousBetterC0deDisableClaudeCodePrompt === "string") {
    process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT =
      previousBetterC0deDisableClaudeCodePrompt
  } else {
    delete process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT
  }
  if (typeof previousBetterC0deDisableClaudeCodeSkills === "string") {
    process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS =
      previousBetterC0deDisableClaudeCodeSkills
  } else {
    delete process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS
  }
  if (typeof previousBetterC0dePure === "string") {
    process.env.BetterC0de_PURE = previousBetterC0dePure
  } else {
    delete process.env.BetterC0de_PURE
  }
  if (typeof previousBetterC0deDisableDefaultPlugins === "string") {
    process.env.BetterC0de_DISABLE_DEFAULT_PLUGINS =
      previousBetterC0deDisableDefaultPlugins
  } else {
    delete process.env.BetterC0de_DISABLE_DEFAULT_PLUGINS
  }
  if (typeof previousBetterC0deDisableAutoupdate === "string") {
    process.env.BetterC0de_DISABLE_AUTOUPDATE =
      previousBetterC0deDisableAutoupdate
  } else {
    delete process.env.BetterC0de_DISABLE_AUTOUPDATE
  }
  if (typeof previousBetterC0deAlwaysNotifyUpdate === "string") {
    process.env.BetterC0de_ALWAYS_NOTIFY_UPDATE =
      previousBetterC0deAlwaysNotifyUpdate
  } else {
    delete process.env.BetterC0de_ALWAYS_NOTIFY_UPDATE
  }
  if (typeof previousBetterC0deDisableModelsFetch === "string") {
    process.env.BetterC0de_DISABLE_MODELS_FETCH =
      previousBetterC0deDisableModelsFetch
  } else {
    delete process.env.BetterC0de_DISABLE_MODELS_FETCH
  }
  if (typeof previousBetterC0deModelsUrl === "string") {
    process.env.BetterC0de_MODELS_URL = previousBetterC0deModelsUrl
  } else {
    delete process.env.BetterC0de_MODELS_URL
  }
  if (typeof previousBetterC0deModelsPath === "string") {
    process.env.BetterC0de_MODELS_PATH = previousBetterC0deModelsPath
  } else {
    delete process.env.BetterC0de_MODELS_PATH
  }
  if (typeof previousBetterC0deFakeVcs === "string") {
    process.env.BetterC0de_FAKE_VCS = previousBetterC0deFakeVcs
  } else {
    delete process.env.BetterC0de_FAKE_VCS
  }
  if (typeof previousBetterC0deWorkspaceId === "string") {
    process.env.BetterC0de_WORKSPACE_ID = previousBetterC0deWorkspaceId
  } else {
    delete process.env.BetterC0de_WORKSPACE_ID
  }
  if (typeof previousBetterC0deAutoHeapSnapshot === "string") {
    process.env.BetterC0de_AUTO_HEAP_SNAPSHOT =
      previousBetterC0deAutoHeapSnapshot
  } else {
    delete process.env.BetterC0de_AUTO_HEAP_SNAPSHOT
  }
  if (typeof previousBetterC0deExperimentalFileWatcher === "string") {
    process.env.BetterC0de_EXPERIMENTAL_FILEWATCHER =
      previousBetterC0deExperimentalFileWatcher
  } else {
    delete process.env.BetterC0de_EXPERIMENTAL_FILEWATCHER
  }
  if (typeof previousBetterC0deExperimentalDisableFileWatcher === "string") {
    process.env.BetterC0de_EXPERIMENTAL_DISABLE_FILEWATCHER =
      previousBetterC0deExperimentalDisableFileWatcher
  } else {
    delete process.env.BetterC0de_EXPERIMENTAL_DISABLE_FILEWATCHER
  }
  if (typeof previousBetterC0deExperimentalDisableCopyOnSelect === "string") {
    process.env.BetterC0de_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
      previousBetterC0deExperimentalDisableCopyOnSelect
  } else {
    delete process.env.BetterC0de_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
  }
  if (typeof previousBetterC0deExperimentalLspTy === "string") {
    process.env.BetterC0de_EXPERIMENTAL_LSP_TY =
      previousBetterC0deExperimentalLspTy
  } else {
    delete process.env.BetterC0de_EXPERIMENTAL_LSP_TY
  }
  if (typeof previousBetterC0deDirectTrace === "string") {
    process.env.BetterC0de_DIRECT_TRACE = previousBetterC0deDirectTrace
  } else {
    delete process.env.BetterC0de_DIRECT_TRACE
  }
  if (typeof previousBetterC0deDisableMouse === "string") {
    process.env.BetterC0de_DISABLE_MOUSE = previousBetterC0deDisableMouse
  } else {
    delete process.env.BetterC0de_DISABLE_MOUSE
  }
  if (typeof previousBetterC0deDisableTerminalTitle === "string") {
    process.env.BetterC0de_DISABLE_TERMINAL_TITLE =
      previousBetterC0deDisableTerminalTitle
  } else {
    delete process.env.BetterC0de_DISABLE_TERMINAL_TITLE
  }
  if (typeof previousBetterC0deShowTtfd === "string") {
    process.env.BetterC0de_SHOW_TTFD = previousBetterC0deShowTtfd
  } else {
    delete process.env.BetterC0de_SHOW_TTFD
  }
  if (typeof previousBetterC0deExperimentalBashDefaultTimeoutMs === "string") {
    process.env.BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS =
      previousBetterC0deExperimentalBashDefaultTimeoutMs
  } else {
    delete process.env.BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
  }
  if (typeof previousBetterC0deDisableLspDownload === "string") {
    process.env.BetterC0de_DISABLE_LSP_DOWNLOAD =
      previousBetterC0deDisableLspDownload
  } else {
    delete process.env.BetterC0de_DISABLE_LSP_DOWNLOAD
  }
  if (typeof previousBetterC0deEnableParallel === "string") {
    process.env.BetterC0de_ENABLE_PARALLEL = previousBetterC0deEnableParallel
  } else {
    delete process.env.BetterC0de_ENABLE_PARALLEL
  }
  if (typeof previousBetterC0deWebSearchProvider === "string") {
    process.env.BetterC0de_WEBSEARCH_PROVIDER =
      previousBetterC0deWebSearchProvider
  } else {
    delete process.env.BetterC0de_WEBSEARCH_PROVIDER
  }
  if (typeof previousBetterC0deExperimentalOutputTokenMax === "string") {
    process.env.BetterC0de_EXPERIMENTAL_OUTPUT_TOKEN_MAX =
      previousBetterC0deExperimentalOutputTokenMax
  } else {
    delete process.env.BetterC0de_EXPERIMENTAL_OUTPUT_TOKEN_MAX
  }
  if (typeof previousBetterC0deClient === "string") {
    process.env.BetterC0de_CLIENT = previousBetterC0deClient
  } else {
    delete process.env.BetterC0de_CLIENT
  }
  if (typeof previousBetterC0deRepoCloneGithubBaseUrl === "string") {
    process.env.BetterC0de_REPO_CLONE_GITHUB_BASE_URL =
      previousBetterC0deRepoCloneGithubBaseUrl
  } else {
    delete process.env.BetterC0de_REPO_CLONE_GITHUB_BASE_URL
  }
  if (typeof previousBetterC0dePluginMetaFile === "string") {
    process.env.BetterC0de_PLUGIN_META_FILE = previousBetterC0dePluginMetaFile
  } else {
    delete process.env.BetterC0de_PLUGIN_META_FILE
  }
  if (typeof previousBetterC0deTestHome === "string") {
    process.env.BetterC0de_TEST_HOME = previousBetterC0deTestHome
  } else {
    delete process.env.BetterC0de_TEST_HOME
  }
  if (typeof previousBetterC0deTestManagedConfigDir === "string") {
    process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR =
      previousBetterC0deTestManagedConfigDir
  } else {
    delete process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR
  }
  if (typeof previousBetterC0deTestManagedPreferencesFile === "string") {
    process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE =
      previousBetterC0deTestManagedPreferencesFile
  } else {
    delete process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE
  }
  if (typeof previousTestBetterC0deShell === "string") {
    process.env.BETTERC0DE_TEST_BetterC0de_SHELL = previousTestBetterC0deShell
  } else {
    delete process.env.BETTERC0DE_TEST_BetterC0de_SHELL
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) =>
        fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
      )
  )
})

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function createRemoteSkillServer(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const url = "https://project-assets.example/"
  __setRemoteProjectFetchDependenciesForTests({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (requestUrl) => {
      if (requestUrl.pathname === "/index.json") {
        return Response.json({
          skills: [
            { name: "remote", files: ["SKILL.md", "README.md"] },
            { name: "missing-skill-md", files: ["README.md"] },
          ],
        })
      }
      if (requestUrl.pathname === "/remote/SKILL.md") {
        return new Response(
          [
            "---",
            "name: remote-skill",
            "description: Remote project skill",
            "---",
            "Remote instructions",
          ].join("\n"),
          { headers: { "content-type": "text/markdown" } }
        )
      }
      if (requestUrl.pathname === "/instructions.md") {
        return new Response("Remote project instruction", {
          headers: { "content-type": "text/markdown" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })

  return {
    url,
    close: async () => undefined,
  }
}

describe("workspace file operations", () => {
  it("reads binary preview data without UTF-8 conversion", async () => {
    const root = await makeWorkspace()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await fs.writeFile(path.join(root, "logo.png"), bytes)

    await expect(
      readBinaryFile({ cwd: root, relative_path: "logo.png" })
    ).resolves.toMatchObject({
      base64: bytes.toString("base64"),
      size: bytes.byteLength,
      path: path.join(root, "logo.png"),
    })
  })

  it("creates directories inside the workspace", async () => {
    const root = await makeWorkspace()

    await createDirectory(root, "src/components")

    expect(
      (await fs.stat(path.join(root, "src", "components"))).isDirectory()
    ).toBe(true)
  })

  it("atomically creates and replaces regular files inside the workspace", async () => {
    const root = await makeWorkspace()

    await writeFile(root, "src/note.txt", "first")
    await writeFile(root, "src/note.txt", "second")

    await expect(
      fs.readFile(path.join(root, "src", "note.txt"), "utf8")
    ).resolves.toBe("second")
    const entries = await fs.readdir(path.join(root, "src"))
    expect(entries).toEqual(["note.txt"])
  })

  it("moves files inside the workspace", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "old.ts"), "export {}", "utf8")

    await movePath(root, "src/old.ts", "src/new.ts")

    await expect(
      fs.readFile(path.join(root, "src", "new.ts"), "utf8")
    ).resolves.toBe("export {}")
    expect(await exists(path.join(root, "src", "old.ts"))).toBe(false)
  })

  it("moves nested folders into another folder and back to the root", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src", "nested"), { recursive: true })
    await fs.mkdir(path.join(root, "assets"))
    await fs.writeFile(path.join(root, "src", "nested", "note.txt"), "keep")
    await movePath(root, "src/nested", "assets/nested")
    await expect(
      fs.readFile(path.join(root, "assets", "nested", "note.txt"), "utf8")
    ).resolves.toBe("keep")
    await movePath(root, "assets/nested", "nested")
    await expect(
      fs.readFile(path.join(root, "nested", "note.txt"), "utf8")
    ).resolves.toBe("keep")
    expect(await exists(path.join(root, "assets", "nested"))).toBe(false)
  })

  it("rejects existing destination files and folders without changing either entry", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"))
    await fs.mkdir(path.join(root, "dest"))
    await fs.writeFile(path.join(root, "src", "file.txt"), "source")
    await fs.writeFile(path.join(root, "dest", "file.txt"), "target")
    await expect(
      movePath(root, "src/file.txt", "dest/file.txt")
    ).rejects.toMatchObject({ statusCode: 409, code: "EEXIST" })
    await expect(
      fs.readFile(path.join(root, "src", "file.txt"), "utf8")
    ).resolves.toBe("source")
    await expect(
      fs.readFile(path.join(root, "dest", "file.txt"), "utf8")
    ).resolves.toBe("target")
    await fs.mkdir(path.join(root, "empty"))
    await expect(movePath(root, "src", "empty")).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(await fs.readdir(path.join(root, "empty"))).toEqual([])
    expect(await exists(path.join(root, "src"))).toBe(true)
  })

  it("rejects moving a folder into itself before creating destination parents", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src", "file.txt"), "keep")
    await expect(movePath(root, "src", "src/new/nested")).rejects.toMatchObject(
      { code: "EINVAL" }
    )
    expect(await fs.readdir(path.join(root, "src"))).toEqual(["file.txt"])
  })

  it("refuses to rename onto a hard link of the same file", async () => {
    // Both names are the same file, but they are not respellings of each
    // other: allowing it would make the rename a silent no-op.
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "a.txt"), "keep")
    await fs.link(path.join(root, "a.txt"), path.join(root, "b.txt"))
    await expect(movePath(root, "a.txt", "b.txt")).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect((await fs.readdir(root)).sort()).toEqual(["a.txt", "b.txt"])
  })

  it("supports same-path and case-only renames", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "note.txt"), "keep")
    await movePath(root, "note.txt", "note.txt")
    await movePath(root, "note.txt", "Note.txt")
    expect(await fs.readdir(root)).toContain("Note.txt")
    await expect(
      fs.readFile(path.join(root, "Note.txt"), "utf8")
    ).resolves.toBe("keep")
  })

  it("deletes files and recursive folders inside the workspace", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "tmp", "nested"), { recursive: true })
    await fs.writeFile(path.join(root, "tmp", "nested", "file.ts"), "")

    await deletePath(root, "tmp", { recursive: true })

    expect(await exists(path.join(root, "tmp"))).toBe(false)
  })

  it("rejects root mutations and traversal", async () => {
    const root = await makeWorkspace()

    await expect(deletePath(root, ".", { recursive: true })).rejects.toThrow(
      "refusing to mutate project root"
    )
    await expect(movePath(root, "src", ".")).rejects.toThrow(
      "refusing to mutate project root"
    )
    await expect(createDirectory(root, "../outside")).rejects.toThrow(
      "path escapes project root"
    )
  })

  it("rejects read, write, move, and delete through an escaping symlink", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const link = path.join(root, "outside-link")
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8")
    await fs.symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir"
    )

    await expect(
      readFile({ cwd: root, relative_path: "outside-link/secret.txt" })
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    await expect(
      readBinaryFile({ cwd: root, relative_path: "outside-link/secret.txt" })
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    await expect(
      writeFile(root, "outside-link/new.txt", "escaped")
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    await expect(
      movePath(root, "outside-link/secret.txt", "moved.txt")
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    await expect(deletePath(root, "outside-link/secret.txt")).rejects.toThrow(
      "workspace path crosses a symbolic link or junction"
    )

    await expect(
      fs.readFile(path.join(outside, "secret.txt"), "utf8")
    ).resolves.toBe("secret")
    await expect(fs.stat(path.join(outside, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects a parent-directory swap immediately before an atomic write commit", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const parent = path.join(root, "safe")
    const movedParent = path.join(root, "safe-original")
    await fs.mkdir(parent)

    __setWorkspaceMutationTestHookForTests(async (phase) => {
      if (phase !== "write:before-commit") return
      await fs.rename(parent, movedParent)
      await fs.symlink(
        outside,
        parent,
        process.platform === "win32" ? "junction" : "dir"
      )
    })

    await expect(
      writeFile(root, "safe/new.txt", "must stay inside")
    ).rejects.toMatchObject({ statusCode: expect.any(Number) })
    await expect(fs.stat(path.join(outside, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects a content change after an optimistic write preimage was read", async () => {
    const root = await makeWorkspace()
    const target = path.join(root, "note.txt")
    await fs.writeFile(target, "agent preimage\n", "utf8")
    const expectedContentHash = createHash("sha256")
      .update("agent preimage\n")
      .digest("hex")

    __setWorkspaceMutationTestHookForTests(async (phase) => {
      if (phase !== "write:before-commit") return
      await fs.writeFile(target, "user edit wins\n", "utf8")
    })

    await expect(
      writeFile(root, "note.txt", "agent replacement\n", {
        expectedContentHash,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "WORKSPACE_PATH_CHANGED",
    })
    await expect(fs.readFile(target, "utf8")).resolves.toBe("user edit wins\n")
  })

  it("rejects a source-parent swap immediately before move", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const parent = path.join(root, "safe")
    const movedParent = path.join(root, "safe-original")
    await fs.mkdir(parent)
    await fs.writeFile(path.join(parent, "item.txt"), "inside", "utf8")
    await fs.writeFile(path.join(outside, "item.txt"), "outside", "utf8")

    __setWorkspaceMutationTestHookForTests(async (phase) => {
      if (phase !== "move:before-commit") return
      await fs.rename(parent, movedParent)
      await fs.symlink(
        outside,
        parent,
        process.platform === "win32" ? "junction" : "dir"
      )
    })

    await expect(
      movePath(root, "safe/item.txt", "moved.txt")
    ).rejects.toMatchObject({ statusCode: expect.any(Number) })
    await expect(
      fs.readFile(path.join(outside, "item.txt"), "utf8")
    ).resolves.toBe("outside")
    await expect(fs.stat(path.join(root, "moved.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects a parent swap immediately before delete quarantine", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const parent = path.join(root, "safe")
    const movedParent = path.join(root, "safe-original")
    await fs.mkdir(parent)
    await fs.writeFile(path.join(parent, "item.txt"), "inside", "utf8")
    await fs.writeFile(path.join(outside, "item.txt"), "outside", "utf8")

    __setWorkspaceMutationTestHookForTests(async (phase) => {
      if (phase !== "delete:before-quarantine") return
      await fs.rename(parent, movedParent)
      await fs.symlink(
        outside,
        parent,
        process.platform === "win32" ? "junction" : "dir"
      )
    })

    await expect(deletePath(root, "safe/item.txt")).rejects.toMatchObject({
      statusCode: expect.any(Number),
    })
    await expect(
      fs.readFile(path.join(outside, "item.txt"), "utf8")
    ).resolves.toBe("outside")
    await expect(
      fs.readFile(path.join(movedParent, "item.txt"), "utf8")
    ).resolves.toBe("inside")
  })

  it("rejects oversized text reads before buffering the file", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "oversized.txt"),
      Buffer.alloc(10 * 1024 * 1024 + 1, 65)
    )

    await expect(
      readFile({ cwd: root, relative_path: "oversized.txt" })
    ).rejects.toMatchObject({ statusCode: 413 })
  })
})

describe("workspace project commands", () => {
  it("loads global BetterC0de command, agent, and skill directories", async () => {
    const root = await makeWorkspace()
    const globalDir = path.join(process.env.XDG_CONFIG_HOME!, "BetterC0de")
    await fs.mkdir(path.join(globalDir, "command"), { recursive: true })
    await fs.mkdir(path.join(globalDir, "agents"), { recursive: true })
    await fs.mkdir(path.join(globalDir, "skills", "global"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(globalDir, "command", "global-review.md"),
      "---\ndescription: Global command\n---\nReview globally",
      "utf8"
    )
    await fs.writeFile(
      path.join(globalDir, "agents", "global-agent.md"),
      "---\ndescription: Global agent\nmode: subagent\n---\nGlobal agent prompt",
      "utf8"
    )
    await fs.writeFile(
      path.join(globalDir, "skills", "global", "SKILL.md"),
      "---\nname: global-skill\ndescription: Global skill\n---\nGlobal skill prompt",
      "utf8"
    )

    await expect(listProjectCommands(root)).resolves.toContainEqual({
      name: "global-review",
      description: "Global command",
      sourcePath: `${path.join(globalDir, "command")}/global-review.md`,
      template: "Review globally",
    })
    await expect(listProjectAgents(root)).resolves.toContainEqual(
      expect.objectContaining({
        id: "global-agent",
        description: "Global agent",
        sourcePath: `${path.join(globalDir, "agents")}/global-agent.md`,
        prompt: "Global agent prompt",
      })
    )
    await expect(listProjectSkills(root)).resolves.toContainEqual({
      id: "global-skill",
      name: "global-skill",
      description: "Global skill",
      sourcePath: `${path.join(globalDir, "skills")}/global/SKILL.md`,
      content: "Global skill prompt",
    })
  })

  it("honors BetterC0de_DISABLE_PROJECT_CONFIG for project BetterC0de files and directories", async () => {
    const root = await makeWorkspace()
    const globalDir = path.join(process.env.XDG_CONFIG_HOME!, "BetterC0de")
    const globalFile = path.join(globalDir, "BetterC0de.jsonc")
    await fs.mkdir(path.join(root, ".BetterC0de", "command"), {
      recursive: true,
    })
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(
      globalFile,
      [
        "{",
        '  "shell": "global-shell",',
        '  "command": {',
        '    "global": {',
        '      "description": "Global config command",',
        '      "template": "Global config template"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "shell": "project-shell",',
        '  "command": {',
        '    "project": {',
        '      "template": "Project config template"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "command", "project-dir.md"),
      "Project directory template",
      "utf8"
    )
    process.env.BetterC0de_DISABLE_PROJECT_CONFIG = "true"

    await expect(getProjectShell(root)).resolves.toBe("global-shell")
    await expect(listProjectCommands(root)).resolves.toEqual([
      {
        name: "global",
        description: "Global config command",
        sourcePath: `${globalFile}#command.global`,
        template: "Global config template",
      },
    ])
  })

  it("loads BetterC0de home and ancestor .BetterC0de directories", async () => {
    const root = await makeWorkspace()
    const projectRoot = path.join(root, "repo", "packages", "app")
    const ancestorDir = path.join(root, "repo", ".BetterC0de")
    const homeDir = path.join(process.env.BetterC0de_TEST_HOME!, ".BetterC0de")

    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true })
    await fs.mkdir(path.join(ancestorDir, "command"), { recursive: true })
    await fs.mkdir(path.join(ancestorDir, "agents"), { recursive: true })
    await fs.mkdir(path.join(ancestorDir, "skills", "parent"), {
      recursive: true,
    })
    await fs.mkdir(path.join(homeDir, "command"), { recursive: true })
    await fs.mkdir(path.join(homeDir, "agents"), { recursive: true })
    await fs.mkdir(path.join(homeDir, "skills", "home"), { recursive: true })

    await fs.writeFile(
      path.join(ancestorDir, "BetterC0de.jsonc"),
      JSON.stringify({
        command: {
          "parent-config": {
            description: "Parent config command",
            template: "Parent config",
          },
        },
        shell: "parent-shell",
      }),
      "utf8"
    )
    await fs.writeFile(
      path.join(ancestorDir, "tui.jsonc"),
      JSON.stringify({ theme: "parent-theme" }),
      "utf8"
    )
    await fs.writeFile(
      path.join(ancestorDir, "command", "parent-review.md"),
      "---\ndescription: Parent command\n---\nParent review",
      "utf8"
    )
    await fs.writeFile(
      path.join(ancestorDir, "agents", "parent-agent.md"),
      "---\ndescription: Parent agent\n---\nParent prompt",
      "utf8"
    )
    await fs.writeFile(
      path.join(ancestorDir, "skills", "parent", "SKILL.md"),
      "---\nname: parent-skill\ndescription: Parent skill\n---\nParent skill prompt",
      "utf8"
    )

    await fs.writeFile(
      path.join(homeDir, "BetterC0de.jsonc"),
      JSON.stringify({
        command: {
          "home-config": {
            description: "Home config command",
            template: "Home config",
          },
        },
        shell: "home-shell",
      }),
      "utf8"
    )
    await fs.writeFile(
      path.join(homeDir, "tui.jsonc"),
      JSON.stringify({ theme: "home-theme" }),
      "utf8"
    )
    await fs.writeFile(
      path.join(homeDir, "command", "home-review.md"),
      "---\ndescription: Home command\n---\nHome review",
      "utf8"
    )
    await fs.writeFile(
      path.join(homeDir, "agents", "home-agent.md"),
      "---\ndescription: Home agent\n---\nHome prompt",
      "utf8"
    )
    await fs.writeFile(
      path.join(homeDir, "skills", "home", "SKILL.md"),
      "---\nname: home-skill\ndescription: Home skill\n---\nHome skill prompt",
      "utf8"
    )

    await expect(listProjectCommands(projectRoot)).resolves.toEqual(
      expect.arrayContaining([
        {
          name: "parent-config",
          description: "Parent config command",
          sourcePath: `${path.join(
            ancestorDir,
            "BetterC0de.jsonc"
          )}#command.parent-config`,
          template: "Parent config",
        },
        {
          name: "parent-review",
          description: "Parent command",
          sourcePath: `${path.join(ancestorDir, "command")}/parent-review.md`,
          template: "Parent review",
        },
        {
          name: "home-config",
          description: "Home config command",
          sourcePath: "~/.BetterC0de/BetterC0de.jsonc#command.home-config",
          template: "Home config",
        },
        {
          name: "home-review",
          description: "Home command",
          sourcePath: "~/.BetterC0de/command/home-review.md",
          template: "Home review",
        },
      ])
    )
    await expect(listProjectAgents(projectRoot)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "parent-agent",
          description: "Parent agent",
          sourcePath: `${path.join(ancestorDir, "agents")}/parent-agent.md`,
          prompt: "Parent prompt",
        }),
        expect.objectContaining({
          id: "home-agent",
          description: "Home agent",
          sourcePath: "~/.BetterC0de/agents/home-agent.md",
          prompt: "Home prompt",
        }),
      ])
    )
    await expect(listProjectSkills(projectRoot)).resolves.toEqual(
      expect.arrayContaining([
        {
          id: "parent-skill",
          name: "parent-skill",
          description: "Parent skill",
          sourcePath: `${path.join(ancestorDir, "skills")}/parent/SKILL.md`,
          content: "Parent skill prompt",
        },
        {
          id: "home-skill",
          name: "home-skill",
          description: "Home skill",
          sourcePath: "~/.BetterC0de/skills/home/SKILL.md",
          content: "Home skill prompt",
        },
      ])
    )

    const settings = await listProjectConfigSettings(projectRoot)
    expect(settings).toEqual(
      expect.arrayContaining([
        {
          key: "shell",
          label: "Shell",
          kind: "scalar",
          value: "parent-shell",
          sourcePath: `${path.join(ancestorDir, "BetterC0de.jsonc")}#shell`,
        },
        {
          key: "shell",
          label: "Shell",
          kind: "scalar",
          value: "home-shell",
          sourcePath: "~/.BetterC0de/BetterC0de.jsonc#shell",
        },
        {
          key: "theme",
          label: "TUI theme",
          kind: "scalar",
          value: "parent-theme",
          sourcePath: `${path.join(ancestorDir, "tui.jsonc")}#theme`,
        },
        {
          key: "theme",
          label: "TUI theme",
          kind: "scalar",
          value: "home-theme",
          sourcePath: "~/.BetterC0de/tui.jsonc#theme",
        },
      ])
    )
  })

  it("loads BetterC0de command templates from singular and plural directories", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, ".BetterC0de", "command", "nested"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".BetterC0de", "commands"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "command", "hello.md"),
      [
        "---",
        "description: Test command",
        "agent: build",
        "model: test/model",
        "subtask: true",
        "---",
        "Hello $ARGUMENTS",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "command", "nested", "child.md"),
      "---\ndescription: Nested command\n---\nNested template",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "commands", "plural.md"),
      "Plural command",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "command": {',
        '    "config": {',
        '      "template": "Config $ARGUMENTS",',
        '      "description": "Config command",',
        '      "agent": "build",',
        '      "model": "test/model",',
        '      "subtask": false,',
        "    },",
        '    "hello": {',
        '      "template": "Config command should lose to markdown",',
        '      "description": "Config duplicate"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectCommands(root)).resolves.toEqual([
      {
        name: "config",
        description: "Config command",
        agent: "build",
        model: "test/model",
        subtask: false,
        sourcePath: "BetterC0de.jsonc#command.config",
        template: "Config $ARGUMENTS",
      },
      {
        name: "hello",
        description: "Test command",
        agent: "build",
        model: "test/model",
        subtask: true,
        sourcePath: ".BetterC0de/command/hello.md",
        template: "Hello $ARGUMENTS",
      },
      {
        name: "nested/child",
        description: "Nested command",
        sourcePath: ".BetterC0de/command/nested/child.md",
        template: "Nested template",
      },
      {
        name: "plural",
        sourcePath: ".BetterC0de/commands/plural.md",
        template: "Plural command",
      },
    ])
  })
})

describe("workspace project agents", () => {
  it("loads BetterC0de agent templates from singular and plural directories", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, ".BetterC0de", "agent"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".BetterC0de", "agents", "nested"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".BetterC0de", "mode"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "agent", "reviewer.md"),
      [
        "---",
        "name: Code Reviewer",
        "description: Reviews risky changes",
        "model: test/model",
        "mode: subagent",
        "variant: careful",
        "temperature: 0.2",
        "top_p: 0.8",
        "color: primary",
        "maxSteps: 7",
        "hidden: false",
        "tools:",
        "  read: true",
        "  write: false",
        "permission:",
        "  edit: ask",
        "  bash:",
        "    npm test: allow",
        "options:",
        "  effort: high",
        "customMarkdownFlag: true",
        "---",
        "Review carefully",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "agents", "nested", "helper.md"),
      "---\nmode: subagent\n---\nNested helper prompt",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "mode", "architect.md"),
      [
        "---",
        "name: Architect Mode",
        "model: test/architect",
        "mode: subagent",
        "---",
        "Think in architecture constraints",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        agent: {
          "config-helper": {
            name: "Config Helper",
            description: "Config-defined subagent",
            prompt: "Use config helper rules",
            mode: "subagent",
            model: "test/model",
            variant: "fast",
            temperature: 0.1,
            top_p: 0.9,
            color: "#00ffaa",
            steps: 5,
            tools: {
              write: false,
              read: true,
            },
            permission: {
              edit: "ask",
              bash: {
                "npm test": "allow",
              },
            },
            options: {
              effort: "high",
            },
            customFlag: true,
          },
          disabled: {
            prompt: "Visible but not selectable",
            disable: true,
          },
          hidden: {
            prompt: "Hide from mentions",
            hidden: true,
          },
          reviewer: {
            name: "Config Reviewer",
            prompt: "Config agent should lose to markdown",
            mode: "primary",
          },
        },
        mode: {
          planner: {
            prompt: "Plan from config",
            model: "test/planner",
          },
        },
      }),
      "utf8"
    )

    await expect(listProjectAgents(root)).resolves.toEqual([
      {
        id: "architect",
        name: "Architect Mode",
        enabled: true,
        model: "test/architect",
        mode: "primary",
        sourcePath: ".BetterC0de/mode/architect.md",
        prompt: "Think in architecture constraints",
        tools: {},
        optionKeys: [],
        permissions: [],
      },
      {
        id: "config-helper",
        name: "Config Helper",
        description: "Config-defined subagent",
        enabled: true,
        model: "test/model",
        mode: "subagent",
        variant: "fast",
        temperature: 0.1,
        topP: 0.9,
        color: "#00ffaa",
        steps: 5,
        sourcePath: "BetterC0de.json#agent.config-helper",
        prompt: "Use config helper rules",
        tools: {
          read: true,
          write: false,
        },
        optionKeys: ["customFlag", "effort"],
        permissions: [
          {
            permission: "edit",
            pattern: "*",
            action: "ask",
            sourcePath: "BetterC0de.json#agent.config-helper#permission.edit",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
            sourcePath: "BetterC0de.json#agent.config-helper#tools.read",
          },
          {
            permission: "bash",
            pattern: "npm test",
            action: "allow",
            sourcePath:
              "BetterC0de.json#agent.config-helper#permission.bash.npm test",
          },
        ],
      },
      {
        id: "disabled",
        name: "disabled",
        enabled: false,
        sourcePath: "BetterC0de.json#agent.disabled",
        prompt: "Visible but not selectable",
        tools: {},
        optionKeys: [],
        permissions: [],
      },
      {
        id: "hidden",
        name: "hidden",
        enabled: true,
        hidden: true,
        sourcePath: "BetterC0de.json#agent.hidden",
        prompt: "Hide from mentions",
        tools: {},
        optionKeys: [],
        permissions: [],
      },
      {
        id: "nested/helper",
        name: "nested/helper",
        enabled: true,
        mode: "subagent",
        sourcePath: ".BetterC0de/agents/nested/helper.md",
        prompt: "Nested helper prompt",
        tools: {},
        optionKeys: [],
        permissions: [],
      },
      {
        id: "planner",
        name: "planner",
        enabled: true,
        model: "test/planner",
        mode: "primary",
        sourcePath: "BetterC0de.json#mode.planner",
        prompt: "Plan from config",
        tools: {},
        optionKeys: [],
        permissions: [],
      },
      {
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews risky changes",
        enabled: true,
        hidden: false,
        model: "test/model",
        mode: "subagent",
        variant: "careful",
        temperature: 0.2,
        topP: 0.8,
        color: "primary",
        steps: 7,
        sourcePath: ".BetterC0de/agent/reviewer.md",
        prompt: "Review carefully",
        tools: {
          read: true,
          write: false,
        },
        optionKeys: ["customMarkdownFlag", "effort"],
        permissions: [
          {
            permission: "edit",
            pattern: "*",
            action: "ask",
            sourcePath: ".BetterC0de/agent/reviewer.md#permission.edit",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
            sourcePath: ".BetterC0de/agent/reviewer.md#tools.read",
          },
          {
            permission: "bash",
            pattern: "npm test",
            action: "allow",
            sourcePath:
              ".BetterC0de/agent/reviewer.md#permission.bash.npm test",
          },
        ],
      },
    ])
  })
})

describe("workspace project skills", () => {
  it("includes the BetterC0de built-in customize skill and lets disk skills override it", async () => {
    const root = await makeWorkspace()

    await expect(listProjectSkills(root)).resolves.toEqual([
      expect.objectContaining({
        id: "customize-betterc0de",
        name: "customize-betterc0de",
        sourcePath: "<built-in>",
        content: expect.stringContaining("# Customizing BetterC0de"),
      }),
    ])

    await fs.mkdir(path.join(root, ".BetterC0de", "skills", "customize"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "skills", "customize", "SKILL.md"),
      "---\nname: customize-betterc0de\ndescription: Project override\n---\nProject override body",
      "utf8"
    )

    await expect(listProjectSkills(root)).resolves.toEqual([
      {
        id: "customize-betterc0de",
        name: "customize-betterc0de",
        description: "Project override",
        sourcePath: ".BetterC0de/skills/customize/SKILL.md",
        content: "Project override body",
      },
    ])
  })

  it("loads BetterC0de and external project skills from SKILL.md files", async () => {
    const root = await makeWorkspace()
    const remote = await createRemoteSkillServer()
    await fs.mkdir(path.join(root, ".BetterC0de", "skills", "review"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".BetterC0de", "skill", "design"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".agents", "skills", "frontend"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, "custom-skills", "local"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: project-review",
        "description: Review local project changes",
        "---",
        "# Review",
        "",
        "Use repo-specific review rules.",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "skill", "design", "SKILL.md"),
      "---\nname: project-design\n---\nDesign instructions",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".agents", "skills", "frontend", "SKILL.md"),
      "---\nname: frontend-agent-skill\n---\nFrontend instructions",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "skills", "ignored.md"),
      "---\nname: ignored\n---\nNot a SKILL.md",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "custom-skills", "local", "SKILL.md"),
      "---\nname: config-path-skill\n---\nConfigured skill path",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        "  // BetterC0de-compatible project skills",
        '  "skills": {',
        '    "paths": ["custom-skills", "/tmp/outside", "~/outside"],',
        `    "urls": [${JSON.stringify(remote.url)}, "ftp://ignored"],`,
        "  },",
        "}",
      ].join("\n"),
      "utf8"
    )

    try {
      await expect(listProjectSkills(root)).resolves.toEqual([
        {
          id: "config-path-skill",
          name: "config-path-skill",
          sourcePath: "custom-skills/local/SKILL.md",
          content: "Configured skill path",
        },
        expect.objectContaining({
          id: "customize-betterc0de",
          name: "customize-betterc0de",
          sourcePath: "<built-in>",
        }),
        {
          id: "frontend-agent-skill",
          name: "frontend-agent-skill",
          sourcePath: ".agents/skills/frontend/SKILL.md",
          content: "Frontend instructions",
        },
        {
          id: "project-design",
          name: "project-design",
          sourcePath: ".BetterC0de/skill/design/SKILL.md",
          content: "Design instructions",
        },
        {
          id: "project-review",
          name: "project-review",
          description: "Review local project changes",
          sourcePath: ".BetterC0de/skills/review/SKILL.md",
          content: "# Review\n\nUse repo-specific review rules.",
        },
        {
          id: "remote-skill",
          name: "remote-skill",
          description: "Remote project skill",
          sourcePath: `${remote.url}remote/SKILL.md`,
          sourceUrl: remote.url,
          content: "Remote instructions",
        },
      ])
    } finally {
      await remote.close()
    }
  })

  it("single-flights concurrent remote skill loads for the same source URL", async () => {
    const root = await makeWorkspace()
    const sourceUrl = "https://single-flight-skills.example/"
    let indexRequests = 0
    let skillRequests = 0
    let releaseIndex!: () => void
    let markIndexStarted!: () => void
    const indexGate = new Promise<void>((resolve) => {
      releaseIndex = resolve
    })
    const indexStarted = new Promise<void>((resolve) => {
      markIndexStarted = resolve
    })
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (url) => {
        if (url.pathname === "/index.json") {
          indexRequests += 1
          markIndexStarted()
          await indexGate
          return Response.json({
            skills: [{ name: "shared", files: ["SKILL.md"] }],
          })
        }
        if (url.pathname === "/shared/SKILL.md") {
          skillRequests += 1
          return new Response("---\nname: shared\n---\nShared instructions")
        }
        return new Response("not found", { status: 404 })
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ skills: { urls: [sourceUrl] } }),
      "utf8"
    )

    const loads = [listProjectSkills(root), listProjectSkills(root)]
    await indexStarted
    for (let turn = 0; turn < 25; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    releaseIndex()

    const results = await Promise.all(loads)
    expect(indexRequests).toBe(1)
    expect(skillRequests).toBe(1)
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "shared",
            content: "Shared instructions",
          }),
        ])
      )
    }
  })

  it("caps configured remote skill sources and shares their deadline signal", async () => {
    const root = await makeWorkspace()
    const sourceUrls = Array.from(
      { length: 9 },
      (_, index) => `https://skill-source-${index}.example/`
    )
    const requestedHosts: string[] = []
    const signals = new Set<AbortSignal>()
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (url, _address, signal) => {
        requestedHosts.push(url.hostname)
        signals.add(signal)
        return Response.json({ skills: [] })
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ skills: { urls: sourceUrls } }),
      "utf8"
    )

    await listProjectSkills(root)

    expect(requestedHosts).toHaveLength(8)
    expect(requestedHosts).not.toContain("skill-source-8.example")
    expect(signals.size).toBe(1)
  })

  it("uses one total deadline signal for the skill index and all fetch waves", async () => {
    const root = await makeWorkspace()
    const sourceUrl = "https://deadline-skills.example/"
    const requestedPaths: string[] = []
    const signals = new Set<AbortSignal>()
    let markFirstWaveStarted!: () => void
    const firstWaveStarted = new Promise<void>((resolve) => {
      markFirstWaveStarted = resolve
    })
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (url, _address, signal) => {
        requestedPaths.push(url.pathname)
        signals.add(signal)
        if (url.pathname === "/index.json") {
          return Response.json({
            skills: Array.from({ length: 9 }, (_, index) => ({
              name: `skill-${index}`,
              files: ["SKILL.md"],
            })),
          })
        }

        if (requestedPaths.length === 9) {
          markFirstWaveStarted()
        }
        return await new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"))
            return
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          })
        })
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ skills: { urls: [sourceUrl] } }),
      "utf8"
    )

    vi.useFakeTimers()
    try {
      let settled = false
      const load = listProjectSkills(root)
      void load.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await firstWaveStarted
      await vi.advanceTimersByTimeAsync(5_000)
      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve()
      }
      const settledAtDeadline = settled
      if (!settled) await vi.runAllTimersAsync()
      const result = await load

      expect(settledAtDeadline).toBe(true)
      expect(signals.size).toBe(1)
      expect(requestedPaths).toHaveLength(9)
      expect(requestedPaths).not.toContain("/skill-8/SKILL.md")
      expect(result.map((skill) => skill.id)).toEqual(["customize-betterc0de"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("honors BetterC0de external skill disable flags", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, ".BetterC0de", "skills", "review"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".agents", "skills", "frontend"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, ".claude", "skills", "claude-review"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "skills", "review", "SKILL.md"),
      "---\nname: project-review\n---\nProject skill",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".agents", "skills", "frontend", "SKILL.md"),
      "---\nname: frontend-agent-skill\n---\nAgent skill",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".claude", "skills", "claude-review", "SKILL.md"),
      "---\nname: claude-skill\n---\nClaude skill",
      "utf8"
    )

    process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS = "true"
    await expect(listProjectSkills(root)).resolves.toEqual([
      expect.objectContaining({
        id: "customize-betterc0de",
        name: "customize-betterc0de",
        sourcePath: "<built-in>",
      }),
      {
        id: "frontend-agent-skill",
        name: "frontend-agent-skill",
        sourcePath: ".agents/skills/frontend/SKILL.md",
        content: "Agent skill",
      },
      {
        id: "project-review",
        name: "project-review",
        sourcePath: ".BetterC0de/skills/review/SKILL.md",
        content: "Project skill",
      },
    ])

    process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS = ""
    process.env.BetterC0de_DISABLE_EXTERNAL_SKILLS = "1"
    await expect(listProjectSkills(root)).resolves.toEqual([
      expect.objectContaining({
        id: "customize-betterc0de",
        name: "customize-betterc0de",
        sourcePath: "<built-in>",
      }),
      {
        id: "project-review",
        name: "project-review",
        sourcePath: ".BetterC0de/skills/review/SKILL.md",
        content: "Project skill",
      },
    ])
  })
})

describe("workspace project MCP servers", () => {
  it("loads BetterC0de MCP server definitions from project config", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "mcp": {',
        '    "local-demo": {',
        '      "type": "local",',
        '      "command": ["node", "server.js", "--stdio"],',
        '      "environment": { "TOKEN": "dev" },',
        '      "timeout": 3000',
        "    },",
        '    "remote-demo": {',
        '      "type": "remote",',
        '      "url": "https://example.com/mcp",',
        '      "enabled": false,',
        '      "headers": { "Authorization": "Bearer test" },',
        '      "oauth": { "clientId": "abc", "scope": "repo" },',
        '      "timeout": 9000',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectMcpServers(root)).resolves.toEqual([
      {
        id: "local-demo",
        name: "local-demo",
        type: "local",
        command: "node",
        args: ["server.js", "--stdio"],
        env: { TOKEN: "dev" },
        envKeys: ["TOKEN"],
        enabled: true,
        sourcePath: "BetterC0de.jsonc#mcp.local-demo",
        timeoutMs: 3000,
      },
      {
        id: "remote-demo",
        name: "remote-demo",
        type: "remote",
        command: "https://example.com/mcp",
        args: [],
        env: { Authorization: "Bearer test" },
        headerKeys: ["Authorization"],
        enabled: false,
        sourcePath: "BetterC0de.jsonc#mcp.remote-demo",
        url: "https://example.com/mcp",
        timeoutMs: 9000,
        oauth: "configured",
        oauthKeys: ["clientId", "scope"],
        authStatus: "not_authenticated",
      },
    ])
  })

  it("loads BetterC0de MCP OAuth auth status without exposing token values", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "mcp": {',
        '    "github": {',
        '      "type": "remote",',
        '      "url": "https://example.com/mcp"',
        "    },",
        '    "expired": {',
        '      "type": "remote",',
        '      "url": "https://expired.example.com/mcp"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    const authDir = path.join(process.env.XDG_DATA_HOME!, "BetterC0de")
    await fs.mkdir(authDir, { recursive: true })
    await fs.writeFile(
      path.join(authDir, "mcp-auth.json"),
      JSON.stringify({
        github: {
          serverUrl: "https://example.com/mcp",
          tokens: {
            accessToken: "secret-access-token",
            refreshToken: "secret-refresh-token",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            scope: "repo",
          },
          clientInfo: {
            clientId: "visible-id-but-not-surfaced",
            clientSecret: "secret-client",
          },
          oauthState: "state-secret",
        },
        expired: {
          serverUrl: "https://expired.example.com/mcp",
          tokens: {
            accessToken: "expired-secret-access-token",
            expiresAt: 1,
          },
        },
      }),
      "utf8"
    )

    const servers = await listProjectMcpServers(root)

    expect(servers).toEqual([
      expect.objectContaining({
        id: "expired",
        authStatus: "expired",
        authStorageKeys: ["tokens", "serverUrl"],
      }),
      expect.objectContaining({
        id: "github",
        authStatus: "authenticated",
        authStorageKeys: ["tokens", "clientInfo", "oauthState", "serverUrl"],
        authServerUrl: "https://example.com/mcp",
      }),
    ])
    expect(JSON.stringify(servers)).not.toContain("secret-access-token")
    expect(JSON.stringify(servers)).not.toContain("secret-refresh-token")
    expect(JSON.stringify(servers)).not.toContain("secret-client")
    expect(JSON.stringify(servers)).not.toContain("state-secret")
  })
})

describe("workspace project instructions", () => {
  it("loads safe BetterC0de instruction files from project config", async () => {
    const root = await makeWorkspace()
    const remote = await createRemoteSkillServer()
    await fs.mkdir(path.join(root, "docs", "rules"), { recursive: true })
    await fs.writeFile(
      path.join(root, "PROJECT.md"),
      "Project instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "docs", "rules", "frontend.md"),
      "Frontend instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "instructions": [',
        '    "PROJECT.md",',
        '    "docs/rules/*.md",',
        `    ${JSON.stringify(`${remote.url}instructions.md`)},`,
        '    "../outside.md"',
        "  ]",
        "}",
      ].join("\n"),
      "utf8"
    )

    try {
      await expect(listProjectInstructions(root)).resolves.toEqual([
        {
          sourcePath: "docs/rules/frontend.md",
          content: "Frontend instruction",
        },
        {
          sourcePath: `${remote.url}instructions.md`,
          content: "Remote project instruction",
        },
        {
          sourcePath: "PROJECT.md",
          content: "Project instruction",
        },
      ])
    } finally {
      await remote.close()
    }
  })

  it("reads oversized local instructions through a UTF-8-safe byte cap", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      `x${"😀".repeat(70_000)}`,
      "utf8"
    )

    const instructions = await listProjectInstructions(root)

    expect(instructions).toHaveLength(1)
    expect(instructions[0]?.content).toContain("...[truncated]")
    expect(instructions[0]?.content).not.toContain("\uFFFD")
    expect(
      Buffer.byteLength(instructions[0]?.content ?? "", "utf8")
    ).toBeLessThan(257 * 1024)
  })

  it("caps aggregate local instruction content", async () => {
    const root = await makeWorkspace()
    const fileNames = Array.from(
      { length: 12 },
      (_, index) => `RULE-${index}.md`
    )
    for (const [index, fileName] of fileNames.entries()) {
      await fs.writeFile(
        path.join(root, fileName),
        `${index}:${"r".repeat(240 * 1024)}`,
        "utf8"
      )
    }
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ instructions: fileNames }),
      "utf8"
    )

    const instructions = await listProjectInstructions(root)
    const aggregateBytes = instructions.reduce(
      (total, item) => total + Buffer.byteLength(item.content, "utf8"),
      0
    )

    expect(aggregateBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(instructions.length).toBeLessThan(fileNames.length)
  })

  it("single-flights concurrent remote instruction loads for the same URL", async () => {
    const root = await makeWorkspace()
    const instructionUrl =
      "https://single-flight-instructions.example/instructions.md"
    let instructionRequests = 0
    let releaseRequest!: () => void
    let markRequestStarted!: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve
    })
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (url) => {
        if (url.href === instructionUrl) {
          instructionRequests += 1
          markRequestStarted()
          await requestGate
          return new Response("Shared remote instruction")
        }
        return new Response("not found", { status: 404 })
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ instructions: [instructionUrl] }),
      "utf8"
    )

    const loads = [listProjectInstructions(root), listProjectInstructions(root)]
    await requestStarted
    for (let turn = 0; turn < 25; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    releaseRequest()

    const results = await Promise.all(loads)
    expect(instructionRequests).toBe(1)
    expect(results).toEqual([
      [{ sourcePath: instructionUrl, content: "Shared remote instruction" }],
      [{ sourcePath: instructionUrl, content: "Shared remote instruction" }],
    ])
  })

  it("caps remote instructions under one total fetch deadline", async () => {
    const root = await makeWorkspace()
    const instructionUrls = Array.from(
      { length: 9 },
      (_, index) => `https://instruction-source-${index}.example/rules.md`
    )
    const requestedUrls: string[] = []
    const signals = new Set<AbortSignal>()
    let markRequestsStarted!: () => void
    const requestsStarted = new Promise<void>((resolve) => {
      markRequestsStarted = resolve
    })
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (url, _address, signal) => {
        requestedUrls.push(url.href)
        signals.add(signal)
        if (requestedUrls.length === 8) markRequestsStarted()
        return await new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"))
            return
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          })
        })
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ instructions: instructionUrls }),
      "utf8"
    )

    vi.useFakeTimers()
    try {
      let settled = false
      const load = listProjectInstructions(root)
      void load.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await requestsStarted
      await vi.advanceTimersByTimeAsync(5_000)
      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve()
      }
      const settledAtDeadline = settled
      if (!settled) await vi.runAllTimersAsync()
      const result = await load

      expect(settledAtDeadline).toBe(true)
      expect(requestedUrls).toHaveLength(8)
      expect(requestedUrls).not.toContain(instructionUrls[8])
      expect(signals.size).toBe(1)
      expect(result).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("loads BetterC0de default global, home, and ancestor instruction files", async () => {
    const root = await makeWorkspace()
    const projectRoot = path.join(root, "repo", "app")
    const globalDir = path.join(process.env.XDG_CONFIG_HOME!, "BetterC0de")
    const homeNotesDir = path.join(process.env.BetterC0de_TEST_HOME!, "notes")
    await fs.mkdir(projectRoot, { recursive: true })
    await fs.mkdir(globalDir, { recursive: true })
    await fs.mkdir(homeNotesDir, { recursive: true })
    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      "Global agents instruction",
      "utf8"
    )
    await fs.mkdir(path.join(process.env.BetterC0de_TEST_HOME!, ".claude"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(process.env.BetterC0de_TEST_HOME!, ".claude", "CLAUDE.md"),
      "Home Claude instruction should lose to global AGENTS",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "repo", "AGENTS.md"),
      "Ancestor agents instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(projectRoot, "CLAUDE.md"),
      "Project Claude instruction should lose to AGENTS",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "repo", "PLAYBOOK.md"),
      "Ancestor playbook",
      "utf8"
    )
    await fs.writeFile(
      path.join(homeNotesDir, "brief.md"),
      "Home brief instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(projectRoot, "BetterC0de.jsonc"),
      JSON.stringify({
        instructions: ["PLAYBOOK.md", "~/notes/brief.md"],
      }),
      "utf8"
    )

    const instructions = await listProjectInstructions(projectRoot)

    expect(instructions).toEqual(
      expect.arrayContaining([
        {
          sourcePath: path.join(globalDir, "AGENTS.md"),
          content: "Global agents instruction",
        },
        {
          sourcePath: `${path.join(root, "repo", "AGENTS.md")}`,
          content: "Ancestor agents instruction",
        },
        {
          sourcePath: `${path.join(root, "repo", "PLAYBOOK.md")}`,
          content: "Ancestor playbook",
        },
        {
          sourcePath: "~/notes/brief.md",
          content: "Home brief instruction",
        },
      ])
    )
    expect(instructions.map((item) => item.content)).not.toContain(
      "Home Claude instruction should lose to global AGENTS"
    )
    expect(instructions.map((item) => item.content)).not.toContain(
      "Project Claude instruction should lose to AGENTS"
    )
  })

  it("honors BetterC0de_DISABLE_CLAUDE_CODE_PROMPT for default instruction files", async () => {
    const root = await makeWorkspace()
    const projectRoot = path.join(root, "repo")
    await fs.mkdir(projectRoot, { recursive: true })
    await fs.mkdir(path.join(process.env.BetterC0de_TEST_HOME!, ".claude"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(process.env.BetterC0de_TEST_HOME!, ".claude", "CLAUDE.md"),
      "Home Claude instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(projectRoot, "CLAUDE.md"),
      "Project Claude instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(projectRoot, "CONTEXT.md"),
      "Project context instruction",
      "utf8"
    )

    process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT = "true"

    await expect(listProjectInstructions(projectRoot)).resolves.toEqual([
      {
        sourcePath: "CONTEXT.md",
        content: "Project context instruction",
      },
    ])
  })

  it("honors BetterC0de_DISABLE_PROJECT_CONFIG for default instruction files", async () => {
    const root = await makeWorkspace()
    const globalDir = path.join(process.env.XDG_CONFIG_HOME!, "BetterC0de")
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      "Global agents instruction",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      "Project agents instruction",
      "utf8"
    )

    process.env.BetterC0de_DISABLE_PROJECT_CONFIG = "true"

    await expect(listProjectInstructions(root)).resolves.toEqual([
      {
        sourcePath: path.join(globalDir, "AGENTS.md"),
        content: "Global agents instruction",
      },
    ])
  })

  it("does not expand workspace environment variables into metadata or outbound URLs", async () => {
    const root = await makeWorkspace()
    const envName = "BETTERC0DE_WORKSPACE_SECRET_SENTINEL"
    const sentinel = "workspace-secret-sentinel-value"
    const requestedUrls: string[] = []
    process.env[envName] = sentinel
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (url) => {
        requestedUrls.push(url.href)
        return new Response("")
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({
        shell: `{env:${envName}}`,
        instructions: [`https://public.example/{env:${envName}}`],
      }),
      "utf8"
    )

    try {
      const settings = await listProjectConfigSettings(root)
      const instructions = await listProjectInstructions(root)
      expect(JSON.stringify({ settings, instructions })).not.toContain(sentinel)
      expect(requestedUrls).not.toEqual([])
      expect(requestedUrls.join("\n")).not.toContain(sentinel)
    } finally {
      delete process.env[envName]
    }
  })

  it("rejects loopback, private, link-local, and IPv6-local remote instructions", async () => {
    const root = await makeWorkspace()
    const requestedUrls: string[] = []
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async (hostname) => {
        if (hostname === "localhost")
          return [{ address: "127.0.0.1", family: 4 }]
        if (hostname === "private.example")
          return [{ address: "10.0.0.8", family: 4 }]
        if (hostname === "metadata.example") {
          return [{ address: "169.254.169.254", family: 4 }]
        }
        return [{ address: "::1", family: 6 }]
      },
      request: async (url) => {
        requestedUrls.push(url.href)
        return new Response("must not be reached")
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({
        instructions: [
          "https://localhost/rules.md",
          "https://private.example/rules.md",
          "https://metadata.example/latest/meta-data/",
          "https://[::1]/rules.md",
        ],
      }),
      "utf8"
    )

    const instructions = await listProjectInstructions(root)
    expect(instructions.map((entry) => entry.sourcePath)).not.toEqual(
      expect.arrayContaining([
        "https://localhost/rules.md",
        "https://private.example/rules.md",
        "https://metadata.example/latest/meta-data/",
        "https://[::1]/rules.md",
      ])
    )
    expect(requestedUrls).toEqual([])
  })

  it("revalidates a public redirect before following it to a private address", async () => {
    const root = await makeWorkspace()
    const requestedUrls: string[] = []
    __setRemoteProjectFetchDependenciesForTests({
      lookup: async (hostname) =>
        hostname === "redirect.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }],
      request: async (url) => {
        requestedUrls.push(url.href)
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        })
      },
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({
        instructions: ["https://redirect.example/rules.md"],
      }),
      "utf8"
    )

    await listProjectInstructions(root)
    expect(requestedUrls).toEqual(["https://redirect.example/rules.md"])
  })
})

describe("workspace project references", () => {
  it("loads BetterC0de reference config and keeps unsafe entries visible", async () => {
    const root = await makeWorkspace()
    const outsideName = `${path.basename(root)}-outside`
    const outsideRoot = path.resolve(root, "..", outsideName)
    const homeReferenceRoot = path.join(
      process.env.BetterC0de_TEST_HOME!,
      "reference-docs"
    )
    await fs.mkdir(path.join(root, "docs"), { recursive: true })
    await fs.mkdir(outsideRoot, { recursive: true })
    await fs.mkdir(homeReferenceRoot, { recursive: true })
    tempRoots.push(outsideRoot)
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "reference": {',
        '    "docs": "./docs",',
        '    "effect": { "repository": "Effect-TS/effect", "branch": "main" },',
        '    "home": "~/reference-docs",',
        '    "missing": "./missing-docs",',
        `    "outside": "../${outsideName}",`,
        '    "bad/name": "not-a-repo"',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectReferences(root)).resolves.toEqual([
      {
        id: "bad/name",
        name: "bad/name",
        kind: "invalid",
        sourcePath: "BetterC0de.jsonc#reference.bad/name",
        message:
          "Reference alias must not contain /, whitespace, comma, or backtick",
      },
      {
        id: "docs",
        name: "docs",
        kind: "local",
        sourcePath: "BetterC0de.jsonc#reference.docs",
        path: path.join(root, "docs"),
        relativePath: "docs",
        exists: true,
      },
      {
        id: "effect",
        name: "effect",
        kind: "git",
        sourcePath: "BetterC0de.jsonc#reference.effect",
        repository: "Effect-TS/effect",
        branch: "main",
      },
      {
        id: "home",
        name: "home",
        kind: "local",
        sourcePath: "BetterC0de.jsonc#reference.home",
        path: homeReferenceRoot,
        exists: true,
      },
      {
        id: "missing",
        name: "missing",
        kind: "local",
        sourcePath: "BetterC0de.jsonc#reference.missing",
        path: path.join(root, "missing-docs"),
        relativePath: "missing-docs",
        exists: false,
        message: "Reference path does not exist or is not a directory yet",
      },
      {
        id: "outside",
        name: "outside",
        kind: "local",
        sourcePath: "BetterC0de.jsonc#reference.outside",
        path: outsideRoot,
        exists: true,
      },
    ])
  })
})

describe("workspace BetterC0de execution config", () => {
  it("loads formatter, LSP, and permission config from BetterC0de project config", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "formatter": {',
        '    "prettier": {',
        '      "command": ["npx", "prettier", "--write"],',
        '      "environment": { "NODE_ENV": "development" },',
        '      "extensions": [".ts", ".tsx"]',
        "    },",
        '    "go": { "disabled": true, "extensions": [".go"] }',
        "  },",
        '  "lsp": {',
        '    "typescript": {',
        '      "command": ["typescript-language-server", "--stdio"],',
        '      "extensions": [".ts", ".tsx"],',
        '      "env": { "TSS_LOG": "off" },',
        '      "initialization": { "locale": "en" }',
        "    },",
        '    "legacy": { "disabled": true }',
        "  },",
        '  "permission": {',
        '    "edit": "ask",',
        '    "bash": {',
        '      "npm test*": "allow",',
        '      "rm -rf*": "deny"',
        "    },",
        '    "webfetch": "deny"',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    const formatters = await listProjectFormatters(root)
    expect(formatters.length).toBeGreaterThan(10)
    expect(formatters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gofmt",
          name: "gofmt",
          enabled: true,
          sourcePath: "BetterC0de.jsonc#formatter.gofmt",
          command: "",
          args: [],
          extensions: [".go"],
          builtin: true,
        }),
        expect.objectContaining({
          id: "prettier",
          name: "prettier",
          enabled: true,
          sourcePath: "BetterC0de.jsonc#formatter.prettier",
          command: "npx",
          args: ["prettier", "--write"],
          env: { BUN_BE_BUN: "1", NODE_ENV: "development" },
          extensions: [".ts", ".tsx"],
          builtin: false,
        }),
      ])
    )
    expect(formatters.some((formatter) => formatter.id === "go")).toBe(false)

    const lspServers = await listProjectLspServers(root)
    expect(lspServers.length).toBeGreaterThan(30)
    expect(lspServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gopls",
          enabled: true,
          sourcePath: "BetterC0de.jsonc#lsp.gopls",
          extensions: [".go"],
          builtin: true,
        }),
        {
          id: "typescript",
          name: "typescript",
          enabled: true,
          sourcePath: "BetterC0de.jsonc#lsp.typescript",
          command: "typescript-language-server",
          args: ["--stdio"],
          env: { TSS_LOG: "off" },
          extensions: [".ts", ".tsx"],
          initialization: { locale: "en" },
          builtin: false,
        },
      ])
    )
    expect(lspServers.some((server) => server.id === "legacy")).toBe(false)

    await expect(listProjectPermissions(root)).resolves.toEqual([
      {
        permission: "edit",
        pattern: "*",
        action: "ask",
        sourcePath: "BetterC0de.jsonc#permission.edit",
      },
      {
        permission: "bash",
        pattern: "npm test*",
        action: "allow",
        sourcePath: "BetterC0de.jsonc#permission.bash.npm test*",
      },
      {
        permission: "bash",
        pattern: "rm -rf*",
        action: "deny",
        sourcePath: "BetterC0de.jsonc#permission.bash.rm -rf*",
      },
      {
        permission: "webfetch",
        pattern: "*",
        action: "deny",
        sourcePath: "BetterC0de.jsonc#permission.webfetch",
      },
    ])
  })

  it("surfaces boolean formatter/LSP and permission shorthand config", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: true,
        lsp: false,
        permission: "allow",
      }),
      "utf8"
    )

    const formatters = await listProjectFormatters(root)
    expect(formatters.length).toBeGreaterThan(10)
    expect(formatters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gofmt",
          name: "gofmt",
          enabled: true,
          sourcePath: "BetterC0de.json#formatter.gofmt",
          command: "",
          args: [],
          extensions: [".go"],
          builtin: true,
        }),
        expect.objectContaining({
          id: "prettier",
          enabled: true,
          sourcePath: "BetterC0de.json#formatter.prettier",
          extensions: expect.arrayContaining([".ts", ".tsx", ".md"]),
          builtin: true,
        }),
      ])
    )
    await expect(listProjectLspServers(root)).resolves.toEqual([
      {
        id: "builtins",
        name: "BetterC0de built-in LSP servers",
        enabled: false,
        sourcePath: "BetterC0de.json#lsp",
        command: "",
        args: [],
        env: {},
        extensions: [],
        initialization: {},
        builtin: true,
      },
    ])
    await expect(listProjectPermissions(root)).resolves.toEqual([
      {
        permission: "*",
        pattern: "*",
        action: "allow",
        sourcePath: "BetterC0de.json#permission",
      },
    ])
  })

  it("fails closed when a project permission config is malformed", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      '{ "permission": { "bash": ',
      "utf8"
    )

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it("fails closed before buffering an oversized project policy config", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        permission: "allow",
        padding: "x".repeat(512 * 1024),
      }),
      "utf8"
    )

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it("fails closed when project permission semantics are invalid", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        permission: {
          bash: "denyy",
          edit: { "*": 1 },
        },
      }),
      "utf8"
    )

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROJECT_POLICY_INVALID",
    })
  })

  it("fails closed when inline project policy JSON is malformed", async () => {
    const root = await makeWorkspace()
    process.env.BetterC0de_CONFIG_CONTENT = '{ "permission": { "bash": '

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROJECT_POLICY_INVALID",
    })
  })

  it("fails closed when uppercase inline project policy exceeds its size limit", async () => {
    const root = await makeWorkspace()
    process.env.BETTERC0DE_CONFIG_CONTENT = "x".repeat(512 * 1024 + 1)

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROJECT_POLICY_INVALID",
    })
  })

  it("fails closed when the inline permission override is invalid", async () => {
    const root = await makeWorkspace()
    process.env.BetterC0de_PERMISSION = '{ "bash": "sometimes" }'

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROJECT_POLICY_INVALID",
    })
  })

  it("fails closed when managed preferences cannot be parsed", async () => {
    const root = await makeWorkspace()
    const managedDir = await makeWorkspace()
    const managedPreferencesFile = path.join(
      managedDir,
      "ai.BetterC0de.managed.plist"
    )
    process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE =
      managedPreferencesFile
    await fs.writeFile(
      managedPreferencesFile,
      "not valid json or plist",
      "utf8"
    )

    await expect(listProjectPermissions(root)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROJECT_POLICY_INVALID",
    })
  })

  it("fails closed when a project provider policy is malformed", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      '{ "disabled_providers": [',
      "utf8"
    )

    await expect(listProjectProviders(root)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it.each(["BETTERC0DE_CONFIG", "BetterC0de_CONFIG"] as const)(
    "fails closed when explicit project policy source %s is missing",
    async (envName) => {
      const root = await makeWorkspace()
      process.env[envName] = path.join(root, "missing-policy.json")

      await expect(listProjectProviders(root)).rejects.toMatchObject({
        statusCode: 503,
        code: "PROJECT_POLICY_INVALID",
      })
    }
  )

  it.each([
    ["enabled_providers has the wrong type", { enabled_providers: "openai" }],
    [
      "enabled_providers contains an invalid element",
      { enabled_providers: ["openai", 42] },
    ],
    ["disabled_providers has the wrong type", { disabled_providers: false }],
    [
      "disabled_providers contains an invalid element",
      { disabled_providers: ["openai", " "] },
    ],
    ["provider container is null", { provider: null }],
    ["provider container is a string", { provider: "custom" }],
    ["provider container is an array", { provider: [] }],
    ["provider entry is null", { provider: { custom: null } }],
    ["provider entry is a string", { provider: { custom: "enabled" } }],
    ["provider entry is an array", { provider: { custom: [] } }],
    [
      "provider whitelist has the wrong type",
      { provider: { custom: { whitelist: "model-a" } } },
    ],
    [
      "provider whitelist contains an invalid element",
      { provider: { custom: { whitelist: ["model-a", null] } } },
    ],
    [
      "provider blacklist has the wrong type",
      { provider: { custom: { blacklist: { model: true } } } },
    ],
    [
      "provider blacklist contains an invalid element",
      { provider: { custom: { blacklist: ["model-a", ""] } } },
    ],
  ])("fails closed when %s", async (_label, config) => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify(config),
      "utf8"
    )

    await expect(listProjectProviders(root)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROJECT_POLICY_INVALID",
    })
  })

  it("expands BetterC0de built-in LSP servers for lsp=true", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ lsp: true }),
      "utf8"
    )

    const servers = await listProjectLspServers(root)

    expect(servers.length).toBeGreaterThan(30)
    expect(servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "typescript",
          name: "typescript",
          enabled: true,
          sourcePath: "BetterC0de.json#lsp.typescript",
          extensions: expect.arrayContaining([".ts", ".tsx", ".js"]),
          builtin: true,
        }),
        expect.objectContaining({
          id: "gopls",
          sourcePath: "BetterC0de.json#lsp.gopls",
          extensions: [".go"],
          builtin: true,
        }),
        expect.objectContaining({
          id: "rust",
          extensions: [".rs"],
          builtin: true,
        }),
      ])
    )
    expect(servers.some((server) => server.id === "ty")).toBe(false)
    expect(servers.some((server) => server.id === "pyright")).toBe(true)
  })

  it("matches BetterC0de experimental ty LSP filtering", async () => {
    const root = await makeWorkspace()
    process.env.BetterC0de_EXPERIMENTAL_LSP_TY = "true"
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ lsp: true }),
      "utf8"
    )

    const servers = await listProjectLspServers(root)

    expect(servers.some((server) => server.id === "ty")).toBe(true)
    expect(servers.some((server) => server.id === "pyright")).toBe(false)
  })

  it("runs an explicit BetterC0de project formatter safely for a matching file", async () => {
    const root = await makeWorkspace()
    const script = [
      "const fs = require('fs')",
      "const file = process.argv[1]",
      "const text = fs.readFileSync(file, 'utf8')",
      "fs.writeFileSync(file, text.trim().toUpperCase() + '\\n')",
    ].join(";")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          shout: {
            command: [process.execPath, "-e", script, "$FILE"],
            extensions: [".txt"],
            environment: {
              NODE_ENV: "test",
              NODE_OPTIONS: "--eval=process.exit(1)",
            },
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf8")
    if (process.platform !== "win32") {
      await fs.chmod(path.join(root, "note.txt"), 0o764)
    }

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })

    expect(result.formatted).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      id: "shout",
      success: true,
      exitCode: 0,
    })
    await expect(
      fs.readFile(path.join(root, "note.txt"), "utf8")
    ).resolves.toBe("HELLO\n")
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(root, "note.txt"))).mode & 0o777).toBe(
        0o764
      )
    }
  })

  it("passes only an isolated sibling staging path to the formatter and always removes it", async () => {
    const root = await makeWorkspace()
    const original = path.join(root, "note.txt")
    const observedPath = path.join(root, "formatter-observed-path.txt")
    const script = [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const staged = process.argv[1]",
      "const original = process.argv[2]",
      "const observed = process.argv[3]",
      "if (path.resolve(staged) === path.resolve(original)) process.exit(41)",
      "fs.writeFileSync(observed, staged)",
      "fs.writeFileSync(staged, 'STAGED ONLY\\n')",
    ].join(";")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          staged: {
            command: [
              process.execPath,
              "-e",
              script,
              "$FILE",
              original,
              observedPath,
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(original, "original\n", "utf8")

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })

    expect(result.results[0]).toMatchObject({ success: true, exitCode: 0 })
    await expect(fs.readFile(original, "utf8")).resolves.toBe("STAGED ONLY\n")
    const observed = await fs.readFile(observedPath, "utf8")
    const relativeToWorkspace = path.relative(
      await fs.realpath(root),
      path.join(
        await fs.realpath(path.dirname(observed)),
        path.basename(observed)
      )
    )
    expect(
      relativeToWorkspace === "" ||
        (!relativeToWorkspace.startsWith("..") &&
          !path.isAbsolute(relativeToWorkspace))
    ).toBe(true)
    expect(path.resolve(observed)).not.toBe(path.resolve(original))
    expect(await fs.realpath(path.dirname(observed))).toBe(
      await fs.realpath(root)
    )
    expect(path.basename(observed)).toMatch(
      /^\.betterc0de-format-[0-9a-f-]+\.txt$/i
    )
    await expect(fs.access(observed)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("preserves the workspace-relative directory, basename, extension, and cwd in private staging", async () => {
    const root = await makeWorkspace()
    const nested = path.join(root, "src", "nested")
    const original = path.join(nested, "note.component.ts")
    const observedPath = path.join(root, "formatter-path-context.json")
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(root, "formatter.config.json"), "{}\n", "utf8")
    await fs.writeFile(path.join(root, ".prettierrc"), "root-config\n", "utf8")
    await fs.writeFile(
      path.join(nested, ".prettierrc"),
      "nested-config\n",
      "utf8"
    )
    const script = [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const staged = process.argv[1]",
      "const observed = process.argv[2]",
      "const config = path.join(process.cwd(), 'formatter.config.json')",
      "let directory = path.dirname(staged)",
      "let stagedConfig = null",
      "while (path.dirname(directory) !== directory) {",
      "  const candidate = path.join(directory, '.prettierrc')",
      "  if (fs.existsSync(candidate)) { stagedConfig = fs.readFileSync(candidate, 'utf8').trim(); break }",
      "  directory = path.dirname(directory)",
      "}",
      "fs.writeFileSync(observed, JSON.stringify({ staged, cwd: process.cwd(), configFound: fs.existsSync(config), stagedConfig }))",
      "fs.writeFileSync(staged, 'export const formatted = true\\n')",
    ].join(";")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          contextual: {
            command: [process.execPath, "-e", script, "$FILE", observedPath],
            extensions: [".ts"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(original, "export const formatted = false\n", "utf8")

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: path.join("src", "nested", "note.component.ts"),
    })

    expect(result.formatted).toBe(true)
    const observed = JSON.parse(await fs.readFile(observedPath, "utf8")) as {
      staged: string
      cwd: string
      configFound: boolean
      stagedConfig: string | null
    }
    expect(path.basename(observed.staged)).toMatch(
      /^\.betterc0de-format-[0-9a-f-]+\.ts$/i
    )
    expect(await fs.realpath(path.dirname(observed.staged))).toBe(
      await fs.realpath(nested)
    )
    expect(path.resolve(observed.staged)).not.toBe(path.resolve(original))
    expect(await fs.realpath(observed.cwd)).toBe(await fs.realpath(root))
    expect(observed.configFound).toBe(true)
    expect(observed.stagedConfig).toBe("nested-config")
    expect(
      path
        .relative(
          await fs.realpath(root),
          path.join(
            await fs.realpath(path.dirname(observed.staged)),
            path.basename(observed.staged)
          )
        )
        .startsWith("..")
    ).toBe(false)
    await expect(fs.access(observed.staged)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects a formatter-replaced staging inode without reading or deleting outside data", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const nested = path.join(root, "internal")
    const target = path.join(nested, "note.txt")
    const outsideTarget = path.join(outside, "note.txt")
    await fs.mkdir(nested)
    await fs.writeFile(target, "inside\n", "utf8")
    await fs.writeFile(outsideTarget, "outside\n", "utf8")
    const script = [
      "const fs = require('node:fs')",
      "const staged = process.argv[1]",
      "const outside = process.argv[2]",
      "fs.unlinkSync(staged)",
      "fs.linkSync(outside, staged)",
      "setInterval(() => {}, 1000)",
    ].join(";")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          swap: {
            command: [process.execPath, "-e", script, "$FILE", outsideTarget],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: path.join("internal", "note.txt"),
    })

    expect(result.formatted).toBe(false)
    expect(result.results[0]).toMatchObject({
      id: "swap",
      success: false,
    })
    expect(result.results[0]?.stderr).toContain(
      "Formatter staging path changed"
    )
    await expect(fs.readFile(target, "utf8")).resolves.toBe("inside\n")
    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside\n")
  })

  it("rejects oversized formatter input before staging or process admission", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          noop: {
            command: [process.execPath, "-e", "process.exit(0)", "$FILE"],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    const target = path.join(root, "oversized.txt")
    const handle = await fs.open(target, "w")
    await handle.truncate(16 * 1024 * 1024 + 1)
    await handle.close()

    await expect(
      formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "oversized.txt",
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "PROJECT_FORMATTER_INPUT_TOO_LARGE",
      limitBytes: 16 * 1024 * 1024,
    })
    expect(__projectFormatterAdmissionCountsForTests()).toEqual({
      active: 0,
      queued: 0,
    })
    expect(activeWorkspaceProcessCount()).toBe(0)
  })

  it("rejects oversized formatter output before accepting or copying it", async () => {
    const root = await makeWorkspace()
    const target = path.join(root, "note.txt")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          expand: {
            command: [
              process.execPath,
              "-e",
              "require('node:fs').truncateSync(process.argv[1], 16 * 1024 * 1024 + 1)",
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(target, "original\n", "utf8")

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })

    expect(result.formatted).toBe(false)
    expect(result.results[0]).toMatchObject({
      id: "expand",
      success: false,
    })
    expect(result.results[0]?.stderr).toContain(
      "Formatter file output exceeded 16777216 bytes"
    )
    await expect(fs.readFile(target, "utf8")).resolves.toBe("original\n")
    expect(__projectFormatterAdmissionCountsForTests()).toEqual({
      active: 0,
      queued: 0,
    })
  })

  it("terminates the formatter process tree while its candidate exceeds the file quota", async () => {
    const root = await makeWorkspace()
    const target = path.join(root, "note.txt")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          expandForever: {
            command: [
              process.execPath,
              "-e",
              [
                "require('node:fs').truncateSync(process.argv[1], 16 * 1024 * 1024 + 1)",
                "setInterval(() => {}, 1000)",
              ].join(";"),
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(target, "original\n", "utf8")
    const startedAt = Date.now()

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })

    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(result.formatted).toBe(false)
    expect(result.results[0]).toMatchObject({
      id: "expandForever",
      success: false,
    })
    expect(result.results[0]?.stderr).toContain(
      "Formatter file output exceeded 16777216 bytes"
    )
    await expect(fs.readFile(target, "utf8")).resolves.toBe("original\n")
    expect(activeWorkspaceProcessCount()).toBe(0)
    expect(__projectFormatterAdmissionCountsForTests()).toEqual({
      active: 0,
      queued: 0,
    })
  }, 20_000)

  it("bounds formatter operations and queues globally and per workspace", async () => {
    const workspaceA = path.join(os.tmpdir(), `formatter-a-${Date.now()}`)
    const workspaceB = path.join(os.tmpdir(), `formatter-b-${Date.now()}`)
    const workspaceC = path.join(os.tmpdir(), `formatter-c-${Date.now()}`)
    const workspaceD = path.join(os.tmpdir(), `formatter-d-${Date.now()}`)
    const workspaceE = path.join(os.tmpdir(), `formatter-e-${Date.now()}`)
    const active = [
      await __reserveProjectFormatterOperationForTests(workspaceA),
      await __reserveProjectFormatterOperationForTests(workspaceA),
      await __reserveProjectFormatterOperationForTests(workspaceB),
      await __reserveProjectFormatterOperationForTests(workspaceB),
    ]
    const queued: Promise<void>[] = []
    const queueReservation = (workspace: string) => {
      const draining = __reserveProjectFormatterOperationForTests(
        workspace
      ).then((reservation) => reservation.release())
      queued.push(draining)
    }
    let admissionsClosed = false

    try {
      for (let index = 0; index < 8; index += 1) {
        queueReservation(workspaceA)
      }
      await expect(
        __reserveProjectFormatterOperationForTests(workspaceA)
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "PROJECT_FORMATTER_OVERLOADED",
      })

      for (const workspace of [workspaceB, workspaceC, workspaceD]) {
        for (let index = 0; index < 8; index += 1) {
          queueReservation(workspace)
        }
      }
      await expect(
        __reserveProjectFormatterOperationForTests(workspaceE)
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "PROJECT_FORMATTER_OVERLOADED",
      })
      expect(__projectFormatterAdmissionCountsForTests()).toEqual({
        active: 4,
        queued: 32,
      })
      expect(__projectFormatterAdmissionCountsForTests(workspaceA)).toEqual({
        active: 2,
        queued: 8,
      })

      for (const reservation of active) reservation.release()
      await Promise.all(queued)
      expect(__projectFormatterAdmissionCountsForTests()).toEqual({
        active: 0,
        queued: 0,
      })
    } finally {
      for (const reservation of active) reservation.release()
      const counts = __projectFormatterAdmissionCountsForTests()
      if (counts.active > 0 || counts.queued > 0) {
        admissionsClosed = true
        beginWorkspaceProcessShutdown()
        await Promise.allSettled(queued)
      }
      const afterCleanup = __projectFormatterAdmissionCountsForTests()
      if (
        admissionsClosed &&
        afterCleanup.active === 0 &&
        afterCleanup.queued === 0 &&
        activeWorkspaceProcessCount() === 0 &&
        queuedWorkspaceProcessCount() === 0
      ) {
        resumeWorkspaceProcessAdmissions()
      }
    }
  })

  it("isolates failed formatter edits while preserving successful formatter chaining", async () => {
    const root = await makeWorkspace()
    const writeScript = (contents: string, exitCode: number) =>
      [
        "const fs = require('node:fs')",
        "const file = process.argv[1]",
        `fs.writeFileSync(file, ${JSON.stringify(contents)})`,
        `process.exit(${exitCode})`,
      ].join(";")
    const verifyOriginalScript = [
      "const fs = require('node:fs')",
      "const file = process.argv[1]",
      "const current = fs.readFileSync(file, 'utf8')",
      "fs.writeFileSync(file, current === 'original\\n' ? 'GOOD\\n' : `LEAKED:${current}`)",
    ].join(";")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          "a-fail": {
            command: [
              process.execPath,
              "-e",
              writeScript("BROKEN\n", 7),
              "$FILE",
            ],
            extensions: [".txt"],
          },
          "b-success": {
            command: [process.execPath, "-e", verifyOriginalScript, "$FILE"],
            extensions: [".txt"],
          },
          "c-fail": {
            command: [
              process.execPath,
              "-e",
              writeScript("PARTIAL AFTER SUCCESS\n", 9),
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "original\n", "utf8")

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })

    expect(result.results.map(({ id, success }) => ({ id, success }))).toEqual([
      { id: "a-fail", success: false },
      { id: "b-success", success: true },
      { id: "c-fail", success: false },
    ])
    expect(result.formatted).toBe(true)
    await expect(
      fs.readFile(path.join(root, "note.txt"), "utf8")
    ).resolves.toBe("GOOD\n")
  })

  it("does not commit a successful formatter when the original file changes in place", async () => {
    const root = await makeWorkspace()
    const target = path.join(root, "note.txt")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          staged: {
            command: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], 'FORMATTED\\n')",
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(target, "original\n", "utf8")

    let stagingPath = ""
    __setWorkspaceMutationTestHookForTests(async (phase, paths) => {
      if (phase !== "format:before-commit") return
      stagingPath = paths.source!
      await fs.writeFile(target, "external change\n", "utf8")
    })

    await expect(
      formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "note.txt",
      })
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_CHANGED" })
    await expect(fs.readFile(target, "utf8")).resolves.toBe("external change\n")
    expect(stagingPath).not.toBe("")
    await expect(fs.access(stagingPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("refuses a formatter commit after a parent swap and leaves outside data untouched", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const internal = path.join(root, "internal")
    const displaced = path.join(root, "internal-original")
    await fs.mkdir(internal)
    await fs.writeFile(path.join(internal, "note.txt"), "inside\n", "utf8")
    await fs.writeFile(path.join(outside, "note.txt"), "outside\n", "utf8")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          staged: {
            command: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], 'FORMATTED\\n')",
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )

    let stagingPath = ""
    __setWorkspaceMutationTestHookForTests(async (phase, paths) => {
      if (phase !== "format:before-commit") return
      stagingPath = paths.source!
      await fs.rename(internal, displaced)
      await fs.symlink(
        outside,
        internal,
        process.platform === "win32" ? "junction" : "dir"
      )
    })

    await expect(
      formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "internal/note.txt",
      })
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    await expect(
      fs.readFile(path.join(outside, "note.txt"), "utf8")
    ).resolves.toBe("outside\n")
    await expect(
      fs.readFile(path.join(displaced, "note.txt"), "utf8")
    ).resolves.toBe("inside\n")
    await expect(fs.access(stagingPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("terminates a formatter that exceeds the bounded output budget", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          noisy: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)",
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf8")

    const result = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })

    expect(result.results[0]).toMatchObject({
      id: "noisy",
      success: false,
    })
    expect(result.results[0]?.stderr).toContain("output exceeded")
    expect(
      Buffer.byteLength(result.results[0]?.stdout ?? "", "utf8")
    ).toBeLessThanOrEqual(64_000)
    expect(activeWorkspaceProcessCount()).toBe(0)
  })

  it("closes formatter admission during shutdown", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          noop: {
            command: [process.execPath, "-e", "process.exit(0)", "$FILE"],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf8")

    beginWorkspaceProcessShutdown()
    try {
      const result = await formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "note.txt",
      })
      expect(result.results[0]).toMatchObject({
        success: false,
        exitCode: null,
      })
      expect(result.results[0]?.stderr).toContain("shutting down")
      expect(activeWorkspaceProcessCount()).toBe(0)
    } finally {
      resumeWorkspaceProcessAdmissions()
    }
  })

  it("awaits active formatter process-tree shutdown", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          waiting: {
            command: [
              process.execPath,
              "-e",
              "setInterval(()=>{},1000)",
              "$FILE",
            ],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf8")

    const formatting = formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })
    void formatting.catch(() => undefined)
    try {
      const deadline = Date.now() + 2_000
      while (activeWorkspaceProcessCount() === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      expect(activeWorkspaceProcessCount()).toBe(1)
      await expect(shutdownAllWorkspaceProcesses()).resolves.toBe(1)
      const result = await formatting
      expect(result.results[0]?.success).toBe(false)
      expect(activeWorkspaceProcessCount()).toBe(0)
    } finally {
      if (activeWorkspaceProcessCount() > 0) {
        await shutdownAllWorkspaceProcesses().catch(() => undefined)
      }
      if (activeWorkspaceProcessCount() === 0) {
        resumeWorkspaceProcessAdmissions()
      }
    }
  })

  it("caps workspace helpers, bounds the FIFO queue, and aborts queued work", async () => {
    const runWaiting = (signal?: AbortSignal) =>
      __runBoundedWorkspaceCommandForTests({
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        timeoutMs: 20_000,
        signal,
      })
    const active = Array.from({ length: 4 }, () => runWaiting())
    const allQueued: Array<ReturnType<typeof runWaiting>> = []
    try {
      const activeDeadline = Date.now() + 3_000
      while (activeWorkspaceProcessCount() < 4 && Date.now() < activeDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      expect(activeWorkspaceProcessCount()).toBe(4)

      const controller = new AbortController()
      const aborted = runWaiting(controller.signal)
      allQueued.push(aborted)
      for (let index = 1; index < 32; index += 1) {
        allQueued.push(runWaiting())
      }
      const queueDeadline = Date.now() + 3_000
      while (queuedWorkspaceProcessCount() < 32 && Date.now() < queueDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      expect(queuedWorkspaceProcessCount()).toBe(32)

      const overloaded = await runWaiting()
      expect(overloaded.exitCode).toBeNull()
      expect(overloaded.stderr).toContain("queue is full")

      controller.abort()
      await expect(aborted).resolves.toMatchObject({ exitCode: null })
      expect((await aborted).stderr).toContain("aborted while queued")
      expect(queuedWorkspaceProcessCount()).toBe(31)
      expect(activeWorkspaceProcessCount()).toBe(4)

      await expect(shutdownAllWorkspaceProcesses()).resolves.toBe(4)
      await Promise.all([...active, ...allQueued])
      expect(activeWorkspaceProcessCount()).toBe(0)
      expect(queuedWorkspaceProcessCount()).toBe(0)
    } finally {
      if (
        activeWorkspaceProcessCount() > 0 ||
        queuedWorkspaceProcessCount() > 0
      ) {
        await shutdownAllWorkspaceProcesses().catch(() => undefined)
      }
      if (
        activeWorkspaceProcessCount() === 0 &&
        queuedWorkspaceProcessCount() === 0
      ) {
        resumeWorkspaceProcessAdmissions()
      }
    }
  })

  it("refuses to format a file reached through a workspace symlink", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    await fs.writeFile(path.join(outside, "note.txt"), "outside\n", "utf8")
    await fs.symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    )

    await expect(
      formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "linked/note.txt",
      })
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    await expect(
      fs.readFile(path.join(outside, "note.txt"), "utf8")
    ).resolves.toBe("outside\n")
  })

  it("revalidates the formatter target after process admission and immediately before spawn", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const internalDir = path.join(root, "internal")
    const displacedDir = path.join(root, "internal-original")
    await fs.mkdir(internalDir)
    await fs.writeFile(path.join(internalDir, "note.txt"), "inside\n", "utf8")
    await fs.writeFile(path.join(outside, "note.txt"), "outside\n", "utf8")
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          noop: {
            command: [process.execPath, "-e", "process.exit(0)", "$FILE"],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )

    let swapped = false
    __setWorkspaceMutationTestHookForTests(async (phase) => {
      if (phase !== "format:before-spawn" || swapped) return
      swapped = true
      await fs.rename(internalDir, displacedDir)
      await fs.symlink(
        outside,
        internalDir,
        process.platform === "win32" ? "junction" : "dir"
      )
    })

    await expect(
      formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "internal/note.txt",
      })
    ).rejects.toThrow("workspace path crosses a symbolic link or junction")
    expect(swapped).toBe(true)
    expect(activeWorkspaceProcessCount()).toBe(0)
    expect(queuedWorkspaceProcessCount()).toBe(0)
    await expect(
      fs.readFile(path.join(outside, "note.txt"), "utf8")
    ).resolves.toBe("outside\n")
  })

  it("runs an available BetterC0de built-in formatter for formatter=true", async () => {
    const root = await makeWorkspace()
    const binDir = path.join(root, "fake-bin")
    await fs.mkdir(binDir)
    const gofmt = path.join(
      binDir,
      process.platform === "win32" ? "gofmt.cmd" : "gofmt"
    )
    await fs.writeFile(
      gofmt,
      process.platform === "win32"
        ? [
            "@echo off",
            `"${process.execPath}" -e "const fs=require('node:fs');const file=process.argv.at(-1);fs.appendFileSync(file,'\\n// formatted\\n')" -- %*`,
          ].join("\r\n")
        : [
            "#!/bin/sh",
            'last=""',
            'for arg do last="$arg"; done',
            'printf "\\n// formatted\\n" >> "$last"',
          ].join("\n"),
      "utf8"
    )
    await fs.chmod(gofmt, 0o755)
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ formatter: true }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "main.go"), "package main\n", "utf8")

    const oldPath = process.env.PATH
    process.env.PATH = [binDir, oldPath].filter(Boolean).join(path.delimiter)
    try {
      const result = await formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "main.go",
      })

      expect(result.formatted).toBe(true)
      expect(result.results[0]).toMatchObject({
        id: "gofmt",
        command: gofmt,
        args: ["-w", path.join(root, "main.go")],
        success: true,
      })
      await expect(
        fs.readFile(path.join(root, "main.go"), "utf8")
      ).resolves.toContain("// formatted")
    } finally {
      process.env.PATH = oldPath
    }
  })

  it("matches BetterC0de built-in prettier activation through package.json dependencies", async () => {
    const root = await makeWorkspace()
    const binDir = path.join(root, "fake-bin")
    await fs.mkdir(binDir)
    const prettier = path.join(
      binDir,
      process.platform === "win32" ? "prettier.cmd" : "prettier"
    )
    await fs.writeFile(
      prettier,
      process.platform === "win32"
        ? [
            "@echo off",
            `"${process.execPath}" -e "const fs=require('node:fs');const file=process.argv.at(-1);fs.appendFileSync(file,'\\n// prettier\\n')" -- %*`,
          ].join("\r\n")
        : [
            "#!/bin/sh",
            'last=""',
            'for arg do last="$arg"; done',
            'printf "\\n// prettier\\n" >> "$last"',
          ].join("\n"),
      "utf8"
    )
    await fs.chmod(prettier, 0o755)
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ formatter: true }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "main.ts"), "const x = 1\n", "utf8")

    const oldPath = process.env.PATH
    process.env.PATH = binDir
    try {
      const beforePackage = await listProjectFormatters(root)
      expect(
        beforePackage.find((item) => item.id === "prettier")
      ).toMatchObject({
        available: false,
      })

      const skipped = await formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "main.ts",
      })

      expect(skipped.formatted).toBe(false)
      await expect(
        fs.readFile(path.join(root, "main.ts"), "utf8")
      ).resolves.not.toContain("// prettier")

      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
        "utf8"
      )
      const afterPackage = await listProjectFormatters(root)
      expect(afterPackage.find((item) => item.id === "prettier")).toMatchObject(
        {
          available: true,
        }
      )

      const formatted = await formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "main.ts",
      })

      expect(formatted.formatted).toBe(true)
      expect(formatted.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "prettier",
            command: prettier,
            success: true,
          }),
        ])
      )
      await expect(
        fs.readFile(path.join(root, "main.ts"), "utf8")
      ).resolves.toContain("// prettier")
    } finally {
      process.env.PATH = oldPath
    }
  })

  it("keeps BetterC0de built-in formatters for object config overrides", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          prettier: { disabled: true },
          shout: {
            command: [process.execPath, "-e", "process.exit(0)", "$FILE"],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )

    const formatters = await listProjectFormatters(root)

    expect(formatters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gofmt",
          enabled: true,
          sourcePath: "BetterC0de.json#formatter.gofmt",
          builtin: true,
        }),
        expect.objectContaining({
          id: "shout",
          enabled: true,
          sourcePath: "BetterC0de.json#formatter.shout",
          command: process.execPath,
          args: ["-e", "process.exit(0)", "$FILE"],
          extensions: [".txt"],
          builtin: false,
        }),
      ])
    )
    expect(formatters.some((formatter) => formatter.id === "prettier")).toBe(
      false
    )
  })

  it("matches BetterC0de linked ruff and uv formatter disabling", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          ruff: { disabled: true },
        },
      }),
      "utf8"
    )

    const formatters = await listProjectFormatters(root)

    expect(formatters.some((formatter) => formatter.id === "ruff")).toBe(false)
    expect(formatters.some((formatter) => formatter.id === "uv")).toBe(false)
    expect(formatters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gofmt", enabled: true }),
      ])
    )
  })

  it("resolves BetterC0de tool_output limits for shell and tool result truncation", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "tool_output": {',
        '    "max_lines": 3,',
        '    "max_bytes": 128',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(getProjectToolOutputLimits(root)).resolves.toEqual({
      maxLines: 3,
      maxBytes: 128,
      sourcePath: "BetterC0de.jsonc#tool_output",
    })
  })

  it("skips project formatting when no enabled formatter matches the extension", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({
        formatter: {
          markdown: {
            command: [process.execPath, "-e", "process.exit(0)", "$FILE"],
            extensions: [".md"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf8")

    await expect(
      formatProjectFile({
        allowWorkspaceCommands: true,
        cwd: root,
        relativePath: "note.txt",
      })
    ).resolves.toMatchObject({
      formatted: false,
      results: [],
    })
  })
})

describe("workspace BetterC0de project config summary", () => {
  it("loads global BetterC0de config before workspace overrides", async () => {
    const root = await makeWorkspace()
    const xdgRoot = await makeWorkspace()
    const globalDir = path.join(xdgRoot, "BetterC0de")
    const globalFile = path.join(globalDir, "BetterC0de.jsonc")
    const globalTuiFile = path.join(globalDir, "tui.jsonc")
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousBetterC0deConfigDir = process.env.BetterC0de_CONFIG_DIR

    try {
      process.env.XDG_CONFIG_HOME = xdgRoot
      delete process.env.BetterC0de_CONFIG_DIR

      await fs.mkdir(path.join(globalDir, "secrets"), { recursive: true })
      await fs.writeFile(
        path.join(globalDir, "secrets", "shell.txt"),
        "fish\n",
        "utf8"
      )
      await fs.writeFile(
        globalFile,
        [
          "{",
          '  "shell": "{file:secrets/shell.txt}",',
          '  "model": "global/slow-model",',
          '  "provider": {',
          '    "global": {',
          '      "name": "Global Provider",',
          '      "models": { "slow-model": { "name": "Slow Model" } }',
          "    }",
          "  },",
          '  "command": {',
          '    "global-review": {',
          '      "description": "Global command from BetterC0de config",',
          '      "template": "Review from global config"',
          "    }",
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      )
      await fs.writeFile(
        globalTuiFile,
        ["{", '  "theme": "catppuccin"', "}"].join("\n"),
        "utf8"
      )
      await fs.writeFile(
        path.join(root, "BetterC0de.jsonc"),
        [
          "{",
          '  "shell": "zsh",',
          '  "model": "project/fast-model",',
          '  "provider": {',
          '    "project": {',
          '      "name": "Project Provider",',
          '      "models": { "fast-model": { "name": "Fast Model" } }',
          "    }",
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      )

      await expect(getProjectShell(root)).resolves.toBe("zsh")
      await expect(listProjectCommands(root)).resolves.toContainEqual({
        name: "global-review",
        description: "Global command from BetterC0de config",
        sourcePath: `${globalFile}#command.global-review`,
        template: "Review from global config",
      })
      await expect(listProjectProviders(root)).resolves.toMatchObject({
        defaultModel: "project/fast-model",
        providers: [
          { id: "global", sourcePath: `${globalFile}#provider.global` },
          { id: "project", sourcePath: "BetterC0de.jsonc#provider.project" },
        ],
      })

      const settings = await listProjectConfigSettings(root)
      expect(settings).toEqual(
        expect.arrayContaining([
          {
            key: "shell",
            label: "Shell",
            kind: "scalar",
            value: "fish",
            sourcePath: `${globalFile}#shell`,
          },
          {
            key: "shell",
            label: "Shell",
            kind: "scalar",
            value: "zsh",
            sourcePath: "BetterC0de.jsonc#shell",
          },
          {
            key: "theme",
            label: "TUI theme",
            kind: "scalar",
            value: "catppuccin",
            sourcePath: `${globalTuiFile}#theme`,
          },
        ])
      )
    } finally {
      if (typeof previousXdgConfigHome === "string") {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      } else {
        delete process.env.XDG_CONFIG_HOME
      }
      if (typeof previousBetterC0deConfigDir === "string") {
        process.env.BetterC0de_CONFIG_DIR = previousBetterC0deConfigDir
      } else {
        delete process.env.BetterC0de_CONFIG_DIR
      }
    }
  })

  it("loads explicit BetterC0de config env sources", async () => {
    const root = await makeWorkspace()
    const envRoot = await makeWorkspace()
    const explicitFile = path.join(envRoot, "custom-BetterC0de.jsonc")
    const explicitTuiFile = path.join(envRoot, "custom-tui.jsonc")
    await fs.writeFile(
      explicitFile,
      [
        "{",
        '  "logLevel": "DEBUG",',
        '  "model": "explicit/base-model"',
        "}",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      explicitTuiFile,
      ["{", '  "theme": "env-theme"', "}"].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "shell": "project-shell",',
        '  "model": "project/model"',
        "}",
      ].join("\n"),
      "utf8"
    )
    process.env.BetterC0de_CONFIG = explicitFile
    process.env.BetterC0de_TUI_CONFIG = explicitTuiFile
    process.env.BetterC0de_CONFIG_CONTENT = JSON.stringify({
      shell: "content-shell",
      model: "content/model",
    })
    process.env.BetterC0de_PERMISSION = JSON.stringify({
      bash: { "npm run *": "ask" },
      repo_clone: "deny",
    })
    process.env.BetterC0de_DISABLE_AUTOCOMPACT = "true"
    process.env.BetterC0de_DISABLE_PRUNE = "1"
    process.env.BetterC0de_AUTO_SHARE = "true"
    process.env.BetterC0de_DISABLE_SHARE = "true"
    process.env.BetterC0de_PURE = "true"
    process.env.BetterC0de_DISABLE_DEFAULT_PLUGINS = "true"
    process.env.BetterC0de_DISABLE_AUTOUPDATE = "true"
    process.env.BetterC0de_ALWAYS_NOTIFY_UPDATE = "true"
    process.env.BetterC0de_DISABLE_MODELS_FETCH = "true"
    process.env.BetterC0de_MODELS_URL = "https://models.example.test"
    process.env.BetterC0de_MODELS_PATH = "/tmp/BetterC0de-models.json"
    process.env.BetterC0de_FAKE_VCS = '{"branch":"preview"}'
    process.env.BetterC0de_WORKSPACE_ID = "workspace-preview"
    process.env.BetterC0de_AUTO_HEAP_SNAPSHOT = "true"
    process.env.BetterC0de_EXPERIMENTAL_FILEWATCHER = "true"
    process.env.BetterC0de_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
    process.env.BetterC0de_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = "true"
    process.env.BetterC0de_DIRECT_TRACE = "true"
    process.env.BetterC0de_DISABLE_MOUSE = "true"
    process.env.BetterC0de_DISABLE_TERMINAL_TITLE = "true"
    process.env.BetterC0de_SHOW_TTFD = "true"
    process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT = "true"
    process.env.BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = "300000"
    process.env.BetterC0de_DISABLE_LSP_DOWNLOAD = "true"
    process.env.BetterC0de_ENABLE_PARALLEL = "true"
    process.env.BetterC0de_WEBSEARCH_PROVIDER = "parallel"
    process.env.BetterC0de_EXPERIMENTAL_OUTPUT_TOKEN_MAX = "8192"
    process.env.BetterC0de_CLIENT = "desktop"
    process.env.BetterC0de_REPO_CLONE_GITHUB_BASE_URL =
      "https://github.enterprise.example/mirror/"

    await expect(getProjectShell(root)).resolves.toBe("content-shell")
    await expect(listProjectProviders(root)).resolves.toMatchObject({
      defaultModel: "content/model",
    })

    const settings = await listProjectConfigSettings(root)
    expect(settings).toEqual(
      expect.arrayContaining([
        {
          key: "logLevel",
          label: "Log level",
          kind: "scalar",
          value: "DEBUG",
          sourcePath: `${explicitFile}#logLevel`,
        },
        {
          key: "shell",
          label: "Shell",
          kind: "scalar",
          value: "content-shell",
          sourcePath: "BetterC0de_CONFIG_CONTENT#shell",
        },
        {
          key: "theme",
          label: "TUI theme",
          kind: "scalar",
          value: "env-theme",
          sourcePath: `${explicitTuiFile}#theme`,
        },
        {
          key: "compaction.auto",
          label: "Compaction auto",
          kind: "toggle",
          value: "disabled",
          sourcePath: "BetterC0de environment flags#compaction.auto",
        },
        {
          key: "compaction.prune",
          label: "Compaction prune",
          kind: "toggle",
          value: "disabled",
          sourcePath: "BetterC0de environment flags#compaction.prune",
        },
        {
          key: "share",
          label: "Share mode",
          kind: "scalar",
          value: "disabled",
          sourcePath: "BetterC0de_DISABLE_SHARE#share",
        },
        {
          key: "runtime.autoShare",
          label: "Runtime auto-share",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de_AUTO_SHARE#runtime.autoShare",
        },
        {
          key: "runtime.pure",
          label: "Pure mode",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de plugin runtime flags#runtime.pure",
        },
        {
          key: "runtime.disableDefaultPlugins",
          label: "Disable default plugins",
          kind: "toggle",
          value: "enabled",
          sourcePath:
            "BetterC0de plugin runtime flags#runtime.disableDefaultPlugins",
        },
        {
          key: "runtime.disableAutoupdate",
          label: "Disable auto-update",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.disableAutoupdate",
        },
        {
          key: "runtime.alwaysNotifyUpdate",
          label: "Always notify update",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.alwaysNotifyUpdate",
        },
        {
          key: "runtime.disableModelsFetch",
          label: "Disable models fetch",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.disableModelsFetch",
        },
        {
          key: "runtime.modelsUrl",
          label: "Models URL",
          kind: "scalar",
          value: "https://models.example.test",
          sourcePath: "BetterC0de runtime flags#runtime.modelsUrl",
        },
        {
          key: "runtime.modelsPath",
          label: "Models path",
          kind: "scalar",
          value: "/tmp/BetterC0de-models.json",
          sourcePath: "BetterC0de runtime flags#runtime.modelsPath",
        },
        {
          key: "runtime.fakeVcs",
          label: "Fake VCS",
          kind: "scalar",
          value: '{"branch":"preview"}',
          sourcePath: "BetterC0de runtime flags#runtime.fakeVcs",
        },
        {
          key: "runtime.workspaceId",
          label: "Workspace ID",
          kind: "scalar",
          value: "workspace-preview",
          sourcePath: "BetterC0de runtime flags#runtime.workspaceId",
        },
        {
          key: "runtime.autoHeapSnapshot",
          label: "Auto heap snapshot",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.autoHeapSnapshot",
        },
        {
          key: "runtime.experimentalFileWatcher",
          label: "Experimental file watcher",
          kind: "toggle",
          value: "enabled",
          sourcePath:
            "BetterC0de runtime flags#runtime.experimentalFileWatcher",
        },
        {
          key: "runtime.experimentalDisableFileWatcher",
          label: "Disable file watcher",
          kind: "toggle",
          value: "enabled",
          sourcePath:
            "BetterC0de runtime flags#runtime.experimentalDisableFileWatcher",
        },
        {
          key: "runtime.experimentalDisableCopyOnSelect",
          label: "Disable copy on select",
          kind: "toggle",
          value: "enabled",
          sourcePath:
            "BetterC0de runtime flags#runtime.experimentalDisableCopyOnSelect",
        },
        {
          key: "runtime.directTrace",
          label: "Direct trace",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.directTrace",
        },
        {
          key: "runtime.disableMouse",
          label: "Disable mouse",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.disableMouse",
        },
        {
          key: "runtime.disableTerminalTitle",
          label: "Disable terminal title",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.disableTerminalTitle",
        },
        {
          key: "runtime.showTtfd",
          label: "Show TTFD",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.showTtfd",
        },
        {
          key: "runtime.bashDefaultTimeoutMs",
          label: "Bash default timeout",
          kind: "scalar",
          value: "300000",
          sourcePath:
            "BetterC0de shell runtime flags#runtime.bashDefaultTimeoutMs",
        },
        {
          key: "runtime.disableClaudeCodePrompt",
          label: "Disable Claude Code prompt",
          kind: "toggle",
          value: "enabled",
          sourcePath:
            "BetterC0de prompt runtime flags#runtime.disableClaudeCodePrompt",
        },
        {
          key: "runtime.disableLspDownload",
          label: "Disable LSP download",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.disableLspDownload",
        },
        {
          key: "runtime.enableParallel",
          label: "Enable parallel search",
          kind: "toggle",
          value: "enabled",
          sourcePath: "BetterC0de runtime flags#runtime.enableParallel",
        },
        {
          key: "runtime.webSearchProvider",
          label: "Web search provider",
          kind: "scalar",
          value: "parallel",
          sourcePath: "BetterC0de runtime flags#runtime.webSearchProvider",
        },
        {
          key: "runtime.outputTokenMax",
          label: "Output token max",
          kind: "scalar",
          value: "8192",
          sourcePath: "BetterC0de runtime flags#runtime.outputTokenMax",
        },
        {
          key: "runtime.client",
          label: "Runtime client",
          kind: "scalar",
          value: "desktop",
          sourcePath: "BetterC0de runtime flags#runtime.client",
        },
        {
          key: "runtime.repoCloneGithubBaseUrl",
          label: "Repo clone GitHub base URL",
          kind: "scalar",
          value: "https://github.enterprise.example/mirror/",
          sourcePath: "BetterC0de runtime flags#runtime.repoCloneGithubBaseUrl",
        },
      ])
    )

    await expect(listProjectPermissions(root)).resolves.toEqual(
      expect.arrayContaining([
        {
          permission: "bash",
          pattern: "npm run *",
          action: "ask",
          sourcePath: "BetterC0de_PERMISSION#permission.bash.npm run *",
        },
        {
          permission: "repo_clone",
          pattern: "*",
          action: "deny",
          sourcePath: "BetterC0de_PERMISSION#permission.repo_clone",
        },
      ])
    )
  })

  // `shell` names the binary every /shell/run and every interactive PTY is
  // launched with — including terminals the human types into — and
  // resolveShellCommandLaunch spawns an absolute shellId directly. Workspace
  // config is whatever the cloned repository shipped, so it may *select* a
  // known shell but must not name an arbitrary program. It also closed a
  // write-to-execute path: an agent with only write access could drop the
  // config plus a script and wait for the user to open a terminal.
  // A custom `formatter.<id>.command` is an arbitrary argv chosen by whoever
  // wrote the repository, and formatting spawns it. Same class as a
  // workspace-declared MCP server: it needs an explicit trust decision, and
  // the default refuses.
  it("refuses a workspace-declared formatter command without explicit trust", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "betterc0de.json"),
      JSON.stringify({
        formatter: {
          payload: {
            command: [process.execPath, "-e", "process.exit(0)", "$FILE"],
            extensions: [".txt"],
          },
        },
      }),
      "utf8"
    )
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf8")

    const refused = await formatProjectFile({
      cwd: root,
      relativePath: "note.txt",
    })
    expect(refused.formatted).toBe(false)
    expect(refused.skippedReason).toContain("No enabled BetterC0de formatter")

    const allowed = await formatProjectFile({
      allowWorkspaceCommands: true,
      cwd: root,
      relativePath: "note.txt",
    })
    expect(allowed.skippedReason).toBeUndefined()
  })

  it("ignores a workspace-controlled shell that is not a known shell id", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "betterc0de.json"),
      JSON.stringify({ shell: "/tmp/attacker-payload" }),
      "utf8"
    )
    await expect(getProjectShell(root)).resolves.toBeUndefined()

    await fs.writeFile(
      path.join(root, "betterc0de.json"),
      JSON.stringify({ shell: "./relative-payload" }),
      "utf8"
    )
    await expect(getProjectShell(root)).resolves.toBeUndefined()

    await fs.writeFile(
      path.join(root, "betterc0de.json"),
      JSON.stringify({ shell: "gitbash" }),
      "utf8"
    )
    await expect(getProjectShell(root)).resolves.toBe("gitbash")
  })

  it("loads ancestor BetterC0de project and TUI config files up to the git root", async () => {
    const root = await makeWorkspace()
    const repoRoot = path.join(root, "repo")
    const projectRoot = path.join(repoRoot, "packages", "app")
    const parentConfig = path.join(repoRoot, "BetterC0de.jsonc")
    const parentTui = path.join(repoRoot, "tui.jsonc")
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true })
    await fs.mkdir(projectRoot, { recursive: true })
    await fs.writeFile(
      parentConfig,
      [
        "{",
        '  "shell": "bash",',
        '  "command": {',
        '    "parent-root": {',
        '      "description": "Parent root command",',
        '      "template": "Parent root"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    await fs.writeFile(
      parentTui,
      JSON.stringify({ theme: "parent-tui" }),
      "utf8"
    )
    await fs.writeFile(
      path.join(projectRoot, "BetterC0de.jsonc"),
      JSON.stringify({ shell: "zsh" }),
      "utf8"
    )

    await expect(getProjectShell(projectRoot)).resolves.toBe("zsh")
    await expect(listProjectCommands(projectRoot)).resolves.toContainEqual({
      name: "parent-root",
      description: "Parent root command",
      sourcePath: `${parentConfig}#command.parent-root`,
      template: "Parent root",
    })

    const settings = await listProjectConfigSettings(projectRoot)
    expect(settings).toEqual(
      expect.arrayContaining([
        {
          key: "shell",
          label: "Shell",
          kind: "scalar",
          value: "bash",
          sourcePath: `${parentConfig}#shell`,
        },
        {
          key: "shell",
          label: "Shell",
          kind: "scalar",
          value: "zsh",
          sourcePath: "BetterC0de.jsonc#shell",
        },
        {
          key: "theme",
          label: "TUI theme",
          kind: "scalar",
          value: "parent-tui",
          sourcePath: `${parentTui}#theme`,
        },
      ])
    )
  })

  it("loads managed BetterC0de config after user, env, and project config", async () => {
    const root = await makeWorkspace()
    const managedDir = await makeWorkspace()
    process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR = managedDir
    process.env.BetterC0de_CONFIG_CONTENT = JSON.stringify({
      shell: "content-shell",
      model: "content/model",
      share: "auto",
    })
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({
        shell: "project-shell",
        model: "project/model",
        autoupdate: true,
      }),
      "utf8"
    )
    await fs.writeFile(
      path.join(managedDir, "BetterC0de.jsonc"),
      JSON.stringify({
        model: "managed/model",
        share: "disabled",
        autoupdate: false,
        disabled_providers: ["openai"],
      }),
      "utf8"
    )

    await expect(getProjectShell(root)).resolves.toBe("content-shell")
    await expect(listProjectProviders(root)).resolves.toMatchObject({
      defaultModel: "managed/model",
      disabledProviders: ["openai"],
    })

    const settings = await listProjectConfigSettings(root)
    expect(settings).toEqual(
      expect.arrayContaining([
        {
          key: "model",
          label: "Default model",
          kind: "scalar",
          value: "managed/model",
          sourcePath: `${path.join(managedDir, "BetterC0de.jsonc")}#model`,
        },
        {
          key: "share",
          label: "Share mode",
          kind: "scalar",
          value: "disabled",
          sourcePath: `${path.join(managedDir, "BetterC0de.jsonc")}#share`,
        },
        {
          key: "autoupdate",
          label: "Auto-update",
          kind: "toggle",
          value: "disabled",
          sourcePath: `${path.join(managedDir, "BetterC0de.jsonc")}#autoupdate`,
        },
      ])
    )
  })

  it("loads macOS managed preferences after managed config and strips plist metadata", async () => {
    const root = await makeWorkspace()
    const managedDir = await makeWorkspace()
    const managedPreferencesFile = path.join(
      managedDir,
      "ai.BetterC0de.managed.plist"
    )
    process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR = managedDir
    process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE =
      managedPreferencesFile
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({
        model: "project/model",
        share: "auto",
      }),
      "utf8"
    )
    await fs.writeFile(
      path.join(managedDir, "BetterC0de.jsonc"),
      JSON.stringify({
        model: "managed-dir/model",
        share: "manual",
      }),
      "utf8"
    )
    await fs.writeFile(
      managedPreferencesFile,
      JSON.stringify({
        PayloadDisplayName: "BetterC0de Managed",
        PayloadIdentifier: "ai.BetterC0de.managed.test",
        PayloadType: "ai.BetterC0de.managed",
        PayloadUUID: "AAAA-BBBB-CCCC",
        PayloadVersion: 1,
        _manualProfile: true,
        model: "mobileconfig/model",
        share: "disabled",
        enterprise: { url: "https://enterprise.example.test" },
      }),
      "utf8"
    )

    await expect(listProjectProviders(root)).resolves.toMatchObject({
      defaultModel: "mobileconfig/model",
    })

    const settings = await listProjectConfigSettings(root)
    expect(settings).toEqual(
      expect.arrayContaining([
        {
          key: "model",
          label: "Default model",
          kind: "scalar",
          value: "mobileconfig/model",
          sourcePath: `mobileconfig:${managedPreferencesFile}#model`,
        },
        {
          key: "share",
          label: "Share mode",
          kind: "scalar",
          value: "disabled",
          sourcePath: `mobileconfig:${managedPreferencesFile}#share`,
        },
        {
          key: "enterprise.url",
          label: "Enterprise URL",
          kind: "scalar",
          value: "https://enterprise.example.test",
          sourcePath: `mobileconfig:${managedPreferencesFile}#enterprise.url`,
        },
      ])
    )
    expect(settings.map((setting) => setting.key)).not.toContain("PayloadUUID")
    expect(settings.map((setting) => setting.key)).not.toContain("PayloadType")
  })

  it("summarizes remaining BetterC0de project settings for chat visibility", async () => {
    const root = await makeWorkspace()
    process.env.BETTERC0DE_TEST_BetterC0de_SHELL = "zsh"
    await fs.mkdir(path.join(root, "secrets"), { recursive: true })
    await fs.writeFile(
      path.join(root, "secrets", "username.txt"),
      "project-user\n",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "shell": "{env:BETTERC0DE_TEST_BetterC0de_SHELL}",',
        '  "username": "{file:secrets/username.txt}",',
        '  // "ignored": "{file:secrets/username.txt}",',
        '  "snapshot": false,',
        '  "share": "manual",',
        '  "model": "anthropic/claude-sonnet-4-5",',
        '  "disabled_providers": ["grok"],',
        '  "skills": { "paths": ["custom-skills"], "urls": ["https://example.test/.well-known/skills"] },',
        '  "watcher": { "ignore": ["dist/**", "tmp/**"] },',
        '  "tools": { "webfetch": false, "bash": true },',
        '  "tool_output": { "max_lines": 2000, "max_bytes": 51200 },',
        '  "compaction": { "auto": true, "prune": false },',
        '  "experimental": { "batch_tool": true, "mcp_timeout": 3000 },',
        '  "attachment": { "image": { "auto_resize": true, "max_width": 1600, "max_height": 1200, "max_base64_bytes": 1024 } }',
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectConfigSettings(root)).resolves.toEqual([
      {
        key: "shell",
        label: "Shell",
        kind: "scalar",
        value: "",
        sourcePath: "BetterC0de.jsonc#shell",
      },
      {
        key: "username",
        label: "Username",
        kind: "scalar",
        value: "project-user",
        sourcePath: "BetterC0de.jsonc#username",
      },
      {
        key: "snapshot",
        label: "Snapshots",
        kind: "toggle",
        value: "disabled",
        sourcePath: "BetterC0de.jsonc#snapshot",
      },
      {
        key: "share",
        label: "Share mode",
        kind: "scalar",
        value: "manual",
        sourcePath: "BetterC0de.jsonc#share",
      },
      {
        key: "model",
        label: "Default model",
        kind: "scalar",
        value: "anthropic/claude-sonnet-4-5",
        sourcePath: "BetterC0de.jsonc#model",
      },
      {
        key: "disabled_providers",
        label: "Disabled providers",
        kind: "list",
        value: "grok",
        sourcePath: "BetterC0de.jsonc#disabled_providers",
      },
      {
        key: "skills",
        label: "Skills",
        kind: "object",
        value: "paths{1}, urls{1}",
        sourcePath: "BetterC0de.jsonc#skills",
      },
      {
        key: "watcher",
        label: "Watcher",
        kind: "object",
        value: "ignore{2}",
        sourcePath: "BetterC0de.jsonc#watcher",
      },
      {
        key: "tools",
        label: "Tools",
        kind: "object",
        value: "webfetch=false, bash=true",
        sourcePath: "BetterC0de.jsonc#tools",
      },
      {
        key: "tool_output",
        label: "Tool output",
        kind: "object",
        value: "max_lines=2000, max_bytes=51200",
        sourcePath: "BetterC0de.jsonc#tool_output",
      },
      {
        key: "compaction",
        label: "Compaction",
        kind: "object",
        value: "auto=true, prune=false",
        sourcePath: "BetterC0de.jsonc#compaction",
      },
      {
        key: "experimental",
        label: "Experimental",
        kind: "object",
        value: "batch_tool=true, mcp_timeout=3000",
        sourcePath: "BetterC0de.jsonc#experimental",
      },
      {
        key: "attachment",
        label: "Attachments",
        kind: "object",
        value: "image{4}",
        sourcePath: "BetterC0de.jsonc#attachment",
      },
      {
        key: "watcher.ignore",
        label: "Watcher ignore",
        kind: "list",
        value: "dist/**, tmp/**",
        sourcePath: "BetterC0de.jsonc#watcher.ignore",
      },
      {
        key: "skills.paths",
        label: "Skill paths",
        kind: "list",
        value: "custom-skills",
        sourcePath: "BetterC0de.jsonc#skills.paths",
      },
      {
        key: "skills.urls",
        label: "Skill URLs",
        kind: "list",
        value: "https://example.test/.well-known/skills",
        sourcePath: "BetterC0de.jsonc#skills.urls",
      },
      {
        key: "tools.webfetch",
        label: "Tool webfetch",
        kind: "toggle",
        value: "disabled",
        sourcePath: "BetterC0de.jsonc#tools.webfetch",
      },
      {
        key: "tools.bash",
        label: "Tool bash",
        kind: "toggle",
        value: "enabled",
        sourcePath: "BetterC0de.jsonc#tools.bash",
      },
      {
        key: "tool_output.max_lines",
        label: "Tool output max lines",
        kind: "scalar",
        value: "2000",
        sourcePath: "BetterC0de.jsonc#tool_output.max_lines",
      },
      {
        key: "tool_output.max_bytes",
        label: "Tool output max bytes",
        kind: "scalar",
        value: "51200",
        sourcePath: "BetterC0de.jsonc#tool_output.max_bytes",
      },
      {
        key: "compaction.auto",
        label: "Compaction auto",
        kind: "toggle",
        value: "enabled",
        sourcePath: "BetterC0de.jsonc#compaction.auto",
      },
      {
        key: "compaction.prune",
        label: "Compaction prune",
        kind: "toggle",
        value: "disabled",
        sourcePath: "BetterC0de.jsonc#compaction.prune",
      },
      {
        key: "experimental.batch_tool",
        label: "Batch tool",
        kind: "toggle",
        value: "enabled",
        sourcePath: "BetterC0de.jsonc#experimental.batch_tool",
      },
      {
        key: "experimental.mcp_timeout",
        label: "MCP timeout",
        kind: "scalar",
        value: "3000",
        sourcePath: "BetterC0de.jsonc#experimental.mcp_timeout",
      },
      {
        key: "attachment.image.auto_resize",
        label: "Image attachment auto resize",
        kind: "toggle",
        value: "enabled",
        sourcePath: "BetterC0de.jsonc#attachment.image.auto_resize",
      },
      {
        key: "attachment.image.max_width",
        label: "Image attachment max width",
        kind: "scalar",
        value: "1600",
        sourcePath: "BetterC0de.jsonc#attachment.image.max_width",
      },
      {
        key: "attachment.image.max_height",
        label: "Image attachment max height",
        kind: "scalar",
        value: "1200",
        sourcePath: "BetterC0de.jsonc#attachment.image.max_height",
      },
      {
        key: "attachment.image.max_base64_bytes",
        label: "Image attachment max base64 bytes",
        kind: "scalar",
        value: "1024",
        sourcePath: "BetterC0de.jsonc#attachment.image.max_base64_bytes",
      },
    ])
    await expect(getProjectShell(root)).resolves.toBeUndefined()
  })

  it("does not read a file variable through an escaping symlink or junction", async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    const sentinel = "outside-config-secret-sentinel"
    await fs.writeFile(path.join(outside, "secret.txt"), sentinel, "utf8")
    await fs.symlink(
      outside,
      path.join(root, "linked-secrets"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({ username: "{file:linked-secrets/secret.txt}" }),
      "utf8"
    )

    const settings = await listProjectConfigSettings(root)
    expect(JSON.stringify(settings)).not.toContain(sentinel)
    expect(settings).toContainEqual(
      expect.objectContaining({
        key: "username",
        value: "{file:linked-secrets/secret.txt}",
      })
    )
  })

  it("does not buffer or substitute an oversized config file variable", async () => {
    const root = await makeWorkspace()
    const sentinel = "oversized-file-variable-secret"
    await fs.writeFile(
      path.join(root, "large-secret.txt"),
      `${"x".repeat(64 * 1024)}${sentinel}`,
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ username: "{file:large-secret.txt}" }),
      "utf8"
    )

    const settings = await listProjectConfigSettings(root)

    expect(JSON.stringify(settings)).not.toContain(sentinel)
    expect(settings).toContainEqual(
      expect.objectContaining({
        key: "username",
        value: "{file:large-secret.txt}",
      })
    )
  })

  it("skips oversized TUI config files", async () => {
    const root = await makeWorkspace()
    const oversizedTui = JSON.stringify({
      theme: "must-not-load",
      padding: "x".repeat(256 * 1024),
    })
    await fs.writeFile(path.join(root, "tui.json"), oversizedTui, "utf8")

    const settings = await listProjectConfigSettings(root)

    expect(settings).not.toContainEqual(
      expect.objectContaining({ value: "must-not-load" })
    )
  })

  it("loads BetterC0de tui.json settings and keybind overrides", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "tui.jsonc"),
      [
        "{",
        '  "theme": "catppuccin",',
        '  "leader_timeout": 1500,',
        '  "keybinds": { "leader": "ctrl+x", "session_new": "<leader>n" },',
        '  "attention": { "enabled": true, "sound": false, "volume": 0.4, "sounds": { "done": "./done.wav" } },',
        '  "scroll_acceleration": { "enabled": false },',
        '  "diff_style": "stacked",',
        '  "mouse": false',
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectConfigSettings(root)).resolves.toEqual([
      {
        key: "theme",
        label: "TUI theme",
        kind: "scalar",
        value: "catppuccin",
        sourcePath: "tui.jsonc#theme",
      },
      {
        key: "leader_timeout",
        label: "Leader timeout",
        kind: "scalar",
        value: "1500",
        sourcePath: "tui.jsonc#leader_timeout",
      },
      {
        key: "keybinds",
        label: "TUI keybinds",
        kind: "object",
        value: "leader=ctrl+x, session_new=<leader>n",
        sourcePath: "tui.jsonc#keybinds",
      },
      {
        key: "attention",
        label: "Attention",
        kind: "object",
        value: "enabled=true, sound=false, volume=0.4, sounds{1}",
        sourcePath: "tui.jsonc#attention",
      },
      {
        key: "scroll_acceleration",
        label: "Scroll acceleration",
        kind: "object",
        value: "enabled=false",
        sourcePath: "tui.jsonc#scroll_acceleration",
      },
      {
        key: "diff_style",
        label: "Diff style",
        kind: "scalar",
        value: "stacked",
        sourcePath: "tui.jsonc#diff_style",
      },
      {
        key: "mouse",
        label: "Mouse capture",
        kind: "toggle",
        value: "disabled",
        sourcePath: "tui.jsonc#mouse",
      },
      {
        key: "keybinds.leader",
        label: "Keybind leader",
        kind: "scalar",
        value: "ctrl+x",
        sourcePath: "tui.jsonc#keybinds.leader",
      },
      {
        key: "keybinds.session_new",
        label: "Keybind session new",
        kind: "scalar",
        value: "<leader>n",
        sourcePath: "tui.jsonc#keybinds.session_new",
      },
      {
        key: "attention.enabled",
        label: "Attention enabled",
        kind: "toggle",
        value: "enabled",
        sourcePath: "tui.jsonc#attention.enabled",
      },
      {
        key: "attention.sound",
        label: "Attention sound",
        kind: "toggle",
        value: "disabled",
        sourcePath: "tui.jsonc#attention.sound",
      },
      {
        key: "attention.volume",
        label: "Attention volume",
        kind: "scalar",
        value: "0.4",
        sourcePath: "tui.jsonc#attention.volume",
      },
      {
        key: "attention.sounds.done",
        label: "Attention sound done",
        kind: "scalar",
        value: "./done.wav",
        sourcePath: "tui.jsonc#attention.sounds.done",
      },
      {
        key: "scroll_acceleration.enabled",
        label: "Scroll acceleration enabled",
        kind: "toggle",
        value: "disabled",
        sourcePath: "tui.jsonc#scroll_acceleration.enabled",
      },
    ])
  })

  it("summarizes BetterC0de server schema fields using current config names", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "server": {',
        '    "hostname": "127.0.0.1",',
        '    "port": 4096,',
        '    "mdns": true,',
        '    "mdnsDomain": "betterc0de.local",',
        '    "cors": ["https://example.test"]',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectConfigSettings(root)).resolves.toEqual([
      {
        key: "server",
        label: "Server",
        kind: "object",
        value:
          "hostname=127.0.0.1, port=4096, mdns=true, mdnsDomain=betterc0de.local, cors{1}",
        sourcePath: "BetterC0de.jsonc#server",
      },
      {
        key: "server.hostname",
        label: "Server hostname",
        kind: "scalar",
        value: "127.0.0.1",
        sourcePath: "BetterC0de.jsonc#server.hostname",
      },
      {
        key: "server.port",
        label: "Server port",
        kind: "scalar",
        value: "4096",
        sourcePath: "BetterC0de.jsonc#server.port",
      },
      {
        key: "server.mdns",
        label: "Server mDNS",
        kind: "toggle",
        value: "enabled",
        sourcePath: "BetterC0de.jsonc#server.mdns",
      },
      {
        key: "server.mdnsDomain",
        label: "Server mDNS domain",
        kind: "scalar",
        value: "betterc0de.local",
        sourcePath: "BetterC0de.jsonc#server.mdnsDomain",
      },
      {
        key: "server.cors",
        label: "Server CORS",
        kind: "list",
        value: "https://example.test",
        sourcePath: "BetterC0de.jsonc#server.cors",
      },
    ])
  })
})

describe("workspace BetterC0de project providers", () => {
  it("summarizes provider and model config without exposing option values", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "model": "custom/fast-model",',
        '  "small_model": "custom/small-model",',
        '  "enabled_providers": ["custom"],',
        '  "disabled_providers": ["legacy"],',
        '  "provider": {',
        '    "custom": {',
        '      "name": "Custom Provider",',
        '      "api": "openai-compatible",',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "env": ["CUSTOM_API_KEY"],',
        '      "whitelist": ["fast-model"],',
        '      "blacklist": ["old-model"],',
        '      "options": {',
        '        "apiKey": "secret",',
        '        "baseURL": "https://example.test/v1",',
        '        "enterpriseUrl": "https://github.example.test",',
        '        "setCacheKey": true,',
        '        "timeout": false,',
        '        "chunkTimeout": 45000',
        "      },",
        '      "models": {',
        '        "fast-model": {',
        '          "name": "Fast Model",',
        '          "family": "gpt",',
        '          "release_date": "2026-01-01",',
        '          "attachment": true,',
        '          "reasoning": true,',
        '          "temperature": true,',
        '          "tool_call": true,',
        '          "interleaved": { "field": "reasoning_content" },',
        '          "status": "stable",',
        '          "limit": { "context": 128000, "input": 64000, "output": 16000 },',
        '          "modalities": { "input": ["text", "image"], "output": ["text"] },',
        '          "cost": { "input": 0.000001, "output": 0.000002, "cache_read": 0.0000001, "context_over_200k": { "input": 0.000003, "output": 0.000004 } },',
        '          "provider": { "api": "responses", "npm": "@ai-sdk/custom" },',
        '          "options": { "temperature": 0.2 },',
        '          "headers": { "X-Project": "betterc0de" },',
        '          "variants": {',
        '            "fast": {},',
        '            "legacy": { "disabled": true }',
        "          }",
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectProviders(root)).resolves.toEqual({
      defaultModel: "custom/fast-model",
      smallModel: "custom/small-model",
      enabledProviders: ["custom"],
      disabledProviders: ["legacy"],
      authAccounts: [],
      providers: [
        {
          id: "custom",
          name: "Custom Provider",
          sourcePath: "BetterC0de.jsonc#provider.custom",
          api: "openai-compatible",
          npm: "@ai-sdk/openai-compatible",
          env: ["CUSTOM_API_KEY"],
          whitelist: ["fast-model"],
          blacklist: ["old-model"],
          optionKeys: [
            "apiKey",
            "baseURL",
            "chunkTimeout",
            "enterpriseUrl",
            "setCacheKey",
            "timeout",
          ],
          hasApiKey: true,
          baseURL: "https://example.test/v1",
          enterpriseUrl: "https://github.example.test",
          setCacheKey: true,
          timeout: false,
          chunkTimeout: 45000,
          models: [
            {
              id: "fast-model",
              name: "Fast Model",
              family: "gpt",
              releaseDate: "2026-01-01",
              sourcePath: "BetterC0de.jsonc#provider.custom.models.fast-model",
              attachment: true,
              reasoning: true,
              temperature: true,
              toolCall: true,
              interleaved: true,
              interleavedField: "reasoning_content",
              experimental: undefined,
              status: "stable",
              contextLimit: 128000,
              inputLimit: 64000,
              outputLimit: 16000,
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
              cost: {
                cache_read: 0.0000001,
                input: 0.000001,
                output: 0.000002,
              },
              contextOver200kCost: {
                input: 0.000003,
                output: 0.000004,
              },
              providerApi: "responses",
              providerNpm: "@ai-sdk/custom",
              optionKeys: ["temperature"],
              headerKeys: ["X-Project"],
              variants: ["fast", "legacy"],
              disabledVariants: ["legacy"],
            },
          ],
        },
      ],
    })
  })

  it("loads BetterC0de provider auth status without exposing credential values", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "provider": {',
        '    "custom": {',
        '      "name": "Custom Provider",',
        '      "models": { "fast": { "name": "Fast" } }',
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    const authDir = path.join(process.env.XDG_DATA_HOME!, "BetterC0de")
    const authPath = path.join(authDir, "auth-v2.json")
    await fs.mkdir(authDir, { recursive: true })
    await fs.writeFile(
      authPath,
      JSON.stringify({
        version: 2,
        active: { custom: "acc_custom", openai: "acc_openai" },
        accounts: {
          acc_custom: {
            id: "acc_custom",
            serviceID: "custom",
            description: "work",
            credential: {
              type: "api",
              key: "secret-api-key",
              metadata: { org: "org-secret" },
            },
          },
          acc_openai: {
            id: "acc_openai",
            serviceID: "openai",
            description: "oauth",
            credential: {
              type: "oauth",
              access: "secret-access-token",
              refresh: "secret-refresh-token",
              expires: 1,
            },
          },
        },
      }),
      "utf8"
    )

    const summary = await listProjectProviders(root)

    expect(summary.authAccounts).toEqual([
      {
        serviceId: "custom",
        sourcePath: authPath,
        accountCount: 1,
        credentialTypes: ["api"],
        activeAccountId: "acc_custom",
        activeDescription: "work",
        activeCredentialType: "api",
        metadataKeys: ["org"],
      },
      {
        serviceId: "openai",
        sourcePath: authPath,
        accountCount: 1,
        credentialTypes: ["oauth"],
        activeAccountId: "acc_openai",
        activeDescription: "oauth",
        activeCredentialType: "oauth",
        activeExpiresAt: 1,
        activeExpired: true,
      },
    ])
    expect(JSON.stringify(summary)).not.toContain("secret-api-key")
    expect(JSON.stringify(summary)).not.toContain("secret-access-token")
    expect(JSON.stringify(summary)).not.toContain("secret-refresh-token")
    expect(JSON.stringify(summary)).not.toContain("org-secret")
  })
})

describe("workspace BetterC0de project plugins", () => {
  it("loads plugin specs from config and discovers project plugin files", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "plugins"), { recursive: true })
    await fs.mkdir(path.join(root, ".BetterC0de", "plugin"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, "plugins", "local.ts"),
      "export {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "plugins", "unconfigured.ts"),
      "export {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "plugin", "auto.js"),
      "export {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "plugin", "ignored.mjs"),
      "export {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "plugin": [',
        '    "acme-plugin@1.2.3",',
        '    ["./plugins/local.ts", { "enabled": true, "token": "secret" }],',
        '    "https://example.test/plugin.js",',
        '    "../outside.js"',
        "  ]",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectPlugins(root)).resolves.toEqual([
      {
        id: "../outside.js",
        spec: "../outside.js",
        kind: "invalid",
        sourcePath: "BetterC0de.jsonc#plugin.3",
        optionsKeys: [],
        message:
          "Local plugin paths must stay inside the active workspace in BetterC0de",
      },
      {
        id: "./plugins/local.ts",
        spec: "./plugins/local.ts",
        kind: "file",
        sourcePath: "BetterC0de.jsonc#plugin.1",
        optionsKeys: ["enabled", "token"],
        path: path.join(root, "plugins", "local.ts"),
        relativePath: "plugins/local.ts",
        exists: true,
      },
      {
        id: ".BetterC0de/plugin/auto.js",
        spec: ".BetterC0de/plugin/auto.js",
        kind: "file",
        sourcePath: ".BetterC0de/plugin/auto.js",
        optionsKeys: [],
        path: path.join(root, ".BetterC0de", "plugin", "auto.js"),
        relativePath: ".BetterC0de/plugin/auto.js",
        exists: true,
      },
      {
        id: "acme-plugin@1.2.3",
        spec: "acme-plugin@1.2.3",
        kind: "npm",
        sourcePath: "BetterC0de.jsonc#plugin.0",
        optionsKeys: [],
      },
      {
        id: "https://example.test/plugin.js",
        spec: "https://example.test/plugin.js",
        kind: "url",
        sourcePath: "BetterC0de.jsonc#plugin.2",
        optionsKeys: [],
      },
    ])
  })

  it("loads BetterC0de plugin files from ancestor and home config directories", async () => {
    const root = await makeWorkspace()
    const projectRoot = path.join(root, "repo", "app")
    const ancestorDir = path.join(root, "repo", ".BetterC0de")
    const homeDir = path.join(process.env.BetterC0de_TEST_HOME!, ".BetterC0de")
    await fs.mkdir(projectRoot, { recursive: true })
    await fs.mkdir(path.join(ancestorDir, "plugin"), { recursive: true })
    await fs.mkdir(path.join(homeDir, "plugins"), { recursive: true })
    await fs.writeFile(
      path.join(ancestorDir, "plugin", "parent.js"),
      "export default {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(ancestorDir, "plugin", "from-config.js"),
      "export default {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(homeDir, "plugins", "home.ts"),
      "export default {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(ancestorDir, "BetterC0de.jsonc"),
      JSON.stringify({ plugin: ["./plugin/from-config.js"] }),
      "utf8"
    )

    await expect(listProjectPlugins(projectRoot)).resolves.toEqual(
      expect.arrayContaining([
        {
          id: "./plugin/from-config.js",
          spec: "./plugin/from-config.js",
          kind: "file",
          sourcePath: `${path.join(ancestorDir, "BetterC0de.jsonc")}#plugin.0`,
          optionsKeys: [],
          path: path.join(ancestorDir, "plugin", "from-config.js"),
          exists: true,
        },
        {
          id: `${path.join(ancestorDir, "plugin")}/parent.js`,
          spec: `${path.join(ancestorDir, "plugin")}/parent.js`,
          kind: "file",
          sourcePath: `${path.join(ancestorDir, "plugin")}/parent.js`,
          optionsKeys: [],
          path: path.join(ancestorDir, "plugin", "parent.js"),
          exists: true,
        },
        {
          id: "~/.BetterC0de/plugins/home.ts",
          spec: "~/.BetterC0de/plugins/home.ts",
          kind: "file",
          sourcePath: "~/.BetterC0de/plugins/home.ts",
          optionsKeys: [],
          path: path.join(homeDir, "plugins", "home.ts"),
          exists: true,
        },
      ])
    )
  })

  it("marks project plugin specs as skipped in BetterC0de pure mode", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, ".BetterC0de", "plugin"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "plugin", "auto.js"),
      "export {}",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({
        plugin: ["acme-plugin", "./.BetterC0de/plugin/auto.js"],
      }),
      "utf8"
    )
    process.env.BetterC0de_PURE = "true"

    await expect(listProjectPlugins(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "acme-plugin",
          skipped: true,
          skippedReason: "Skipped by BetterC0de_PURE",
        }),
        expect.objectContaining({
          id: "./.BetterC0de/plugin/auto.js",
          skipped: true,
          skippedReason: "Skipped by BetterC0de_PURE",
        }),
      ])
    )
  })

  it("attaches read-only BetterC0de plugin metadata", async () => {
    const root = await makeWorkspace()
    const metaDir = path.join(process.env.XDG_STATE_HOME!, "BetterC0de")
    const metaPath = path.join(metaDir, "plugin-meta.json")
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({ plugin: ["acme-plugin@1.2.3"] }),
      "utf8"
    )
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        "acme-plugin@1.2.3": {
          id: "acme-plugin@1.2.3",
          source: "npm",
          spec: "acme-plugin@1.2.3",
          target: "/tmp/BetterC0de/plugins/acme",
          requested: "1.2.3",
          version: "1.2.4",
          load_count: 7,
          last_time: 1700000000000,
          time_changed: 1699999999000,
          themes: {
            agency: { src: "agency.json", dest: "agency.json" },
          },
        },
      }),
      "utf8"
    )

    await expect(listProjectPlugins(root)).resolves.toEqual([
      {
        id: "acme-plugin@1.2.3",
        spec: "acme-plugin@1.2.3",
        kind: "npm",
        sourcePath: "BetterC0de.jsonc#plugin.0",
        optionsKeys: [],
        metaSourcePath: metaPath,
        metaSource: "npm",
        metaTarget: "/tmp/BetterC0de/plugins/acme",
        metaRequested: "1.2.3",
        metaVersion: "1.2.4",
        metaLoadCount: 7,
        metaLastTime: 1700000000000,
        metaTimeChanged: 1699999999000,
        metaThemes: ["agency"],
      },
    ])
  })
})

describe("workspace BetterC0de project tools", () => {
  it("loads legacy BetterC0de tool enable flags from project config", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "tools": {',
        '    "bash": true,',
        '    "webfetch": false',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectTools(root)).resolves.toEqual([
      {
        tool: "bash",
        enabled: true,
        kind: "flag",
        sourcePath: "BetterC0de.jsonc#tools.bash",
      },
      {
        tool: "webfetch",
        enabled: false,
        kind: "flag",
        sourcePath: "BetterC0de.jsonc#tools.webfetch",
      },
    ])
  })

  it("fails closed on malformed project tool policy values", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      JSON.stringify({ tools: { bash: "false" } }),
      "utf8"
    )

    await expect(listProjectTools(root)).rejects.toThrow(
      /tools\.bash must be boolean/i
    )
  })

  it("discovers BetterC0de custom tool modules from config tool directories", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, ".BetterC0de", "tools"), { recursive: true })
    await fs.writeFile(
      path.join(root, ".BetterC0de", "tools", "repo.ts"),
      [
        "export default {",
        '  description: "Default repo tool",',
        "  args: {},",
        "  execute: async () => 'ok',",
        "}",
        "export const overview = {",
        '  description: "Overview tool",',
        "  args: {},",
        "  execute: async () => 'ok',",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectTools(root)).resolves.toEqual([
      {
        tool: "repo",
        enabled: true,
        kind: "custom",
        exportName: "default",
        sourcePath: ".BetterC0de/tools/repo.ts",
      },
      {
        tool: "repo_overview",
        enabled: true,
        kind: "custom",
        exportName: "overview",
        sourcePath: ".BetterC0de/tools/repo.ts",
      },
    ])
  })

  it("keeps legacy tool flags when a custom tool module has the same id", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, ".BetterC0de", "tools"), { recursive: true })
    await fs.writeFile(
      path.join(root, "BetterC0de.json"),
      JSON.stringify({ tools: { repo: false } }),
      "utf8"
    )
    await fs.writeFile(
      path.join(root, ".BetterC0de", "tools", "repo.ts"),
      "export default { description: 'repo', args: {}, execute: async () => 'ok' }",
      "utf8"
    )

    await expect(listProjectTools(root)).resolves.toEqual([
      {
        tool: "repo",
        enabled: false,
        kind: "flag",
        sourcePath: "BetterC0de.json#tools.repo",
      },
      {
        tool: "repo",
        enabled: true,
        kind: "custom",
        exportName: "default",
        sourcePath: ".BetterC0de/tools/repo.ts",
      },
    ])
  })

  it("merges legacy BetterC0de top-level tools into project permissions", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "tools": {',
        '    "bash": true,',
        '    "write": false,',
        '    "patch": false,',
        '    "webfetch": false,',
        '    "fetch": false,',
        '    "repo_clone": false,',
        '    "repo-overview": false,',
        '    "external-directory": false',
        "  },",
        '  "permission": {',
        '    "edit": "ask",',
        '    "bash": { "npm test*": "allow" }',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(listProjectPermissions(root)).resolves.toEqual([
      {
        permission: "bash",
        pattern: "*",
        action: "allow",
        sourcePath: "BetterC0de.jsonc#tools.bash",
      },
      {
        permission: "edit",
        pattern: "*",
        action: "ask",
        sourcePath: "BetterC0de.jsonc#permission.edit",
      },
      {
        permission: "external_directory",
        pattern: "*",
        action: "deny",
        sourcePath: "BetterC0de.jsonc#tools.external-directory",
      },
      {
        permission: "repo_clone",
        pattern: "*",
        action: "deny",
        sourcePath: "BetterC0de.jsonc#tools.repo_clone",
      },
      {
        permission: "repo_overview",
        pattern: "*",
        action: "deny",
        sourcePath: "BetterC0de.jsonc#tools.repo-overview",
      },
      {
        permission: "webfetch",
        pattern: "*",
        action: "deny",
        sourcePath: "BetterC0de.jsonc#tools.fetch",
      },
      {
        permission: "bash",
        pattern: "npm test*",
        action: "allow",
        sourcePath: "BetterC0de.jsonc#permission.bash.npm test*",
      },
    ])
  })
})

describe("workspace content search", () => {
  it("finds text matches with file paths and line numbers", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(
      path.join(root, "src", "feature.ts"),
      ["export function alpha() {", "  return 'needle value'", "}"].join("\n"),
      "utf8"
    )

    await expect(searchContent(root, "needle")).resolves.toEqual([
      {
        path: "src/feature.ts",
        name: "feature.ts",
        matches: [
          {
            line: 2,
            column: 11,
            length: 6,
            previewColumn: 9,
            previewLength: 6,
            preview: "return 'needle value'",
          },
        ],
      },
    ])
  })

  it("supports case-sensitive search", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "case.ts"), "Needle\nneedle", "utf8")

    const results = await searchContent(root, "Needle", {
      caseSensitive: true,
    })

    expect(results).toEqual([
      {
        path: "case.ts",
        name: "case.ts",
        matches: [
          {
            line: 1,
            column: 1,
            length: 6,
            previewColumn: 1,
            previewLength: 6,
            preview: "Needle",
          },
        ],
      },
    ])
  })

  it("supports whole-word search", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "words.ts"),
      "needle\nneedles\nmy_needle\nneedleValue",
      "utf8"
    )

    const results = await searchContent(root, "needle", {
      wholeWord: true,
    })

    expect(results).toEqual([
      {
        path: "words.ts",
        name: "words.ts",
        matches: [
          {
            line: 1,
            column: 1,
            length: 6,
            previewColumn: 1,
            previewLength: 6,
            preview: "needle",
          },
        ],
      },
    ])
  })

  it("returns every matching column on a line", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "multi.ts"),
      "const Foo = Foo; const FooBar = Foo",
      "utf8"
    )

    const results = await searchContent(root, "Foo", {
      caseSensitive: true,
      wholeWord: true,
    })

    expect(results).toHaveLength(1)
    expect(
      results[0]?.matches.map((match) => ({
        column: match.column,
        length: match.length,
        previewColumn: match.previewColumn,
        previewLength: match.previewLength,
      }))
    ).toEqual([
      { column: 7, length: 3, previewColumn: 7, previewLength: 3 },
      { column: 13, length: 3, previewColumn: 13, previewLength: 3 },
      { column: 33, length: 3, previewColumn: 33, previewLength: 3 },
    ])
  })

  it("stops literal and regex matching at the global result budget", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "many.ts"),
      Array.from({ length: 100 }, () => "needle").join(" "),
      "utf8"
    )

    const literal = await searchContent(root, "needle", { limit: 3 })
    const regex = await searchContent(root, "needle", {
      limit: 4,
      regex: true,
    })

    expect(
      literal.reduce((count, result) => count + result.matches.length, 0)
    ).toBe(3)
    expect(
      regex.reduce((count, result) => count + result.matches.length, 0)
    ).toBe(4)
  })

  it("treats dollar signs and hyphens as whole-word identifier characters", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "identifiers.ts"),
      "$store $storeValue other-$store $store\npanel-title panel-title-large",
      "utf8"
    )

    const dollarResults = await searchContent(root, "$store", {
      caseSensitive: true,
      wholeWord: true,
    })
    const hyphenResults = await searchContent(root, "panel-title", {
      caseSensitive: true,
      wholeWord: true,
    })

    expect(
      dollarResults[0]?.matches.map((match) => ({
        column: match.column,
        length: match.length,
        previewColumn: match.previewColumn,
        previewLength: match.previewLength,
      }))
    ).toEqual([
      { column: 1, length: 6, previewColumn: 1, previewLength: 6 },
      { column: 33, length: 6, previewColumn: 33, previewLength: 6 },
    ])
    expect(
      hyphenResults[0]?.matches.map((match) => ({
        column: match.column,
        length: match.length,
        previewColumn: match.previewColumn,
        previewLength: match.previewLength,
      }))
    ).toEqual([{ column: 1, length: 11, previewColumn: 1, previewLength: 11 }])
  })

  it("supports regex search", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(
      path.join(root, "regex.ts"),
      "const alpha = 1\nconst beta = 2",
      "utf8"
    )

    const results = await searchContent(root, "const\\s+beta", {
      regex: true,
    })

    expect(results).toEqual([
      {
        path: "regex.ts",
        name: "regex.ts",
        matches: [
          {
            line: 2,
            column: 1,
            length: 10,
            previewColumn: 1,
            previewLength: 10,
            preview: "const beta = 2",
          },
        ],
      },
    ])
  })

  it("rejects invalid regex search queries", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "regex.ts"), "needle", "utf8")

    await expect(searchContent(root, "[", { regex: true })).rejects.toThrow(
      "Invalid search regex"
    )
  })

  it("rejects regex features that can catastrophically backtrack", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "regex.ts"), "a".repeat(100_000), "utf8")

    await expect(
      searchContent(root, "(a+)+$", { regex: true })
    ).rejects.toThrow("Unsafe search regex feature")
  })

  it("rejects chains of optional quantifiers that can backtrack exponentially", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "regex.ts"), "a".repeat(100_000), "utf8")

    await expect(
      searchContent(root, "a?a?a?a?a?a?a?a?a?aaaaaaaaa", { regex: true })
    ).rejects.toThrow("Unsafe search regex feature")
  })

  it("filters content search by include and exclude globs", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.mkdir(path.join(root, "test"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "keep.ts"), "needle", "utf8")
    await fs.writeFile(path.join(root, "src", "skip.test.ts"), "needle", "utf8")
    await fs.writeFile(path.join(root, "test", "keep.ts"), "needle", "utf8")
    await fs.writeFile(path.join(root, "README.md"), "needle", "utf8")

    const results = await searchContent(root, "needle", {
      include: "src/**/*.ts",
      exclude: "*.test.ts",
    })

    expect(results.map((result) => result.path)).toEqual(["src/keep.ts"])
  })

  it("respects gitignore and baseline ignores", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.mkdir(path.join(root, "ignored"), { recursive: true })
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true })
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8")
    await fs.writeFile(path.join(root, "src", "keep.ts"), "needle", "utf8")
    await fs.writeFile(path.join(root, "ignored", "skip.ts"), "needle", "utf8")
    await fs.writeFile(
      path.join(root, "node_modules", "pkg", "skip.js"),
      "needle",
      "utf8"
    )

    const results = await searchContent(root, "needle")
    expect(results.map((result) => result.path)).toEqual(["src/keep.ts"])
  })

  it("skips binary and oversized files", async () => {
    const root = await makeWorkspace()
    await fs.writeFile(path.join(root, "image.png"), Buffer.from([0, 1, 2]))
    await fs.writeFile(
      path.join(root, "large.txt"),
      `${"x".repeat(1024 * 1024 + 1)}needle`,
      "utf8"
    )
    await fs.writeFile(path.join(root, "small.txt"), "needle", "utf8")

    const results = await searchContent(root, "needle")
    expect(results.map((result) => result.path)).toEqual(["small.txt"])
  })
})

describe("workspace quick open", () => {
  it("ranks basename matches ahead of fuzzy path matches", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src", "components"), { recursive: true })
    await fs.mkdir(path.join(root, "docs"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "components", "Button.tsx"), "")
    await fs.writeFile(
      path.join(root, "src", "components", "ButtonGroup.tsx"),
      ""
    )
    await fs.writeFile(path.join(root, "docs", "better-control-panel.md"), "")

    const results = await quickOpenFiles(root, "button")

    expect(results.map((result) => result.path).slice(0, 2)).toEqual([
      "src/components/Button.tsx",
      "src/components/ButtonGroup.tsx",
    ])
  })

  it("matches path fragments and respects ignores", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src", "components"), { recursive: true })
    await fs.mkdir(path.join(root, "ignored", "components"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true })
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8")
    await fs.writeFile(path.join(root, "src", "components", "Panel.tsx"), "")
    await fs.writeFile(
      path.join(root, "ignored", "components", "Panel.tsx"),
      ""
    )
    await fs.writeFile(path.join(root, "node_modules", "pkg", "Panel.tsx"), "")

    const results = await quickOpenFiles(root, "components/panel")

    expect(results).toEqual([
      {
        path: "src/components/Panel.tsx",
        name: "Panel.tsx",
      },
    ])
  })

  it("filters quick open files by BetterC0de-style include globs", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.mkdir(path.join(root, "docs"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "chat.ts"), "")
    await fs.writeFile(path.join(root, "src", "chat.test.ts"), "")
    await fs.writeFile(path.join(root, "docs", "chat.md"), "")

    const results = await quickOpenFiles(root, "chat", {
      include: "src/**/*.ts",
    })

    expect(results.map((result) => result.path).sort()).toEqual([
      "src/chat.test.ts",
      "src/chat.ts",
    ])
  })
})

describe("BetterC0de watcher ignores", () => {
  it("applies watcher.ignore to search, quick open, and workspace map", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.mkdir(path.join(root, "generated"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "Visible.ts"), "needle")
    await fs.writeFile(path.join(root, "src", "Hidden.secret.ts"), "needle")
    await fs.writeFile(path.join(root, "generated", "Hidden.ts"), "needle")
    await fs.writeFile(
      path.join(root, "BetterC0de.jsonc"),
      [
        "{",
        '  "watcher": {',
        '    "ignore": ["generated/**", "**/*.secret.ts"]',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )

    await expect(searchEntries(root, "Hidden")).resolves.toEqual([])
    await expect(quickOpenFiles(root, "hidden")).resolves.toEqual([])
    await expect(searchContent(root, "needle")).resolves.toEqual([
      {
        path: "src/Visible.ts",
        name: "Visible.ts",
        matches: [
          {
            line: 1,
            column: 1,
            length: 6,
            previewColumn: 1,
            previewLength: 6,
            preview: "needle",
          },
        ],
      },
    ])

    const overview = await workspaceMap(root)
    expect(overview.files.map((file) => file.path)).toEqual([
      "BetterC0de.jsonc",
      "src/Visible.ts",
    ])
  })

  it("applies watcher.ignore from parent .BetterC0de config", async () => {
    const root = await makeWorkspace()
    const projectRoot = path.join(root, "repo", "app")
    const parentBetterC0de = path.join(root, "repo", ".BetterC0de")
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true })
    await fs.mkdir(path.join(projectRoot, "generated"), { recursive: true })
    await fs.mkdir(parentBetterC0de, { recursive: true })
    await fs.writeFile(path.join(projectRoot, "src", "Visible.ts"), "needle")
    await fs.writeFile(
      path.join(projectRoot, "generated", "Hidden.ts"),
      "needle"
    )
    await fs.writeFile(
      path.join(parentBetterC0de, "BetterC0de.jsonc"),
      JSON.stringify({ watcher: { ignore: ["generated/**"] } }),
      "utf8"
    )

    await expect(searchEntries(projectRoot, "Hidden")).resolves.toEqual([])
    await expect(searchContent(projectRoot, "needle")).resolves.toEqual([
      {
        path: "src/Visible.ts",
        name: "Visible.ts",
        matches: [
          {
            line: 1,
            column: 1,
            length: 6,
            previewColumn: 1,
            previewLength: 6,
            preview: "needle",
          },
        ],
      },
    ])
  })
})

describe("workspace map", () => {
  it("aggregates directories, extensions, and important files", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src", "components"), { recursive: true })
    await fs.mkdir(path.join(root, "docs"), { recursive: true })
    await fs.writeFile(path.join(root, "package.json"), "{}")
    await fs.writeFile(path.join(root, "tsconfig.json"), "{}")
    await fs.writeFile(path.join(root, "src", "main.tsx"), "export {}")
    await fs.writeFile(
      path.join(root, "src", "components", "Button.tsx"),
      "export const Button = () => null"
    )
    await fs.writeFile(path.join(root, "docs", "guide.md"), "# Guide")

    const overview = await workspaceMap(root)

    expect(overview.totalFiles).toBe(5)
    expect(overview.codeFiles).toBe(2)
    expect(overview.truncated).toBe(false)
    expect(overview.files.map((file) => file.path)).toEqual([
      "docs/guide.md",
      "package.json",
      "src/components/Button.tsx",
      "src/main.tsx",
      "tsconfig.json",
    ])
    expect(overview.topDirectories[0]).toMatchObject({
      path: "src",
      fileCount: 2,
      codeFileCount: 2,
    })
    expect(overview.extensions.map((entry) => entry.extension)).toContain("tsx")
    expect(overview.importantFiles.map((file) => file.path)).toEqual([
      "package.json",
      "tsconfig.json",
      "src/main.tsx",
    ])
  })

  it("respects ignores and max file limits", async () => {
    const root = await makeWorkspace()
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.mkdir(path.join(root, "ignored"), { recursive: true })
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8")
    for (let index = 0; index < 120; index += 1) {
      await fs.writeFile(path.join(root, "src", `file-${index}.ts`), "")
    }
    await fs.writeFile(path.join(root, "ignored", "skip.ts"), "")

    const overview = await workspaceMap(root, { maxFiles: 100 })

    expect(overview.totalFiles).toBe(100)
    expect(overview.files).toHaveLength(100)
    expect(overview.truncated).toBe(true)
    expect(overview.topDirectories).toEqual([
      {
        path: "src",
        name: "src",
        fileCount: 100,
        codeFileCount: 100,
        totalBytes: 0,
      },
    ])
  })
})
