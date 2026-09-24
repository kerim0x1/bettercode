import {
  workspaceContextArtifactSchema,
  workspaceEffectiveRulesSchema,
  workspaceTrustGetSchema,
} from "@betterc0de/schema"
import type { Hono } from "hono"
import type { AppState } from "../../appState"
import { requestIdentity } from "../../remote/http"
import { buildWorkspaceContextArtifact } from "../../services/context-artifact"
import { resolveAppEffectiveRules } from "../../services/effective-rules"
import {
  copyScratchWorkspaceInto,
  scratchWorkspacePathFor,
} from "../../services/scratchWorkspace"
import * as workspace from "../../services/workspace"
import {
  openWorkspaceRoot,
  resolveApprovedWorkspaceRoot,
} from "../../services/workspace/authorization"
import { withCheckpointRecoveryMutation } from "../checkpointRecoveryFence"
import { parseAndHandle } from "../routeHelpers"
import {
  workspaceAdoptScratchSchema,
  workspaceContentSearchSchema,
  workspaceDeleteSchema,
  workspaceMapSchema,
  workspaceMkdirSchema,
  workspaceMoveSchema,
  workspaceProjectAgentsSchema,
  workspaceProjectCommandsSchema,
  workspaceProjectConfigSchema,
  workspaceProjectFormatSchema,
  workspaceProjectFormattersSchema,
  workspaceProjectInstructionsSchema,
  workspaceProjectLspServersSchema,
  workspaceProjectMcpServersSchema,
  workspaceProjectPermissionsSchema,
  workspaceProjectPluginsSchema,
  workspaceProjectProvidersSchema,
  workspaceProjectReferencesSchema,
  workspaceProjectSkillsSchema,
  workspaceProjectToolsSchema,
  workspaceQuickOpenSchema,
  workspaceReadSchema,
  workspaceSearchSchema,
  workspaceWriteSchema,
} from "../validation"
export {
  resolveApprovedWorkspaceRoot,
  resolveChatWorkspaceRoot,
} from "../../services/workspace/authorization"

export function registerWorkspaceRoutes(api: Hono, state: AppState): void {
  api.post("/workspace/open", (c) =>
    parseAndHandle(
      c,
      workspaceTrustGetSchema,
      (body) => openWorkspaceRoot(state, body.workspacePath),
      { operation: "open workspace" }
    )
  )
  // Both search routes answer with the detailed shape
  // (`{ entries|results, truncated, truncatedReason? }`) rather than a bare
  // array: the walks are capped by result count, visited entries, bytes and a
  // deadline, and a client that only receives the array cannot tell a small
  // workspace from a cut-short scan. The renderer's `workspaceApi` unwraps.
  api.post("/workspace/search", (c) =>
    parseAndHandle(
      c,
      workspaceSearchSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.searchEntriesDetailed(cwd, b.query)
      },
      { operation: "workspace search" }
    )
  )

  api.post("/workspace/search-content", (c) =>
    parseAndHandle(
      c,
      workspaceContentSearchSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.searchContentDetailed(cwd, b.query, {
          limit: b.limit,
          caseSensitive: b.caseSensitive,
          wholeWord: b.wholeWord,
          regex: b.regex,
          include: b.include,
          exclude: b.exclude,
        })
      },
      { operation: "workspace content search" }
    )
  )

  api.post("/workspace/quick-open", (c) =>
    parseAndHandle(
      c,
      workspaceQuickOpenSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.quickOpenFiles(cwd, b.query, {
          limit: b.limit,
          include: b.include,
        })
      },
      { operation: "workspace quick open" }
    )
  )

  api.post("/workspace/map", (c) =>
    parseAndHandle(
      c,
      workspaceMapSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.workspaceMap(cwd, { maxFiles: b.maxFiles })
      },
      { operation: "workspace map" }
    )
  )

  api.post("/workspace/project-commands", (c) =>
    parseAndHandle(
      c,
      workspaceProjectCommandsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectCommands(cwd)
      },
      { operation: "workspace project commands" }
    )
  )

  api.post("/workspace/project-agents", (c) =>
    parseAndHandle(
      c,
      workspaceProjectAgentsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectAgents(cwd)
      },
      { operation: "workspace project agents" }
    )
  )

  api.post("/workspace/project-skills", (c) =>
    parseAndHandle(
      c,
      workspaceProjectSkillsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectSkills(cwd)
      },
      { operation: "workspace project skills" }
    )
  )

  api.post("/workspace/project-mcp-servers", (c) =>
    parseAndHandle(
      c,
      workspaceProjectMcpServersSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        const servers = await workspace.listProjectMcpServers(cwd)
        if (requestIdentity(c, state.config, state)?.kind !== "remote")
          return servers
        // Paired clients need the server names for workspace prompt context.
        // Commands, URLs, arguments and arbitrary environment/header values
        // may contain host credentials, including from global configuration.
        return servers.map(({ id, name, type, enabled }) => ({
          id,
          name,
          type,
          enabled,
          command: "",
          args: [],
          env: {},
          sourcePath: "",
        }))
      },
      { operation: "workspace project MCP servers" }
    )
  )

  api.post("/workspace/project-instructions", (c) =>
    parseAndHandle(
      c,
      workspaceProjectInstructionsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectInstructions(cwd)
      },
      { operation: "workspace project instructions" }
    )
  )

  api.post("/workspace/effective-rules", (c) =>
    parseAndHandle(
      c,
      workspaceEffectiveRulesSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return resolveAppEffectiveRules(state, {
          workspaceRoot: cwd,
          targetPath: b.targetPath,
        })
      },
      { operation: "workspace effective rules" }
    )
  )

  api.post("/workspace/context-artifact", (c) =>
    parseAndHandle(
      c,
      workspaceContextArtifactSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return buildWorkspaceContextArtifact(state, {
          workspaceRoot: cwd,
          targetPath: b.targetPath,
          threadId: b.threadId,
          pendingMessageCharacters: b.pendingMessageCharacters,
          pendingAttachments: b.pendingAttachments,
        })
      },
      { operation: "workspace context artifact" }
    )
  )

  api.post("/workspace/project-references", (c) =>
    parseAndHandle(
      c,
      workspaceProjectReferencesSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectReferences(cwd)
      },
      { operation: "workspace project references" }
    )
  )

  api.post("/workspace/project-formatters", (c) =>
    parseAndHandle(
      c,
      workspaceProjectFormattersSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectFormatters(cwd)
      },
      { operation: "workspace project formatters" }
    )
  )

  api.post("/workspace/project-format", (c) =>
    parseAndHandle(
      c,
      workspaceProjectFormatSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "format a project file",
        })
        // `assertWorkspaceTrusted` only rejects an *explicitly* untrusted
        // workspace; the compatibility default is trusted-with-no-record.
        // Running a formatter command the repository chose needs a real
        // decision, so check `explicit` separately.
        const trust = state.agentPermissions.getWorkspaceTrust(cwd)
        const allowWorkspaceCommands =
          trust?.state === "trusted" && trust.explicit === true
        return withCheckpointRecoveryMutation(
          state,
          { workspaces: [cwd] },
          () =>
            workspace.formatProjectFile({
              cwd,
              relativePath: b.relativePath,
              formatterId: b.formatterId,
              allowWorkspaceCommands,
            })
        )
      },
      { operation: "workspace project format" }
    )
  )

  api.post("/workspace/project-lsp-servers", (c) =>
    parseAndHandle(
      c,
      workspaceProjectLspServersSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectLspServers(cwd)
      },
      { operation: "workspace project LSP servers" }
    )
  )

  api.post("/workspace/project-permissions", (c) =>
    parseAndHandle(
      c,
      workspaceProjectPermissionsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectPermissions(cwd)
      },
      { operation: "workspace project permissions" }
    )
  )

  api.post("/workspace/project-config", (c) =>
    parseAndHandle(
      c,
      workspaceProjectConfigSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectConfigSettings(cwd)
      },
      { operation: "workspace project config" }
    )
  )

  api.post("/workspace/project-providers", (c) =>
    parseAndHandle(
      c,
      workspaceProjectProvidersSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectProviders(cwd)
      },
      { operation: "workspace project providers" }
    )
  )

  api.post("/workspace/project-plugins", (c) =>
    parseAndHandle(
      c,
      workspaceProjectPluginsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectPlugins(cwd)
      },
      { operation: "workspace project plugins" }
    )
  )

  api.post("/workspace/project-tools", (c) =>
    parseAndHandle(
      c,
      workspaceProjectToolsSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectTools(cwd)
      },
      { operation: "workspace project tools" }
    )
  )

  api.post("/workspace/read", (c) =>
    parseAndHandle(
      c,
      workspaceReadSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.readFile({ cwd, relative_path: b.relativePath })
      },
      { operation: "workspace read" }
    )
  )

  api.post("/workspace/read-binary", (c) =>
    parseAndHandle(
      c,
      workspaceReadSchema,
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.readBinaryFile({ cwd, relative_path: b.relativePath })
      },
      { operation: "workspace binary read" }
    )
  )

  api.post("/workspace/write", (c) =>
    parseAndHandle(
      c,
      workspaceWriteSchema,
      async (b, ctx) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "write a workspace file",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.writeFile(cwd, b.relativePath, b.contents)
        )
        return ctx.body(null, 204)
      },
      { operation: "workspace write" }
    )
  )

  // Forking a project-less chat into a repository: carry over whatever the
  // agent built in that chat's scratch workspace. Existing files in the
  // destination are left untouched and reported back rather than overwritten.
  api.post("/workspace/scratch/adopt", (c) =>
    parseAndHandle(
      c,
      workspaceAdoptScratchSchema,
      async (b) => {
        const destination = await resolveApprovedWorkspaceRoot(
          state,
          b.destination
        )
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: destination,
          operation: "adopt a scratch workspace",
        })
        const scratchPath = scratchWorkspacePathFor(
          state.config.dataDir,
          b.threadId
        )
        // Same shape as a real copy: the renderer reads `truncated` to tell
        // the user when the copy was cut short.
        if (!scratchPath) return { copied: 0, skipped: [], truncated: false }
        return withCheckpointRecoveryMutation(
          state,
          { threadIds: [b.threadId], workspaces: [scratchPath, destination] },
          () => copyScratchWorkspaceInto(scratchPath, destination)
        )
      },
      { operation: "workspace scratch adopt" }
    )
  )

  api.post("/workspace/mkdir", (c) =>
    parseAndHandle(
      c,
      workspaceMkdirSchema,
      async (b, ctx) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "create a workspace directory",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.createDirectory(cwd, b.relativePath)
        )
        return ctx.body(null, 204)
      },
      { operation: "workspace mkdir" }
    )
  )

  api.post("/workspace/move", (c) =>
    parseAndHandle(
      c,
      workspaceMoveSchema,
      async (b, ctx) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "move a workspace path",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.movePath(cwd, b.fromRelativePath, b.toRelativePath)
        )
        return ctx.body(null, 204)
      },
      { operation: "workspace move" }
    )
  )

  api.post("/workspace/delete", (c) =>
    parseAndHandle(
      c,
      workspaceDeleteSchema,
      async (b, ctx) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "delete a workspace path",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.deletePath(cwd, b.relativePath, {
            recursive: b.recursive,
          })
        )
        return ctx.body(null, 204)
      },
      { operation: "workspace delete" }
    )
  )
}
