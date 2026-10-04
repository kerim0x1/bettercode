import { create } from "zustand"
import { getCliStatus, type CliStatusResponse } from "@/services/backend"

export interface McpServer {
  id: string
  name: string
  source: "claude" | "codex"
  type: "oauth" | "command" | "http"
  url?: string | null
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  headerEnv?: Record<string, string>
  authenticated?: boolean
  enabled?: boolean
  scope?: "user" | "project"
  sourcePath?: string
}

export interface Skill {
  id: string
  name: string
  source: "claude" | "codex"
  path?: string
  providerKinds?: string[]
  providerInstanceIds?: string[]
}

export interface CliPlugin {
  id: string
  name: string
  source: "claude"
  marketplace?: string
}

export interface ScanResult {
  projectScope?: {
    status: "not-selected" | "invalid" | "unavailable" | "untrusted" | "trusted"
    projectPath: string | null
    workspaceTrusted: boolean
  }
  claude: {
    found: boolean
    plugins: CliPlugin[]
    mcpServers: McpServer[]
    skills: Skill[]
    agents: { id: string; name: string; source: string; path?: string }[]
    commands?: { id: string; name: string; source: string; path?: string }[]
    skippedMcpServers?: Array<{
      id: string
      name: string
      reason: string
      unsupportedKeys: string[]
    }>
    configSources?: string[]
  }
  codex: {
    found: boolean
    mcpServers: McpServer[]
    skills: Skill[]
    agents: { id: string; name: string; source: string }[]
    commands?: { id: string; name: string; source: string; path?: string }[]
    skippedMcpServers?: Array<{
      id: string
      name: string
      reason: string
      unsupportedKeys: string[]
    }>
    configSources?: string[]
    model?: string | null
    features?: Record<string, boolean>
  }
}

export interface CliStatusInfo {
  installed: boolean
  version: string | null
  authenticated: boolean
  authType: string | null
  binaryPath: string | null
}

/** Every CLI the backend's `/cli/status` `cli` map can carry, keyed by the
 *  provider catalog id (`apps/backend/src/provider/catalog/`). Entries are
 *  optional because an older backend may not report the newer CLIs. */
export interface CliStatusMap {
  claude?: CliStatusInfo
  codex?: CliStatusInfo
  "grok-cli"?: CliStatusInfo
  cursor?: CliStatusInfo
  "opencode-cli"?: CliStatusInfo
}

interface OnboardingState {
  step: number
  cliStatus: CliStatusMap | null
  scanResult: ScanResult | null
  selectedMcp: Set<string>
  selectedSkills: Set<string>
  selectedAgents: Set<string>
  selectedPlugins: Set<string>
  scanning: boolean
  importing: boolean
  done: boolean
  checked: boolean

  checkDone: () => Promise<void>
  startScan: () => Promise<void>
  toggleMcp: (id: string) => void
  toggleSkill: (id: string) => void
  toggleAgent: (id: string) => void
  togglePlugin: (id: string) => void
  selectAllMcp: () => void
  selectAllSkills: () => void
  selectAllAgents: () => void
  selectAllPlugins: () => void
  importSelected: () => Promise<void>
  complete: () => Promise<void>
  nextStep: () => void
  prevStep: () => void
}

const api = () => window.electronAPI

/** `cli` is the authoritative per-provider map; `claude`/`codex` remain as
 *  top-level shortcuts for older backends that predate it. */
function toCliStatusMap(res: CliStatusResponse): CliStatusMap {
  const cli = res.cli ?? {}
  return {
    claude: cli.claude ?? res.claude,
    codex: cli.codex ?? res.codex,
    "grok-cli": cli["grok-cli"],
    cursor: cli.cursor,
    "opencode-cli": cli["opencode-cli"],
  }
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  step: 0,
  cliStatus: null,
  scanResult: null,
  selectedMcp: new Set(),
  selectedSkills: new Set(),
  selectedAgents: new Set(),
  selectedPlugins: new Set(),
  scanning: false,
  importing: false,
  done: false,
  checked: false,

  checkDone: async () => {
    const bridge = api()
    if (!bridge?.onboardingIsDone) {
      set({ done: true, checked: true })
      return
    }
    try {
      const isDone = await bridge.onboardingIsDone()
      set({ done: isDone, checked: true })
    } catch {
      set({ done: true, checked: true })
    }
  },

  startScan: async () => {
    set({ scanning: true })
    // CLI binary detection (backend spawns `claude --version` etc.) is the
    // slow half of this scan — it used to run BEFORE the config scan, so
    // the "Import from CLI" list sat on a spinner for the full probe
    // duration. It only feeds the Detect step's status cards, so let it
    // resolve on its own; `scanning` now gates the config scan alone.
    void getCliStatus()
      .catch(() => null)
      .then((res) => set({ cliStatus: res ? toCliStatusMap(res) : null }))
    try {
      // Config file scanning via Electron IPC (MCP servers, plugins, skills)
      const bridge = api()
      if (bridge?.onboardingScan) {
        const res = (await bridge.onboardingScan()) as
          | {
              ok?: boolean
              claude: ScanResult["claude"]
              codex: ScanResult["codex"]
              projectScope?: ScanResult["projectScope"]
            }
          | undefined
        if (res?.ok) {
          const scan = {
            claude: res.claude,
            codex: res.codex,
            projectScope: res.projectScope,
          } as ScanResult
          const mcpIds = new Set<string>()
          const skillIds = new Set<string>()
          const agentIds = new Set<string>()
          const pluginIds = new Set<string>()
          for (const s of [
            ...(scan.claude?.mcpServers || []),
            ...(scan.codex?.mcpServers || []),
          ])
            mcpIds.add(s.id)
          for (const s of [
            ...(scan.claude?.skills || []),
            ...(scan.codex?.skills || []),
          ])
            skillIds.add(s.id)
          for (const agent of [
            ...(scan.claude?.agents || []),
            ...(scan.codex?.agents || []),
          ])
            agentIds.add(agent.id)
          for (const p of scan.claude?.plugins || []) pluginIds.add(p.id)
          set({
            scanResult: scan,
            selectedMcp: mcpIds,
            selectedSkills: skillIds,
            selectedAgents: agentIds,
            selectedPlugins: pluginIds,
          })
        }
      }
    } catch {
      // Ignore scan/bootstrap failures and continue with whatever data is available.
    }
    set({ scanning: false })
  },

  toggleMcp: (id) =>
    set((s) => {
      const next = new Set(s.selectedMcp)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedMcp: next }
    }),

  toggleSkill: (id) =>
    set((s) => {
      const next = new Set(s.selectedSkills)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedSkills: next }
    }),

  toggleAgent: (id) =>
    set((s) => {
      const next = new Set(s.selectedAgents)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedAgents: next }
    }),

  togglePlugin: (id) =>
    set((s) => {
      const next = new Set(s.selectedPlugins)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedPlugins: next }
    }),

  selectAllMcp: () => {
    const scan = get().scanResult
    if (!scan) return
    const all = [
      ...(scan.claude?.mcpServers || []),
      ...(scan.codex?.mcpServers || []),
    ]
    set({ selectedMcp: new Set(all.map((s) => s.id)) })
  },

  selectAllSkills: () => {
    const scan = get().scanResult
    if (!scan) return
    const all = [...(scan.claude?.skills || []), ...(scan.codex?.skills || [])]
    set({ selectedSkills: new Set(all.map((s) => s.id)) })
  },

  selectAllAgents: () => {
    const scan = get().scanResult
    if (!scan) return
    const all = [...(scan.claude?.agents || []), ...(scan.codex?.agents || [])]
    set({ selectedAgents: new Set(all.map((a) => a.id)) })
  },

  selectAllPlugins: () => {
    const scan = get().scanResult
    if (!scan) return
    set({
      selectedPlugins: new Set((scan.claude?.plugins || []).map((p) => p.id)),
    })
  },

  importSelected: async () => {
    if (!api()?.onboardingImport) return
    const {
      scanResult,
      selectedMcp,
      selectedSkills,
      selectedAgents,
      selectedPlugins,
    } = get()
    if (!scanResult) return
    set({ importing: true })
    try {
      const allMcp = [
        ...(scanResult.claude?.mcpServers || []),
        ...(scanResult.codex?.mcpServers || []),
      ]
      const allSkills = [
        ...(scanResult.claude?.skills || []),
        ...(scanResult.codex?.skills || []),
      ]
      const allAgents = [
        ...(scanResult.claude?.agents || []),
        ...(scanResult.codex?.agents || []),
      ]
      const allPlugins = scanResult.claude?.plugins || []

      const bridge = api()
      if (bridge?.onboardingImport) {
        await bridge.onboardingImport({
          mcpServers: allMcp.filter((s) => selectedMcp.has(s.id)),
          skills: allSkills.filter((s) => selectedSkills.has(s.id)),
          agents: allAgents.filter((a) => selectedAgents.has(a.id)),
          plugins: allPlugins.filter((p) => selectedPlugins.has(p.id)),
        })
      }
    } catch {
      // Import failures are surfaced by the onboarding completion state.
    }
    set({ importing: false })
  },

  complete: async () => {
    await get().importSelected()
    const bridge = api()
    if (bridge?.onboardingComplete) {
      await bridge.onboardingComplete()
    }
    set({ done: true })
  },

  nextStep: () => set((s) => ({ step: Math.min(5, s.step + 1) })),
  prevStep: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
}))
