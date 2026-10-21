import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/chat-store", () => ({ useActiveThread: () => null }))
vi.mock("@/lib/runtime-config", () => ({
  canManageRuntimeConfig: vi.fn(() => true),
  deleteRuntimeSkill: vi.fn(),
  deleteRuntimeSubagent: vi.fn(),
  listRuntimeSkills: vi.fn(),
  listRuntimeSubagents: vi.fn(),
  saveRuntimeSkill: vi.fn(),
  saveRuntimeSubagent: vi.fn(),
}))
vi.mock("@/lib/cli-scan-context", () => ({
  describeCliScanProjectScope: () => "",
  resolveCliScanContext: vi.fn(),
}))

import {
  cliManagedSkillOwner,
  describeCliSkillScan,
  describeCliSkillSync,
  isWorkspaceScopedCliAsset,
  planCliSkillImport,
} from "./skills-section"

describe("isWorkspaceScopedCliAsset", () => {
  it("matches the desktop import: project and local entries stay with their project", () => {
    expect(isWorkspaceScopedCliAsset({ scope: "project" })).toBe(true)
    expect(isWorkspaceScopedCliAsset({ scope: "local" })).toBe(true)
    expect(isWorkspaceScopedCliAsset({ scope: "user" })).toBe(false)
    // The desktop import keeps entries without a known scope.
    expect(isWorkspaceScopedCliAsset({})).toBe(false)
    expect(isWorkspaceScopedCliAsset({ scope: "global" })).toBe(false)
  })
})

describe("describeCliSkillSync", () => {
  const foundSummary = "Found 3 skills from Claude, 1 agent from Codex."

  it("counts only what was imported and names the skipped project items", () => {
    expect(
      describeCliSkillSync({
        foundSummary,
        importedSkills: 1,
        importedAgents: 1,
        skippedWorkspaceAssets: 2,
      })
    ).toBe(
      `${foundSummary} Imported 1 skill and 1 agent. Skipped 2 project items: they apply only in their own project.`
    )
  })

  it("does not claim everything is imported when project items were left out", () => {
    expect(
      describeCliSkillSync({
        foundSummary,
        importedSkills: 0,
        importedAgents: 0,
        skippedWorkspaceAssets: 1,
      })
    ).toBe(
      `${foundSummary} Nothing new to import. Skipped 1 project item: they apply only in their own project.`
    )
  })

  it("reports an up-to-date import without a skipped note", () => {
    expect(
      describeCliSkillSync({
        foundSummary,
        importedSkills: 0,
        importedAgents: 0,
        skippedWorkspaceAssets: 0,
      })
    ).toBe(`${foundSummary} All items already imported.`)
    expect(
      describeCliSkillSync({
        foundSummary,
        importedSkills: 2,
        importedAgents: 0,
        skippedWorkspaceAssets: 0,
      })
    ).toBe(`${foundSummary} Imported 2 skills.`)
  })
})

describe("planCliSkillImport", () => {
  const plugins = [
    {
      id: "review@claude",
      name: "Review",
      source: "claude" as const,
      marketplace: "claude",
    },
  ]
  const scan = {
    claude: {
      plugins,
      skills: [
        {
          id: "claude-skill-notes",
          name: "Notes",
          source: "claude" as const,
          scope: "user",
        },
        {
          id: "claude-skill-repo-lint",
          name: "Repo lint",
          source: "claude" as const,
          scope: "project",
        },
      ],
    },
    codex: {
      skills: [
        {
          id: "codex-skill-deploy",
          name: "Deploy",
          source: "codex" as const,
          scope: "user",
        },
      ],
      agents: [
        { id: "codex-agent-reviewer", name: "Reviewer", source: "codex" },
        {
          id: "codex-agent-repo",
          name: "Repo",
          source: "codex",
          scope: "project",
        },
      ],
    },
  }

  it("sends only new user-level items and counts the project ones it leaves out", () => {
    const plan = planCliSkillImport(scan, {
      skillIds: new Set(["codex-skill-deploy"]),
      subagentIds: new Set<string>(),
    })
    expect(plan.skills.map((skill) => skill.id)).toEqual(["claude-skill-notes"])
    expect(plan.agents.map((agent) => agent.id)).toEqual([
      "codex-agent-reviewer",
    ])
    expect(plan.skippedWorkspaceAssets).toBe(2)
  })

  it("passes the scanned plugins so the import does not erase the plugin record", () => {
    const plan = planCliSkillImport(scan, {
      skillIds: new Set<string>(),
      subagentIds: new Set<string>(),
    })
    expect(plan.plugins).toEqual(plugins)
  })

  it("copes with a scan that found only one CLI", () => {
    expect(
      planCliSkillImport(
        { claude: null, codex: { skills: [], agents: [] } },
        { skillIds: new Set<string>(), subagentIds: new Set<string>() }
      )
    ).toEqual({
      skills: [],
      agents: [],
      plugins: [],
      skippedWorkspaceAssets: 0,
    })
  })
})

describe("planCliSkillImport with Claude Code agents", () => {
  it("imports Claude Code's user agents next to Codex's", () => {
    const plan = planCliSkillImport(
      {
        claude: {
          agents: [
            {
              id: "claude-agent-reviewer",
              name: "Reviewer",
              source: "claude",
              scope: "user",
            },
            {
              id: "claude-agent-repo",
              name: "Repo",
              source: "claude",
              scope: "project",
            },
          ],
        },
        codex: {
          agents: [{ id: "codex-agent-docs", name: "Docs", source: "codex" }],
        },
      },
      {
        skillIds: new Set<string>(),
        subagentIds: new Set(["codex-agent-docs"]),
      }
    )
    expect(plan.agents.map((agent) => agent.id)).toEqual([
      "claude-agent-reviewer",
    ])
    expect(plan.skippedWorkspaceAssets).toBe(1)
  })
})

describe("describeCliSkillScan", () => {
  it("names each CLI that was found and its agents", () => {
    expect(
      describeCliSkillScan({
        claude: { found: true, skills: [1, 2, 3], agents: [1] },
        codex: { found: true, skills: [1], agents: [] },
      })
    ).toBe(
      "Found 3 skills from Claude Code, 1 agent from Claude Code, 1 skill from Codex."
    )
    expect(
      describeCliSkillScan({
        claude: { found: false, skills: [1] },
        codex: { found: true, skills: [] },
      })
    ).toBe("Found 0 skills from Codex.")
  })
})

describe("cliManagedSkillOwner", () => {
  it("treats skills imported from a CLI as managed by that CLI", () => {
    expect(cliManagedSkillOwner({ source: "claude" })).toBe("claude")
    expect(cliManagedSkillOwner({ source: "Codex" })).toBe("codex")
  })

  it("leaves skills BetterC0de manages, including installed ones, alone", () => {
    expect(cliManagedSkillOwner({ source: "local" })).toBeNull()
    expect(cliManagedSkillOwner({ source: "url-import" })).toBeNull()
    expect(cliManagedSkillOwner({ source: "" })).toBeNull()
    expect(cliManagedSkillOwner({})).toBeNull()
  })
})
