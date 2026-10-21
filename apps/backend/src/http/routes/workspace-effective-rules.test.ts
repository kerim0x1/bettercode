import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  workspaceContextArtifactResultSchema,
  workspaceEffectiveRulesResultSchema,
  type WorkspaceEffectiveRulesResult,
} from "@betterc0de/schema"
import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import type { AppState } from "../../appState"
import { registerWorkspaceRoutes as registerWorkspaceRoutesUnfilled } from "./workspace"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerWorkspaceRoutes = withInertStateArgument(
  registerWorkspaceRoutesUnfilled,
  1
)

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "betterc0de-rules-route-")
  )
  tempRoots.push(root)
  return root
}

function testState(input: {
  workspaceRoot: string
  dataDir: string
  customRules?: string
  messages?: Record<string, unknown>[]
  providerHistory?: unknown[]
}): AppState {
  return {
    config: { dataDir: input.dataDir },
    settings: {
      get: () => ({ custom_rules: input.customRules ?? "" }),
    },
    projectProjections: {
      listAll: () => [{ path: input.workspaceRoot }],
    },
    threads: {
      listProjects: () => [],
      listMessages: () => input.messages ?? [],
      buildProviderHistory: () => input.providerHistory ?? [],
    },
    worktreeRegistry: { listAll: () => [] },
  } as unknown as AppState
}

async function postRules(
  api: Hono,
  body: Record<string, unknown>
): Promise<Response> {
  return api.request("/workspace/effective-rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function postContextArtifact(
  api: Hono,
  body: Record<string, unknown>
): Promise<Response> {
  return api.request("/workspace/context-artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe("POST /workspace/effective-rules", () => {
  it("returns the backend resolution contract and source provenance", async () => {
    const root = await makeTempRoot()
    const dataDir = path.join(root, ".runtime", "userdata")
    await fs.mkdir(path.join(root, ".betterc0de", "rules"), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "AGENTS.md"), "project route rule")
    await fs.writeFile(
      path.join(root, ".betterc0de", "rules", "typescript.md"),
      "---\nglobs: src/**/*.ts\n---\ntarget route rule"
    )
    await fs.writeFile(path.join(root, "src", "app.ts"), "export {}")

    const api = new Hono()
    registerWorkspaceRoutes(
      api,
      testState({
        workspaceRoot: root,
        dataDir,
        customRules: "settings route rule",
      })
    )
    const response = await postRules(api, {
      cwd: root,
      targetPath: "src/app.ts",
    })

    expect(response.status).toBe(200)
    const parsed = workspaceEffectiveRulesResultSchema.parse(
      await response.json()
    )
    expect(parsed.workspaceRoot).toBe(await fs.realpath(root))
    expect(parsed.targetPath).toBe("src/app.ts")
    expect(parsed.content).toContain("settings route rule")
    expect(parsed.content).toContain("project route rule")
    expect(parsed.content).toContain("target route rule")
    expect(source(parsed, "settings.custom_rules")).toMatchObject<
      Partial<WorkspaceEffectiveRulesResult["sources"][number]>
    >({
      sourceKind: "global-setting",
      scope: "global",
      applied: true,
    })
    expect(source(parsed, "AGENTS.md")).toMatchObject({
      sourceKind: "project-file",
      scope: "project",
      applied: true,
    })
    expect(source(parsed, ".betterc0de/rules/typescript.md")).toMatchObject({
      sourceKind: "target-file",
      scope: "target",
      targetGlobs: ["src/**/*.ts"],
      applied: true,
    })
  })

  it("rejects a target that escapes an approved workspace", async () => {
    const root = await makeTempRoot()
    const api = new Hono()
    registerWorkspaceRoutes(
      api,
      testState({
        workspaceRoot: root,
        dataDir: path.join(root, ".runtime", "userdata"),
      })
    )

    const response = await postRules(api, {
      cwd: root,
      targetPath: "../outside.ts",
    })
    expect(response.status).toBe(403)
  })
})

describe("POST /workspace/context-artifact", () => {
  it("returns an approved workspace's backend-owned context tree", async () => {
    const root = await makeTempRoot()
    await fs.writeFile(path.join(root, "AGENTS.md"), "context route rule")
    const api = new Hono()
    registerWorkspaceRoutes(
      api,
      testState({
        workspaceRoot: root,
        dataDir: path.join(root, ".runtime", "userdata"),
        messages: [
          {
            id: "message-1",
            role: "user",
            content: "Inspect context",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        providerHistory: [{ role: "user", content: "Inspect context" }],
      })
    )

    const response = await postContextArtifact(api, {
      cwd: root,
      targetPath: ".",
      threadId: "thread-1",
    })

    expect(response.status).toBe(200)
    const parsed = workspaceContextArtifactResultSchema.parse(
      await response.json()
    )
    expect(parsed.threadId).toBe("thread-1")
    expect(parsed.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "context:rules", included: true }),
        expect.objectContaining({ id: "context:history", included: true }),
        expect.objectContaining({
          id: "context:message:message-1",
          parentId: "context:history",
        }),
      ])
    )
  })

  it("rejects unregistered workspace context requests", async () => {
    const root = await makeTempRoot()
    const outside = await makeTempRoot()
    const api = new Hono()
    registerWorkspaceRoutes(
      api,
      testState({
        workspaceRoot: root,
        dataDir: path.join(root, ".runtime", "userdata"),
      })
    )

    const response = await postContextArtifact(api, {
      cwd: outside,
      targetPath: ".",
    })

    expect(response.status).toBe(403)
  })
})

function source(
  result: WorkspaceEffectiveRulesResult,
  sourcePath: string
): WorkspaceEffectiveRulesResult["sources"][number] | undefined {
  return result.sources.find((candidate) => candidate.sourcePath === sourcePath)
}
