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
import { handleHttpContract } from "../contracts"
export {
  resolveApprovedWorkspaceRoot,
  resolveChatWorkspaceRoot,
} from "../../services/workspace/authorization"

/**
 * Every route here answers with its shared contract
 * (`@betterc0de/schema/http-contracts`): the request is parsed with the
 * contract's schema and the response validated before it is sent.
 */
export function registerWorkspaceRoutes(api: Hono, state: AppState): void {
  api.post("/workspace/open", (c) =>
    handleHttpContract(
      c,
      "workspaceOpen",
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
    handleHttpContract(
      c,
      "workspaceSearch",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.searchEntriesDetailed(cwd, b.query)
      },
      { operation: "workspace search" }
    )
  )

  api.post("/workspace/search-content", (c) =>
    handleHttpContract(
      c,
      "workspaceSearchContent",
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
    handleHttpContract(
      c,
      "workspaceQuickOpen",
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
    handleHttpContract(
      c,
      "workspaceMap",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.workspaceMap(cwd, { maxFiles: b.maxFiles })
      },
      { operation: "workspace map" }
    )
  )

  api.post("/workspace/project-commands", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectCommands",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectCommands(cwd)
      },
      { operation: "workspace project commands" }
    )
  )

  api.post("/workspace/project-agents", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectAgents",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectAgents(cwd)
      },
      { operation: "workspace project agents" }
    )
  )

  api.post("/workspace/project-skills", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectSkills",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectSkills(cwd)
      },
      { operation: "workspace project skills" }
    )
  )

  api.post("/workspace/project-mcp-servers", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectMcpServers",
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
    handleHttpContract(
      c,
      "workspaceProjectInstructions",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectInstructions(cwd)
      },
      { operation: "workspace project instructions" }
    )
  )

  api.post("/workspace/effective-rules", (c) =>
    handleHttpContract(
      c,
      "workspaceEffectiveRules",
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
    handleHttpContract(
      c,
      "workspaceContextArtifact",
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
    handleHttpContract(
      c,
      "workspaceProjectReferences",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectReferences(cwd)
      },
      { operation: "workspace project references" }
    )
  )

  api.post("/workspace/project-formatters", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectFormatters",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectFormatters(cwd)
      },
      { operation: "workspace project formatters" }
    )
  )

  api.post("/workspace/project-format", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectFormat",
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
    handleHttpContract(
      c,
      "workspaceProjectLspServers",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectLspServers(cwd)
      },
      { operation: "workspace project LSP servers" }
    )
  )

  api.post("/workspace/project-permissions", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectPermissions",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectPermissions(cwd)
      },
      { operation: "workspace project permissions" }
    )
  )

  api.post("/workspace/project-config", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectConfig",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectConfigSettings(cwd)
      },
      { operation: "workspace project config" }
    )
  )

  api.post("/workspace/project-providers", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectProviders",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectProviders(cwd)
      },
      { operation: "workspace project providers" }
    )
  )

  api.post("/workspace/project-plugins", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectPlugins",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectPlugins(cwd)
      },
      { operation: "workspace project plugins" }
    )
  )

  api.post("/workspace/project-tools", (c) =>
    handleHttpContract(
      c,
      "workspaceProjectTools",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.listProjectTools(cwd)
      },
      { operation: "workspace project tools" }
    )
  )

  api.post("/workspace/read", (c) =>
    handleHttpContract(
      c,
      "workspaceRead",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.readFile({ cwd, relative_path: b.relativePath })
      },
      { operation: "workspace read" }
    )
  )

  api.post("/workspace/read-binary", (c) =>
    handleHttpContract(
      c,
      "workspaceReadBinary",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        return workspace.readBinaryFile({ cwd, relative_path: b.relativePath })
      },
      { operation: "workspace binary read" }
    )
  )

  api.post("/workspace/write", (c) =>
    handleHttpContract(
      c,
      "workspaceWrite",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "write a workspace file",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.writeFile(cwd, b.relativePath, b.contents, {
            expectedContentHash: b.expectedSha256,
          })
        )
      },
      { operation: "workspace write" }
    )
  )

  // Forking a project-less chat into a repository: carry over whatever the
  // agent built in that chat's scratch workspace. Existing files in the
  // destination are left untouched and reported back rather than overwritten.
  api.post("/workspace/scratch/adopt", (c) =>
    handleHttpContract(
      c,
      "workspaceScratchAdopt",
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
    handleHttpContract(
      c,
      "workspaceMkdir",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "create a workspace directory",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.createDirectory(cwd, b.relativePath)
        )
      },
      { operation: "workspace mkdir" }
    )
  )

  api.post("/workspace/move", (c) =>
    handleHttpContract(
      c,
      "workspaceMove",
      async (b) => {
        const cwd = await resolveApprovedWorkspaceRoot(state, b.cwd)
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: cwd,
          operation: "move a workspace path",
        })
        await withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, () =>
          workspace.movePath(cwd, b.fromRelativePath, b.toRelativePath)
        )
      },
      { operation: "workspace move" }
    )
  )

  api.post("/workspace/delete", (c) =>
    handleHttpContract(
      c,
      "workspaceDelete",
      async (b) => {
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
      },
      { operation: "workspace delete" }
    )
  )
}
