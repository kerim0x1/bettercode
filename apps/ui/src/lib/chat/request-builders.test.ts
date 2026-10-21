import { describe, expect, it } from "vitest"
import {
  formatBetterC0deProjectPermissionRulesForPrompt,
  mergePromptSubagents,
  projectAgentsToPromptSubagents,
  selectPromptSkillsForProvider,
} from "@betterc0de/schema/prompt-context"
import {
  buildModelSelection,
  buildProviderPrompt,
  buildWireHistory,
  stripOptimisticUserEcho,
  workspaceRuleTargetPath,
} from "./request-builders"

describe("workspaceRuleTargetPath", () => {
  it("derives a workspace-relative target for Unix and Windows editor paths", () => {
    expect(workspaceRuleTargetPath("/repo", "/repo/src/App.tsx")).toBe(
      "src/App.tsx"
    )
    expect(workspaceRuleTargetPath("C:\\Repo", "c:\\repo\\src\\App.tsx")).toBe(
      "src/App.tsx"
    )
  })

  it("preserves safe relative targets and rejects paths outside the workspace", () => {
    expect(workspaceRuleTargetPath("/repo", "./src/app.ts")).toBe("src/app.ts")
    expect(workspaceRuleTargetPath("/repo", "/other/app.ts")).toBeNull()
    expect(workspaceRuleTargetPath("/repo", "../other/app.ts")).toBeNull()
  })
})

describe("buildModelSelection", () => {
  it("uses BetterC0de's Codex reasoningEffort option id", () => {
    expect(
      buildModelSelection({
        modelId: "gpt-5.5",
        providerKind: "codex",
        reasoningEffort: "Ultra Think",
        fastMode: true,
      })
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "fastMode", value: true },
      ],
    })
  })

  it("passes live max/ultra effort selections through on the Codex wire", () => {
    expect(
      buildModelSelection({
        modelId: "gpt-live-a",
        providerKind: "codex",
        reasoningEffort: "ultra",
      })
    ).toEqual({
      instanceId: "codex",
      model: "gpt-live-a",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    })
    expect(
      buildModelSelection({
        modelId: "gpt-live-b",
        providerKind: "codex",
        reasoningEffort: "max",
      })
    ).toEqual({
      instanceId: "codex",
      model: "gpt-live-b",
      options: [{ id: "reasoningEffort", value: "max" }],
    })
  })

  it("keeps Claude on the effort option id and normalizes CLI aliases", () => {
    expect(
      buildModelSelection({
        modelId: "claude-opus-4-7",
        providerKind: "anthropic_cli",
        reasoningEffort: "High",
        contextWindow: "200k",
      })
    ).toEqual({
      instanceId: "claude",
      model: "claude-opus-4-7",
      options: [
        { id: "effort", value: "high" },
        { id: "contextWindow", value: "200k" },
      ],
    })
  })

  it("normalizes legacy model aliases in model selections", () => {
    expect(
      buildModelSelection({
        modelId: "gpt-5-codex",
        providerKind: "codex",
      })
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    })
    expect(
      buildModelSelection({
        modelId: "opus-4.7",
        providerKind: "claude",
        contextWindow: "1m",
      })
    ).toEqual({
      instanceId: "claude",
      model: "claude-opus-4-7",
      options: [{ id: "contextWindow", value: "1m" }],
    })
  })

  it("normalizes Cursor aliases and Claude Agent provider ids", () => {
    expect(
      buildModelSelection({
        modelId: "composer",
        providerKind: "cursor",
      })
    ).toEqual({
      instanceId: "cursor",
      model: "composer-2",
    })
    expect(
      buildModelSelection({
        modelId: "opus-4.6-thinking",
        providerKind: "cursor",
      })
    ).toEqual({
      instanceId: "cursor",
      model: "claude-opus-4-6",
    })
    expect(
      buildModelSelection({
        modelId: "sonnet-4.6",
        providerKind: "betterc0de",
      })
    ).toEqual({
      instanceId: "betterc0de",
      model: "sonnet-4.6",
    })
    expect(
      buildModelSelection({
        modelId: "opus-4.7",
        providerKind: "claudeAgent",
        reasoningEffort: "ExtraHigh",
      })
    ).toEqual({
      instanceId: "claude",
      model: "claude-opus-4-7",
      options: [{ id: "effort", value: "max" }],
    })
  })

  it("uses BetterC0de Cursor option ids for ACP model configuration", () => {
    expect(
      buildModelSelection({
        modelId: "composer",
        providerKind: "cursor",
        reasoningEffort: "Extra High",
        fastMode: true,
        contextWindow: "1m",
      })
    ).toEqual({
      instanceId: "cursor",
      model: "composer-2",
      options: [
        { id: "reasoning", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "contextWindow", value: "1m" },
      ],
    })
  })

  it("omits fastMode for providers without the BetterC0de fast-mode option", () => {
    expect(
      buildModelSelection({
        modelId: "gemini-3.1-pro",
        providerKind: "google",
        reasoningEffort: "High",
        fastMode: false,
      })
    ).toEqual({
      instanceId: "google",
      model: "gemini-3.1-pro",
      options: [{ id: "effort", value: "high" }],
    })
  })

  it("omits contextWindow for Claude models without a context-window descriptor", () => {
    expect(
      buildModelSelection({
        modelId: "claude-haiku-4-5-20251001",
        providerKind: "claude",
        contextWindow: "1m",
      })
    ).toEqual({
      instanceId: "claude",
      model: "claude-haiku-4-5",
    })
  })

  it("preserves Claude descriptor effort values such as max and ultrathink", () => {
    expect(
      buildModelSelection({
        modelId: "claude-opus-4-7",
        providerKind: "anthropic",
        reasoningEffort: "Extra High",
      }).options
    ).toEqual([{ id: "effort", value: "max" }])
    expect(
      buildModelSelection({
        modelId: "claude-opus-4-6",
        providerKind: "claude",
        reasoningEffort: "Ultra Think",
      }).options
    ).toEqual([{ id: "effort", value: "ultrathink" }])
    expect(
      buildModelSelection({
        modelId: "claude-opus-4-6",
        providerKind: "claude",
        reasoningEffort: "max",
      }).options
    ).toEqual([{ id: "effort", value: "max" }])
  })

  it("uses model capability descriptors to include defaults and drop stale options", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select" as const,
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High", isDefault: true },
            { id: "max", label: "Max" },
            { id: "ultrathink", label: "Ultrathink" },
          ],
        },
      ],
    }

    expect(
      buildModelSelection({
        modelId: "claude-opus-4-7",
        providerKind: "claude",
        reasoningEffort: "xHigh",
        capabilities,
      }).options
    ).toEqual([{ id: "effort", value: "xhigh" }])

    expect(
      buildModelSelection({
        modelId: "claude-opus-4-7",
        providerKind: "claude",
        reasoningEffort: "max",
        fastMode: true,
        contextWindow: "1m",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High", isDefault: true },
                { id: "max", label: "Max" },
                { id: "ultrathink", label: "Ultrathink" },
              ],
            },
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select",
              options: [
                { id: "200k", label: "200K", isDefault: true },
                { id: "1m", label: "1M" },
              ],
            },
          ],
        },
      }).options
    ).toEqual([
      { id: "effort", value: "max" },
      { id: "contextWindow", value: "1m" },
    ])
  })

  it("falls back to descriptor defaults when a selection is invalid", () => {
    expect(
      buildModelSelection({
        modelId: "gpt-5.5",
        providerKind: "codex",
        reasoningEffort: "unsupported",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "medium",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      }).options
    ).toEqual([{ id: "reasoningEffort", value: "medium" }])
  })

  it("includes provider-scoped BetterC0de model variant selections", () => {
    expect(
      buildModelSelection({
        modelId: "anthropic/claude-sonnet-4-6",
        providerKind: "betterc0de",
        optionSelections: [{ id: "variant", value: "xhigh" }],
        capabilities: {
          optionDescriptors: [
            {
              id: "variant",
              label: "Variant",
              type: "select",
              currentValue: "high",
              options: [
                { id: "high", label: "High", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      }).options
    ).toEqual([{ id: "variant", value: "xhigh" }])
  })

  it("treats promptInjectedValues as prompt control, not regular dispatch options", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select" as const,
          currentValue: "high",
          promptInjectedValues: ["ultrathink"],
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
            { id: "ultrathink", label: "Ultrathink" },
          ],
        },
      ],
    }

    expect(
      buildModelSelection({
        modelId: "claude-opus-4-7",
        providerKind: "claude",
        reasoningEffort: "Ultra Think",
        capabilities,
      }).options
    ).toEqual([{ id: "effort", value: "high" }])
    expect(
      buildProviderPrompt({
        message: "Investigate this failure",
        providerKind: "claude",
        reasoningEffort: "Ultra Think",
        capabilities,
      })
    ).toBe("Ultrathink:\nInvestigate this failure")
  })

  it("does not duplicate the Ultrathink prompt prefix", () => {
    expect(
      buildProviderPrompt({
        message: "Ultrathink:\nInvestigate this failure",
        providerKind: "claude",
        reasoningEffort: "Ultra Think",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              promptInjectedValues: ["ultrathink"],
              options: [
                { id: "high", label: "High", isDefault: true },
                { id: "ultrathink", label: "Ultrathink" },
              ],
            },
          ],
        },
      })
    ).toBe("Ultrathink:\nInvestigate this failure")
  })
})

describe("selectPromptSkillsForProvider", () => {
  const skills = [
    { name: "global", content: "global skill" },
    {
      name: "openai",
      content: "openai skill",
      providerKinds: ["openai"],
    },
    {
      name: "claude-cli",
      content: "claude cli skill",
      providerKinds: ["claude"],
    },
    {
      name: "work",
      content: "work instance skill",
      providerKinds: ["openai"],
      providerInstanceIds: ["openai-work"],
    },
    {
      name: "project",
      content: "project skill",
      source: "betterc0de",
      sourcePath: ".betterc0de/skills/project/SKILL.md",
    },
  ]

  it("filters runtime prompt skills by provider kind and instance", () => {
    expect(
      selectPromptSkillsForProvider(skills, {
        providerKind: "openai",
        providerInstanceId: "openai-api",
      }).map((skill) => skill.name)
    ).toEqual(["global", "openai", "project"])

    expect(
      selectPromptSkillsForProvider(skills, {
        providerKind: "openai_api",
        providerInstanceId: "openai-work",
      }).map((skill) => skill.name)
    ).toEqual(["global", "openai", "work", "project"])

    expect(
      selectPromptSkillsForProvider(skills, {
        providerKind: "anthropic",
        providerInstanceId: "anthropic",
      }).map((skill) => skill.name)
    ).toEqual(["global", "project"])
  })

  it("only prompt-injects project-local skills for native CLI providers", () => {
    expect(
      selectPromptSkillsForProvider(skills, {
        providerKind: "codex",
        providerInstanceId: "codex",
      }).map((skill) => skill.name)
    ).toEqual(["project"])
    expect(
      selectPromptSkillsForProvider(skills, {
        providerKind: "anthropic_cli",
        providerInstanceId: "claude",
      }).map((skill) => skill.name)
    ).toEqual(["project"])
  })
})

describe("formatBetterC0deProjectPermissionRulesForPrompt", () => {
  it("formats project permission rules as restrictive prompt context", () => {
    expect(
      formatBetterC0deProjectPermissionRulesForPrompt([
        {
          permission: "bash",
          pattern: "rm -rf*",
          action: "deny",
          sourcePath: "betterc0de.jsonc#permission.bash.rm -rf*",
        },
      ])
    ).toContain(
      "| `bash` | `rm -rf*` | **deny** | `betterc0de.jsonc#permission.bash.rm -rf*` |"
    )
  })
})

describe("projectAgentsToPromptSubagents", () => {
  it("imports visible BetterC0de project agents into prompt context", () => {
    const agents = projectAgentsToPromptSubagents([
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Review code",
        enabled: true,
        mode: "subagent",
        model: "anthropic/claude-sonnet-4-6",
        tools: { read: true, write: false },
        optionKeys: [],
        permissions: [
          {
            permission: "edit",
            pattern: "*",
            action: "deny",
            sourcePath: ".betterc0de/agent/reviewer.md#tools.write",
          },
        ],
        sourcePath: ".betterc0de/agent/reviewer.md",
        prompt: "Review carefully",
      },
      {
        id: "hidden",
        name: "Hidden",
        enabled: true,
        hidden: true,
        tools: {},
        optionKeys: [],
        permissions: [],
        sourcePath: ".betterc0de/agent/hidden.md",
        prompt: "Hidden prompt",
      },
    ])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: "Reviewer",
      source: "betterc0de",
      mode: "subagent",
      model: "anthropic/claude-sonnet-4-6",
      tools: { read: true, write: false },
    })
    expect(agents[0]?.permissions?.[0]).toMatchObject({
      permission: "edit",
      action: "deny",
    })
  })

  it("lets project agents override same-named runtime prompt agents", () => {
    expect(
      mergePromptSubagents(
        [{ name: "Reviewer", prompt: "runtime" }],
        [{ name: "Reviewer", prompt: "project", source: "betterc0de" }]
      )
    ).toEqual([{ name: "Reviewer", prompt: "project", source: "betterc0de" }])
  })
})

describe("stripOptimisticUserEcho", () => {
  it("strips the raw optimistic user echo when the provider prompt was transformed", () => {
    const messages = [
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Investigate this failure" },
    ]

    expect(
      stripOptimisticUserEcho(
        messages,
        "Ultrathink:\nInvestigate this failure",
        "Investigate this failure"
      )
    ).toEqual([{ role: "assistant", content: "Earlier answer" }])
  })

  it("strips the visible plan handoff message when executing a hidden plan prompt", () => {
    const messages = [
      { role: "assistant", content: "# Plan\n\n- Ship it" },
      { role: "user", content: "Implement the proposed plan." },
    ]

    expect(
      stripOptimisticUserEcho(
        messages,
        "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n\n- Ship it",
        "Implement the proposed plan."
      )
    ).toEqual([{ role: "assistant", content: "# Plan\n\n- Ship it" }])
  })
})

describe("buildWireHistory", () => {
  const serializedBytes = (history: unknown): number =>
    new TextEncoder().encode(JSON.stringify(history)).byteLength

  it("keeps the newest useful UTF-8 history within the total byte budget", () => {
    const newest = [{ role: "assistant", content: "latest 🧠" }]
    const maxBytes = serializedBytes(newest)

    const history = buildWireHistory(
      [
        { role: "user", content: "🚀".repeat(200) },
        { role: "assistant", content: "latest 🧠" },
      ],
      "current turn",
      null,
      { maxBytes }
    )

    expect(history).toEqual(newest)
    expect(serializedBytes(history)).toBeLessThanOrEqual(maxBytes)
  })

  it("retains assistant tool calls and every matching result as one group", () => {
    const expected = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-a", name: "Read", input: { path: "a.ts" } },
          { id: "call-b", name: "Grep", input: { query: "TODO" } },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "file body" },
      { role: "tool", tool_call_id: "call-b", content: "no matches" },
    ]

    const history = buildWireHistory(
      [
        { role: "user", content: "old context that should not fit" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-b",
              name: "Grep",
              input: { query: "TODO" },
              output: "no matches",
              startedAt: "2026-01-01T00:00:02.000Z",
            },
            {
              id: "call-a",
              name: "Read",
              input: { path: "a.ts" },
              output: "file body",
              startedAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        },
      ],
      "current turn",
      null,
      { maxBytes: serializedBytes(expected) }
    )

    expect(history).toEqual(expected)
  })

  it("counts serialized tool inputs and tool results against the byte budget", () => {
    const makeToolTurn = (input: unknown, output: string) => [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-large",
            name: "Read",
            input,
            output,
          },
        ],
      },
    ]

    expect(
      buildWireHistory(
        makeToolTurn({ payload: "x".repeat(2_000) }, "ok"),
        "current turn",
        null,
        { maxBytes: 300 }
      )
    ).toEqual([])
    expect(
      buildWireHistory(
        makeToolTurn({ path: "small.ts" }, "x".repeat(2_000)),
        "current turn",
        null,
        { maxBytes: 300 }
      )
    ).toEqual([])
  })

  it("clips an oversized tool input so the newest complete tool group stays useful", () => {
    const history = buildWireHistory(
      [
        {
          role: "assistant",
          content: "checked the file",
          toolCalls: [
            {
              id: "call-input",
              name: "Write",
              input: { contents: "x".repeat(2_000) },
              output: "written",
            },
          ],
        },
      ],
      "current turn",
      null,
      { maxContentChars: 80, maxBytes: 500 }
    )

    expect(history).toHaveLength(2)
    expect(history[0]?.tool_calls?.[0]?.input).toContain(
      "truncated tool input for transport"
    )
    expect(history[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call-input",
      content: "written",
    })
    expect(serializedBytes(history)).toBeLessThanOrEqual(500)
  })
})
