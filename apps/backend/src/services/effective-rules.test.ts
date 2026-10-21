import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chatSendSchema } from "@betterc0de/schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import { logger } from "../observability/logger"
import {
  mergeEffectiveRulesIntoSystemInstruction,
  resolveAppEffectiveRules,
  resolveEffectiveRules,
  resolveTurnSystemInstruction,
  runtimeRulesFile,
} from "./effective-rules"

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "betterc0de-effective-rules-")
  )
  tempRoots.push(root)
  return root
}

async function writeRule(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = path.join(root, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, content, "utf8")
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe("resolveEffectiveRules", () => {
  it("merges global, project, ancestor, and target rules in deterministic precedence order", async () => {
    const root = await makeTempRoot()
    const runtimeRules = path.join(
      root,
      "..",
      `${path.basename(root)}-rules.md`
    )
    tempRoots.push(runtimeRules)
    await fs.writeFile(runtimeRules, "runtime global", "utf8")
    await writeRule(root, "AGENTS.md", "project root")
    await writeRule(root, "src/AGENTS.md", "source directory")
    await writeRule(
      root,
      ".betterc0de/rules/typescript.md",
      "---\nglobs: src/**/*.ts\n---\nworkspace TypeScript"
    )
    await writeRule(
      root,
      "src/.betterc0de/rules/components.md",
      "---\napplyTo: components/*.ts\n---\ncomponent TypeScript"
    )
    await writeRule(root, "src/components/app.ts", "export {}")

    const result = await resolveEffectiveRules(
      {
        workspaceRoot: root,
        targetPath: "src/components/app.ts",
        globalRules: "settings global",
        globalRuleFiles: [runtimeRules],
      },
      {
        listInstructions: async () => [
          { sourcePath: "AGENTS.md", content: "project root" },
          { sourcePath: "docs/extra.md", content: "configured project" },
        ],
      }
    )

    expect(
      result.sources.map((source) => [
        source.sourceKind,
        source.scope,
        source.sourcePath.replace(/\\/g, "/"),
        source.applied,
      ])
    ).toEqual([
      ["global-file", "global", runtimeRules.replace(/\\/g, "/"), true],
      ["global-setting", "global", "settings.custom_rules", true],
      ["project-file", "project", "AGENTS.md", true],
      ["configured-file", "project", "docs/extra.md", true],
      ["directory-file", "directory", "src/AGENTS.md", true],
      ["target-file", "target", ".betterc0de/rules/typescript.md", true],
      ["target-file", "target", "src/.betterc0de/rules/components.md", true],
    ])
    expect(result.sources.map((source) => source.precedence)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])
    expect(result.explanation.mergeOrder).toBe("low-to-high")
    expect(result.targetPath).toBe("src/components/app.ts")

    const sections = [
      "runtime global",
      "settings global",
      "project root",
      "configured project",
      "source directory",
      "workspace TypeScript",
      "component TypeScript",
    ]
    for (let index = 1; index < sections.length; index += 1) {
      expect(result.content.indexOf(sections[index]!)).toBeGreaterThan(
        result.content.indexOf(sections[index - 1]!)
      )
    }
  })

  it("applies positive and negative target globs and explains skipped sources", async () => {
    const root = await makeTempRoot()
    await writeRule(
      root,
      ".cursor/rules/react.mdc",
      [
        "---",
        'globs: ["src/**/*.{tsx,jsx}", "!src/generated/**"]',
        "alwaysApply: false",
        "---",
        "React target rule",
      ].join("\n")
    )
    await writeRule(
      root,
      ".betterc0de/rules/manual.md",
      "---\nalwaysApply: false\n---\nManual-only rule"
    )
    await writeRule(
      root,
      ".betterc0de/rules/z-broad.md",
      "---\nglobs: src/**/*.tsx\n---\nBroad TSX rule"
    )
    await writeRule(
      root,
      ".betterc0de/rules/a-specific.md",
      "---\nglobs: src/components/*.tsx\n---\nSpecific component rule"
    )

    const matching = await resolveEffectiveRules(
      { workspaceRoot: root, targetPath: "src/components/App.tsx" },
      { listInstructions: async () => [] }
    )
    expect(
      matching.sources.find((source) => source.sourcePath.endsWith("react.mdc"))
    ).toMatchObject({
      applied: true,
      targetGlobs: ["src/**/*.{tsx,jsx}", "!src/generated/**"],
      content: "React target rule",
    })
    expect(matching.content.indexOf("Broad TSX rule")).toBeLessThan(
      matching.content.indexOf("Specific component rule")
    )

    const excluded = await resolveEffectiveRules(
      { workspaceRoot: root, targetPath: "src/generated/App.tsx" },
      { listInstructions: async () => [] }
    )
    const excludedReact = excluded.sources.find((source) =>
      source.sourcePath.endsWith("react.mdc")
    )
    expect(excludedReact).toMatchObject({
      applied: false,
      content: "React target rule",
    })
    expect(excludedReact?.reason).toContain("does not match")
    expect(excluded.content).not.toContain("React target rule")

    const manual = excluded.sources.find((source) =>
      source.sourcePath.endsWith("manual.md")
    )
    expect(manual).toMatchObject({
      applied: false,
      content: "Manual-only rule",
    })
    expect(manual?.reason).toContain("alwaysApply is false")

    const workspaceOnly = await resolveEffectiveRules(
      { workspaceRoot: root },
      { listInstructions: async () => [] }
    )
    const deferredReact = workspaceOnly.sources.find((source) =>
      source.sourcePath.endsWith("react.mdc")
    )
    expect(deferredReact).toMatchObject({
      applied: false,
      content: "React target rule",
    })
    expect(deferredReact?.reason).toContain("until a target path is provided")
  })

  it("reports configured and remote provenance with stable source ids", async () => {
    const root = await makeTempRoot()
    const dependencies = {
      listInstructions: async () => [
        {
          sourcePath: "~/.config/betterc0de/AGENTS.md",
          content: "home config",
        },
        {
          sourcePath: "docs/team.md",
          content: "workspace config",
        },
        {
          sourcePath: "https://example.test/rules.md",
          content: "---\nglobs: src/**\n---\nremote target",
        },
      ],
    }

    const first = await resolveEffectiveRules(
      {
        workspaceRoot: root,
        targetPath: "src/app.ts",
        globalRules: "backend global setting",
      },
      dependencies
    )
    const second = await resolveEffectiveRules(
      {
        workspaceRoot: root,
        targetPath: "src/app.ts",
        globalRules: "backend global setting",
      },
      dependencies
    )

    expect(
      first.sources.map(({ sourcePath, sourceKind, scope }) => ({
        sourcePath,
        sourceKind,
        scope,
      }))
    ).toEqual([
      {
        sourcePath: "~/.config/betterc0de/AGENTS.md",
        sourceKind: "global-file",
        scope: "global",
      },
      {
        sourcePath: "settings.custom_rules",
        sourceKind: "global-setting",
        scope: "global",
      },
      {
        sourcePath: "docs/team.md",
        sourceKind: "configured-file",
        scope: "project",
      },
      {
        sourcePath: "https://example.test/rules.md",
        sourceKind: "remote-file",
        scope: "target",
      },
    ])
    expect(first.sources.map((source) => source.id)).toEqual(
      second.sources.map((source) => source.id)
    )
  })

  it("keeps only the higher-precedence copy of duplicate content", async () => {
    const root = await makeTempRoot()
    const runtimeRules = path.join(root, "runtime.md")
    await fs.writeFile(runtimeRules, "same rule", "utf8")
    await writeRule(root, "AGENTS.md", "same rule")

    const result = await resolveEffectiveRules(
      {
        workspaceRoot: root,
        globalRuleFiles: [runtimeRules],
      },
      { listInstructions: async () => [] }
    )

    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({
      sourceKind: "global-file",
      applied: false,
      content: "same rule",
    })
    expect(result.sources[0]?.reason).toContain("higher-precedence AGENTS.md")
    expect(result.sources[1]).toMatchObject({
      sourceKind: "project-file",
      applied: true,
    })
    expect(result.content.match(/same rule/g)).toHaveLength(1)
  })

  it("rejects target paths that escape the workspace", async () => {
    const root = await makeTempRoot()
    await expect(
      resolveEffectiveRules(
        { workspaceRoot: root, targetPath: "../outside.ts" },
        { listInstructions: async () => [] }
      )
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe("turn context integration", () => {
  it("normalizes the optional target path in the shared chat contract", () => {
    const parsed = chatSendSchema.parse({
      threadId: "thread-1",
      message: "Update the active file",
      modelId: "model-1",
      ruleTargetPath: "src/app.ts",
    })

    expect(parsed.rule_target_path).toBe("src/app.ts")
  })

  it("appends only missing effective sources and is idempotent", async () => {
    const root = await makeTempRoot()
    await writeRule(root, "AGENTS.md", "project turn rule")
    const result = await resolveEffectiveRules(
      {
        workspaceRoot: root,
        globalRules: "already rendered global",
      },
      { listInstructions: async () => [] }
    )

    const merged = mergeEffectiveRulesIntoSystemInstruction(
      "base prompt\n\nalready rendered global",
      result
    )
    expect(merged).toContain("base prompt")
    expect(merged).toContain("project turn rule")
    expect(merged?.match(/already rendered global/g)).toHaveLength(1)
    expect(mergeEffectiveRulesIntoSystemInstruction(merged, result)).toBe(
      merged
    )
    const markerOnly = mergeEffectiveRulesIntoSystemInstruction(
      "<!-- betterc0de-effective-rules:v1 -->\nbase prompt",
      result
    )
    expect(markerOnly).toContain("project turn rule")
  })

  it("loads backend settings and the compatibility runtime file for turns", async () => {
    const root = await makeTempRoot()
    const dataDir = path.join(root, "runtime", "userdata")
    await fs.mkdir(dataDir, { recursive: true })
    await writeRule(root, "runtime/rules.md", "runtime compatibility rule")
    await writeRule(root, "workspace/AGENTS.md", "workspace rule")
    const workspaceRoot = path.join(root, "workspace")
    const state = {
      config: { dataDir },
      settings: {
        get: () => ({ custom_rules: "backend settings rule" }),
      },
    }

    const resolution = await resolveAppEffectiveRules(
      state as never,
      { workspaceRoot },
      { listInstructions: async () => [] }
    )
    expect(resolution.sources.map((source) => source.content)).toEqual([
      "runtime compatibility rule",
      "backend settings rule",
      "workspace rule",
    ])

    const systemInstruction = await resolveTurnSystemInstruction(
      state as never,
      {
        workspaceRoot,
        systemInstruction: "base turn prompt",
      }
    )
    expect(systemInstruction).toContain("runtime compatibility rule")
    expect(systemInstruction).toContain("backend settings rule")
    expect(systemInstruction).toContain("workspace rule")
  })

  it("reads the user's rules from the runtime home the config names", async () => {
    const root = await makeTempRoot()
    // The environment never moves it; ServerConfig resolved it once.
    vi.stubEnv("BETTERC0DE_HOME", path.join(root, "elsewhere"))
    expect(
      runtimeRulesFile({
        dataDir: path.join(root, "custom-data"),
        runtimeHome: path.join(root, "runtime"),
      })
    ).toBe(path.join(root, "runtime", "rules.md"))
    // A hand-built config without one keeps the standard layout rule.
    expect(
      runtimeRulesFile({ dataDir: path.join(root, "runtime", "userdata") })
    ).toBe(path.join(root, "runtime", "rules.md"))
    expect(
      runtimeRulesFile({ dataDir: path.join(root, "runtime", "data") })
    ).toBe(null)
  })
})

describe("degradation is logged", () => {
  it("warns with the workspace when rule resolution fails and the turn continues", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    try {
      const state = {
        config: { dataDir: null },
        settings: {
          get: () => {
            throw new Error("settings store unavailable")
          },
        },
      } as never
      const result = await resolveTurnSystemInstruction(state, {
        workspaceRoot: "/repo",
        systemInstruction: "base",
      })
      expect(result).toBe("base")
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: "/repo",
          err: "settings store unavailable",
        }),
        expect.stringMatching(/effective rules/i)
      )
    } finally {
      warn.mockRestore()
    }
  })
})
