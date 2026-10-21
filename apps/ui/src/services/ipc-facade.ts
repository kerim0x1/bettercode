/**
 * Typed facade over `window.electronAPI`.
 *
 * Problem: components scattered across the renderer call
 * `window.electronAPI?.mcpInstall(cfg)` and then unpack
 * `{ ok, error?, id? }` by hand — with slightly different error logic
 * everywhere. Any change to the envelope shape or a payload type
 * required a grep-and-fix across 16+ files. Runtime validation of
 * the result was never done, so main-process contract drift shipped
 * bugs silently (e.g. a channel rename would just return `undefined`).
 *
 * This module is the single seam between renderer code and the IPC
 * bridge. Every caller imports `ipcApi` from here. Individual methods:
 *   - guard against a missing `window.electronAPI` (remote backend
 *     mode) by throwing a uniform `IpcError`,
 *   - `unwrap` the `{ ok, error?, ...data }` envelope — throwing
 *     `IpcError(error)` on `ok: false` so callers write `try/catch`
 *     instead of `if (res?.ok) {…}`,
 *   - cast the `unknown[]` returns to the payload types defined in
 *     `electron-api.d.ts` (the source of truth for the bridge).
 *
 * Not Zod-validated on the data payloads yet — the preload's TypeScript
 * types are enough until we have evidence of contract drift on those
 * specific shapes. The envelope IS runtime-validated here because it's
 * the most drift-prone surface and cheap to check.
 */

import type {
  RuntimeHookView,
  RuntimeMcpServerRecord,
} from "@betterc0de/schema/runtime-records"
import type {
  BugReportPayload,
  BugReportResult,
  ElectronAPI,
} from "@/types/electron-api"
// The class module, not the `@/lib/errors` index: that one also pulls in
// React hooks, and every renderer module reaches the bridge through here.
import { IpcError } from "@/lib/errors/types"

/**
 * The preload bridge (`window.electronAPI`), or `undefined` outside the
 * desktop shell: remote backend mode, a plain browser, tests without a
 * `window`. Renderer code outside `services/` reads the bridge only through
 * this accessor or the typed `ipcApi` methods below (eslint
 * `no-restricted-properties` warns on `window.electronAPI` elsewhere), so the
 * IPC surface the UI depends on can be found from one module.
 *
 * Read it at call time rather than caching it: tests and the remote-mode
 * bootstrap install or replace the bridge after modules load.
 */
export function getElectronApi(): ElectronAPI | undefined {
  return typeof window === "undefined" ? undefined : window.electronAPI
}

/** Whether the desktop shell's preload bridge is present. */
export function hasElectronApi(): boolean {
  return getElectronApi() !== undefined
}

function requireApi(): ElectronAPI {
  const api = window.electronAPI
  if (!api) {
    throw new IpcError(
      "electronAPI is not available — remote backend mode?",
      "*"
    )
  }
  return api
}

type Envelope =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error?: string }

/**
 * Runtime-validate the `{ ok, error? }` envelope. Throws `IpcError` on
 * `{ ok: false }` or on unexpected shapes (null, undefined, non-object).
 * Returns the raw success envelope so callers can destructure their
 * payload field (e.g. `{ id } = await unwrap(res, "mcp:install")`).
 */
function unwrap<T extends Record<string, unknown>>(
  res: unknown,
  channel: string
): T {
  if (!res || typeof res !== "object") {
    throw new IpcError(`Invalid IPC envelope from ${channel}`, channel)
  }
  const env = res as Envelope
  if (!env.ok) {
    throw new IpcError(env.error || `${channel} failed`, channel)
  }
  return env as unknown as T
}

// ─── Payload types ──────────────────────────────────────────────────
// Mirror the on-disk manifest shapes written by `apps/shell/skills-ipc.cjs`
// and its siblings. Kept minimal — the UI only reads these fields. MCP
// servers and hooks use the shared record types the shell checks every
// record against (`@betterc0de/schema/runtime-records`).

export type Skill = {
  id: string
  name: string
  version: string
  public: boolean
  enabled: boolean
  description: string
  createdAt: string
  updatedAt: string
  source: string
  sourceUrl?: string
  sourcePath?: string
  providerKinds?: string[]
  providerInstanceIds?: string[]
  content: string
}

export type Subagent = {
  id: string
  name: string
  description: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  source: string
  sourcePath?: string
  prompt: string
}

export type Plugin = {
  manifest: {
    id: string
    name: string
    version?: string
    author?: string
    entry?: string
  }
  enabled: boolean
  config: Record<string, unknown>
  status: "active" | "disabled" | "error"
  error: string | null
}

// ─── Facade ─────────────────────────────────────────────────────────

export const ipcApi = {
  bugReport: {
    send: async (report: BugReportPayload): Promise<BugReportResult> => {
      const api = requireApi()
      if (!api.sendBugReport) {
        throw new IpcError(
          "Restart the desktop app to enable report sending.",
          "bug-report:send"
        )
      }
      const result = await api.sendBugReport(report)
      // Preserve the cooldown even on failure, instead of unwrapping it away.
      if (
        !result ||
        typeof result.ok !== "boolean" ||
        !Number.isFinite(result.retryAfterMs) ||
        result.retryAfterMs < 0 ||
        (!result.ok && typeof result.error !== "string")
      ) {
        throw new IpcError(
          "Invalid response while sending the report.",
          "bug-report:send"
        )
      }
      return result
    },
  },
  mcp: {
    list: async (): Promise<RuntimeMcpServerRecord[]> => {
      const res = await requireApi().mcpList()
      return (res ?? []) as RuntimeMcpServerRecord[]
    },
    install: async (
      config: Partial<RuntimeMcpServerRecord> & Record<string, unknown>
    ): Promise<{ id: string }> => {
      const res = await requireApi().mcpInstall(config)
      return unwrap<{ id: string }>(res, "mcp:install")
    },
    remove: (id: string) =>
      requireApi()
        .mcpRemove(id)
        .then((r) => unwrap(r, "mcp:remove")),
    updateEnv: (id: string, env: Record<string, string>) =>
      requireApi()
        .mcpUpdateEnv(id, env)
        .then((r) => unwrap(r, "mcp:update-env")),
    setEnabled: (id: string, enabled: boolean) =>
      requireApi()
        .mcpSetEnabled(id, enabled)
        .then((r) => unwrap(r, "mcp:set-enabled")),
    probe: async (config: Record<string, unknown>) => {
      const res = await requireApi().mcpProbe(config)
      // probe's envelope shape is non-standard (includes stdout/stderr
      // on both success and failure) — return the raw result so callers
      // can read every field. Still throw on {ok:false, error}.
      if (res && typeof res === "object" && (res as Envelope).ok === false) {
        throw new IpcError(
          (res as { error?: string }).error || "mcp:probe failed",
          "mcp:probe"
        )
      }
      return res
    },
  },

  skill: {
    list: async (): Promise<Skill[]> => {
      const res = await requireApi().skillList()
      return (res ?? []) as Skill[]
    },
    save: async (
      data: Partial<Skill> & Record<string, unknown>
    ): Promise<{ id: string }> => {
      const res = await requireApi().skillSave(data)
      return unwrap<{ id: string }>(res, "skill:save")
    },
    delete: (id: string) =>
      requireApi()
        .skillDelete(id)
        .then((r) => unwrap(r, "skill:delete")),
    importUrl: async (url: string, name?: string): Promise<{ id: string }> => {
      const res = await requireApi().skillImportUrl(url, name)
      return unwrap<{ id: string }>(res, "skill:import-url")
    },
  },

  hook: {
    list: async (): Promise<RuntimeHookView[]> => {
      const res = await requireApi().hookList()
      return (res ?? []) as RuntimeHookView[]
    },
    save: async (
      hook: Partial<RuntimeHookView> & Record<string, unknown>
    ): Promise<{ id: string }> => {
      const res = await requireApi().hookSave(hook)
      return unwrap<{ id: string }>(res, "hook:save")
    },
    delete: (id: string) =>
      requireApi()
        .hookDelete(id)
        .then((r) => unwrap(r, "hook:delete")),
    updateRun: (
      id: string,
      status: string,
      exitCode?: number | null,
      error?: string | null
    ) =>
      requireApi()
        .hookUpdateRun(id, status, exitCode, error)
        .then((r) => unwrap(r, "hook:update-run")),
  },

  subagent: {
    list: async (): Promise<Subagent[]> => {
      const res = await requireApi().subagentList()
      return (res ?? []) as Subagent[]
    },
    save: async (
      agent: Partial<Subagent> & Record<string, unknown>
    ): Promise<{ id: string }> => {
      const res = await requireApi().subagentSave(agent)
      return unwrap<{ id: string }>(res, "subagent:save")
    },
    delete: (id: string) =>
      requireApi()
        .subagentDelete(id)
        .then((r) => unwrap(r, "subagent:delete")),
  },

  rules: {
    get: async (): Promise<string> => {
      const res = await requireApi().rulesGet()
      return res?.content ?? ""
    },
    save: (content: string) =>
      requireApi()
        .rulesSave(content)
        .then((r) => unwrap(r, "rules:save")),
  },

  plugin: {
    list: async (): Promise<Plugin[]> => {
      const res = await requireApi().pluginList()
      return (res ?? []) as Plugin[]
    },
    install: async (sourcePath?: string): Promise<{ manifest?: unknown }> => {
      const res = await requireApi().pluginInstall(sourcePath)
      // pluginInstall's cancel path returns `{ ok: false }` with no error
      // (user cancelled the folder picker). Preserve the old semantics:
      // return the raw envelope so callers can distinguish cancel vs error.
      if (!res || typeof res !== "object") {
        throw new IpcError(
          "Invalid IPC envelope from plugin:install",
          "plugin:install"
        )
      }
      return res as { ok: boolean; manifest?: unknown }
    },
    installDefault: async (
      pluginId: string
    ): Promise<{ manifest?: unknown }> => {
      const res = await requireApi().pluginInstallDefault(pluginId)
      return unwrap<{ manifest?: unknown }>(res, "plugin:install-default")
    },
    remove: (pluginId: string) =>
      requireApi()
        .pluginRemove(pluginId)
        .then((r) => unwrap(r, "plugin:remove")),
    toggle: (pluginId: string, enabled: boolean) =>
      requireApi()
        .pluginToggle(pluginId, enabled)
        .then((r) => unwrap(r, "plugin:toggle")),
  },
}
