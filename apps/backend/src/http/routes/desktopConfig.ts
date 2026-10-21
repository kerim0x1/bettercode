import { DESKTOP_SHELL_CAPABILITY_HEADER } from "@betterc0de/schema/http-contracts"
import type { Context, Hono } from "hono"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { requestIdentity } from "../../remote/http"
import { constantTimeEqual } from "../../security/token"
import {
  desktopConfigStoreFor,
  type DesktopConfigStore,
} from "../../services/desktop-config/store"
import { contractJson, handleHttpContract } from "../contracts"

/**
 * `/config/{mcp,hooks,rules,skills,subagents}`: the desktop configuration
 * this backend owns (services/desktop-config/store.ts).
 *
 * Only the desktop's main process may call these routes. It decides what
 * is stored: a hook or MCP command is saved only after the user allowed it
 * in a native dialog, with the approval marker the main process computed,
 * and MCP secrets arrive already encrypted. The renderer and paired devices
 * never reach this surface, so they cannot store a command or a marker
 * themselves; the main process proves itself with the capability header
 * (the backend bearer, which renderer code never sees).
 */
export function registerDesktopConfigRoutes(api: Hono, state: AppState): void {
  api.use("/config/*", async (c, next) => {
    const identity = requestIdentity(c, state.config, state)
    const capability = c.req.header(DESKTOP_SHELL_CAPABILITY_HEADER) ?? ""
    const token = state.config.authToken
    if (
      identity?.kind !== "local" ||
      !token ||
      !constantTimeEqual(capability, token)
    ) {
      return c.json(
        {
          error:
            "The desktop configuration is managed by the BetterC0de desktop app.",
          code: "desktop_only",
        },
        403
      )
    }
    return next()
  })

  const store = (): DesktopConfigStore => {
    const resolved = desktopConfigStoreFor(state.config)
    if (!resolved) {
      throw new HttpError(
        503,
        "This backend has no desktop configuration folder.",
        "desktop_config_unavailable"
      )
    }
    return resolved
  }
  const entryId = (c: Context): string => c.req.param("id") ?? ""

  // ── mcp-servers.json ──────────────────────────────────────────────────
  api.get("/config/mcp", (c) =>
    contractJson(c, "desktopConfigMcpGet", store().readMcp())
  )
  api.put("/config/mcp", (c) =>
    handleHttpContract(
      c,
      "desktopConfigMcpPut",
      async (body) => store().writeMcp(body.entries, body.expectedRevision),
      { operation: "desktop MCP configuration write" }
    )
  )

  // ── hooks.json ────────────────────────────────────────────────────────
  api.get("/config/hooks", (c) =>
    contractJson(c, "desktopConfigHooksGet", store().readHooks())
  )
  api.put("/config/hooks", (c) =>
    handleHttpContract(
      c,
      "desktopConfigHooksPut",
      async (body) => store().writeHooks(body.entries, body.expectedRevision),
      { operation: "desktop hooks write" }
    )
  )

  // ── rules.md ──────────────────────────────────────────────────────────
  api.get("/config/rules", (c) =>
    contractJson(c, "desktopConfigRulesGet", store().readRules())
  )
  api.put("/config/rules", (c) =>
    handleHttpContract(
      c,
      "desktopConfigRulesPut",
      async (body) => store().writeRules(body.content, body.expectedRevision),
      { operation: "desktop rules write" }
    )
  )

  // ── skills/<id>/ ──────────────────────────────────────────────────────
  api.get("/config/skills", (c) =>
    contractJson(c, "desktopConfigSkillsList", {
      entries: store().listDirectory("skills"),
    })
  )
  api.get("/config/skills/:id", (c) =>
    contractJson(c, "desktopConfigSkillGet", {
      entry: store().getDirectoryEntry("skills", entryId(c)),
    })
  )
  api.put("/config/skills/:id", (c) =>
    handleHttpContract(
      c,
      "desktopConfigSkillPut",
      async (body, context) =>
        store().putDirectoryEntry(
          "skills",
          entryId(context),
          body.manifest,
          body.text
        ),
      { operation: "desktop skill write" }
    )
  )
  api.delete("/config/skills/:id", (c) =>
    contractJson(c, "desktopConfigSkillDelete", {
      removed: store().removeDirectoryEntry("skills", entryId(c)),
    })
  )

  // ── subagents/<id>/ ───────────────────────────────────────────────────
  api.get("/config/subagents", (c) =>
    contractJson(c, "desktopConfigSubagentsList", {
      entries: store().listDirectory("subagents"),
    })
  )
  api.get("/config/subagents/:id", (c) =>
    contractJson(c, "desktopConfigSubagentGet", {
      entry: store().getDirectoryEntry("subagents", entryId(c)),
    })
  )
  api.put("/config/subagents/:id", (c) =>
    handleHttpContract(
      c,
      "desktopConfigSubagentPut",
      async (body, context) =>
        store().putDirectoryEntry(
          "subagents",
          entryId(context),
          body.manifest,
          body.text
        ),
      { operation: "desktop subagent write" }
    )
  )
  api.delete("/config/subagents/:id", (c) =>
    contractJson(c, "desktopConfigSubagentDelete", {
      removed: store().removeDirectoryEntry("subagents", entryId(c)),
    })
  )
}
