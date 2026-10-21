import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { openWorkspaceRoot } from "../services/workspace/authorization"
import type { AppState } from "../appState"
import {
  AgentPermissionPolicy,
  AgentWorkspaceUntrustedError,
  defaultAgentConfigRoots,
  isAgentConfigPath,
  normalizeGrantPathScope,
  normalizeEffectiveAgentAppMode,
  normalizeWorkspaceRelativePath,
} from "./agent-permission-policy"

const cleanupDirectories: string[] = []

function tempWorkspace(label: string): {
  directory: string
  workspace: string
  dbPath: string
} {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(
      path.join(os.tmpdir(), `betterc0de-agent-permissions-${label}-`)
    )
  )
  cleanupDirectories.push(directory)
  const workspace = path.join(directory, "workspace")
  fs.mkdirSync(workspace)
  return {
    directory,
    workspace,
    dbPath: path.join(directory, "betterc0de.sqlite"),
  }
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("AgentPermissionPolicy", () => {
  it("matches durable deny scopes using the host path case semantics", () => {
    const { workspace, dbPath } = tempWorkspace("scope-case")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)
    try {
      policy.upsertGrant({
        destination: "user",
        toolName: "read",
        pathScope: "SRC",
        behavior: "allow",
      })
      policy.upsertGrant({
        destination: "workspace",
        workspacePath: workspace,
        toolName: "read",
        pathScope: "src/private",
        behavior: "deny",
      })
      expect(
        policy.evaluateTool({
          workspacePath: workspace,
          toolName: "Read",
          path: "SRC/PRIVATE/secret.txt",
        }).decision
      ).toBe(process.platform === "win32" ? "deny" : "allow")
    } finally {
      db.close()
    }
  })

  it("preserves durable grants and explicit trust across a database restart", () => {
    const { workspace, dbPath } = tempWorkspace("restart")
    const firstDb = openDatabase(dbPath)
    runMigrations(firstDb)
    const first = new AgentPermissionPolicy(firstDb, {
      createId: () => "grant-restart",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    })

    first.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Edit",
      pathScope: "./src\\components",
      behavior: "allow",
    })
    first.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    firstDb.close()

    const restartedDb = openDatabase(dbPath)
    runMigrations(restartedDb)
    const restarted = new AgentPermissionPolicy(restartedDb)

    expect(restarted.listGrants({ workspacePath: workspace })).toEqual([
      {
        id: "grant-restart",
        destination: "workspace",
        workspacePath:
          process.platform === "win32" ? workspace.toLowerCase() : workspace,
        toolName: "edit",
        pathScope: "src/components",
        behavior: "allow",
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
    ])
    expect(restarted.getWorkspaceTrust(workspace)).toMatchObject({
      state: "untrusted",
      explicit: true,
    })
    restartedDb.close()
  })

  it("lets an explicit trust decision govern the whole subtree", () => {
    const { workspace, dbPath } = tempWorkspace("subtree")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)
    const nested = path.join(workspace, "public", "brand")
    fs.mkdirSync(nested, { recursive: true })

    // No record anywhere → compatibility default, also for subdirectories.
    expect(policy.getWorkspaceTrust(nested)).toMatchObject({
      state: "trusted",
      explicit: false,
    })

    // An explicitly untrusted root must not be bypassable through a deeper
    // cwd (resolveApprovedWorkspaceRoot approves subdirs by containment).
    policy.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    expect(policy.getWorkspaceTrust(nested)).toMatchObject({
      state: "untrusted",
      explicit: true,
    })
    expect(() =>
      policy.assertWorkspaceTrusted({
        workspacePath: nested,
        operation: "write a workspace file",
      })
    ).toThrow(AgentWorkspaceUntrustedError)

    // The nearest explicit record wins over an ancestor's.
    policy.setWorkspaceTrust({ workspacePath: nested, state: "trusted" })
    expect(policy.getWorkspaceTrust(nested)).toMatchObject({
      state: "trusted",
      explicit: true,
    })
    db.close()
  })

  it("applies deny then ask then allow precedence across user and workspace grants", () => {
    const { workspace, dbPath } = tempWorkspace("precedence")
    const db = openDatabase(dbPath)
    runMigrations(db)
    let id = 0
    const policy = new AgentPermissionPolicy(db, {
      createId: () => `grant-${++id}`,
      now: () => new Date(`2026-07-24T10:00:0${id}.000Z`),
    })
    policy.setWorkspaceTrust({ workspacePath: workspace, state: "trusted" })
    policy.upsertGrant({
      destination: "user",
      toolName: "read",
      pathScope: "README.md",
      behavior: "allow",
    })
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Bash",
      pathScope: "src",
      behavior: "ask",
    })
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "bash",
      pathScope: "src/private",
      behavior: "deny",
    })

    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "BASH",
        path: "src/private/build.ps1",
      })
    ).toMatchObject({
      decision: "deny",
      source: "grant",
      normalizedPath: "src/private/build.ps1",
      grant: { destination: "workspace", pathScope: "src/private" },
    })
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "bash",
        path: "src/index.ts",
      })
    ).toMatchObject({
      decision: "ask",
      source: "grant",
      grant: { destination: "workspace", pathScope: "src" },
    })
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "Read",
        path: "README.md",
      })
    ).toMatchObject({
      decision: "allow",
      source: "grant",
      grant: { destination: "user", toolName: "read", pathScope: "README.md" },
    })
    db.close()
  })

  it("normalizes safe relative scopes and fails closed on path escape", () => {
    const { directory, workspace, dbPath } = tempWorkspace("paths")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db, {
      createId: () => "grant-path",
    })
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "read",
      pathScope: ".\\src//components/.",
      behavior: "allow",
    })

    expect(normalizeGrantPathScope(".\\src//components/.")).toBe(
      "src/components"
    )
    expect(
      normalizeWorkspaceRelativePath(
        workspace,
        path.join(workspace, "src", "components", "button.tsx")
      )
    ).toBe("src/components/button.tsx")
    expect(() => normalizeGrantPathScope("../outside")).toThrow(
      /inside the workspace/
    )
    expect(() => normalizeGrantPathScope("src/../../outside")).toThrow(
      /inside the workspace/
    )
    expect(() =>
      normalizeGrantPathScope(path.join(directory, "outside"))
    ).toThrow(/workspace-relative/)

    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: path.join(directory, "outside", "secret.txt"),
      })
    ).toEqual({
      decision: "deny",
      source: "path_confinement",
      reason: "The requested path is outside the selected workspace.",
      normalizedPath: null,
      grant: null,
    })
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: "../outside/secret.txt",
      })
    ).toMatchObject({
      decision: "deny",
      source: "path_confinement",
    })
    db.close()
  })

  // The agent CLIs keep their own state outside the workspace: Claude Code's
  // auto-memory lives under `~/.claude/projects/<slug>/memory`. Confinement
  // used to deny those paths at every level, so a bypass turn could not read
  // the memory the CLI itself had written. They are not workspace escapes;
  // the level ceiling decides, exactly as for an in-workspace path without a
  // grant. Everything else outside the workspace stays denied.
  it("hands the agent's own configuration directory to the level ceiling instead of denying it", () => {
    const { directory, workspace, dbPath } = tempWorkspace("config-roots")
    const configRoot = path.join(directory, "claude-home")
    fs.mkdirSync(path.join(configRoot, "projects", "slug", "memory"), {
      recursive: true,
    })
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db, {
      agentConfigRoots: () => [configRoot],
    })
    policy.setWorkspaceTrust({ workspacePath: workspace, state: "trusted" })

    const memoryFile = path.join(
      configRoot,
      "projects",
      "slug",
      "memory",
      "MEMORY.md"
    )
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: memoryFile,
      })
    ).toEqual({
      decision: "ask",
      source: "default",
      reason: "The path is inside the agent's own configuration directory.",
      normalizedPath: null,
      grant: null,
    })
    // A sibling of the config root is still an escape.
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: path.join(directory, "claude-home-evil", "x.md"),
      })
    ).toMatchObject({ decision: "deny", source: "path_confinement" })
    // The config root itself, and a traversal that ends outside it.
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: configRoot,
      })
    ).toMatchObject({ decision: "ask", source: "default" })
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: path.join(configRoot, "..", "outside.txt"),
      })
    ).toMatchObject({ decision: "deny", source: "path_confinement" })
    // Untrusted workspaces stay closed regardless.
    policy.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: memoryFile,
      })
    ).toMatchObject({ decision: "deny", source: "workspace_trust" })
    db.close()
  })

  it("derives the agent config roots from the CLIs' override variables", () => {
    const home = path.join(os.tmpdir(), "home")
    const roots = defaultAgentConfigRoots({}, home)
    expect(roots).toEqual([
      path.join(home, ".claude"),
      path.join(home, ".codex"),
      path.join(home, ".cursor"),
      path.join(home, ".grok"),
    ])
    const custom = defaultAgentConfigRoots(
      { CLAUDE_CONFIG_DIR: path.join(home, "claude-cfg"), CODEX_HOME: " " },
      home
    )
    expect(custom[0]).toBe(path.join(home, "claude-cfg"))
    expect(custom[1]).toBe(path.join(home, ".codex"))
    expect(isAgentConfigPath("relative/inside", roots)).toBe(false)
    expect(
      isAgentConfigPath(path.join(home, ".claude", "settings.json"), roots)
    ).toBe(true)
    expect(
      isAgentConfigPath(path.join(home, ".claudex", "settings.json"), roots)
    ).toBe(false)
  })

  // Regression: untrusted state used to be enforced ONLY when appMode was
  // "agent". Editor and Design turns dispatch the same tool set (the tool list
  // keys off chatMode, not appMode) and appMode is a plain client-supplied
  // field, so marking a workspace untrusted stopped turns in one of three tabs.
  it("makes explicit untrusted state authoritative in every app mode", () => {
    const { workspace, dbPath } = tempWorkspace("trust")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)

    expect(policy.getWorkspaceTrust(workspace)).toMatchObject({
      state: "trusted",
      explicit: false,
    })
    expect(
      policy.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toMatchObject({
      decision: "deny",
      source: "workspace_trust",
      toolName: "AgentMode",
    })
    expect(
      policy.evaluateTurnTrust({ workspacePath: workspace, appMode: "editor" })
    ).toEqual({ decision: "allow", source: "default" })

    policy.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    for (const appMode of ["agent", "editor", "design"]) {
      expect(
        policy.evaluateTurnTrust({ workspacePath: workspace, appMode })
      ).toEqual({
        decision: "deny",
        source: "workspace_trust",
        toolName: "AgentMode",
        reason: "This workspace is marked untrusted; agent turns are disabled.",
      })
    }
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "read",
        path: "README.md",
      })
    ).toMatchObject({
      decision: "deny",
      source: "workspace_trust",
    })
    db.close()
  })

  // Automatic trust is an opt-in convenience (off by default): when on, the
  // first Agent turn records trust instead of dead-ending. The explicit
  // untrusted kill switch must survive that convenience.
  it("auto-trusts unknown workspaces only when the setting is on", () => {
    const { workspace, dbPath } = tempWorkspace("auto-trust")
    const db = openDatabase(dbPath)
    runMigrations(db)

    const strict = new AgentPermissionPolicy(db)
    expect(
      strict.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toMatchObject({ decision: "deny", source: "workspace_trust" })
    expect(strict.getWorkspaceTrust(workspace).explicit).toBe(false)

    let autoTrust = true
    const relaxed = new AgentPermissionPolicy(db, {
      autoTrustWorkspaces: () => autoTrust,
    })
    expect(
      relaxed.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toEqual({ decision: "allow", source: "default" })
    // Recorded, not merely allowed — repo-declared MCP servers and formatter
    // commands gate on an explicit record rather than on a passing turn.
    expect(relaxed.getWorkspaceTrust(workspace)).toMatchObject({
      state: "trusted",
      explicit: true,
    })

    // An explicit untrusted decision still wins with auto-trust enabled.
    relaxed.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    expect(
      relaxed.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toMatchObject({ decision: "deny", source: "workspace_trust" })
    autoTrust = false
    expect(
      relaxed.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toMatchObject({ decision: "deny", source: "workspace_trust" })
    db.close()
  })

  it("allows Agent turns in app-owned scratch workspaces without recording trust", () => {
    const { directory, workspace, dbPath } = tempWorkspace("app-owned")
    const scratch = path.join(directory, "scratch", "thread-1")
    fs.mkdirSync(scratch, { recursive: true })
    const db = openDatabase(dbPath)
    try {
      runMigrations(db)
      const policy = new AgentPermissionPolicy(db)
      expect(
        policy.evaluateTurnTrust({ workspacePath: scratch, appMode: "agent" })
      ).toMatchObject({ decision: "deny", source: "workspace_trust" })

      policy.configureAppOwnedWorkspaces(
        (candidate) =>
          path
            .relative(path.join(directory, "scratch"), candidate)
            .split(path.sep)[0] !== ".."
      )
      expect(
        policy.evaluateTurnTrust({ workspacePath: scratch, appMode: "agent" })
      ).toEqual({ decision: "allow", source: "default" })
      // Allowing the turn is not consent for repo-declared commands.
      expect(policy.getWorkspaceTrust(scratch).explicit).toBe(false)
      // Ordinary workspaces still need a decision.
      expect(
        policy.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
      ).toMatchObject({ decision: "deny", source: "workspace_trust" })
      // An explicit untrusted record still wins.
      policy.setWorkspaceTrust({ workspacePath: scratch, state: "untrusted" })
      expect(
        policy.evaluateTurnTrust({ workspacePath: scratch, appMode: "agent" })
      ).toMatchObject({ decision: "deny", source: "workspace_trust" })

      // A throwing matcher fails closed.
      policy.configureAppOwnedWorkspaces(() => {
        throw new Error("boom")
      })
      const other = path.join(directory, "scratch", "thread-2")
      fs.mkdirSync(other, { recursive: true })
      expect(
        policy.evaluateTurnTrust({ workspacePath: other, appMode: "agent" })
      ).toMatchObject({ decision: "deny", source: "workspace_trust" })
    } finally {
      db.close()
    }
  })

  it("ensureWorkspaceTrusted never overrides an explicit decision", () => {
    const { workspace, dbPath } = tempWorkspace("ensure-trust")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db, {
      autoTrustWorkspaces: () => true,
    })

    expect(policy.ensureWorkspaceTrusted(workspace)).toMatchObject({
      state: "trusted",
      explicit: true,
    })

    policy.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    expect(policy.ensureWorkspaceTrusted(workspace)).toMatchObject({
      state: "untrusted",
      explicit: true,
    })
    db.close()
  })

  it("registers opened folders without granting trust when automatic trust is disabled", async () => {
    const { workspace, dbPath } = tempWorkspace("open-without-trust")
    const db = openDatabase(dbPath)
    try {
      runMigrations(db)
      let automatic = false
      const agentPermissions = new AgentPermissionPolicy(db, {
        autoTrustWorkspaces: () => automatic,
      })
      const state = { db, agentPermissions } as AppState
      await openWorkspaceRoot(state, workspace)
      expect(agentPermissions.getWorkspaceTrust(workspace).explicit).toBe(false)
      expect(
        agentPermissions.evaluateTurnTrust({
          workspacePath: workspace,
          appMode: "agent",
        }).decision
      ).toBe("deny")
      automatic = true
      await openWorkspaceRoot(state, workspace)
      expect(agentPermissions.getWorkspaceTrust(workspace).explicit).toBe(true)
      expect(
        agentPermissions.evaluateTurnTrust({
          workspacePath: workspace,
          appMode: "agent",
        }).decision
      ).toBe("allow")
      agentPermissions.setWorkspaceTrust({
        workspacePath: workspace,
        state: "untrusted",
      })
      await openWorkspaceRoot(state, workspace)
      expect(agentPermissions.getWorkspaceTrust(workspace).state).toBe(
        "untrusted"
      )
    } finally {
      db.close()
    }
  })

  it("defaults and normalizes app mode fail-closed for turn trust", () => {
    const { workspace, dbPath } = tempWorkspace("effective-app-mode")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)
    policy.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })

    expect(normalizeEffectiveAgentAppMode(null)).toBe("agent")
    expect(normalizeEffectiveAgentAppMode(" AGENT ")).toBe("agent")
    expect(normalizeEffectiveAgentAppMode("unexpected")).toBe("agent")
    expect(normalizeEffectiveAgentAppMode(" EDITOR ")).toBe("editor")
    for (const appMode of [null, undefined, " AGENT ", "unexpected"]) {
      expect(
        policy.evaluateTurnTrust({ workspacePath: workspace, appMode })
      ).toMatchObject({
        decision: "deny",
        source: "workspace_trust",
      })
    }
    expect(policy.evaluateTurnTrust({ appMode: null })).toEqual({
      decision: "deny",
      source: "path_confinement",
      toolName: "AgentMode",
      reason:
        "Agent Mode needs an open project folder. Open a folder, or switch to Editor or Canvas mode to continue.",
    })
    // The only thing that still varies by mode: Agent Mode requires a
    // workspace, Editor/Design chats may run without a project attached.
    expect(policy.evaluateTurnTrust({ appMode: "editor" })).toEqual({
      decision: "allow",
      source: "default",
    })
    // ...but once a workspace IS attached, its trust state binds in every mode.
    expect(
      policy.evaluateTurnTrust({ workspacePath: workspace, appMode: "design" })
    ).toMatchObject({ decision: "deny", source: "workspace_trust" })
    db.close()
  })

  it("detects restrictive user or selected-workspace durable grants", () => {
    const first = tempWorkspace("restrictive-first")
    const second = tempWorkspace("restrictive-second")
    const db = openDatabase(first.dbPath)
    runMigrations(db)
    let id = 0
    const policy = new AgentPermissionPolicy(db, {
      createId: () => `restrictive-${++id}`,
    })

    policy.upsertGrant({
      destination: "workspace",
      workspacePath: first.workspace,
      toolName: "read",
      pathScope: "README.md",
      behavior: "allow",
    })
    expect(policy.hasRestrictiveGrants(first.workspace)).toBe(false)

    policy.upsertGrant({
      destination: "workspace",
      workspacePath: second.workspace,
      toolName: "bash",
      behavior: "deny",
    })
    expect(policy.hasRestrictiveGrants(first.workspace)).toBe(false)
    expect(policy.hasRestrictiveGrants(second.workspace)).toBe(true)

    policy.upsertGrant({
      destination: "user",
      toolName: "edit",
      behavior: "ask",
    })
    expect(policy.hasRestrictiveGrants(first.workspace)).toBe(true)
    db.close()
  })

  it("exposes a mutation guard that only rejects explicit untrusted state", () => {
    const { workspace, dbPath } = tempWorkspace("mutation-guard")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)

    expect(
      policy.assertWorkspaceTrusted({
        workspacePath: workspace,
        operation: "create a checkpoint",
      })
    ).toMatchObject({ state: "trusted", explicit: false })

    policy.setWorkspaceTrust({ workspacePath: workspace, state: "untrusted" })
    expect(() =>
      policy.assertWorkspaceTrusted({
        workspacePath: workspace,
        operation: "create a checkpoint",
      })
    ).toThrow(
      expect.objectContaining<Partial<AgentWorkspaceUntrustedError>>({
        statusCode: 403,
        code: "workspace_untrusted",
        operation: "create a checkpoint",
      })
    )
    db.close()
  })

  it("normalizes equivalent provider tool names to one durable grant", () => {
    const { workspace, dbPath } = tempWorkspace("provider-tool-aliases")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Edit",
      pathScope: "src",
      behavior: "deny",
    })

    for (const toolName of [
      "Write",
      "file_edit",
      "file_change_approval",
      "apply_patch",
    ]) {
      expect(
        policy.evaluateTool({
          workspacePath: workspace,
          toolName,
          path: "src/index.ts",
        })
      ).toMatchObject({ decision: "deny", source: "grant" })
    }
    db.close()
  })

  it("rejects durable allow grants without a concrete path scope", () => {
    const { workspace, dbPath } = tempWorkspace("unscoped-allow")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)

    expect(() =>
      policy.upsertGrant({
        destination: "workspace",
        workspacePath: workspace,
        toolName: "bash",
        behavior: "allow",
      })
    ).toThrow(/concrete path scope/i)
    expect(() =>
      policy.upsertGrant({
        destination: "user",
        toolName: "edit",
        pathScope: ".",
        behavior: "allow",
      })
    ).toThrow(/concrete path scope/i)
    expect(() =>
      policy.upsertGrant({
        destination: "user",
        toolName: "*",
        pathScope: "src",
        behavior: "allow",
      })
    ).toThrow(/wildcard tool name/i)
    expect(
      policy.upsertGrant({
        destination: "workspace",
        workspacePath: workspace,
        toolName: "bash",
        pathScope: ".",
        behavior: "deny",
      }).pathScope
    ).toBe(".")
    db.close()
  })

  it("denies Agent Mode when the workspace has no explicit trust record", () => {
    const { workspace, dbPath } = tempWorkspace("implicit-agent")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)

    expect(
      policy.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toMatchObject({
      decision: "deny",
      source: "workspace_trust",
    })
    policy.setWorkspaceTrust({ workspacePath: workspace, state: "trusted" })
    expect(
      policy.evaluateTurnTrust({ workspacePath: workspace, appMode: "agent" })
    ).toEqual({ decision: "allow", source: "default" })
    db.close()
  })
})

function explainPlan(db: Db, sql: string): string {
  const params = Array.from(
    { length: (sql.match(/\?/g) ?? []).length },
    () => "x"
  )
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string
    }>
  )
    .map((row) => row.detail)
    .join("\n")
}

function statementSource(owner: object, name: string): string {
  const statement = (owner as Record<string, { source: string }>)[name]
  if (!statement) throw new Error(`unknown statement ${name}`)
  return statement.source
}

describe("AgentPermissionPolicy grant listing", () => {
  it("filters grants in SQL by destination and workspace", () => {
    const { workspace, dbPath, directory } = tempWorkspace("list-grants")
    const otherWorkspace = path.join(directory, "other")
    fs.mkdirSync(otherWorkspace)
    const db = openDatabase(dbPath)
    runMigrations(db)
    let counter = 0
    const policy = new AgentPermissionPolicy(db, {
      createId: () => `grant-${(counter += 1)}`,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    })
    policy.upsertGrant({
      destination: "user",
      toolName: "bash",
      behavior: "ask",
    })
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "edit",
      pathScope: "src",
      behavior: "allow",
    })
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: otherWorkspace,
      toolName: "edit",
      pathScope: "src",
      behavior: "deny",
    })

    const ids = (grants: Array<{ id: string }>) =>
      grants.map((grant) => grant.id)
    // ORDER BY destination, workspace_path: the "other" workspace sorts first.
    expect(ids(policy.listGrants())).toEqual(["grant-1", "grant-3", "grant-2"])
    expect(ids(policy.listGrants({ workspacePath: workspace }))).toEqual([
      "grant-1",
      "grant-2",
    ])
    expect(
      ids(policy.listGrants({ workspacePath: workspace, includeUser: false }))
    ).toEqual(["grant-2"])
    expect(
      ids(policy.listGrants({ workspacePath: workspace, destination: "user" }))
    ).toEqual(["grant-1"])
    expect(
      ids(
        policy.listGrants({
          workspacePath: workspace,
          destination: "workspace",
        })
      )
    ).toEqual(["grant-2"])
    expect(ids(policy.listGrants({ destination: "workspace" }))).toEqual([
      "grant-3",
      "grant-2",
    ])
    expect(policy.hasRestrictiveGrants(workspace)).toBe(true)
    expect(
      policy.evaluateTool({
        workspacePath: workspace,
        toolName: "edit",
        path: "src/a.ts",
      })
    ).toMatchObject({ decision: "allow", grant: { id: "grant-2" } })

    for (const name of [
      "listWorkspaceGrantsStmt",
      "listGrantsByDestinationStmt",
    ]) {
      const plan = explainPlan(db, statementSource(policy, name))
      expect(plan, name).toMatch(
        /agent_permission_grants USING (COVERING )?INDEX/
      )
      expect(plan, name).not.toContain("USE TEMP B-TREE")
    }
    const trustPlan = explainPlan(
      db,
      statementSource(policy, "findWorkspaceTrustStmt")
    )
    expect(trustPlan).toMatch(/agent_workspace_trust USING (COVERING )?INDEX/)
    db.close()
  })
})
