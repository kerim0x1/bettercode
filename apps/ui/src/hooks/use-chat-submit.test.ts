import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/backend/workspaceApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/backend/workspaceApi")>()
  return {
    ...actual,
    listProjectConfigSettings: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  }
})

import {
  listProjectConfigSettings,
  readFile,
  writeFile,
} from "@/services/backend/workspaceApi"
import type { RuntimeDebugInfo } from "@/services/backend/coreApi"
import {
  activeContextMessagesFromThread,
  buildMcpAddOutput,
  buildMcpAuthOutput,
  buildMcpDebugOutput,
  buildMcpLogoutOutput,
  buildMcpResourcesOutput,
  buildMcpServersOutput,
  buildProjectMcpConfigOutput,
  buildPendingApprovalsOutput,
  buildRuntimeMcpDetailOutput,
  buildRuntimeDebugInfoOutput,
  buildRuntimeDebugPathsOutput,
  buildRuntimeHeapSnapshotOutput,
  buildDebugFileListOutput,
  buildDebugFileReadOutput,
  buildDebugFileStatusOutput,
  buildDebugSnapshotMarkdown,
  buildExportThreadOutput,
  buildImportThreadOutput,
  betterC0deImportUrlCandidates,
  buildRuntimeSubagentDetailOutput,
  buildRuntimeSubagentDebugOutput,
  buildRuntimeSubagentListOutput,
  buildDebugRgFilesOutput,
  buildDebugRgSearchOutput,
  buildDebugRgTreeOutput,
  buildThreadContextMarkdown,
  buildEditorSelectionContextDraft,
  buildThreadMessagesMarkdown,
  buildThreadStatsOutput,
  buildThreadJsonExportPayload,
  buildThreadImportDraftFromJsonPayload,
  buildThreadTimelineMarkdown,
  buildThreadEventsOutputFromSnapshot,
  buildThreadTodosOutputFromItems,
  buildSessionStatusOutputFromSnapshot,
  buildBetterC0deDefaultCommandPrompt,
  buildGithubAgentOutput,
  buildAgentCreateOutput,
  buildBetterC0deRuntimeConfigOutput,
  buildBetterC0deRuntimeEntrypointOutput,
  buildBetterC0deMaintenanceOutput,
  buildBetterC0deDbPathOutput,
  buildBetterC0deSessionCliOutput,
  buildBetterC0deSyncRouteOutput,
  buildBetterC0deWorkspaceRouteOutput,
  buildBetterC0deLifecycleRouteOutput,
  buildBetterC0deTuiControlRouteOutput,
  buildBetterC0deDebugConfigOutput,
  buildBetterC0deDebugUtilityOutput,
  buildBetterC0deInternalRouteOutput,
  buildBetterC0deAuthControlOutput,
  buildBetterC0dePrTerminalCommand,
  buildBetterC0dePrTerminalOutput,
  buildProviderCatalogOutput,
  buildProviderAuthOutput,
  buildProviderConnectionOutput,
  buildProviderOrganizationOutput,
  buildComposerInputActionsOutput,
  buildProjectCommandConfigOutput,
  buildProjectCommandAgentInstructions,
  buildRuntimeSkillsOutput,
  buildProjectKeybindsOutput,
  buildProjectTuiConfigWriteOutput,
  buildProjectReferenceConfigOutput,
  buildProjectInstructionsConfigOutput,
  buildProjectSkillsConfigOutput,
  buildProjectToolsConfigOutput,
  buildProjectFormatOutput,
  buildProjectFormatterConfigOutput,
  buildProjectLspConfigOutput,
  buildProjectLspServersOutput,
  buildProjectPermissionsOutput,
  buildProjectPermissionsConfigOutput,
  buildProjectProviderConfigOutput,
  buildPluginInstallOutput,
  buildPluginToggleOutput,
  buildPendingUserInputsOutput,
  buildUserInputAnswerPayload,
  buildFindFilesOutput,
  buildFindTextOutput,
  buildVcsApplyOutput,
  buildVcsDiffOutput,
  buildVcsStatusOutput,
  buildProjectPluginsOutput,
  cycleModelVariantValue,
  cycleProviderModelAgentSelection,
  cycleProviderModelVariantSelection,
  buildProjectProvidersOutput,
  buildSessionsOutput,
  parseSessionUpdateArgs,
  buildAppLogOutput,
  buildThreadDiffMarkdown,
  parseAppLogCommandArgs,
  cycleChatMode,
  deriveChatPendingApprovals,
  deriveChatPendingUserInputs,
  deriveChatTodosFromActivities,
  archivedThreadIdsAfterAction,
  extractBetterC0deMentions,
  hydrateProjectCommandShellBlocks,
  hydrateProjectCommandTemplate,
  isProviderNativeSlashCommand,
  lastAssistantMessageText,
  buildTerminalFontOutput,
  normalizeTerminalFontCommandValue,
  parseStatsCommandOptions,
  parseSessionListOptions,
  buildDiffStyleOutput,
  resolveDiffStyleArg,
  betterC0deShareModeFromProjectSettings,
  parseMessageListArgs,
  resolveDebugRgRequest,
  projectCommandChatModeOverride,
  projectCommandSubtaskLabel,
  resolveProjectCommandModelOverride,
  resolveRuntimeMcpServer,
  stripBetterC0deAgentSlashSubcommand,
  stripBetterC0deConsoleSlashSubcommand,
  stripBetterC0deGithubSlashSubcommand,
  stripBetterC0deMcpSlashSubcommand,
  stripBetterC0deProviderSlashSubcommand,
  stripBetterC0deSessionSlashSubcommand,
  resolveChildThread,
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveModelVariantValue,
  resolvePendingApprovalReference,
  resolvePendingUserInputReference,
  resolveInterruptProviderKind,
  resolveSessionCommandThread,
  resolveSiblingChildThread,
  sanitizeThreadRenameTitle,
} from "@/lib/slash-command-runtime"
import type {
  ChatMessage,
  ChatThread,
  ThreadActivity,
} from "@betterc0de/schema"
import type { UiProvider } from "@/lib/provider-types"
import { useEditorDiagnosticsStore } from "@/lib/editor-diagnostics-store"
import { useEditorStore, type EditorTab } from "@/lib/editor-store"
import { HttpError } from "@/lib/errors/types"
import { useChatStore } from "@/lib/chat-store"

const readFileMock = vi.mocked(readFile)
const listProjectConfigSettingsMock = vi.mocked(listProjectConfigSettings)
const writeFileMock = vi.mocked(writeFile)

function withBetterC0deSchema(value: string): string {
  return value
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    role: overrides.role ?? "user",
    content: overrides.content ?? "",
    createdAt: overrides.createdAt ?? "2026-05-19T10:00:00.000Z",
    ...overrides,
  }
}

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    title: "Timeline Test",
    projectName: "BetterC0de",
    projectPath: "/repo",
    messages: [],
    createdAt: "2026-05-19T09:00:00.000Z",
    updatedAt: "2026-05-19T10:00:00.000Z",
    ...overrides,
  }
}

function activity(overrides: Partial<ThreadActivity>): ThreadActivity {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: overrides.threadId ?? "thread-1",
    kind: overrides.kind ?? "approval.requested",
    tone: overrides.tone ?? "approval",
    summary: overrides.summary ?? "Approval requested",
    payload: overrides.payload ?? {},
    sequence: overrides.sequence ?? 1,
    createdAt: overrides.createdAt ?? "2026-05-19T10:00:00.000Z",
    ...overrides,
  }
}

describe("isProviderNativeSlashCommand", () => {
  it("matches provider slash commands with or without a leading slash", () => {
    const provider = {
      slashCommands: [
        { name: "compact" },
        { name: "/doctor", description: "Diagnose provider setup" },
      ],
    }

    expect(isProviderNativeSlashCommand("/compact", provider)).toBe(false)
    expect(isProviderNativeSlashCommand("/doctor staged files", provider)).toBe(
      true
    )
    expect(isProviderNativeSlashCommand("/review staged files", provider)).toBe(
      false
    )
    expect(isProviderNativeSlashCommand("/status", provider)).toBe(false)
  })

  it("does not match when the selected provider exposes no command metadata", () => {
    expect(isProviderNativeSlashCommand("/compact", undefined)).toBe(false)
    expect(isProviderNativeSlashCommand("compact", { slashCommands: [] })).toBe(
      false
    )
  })
})

describe("extractBetterC0deMentions", () => {
  it("matches BetterC0de-compatible file, skill, agent, and reference mentions", () => {
    expect(
      extractBetterC0deMentions(
        "Use @src/app.ts and @docs/readme.md plus @skill"
      )
    ).toEqual(["src/app.ts", "docs/readme.md", "skill"])
  })

  it("does not treat email addresses or backtick escaped text as mentions", () => {
    expect(
      extractBetterC0deMentions("mail test@example.com and literal `@file.ts`")
    ).toEqual([])
  })
})

describe("buildEditorSelectionContextDraft", () => {
  it("appends active editor selection context to the composer draft", () => {
    const output = buildEditorSelectionContextDraft({
      currentDraft: "Refactor this carefully.",
      relativePath: "src/app.ts",
      language: "typescript",
      selection: {
        lineCount: 2,
        charCount: 28,
        startLine: 10,
        startColumn: 1,
        endLine: 11,
        endColumn: 6,
        text: "const value = 1\nreturn value",
      },
    })

    expect(output).toContain("Refactor this carefully.")
    expect(output).toContain("[Selected file context: src/app.ts:L10-L11]")
    expect(output).toContain("```typescript")
    expect(output).toContain("const value = 1\nreturn value")
  })

  it("uses a longer markdown fence when selected text contains backticks", () => {
    const output = buildEditorSelectionContextDraft({
      currentDraft: "",
      relativePath: "README.md",
      language: "markdown",
      selection: {
        lineCount: 1,
        charCount: 9,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 10,
        text: "```demo",
      },
    })

    expect(output).toContain("````markdown")
    expect(output).toContain("[Selected file context: README.md:L3]")
  })
})

describe("pending provider approvals", () => {
  it("derives open approval requests and clears resolved ones", () => {
    const approvals = deriveChatPendingApprovals([
      activity({
        id: "a-1",
        sequence: 1,
        payload: {
          requestId: "req-run",
          providerKind: "codex_cli",
          toolName: "shell",
          input: { command: "npm test" },
        },
      }),
      activity({
        id: "a-2",
        sequence: 2,
        payload: {
          requestId: "req-edit",
          providerKind: "claude",
          toolName: "edit",
          input: { file_path: "src/app.tsx" },
        },
      }),
      activity({
        id: "a-3",
        kind: "approval.resolved",
        tone: "info",
        sequence: 3,
        summary: "Approval approved",
        payload: { requestId: "req-run" },
      }),
    ])

    expect(approvals).toEqual([
      expect.objectContaining({
        requestId: "req-edit",
        providerKind: "claude",
        toolName: "edit",
      }),
    ])
  })

  it("formats a chat-readable approval list", () => {
    const output = buildPendingApprovalsOutput([
      {
        requestId: "req-run-command-123456",
        providerKind: "codex",
        toolName: "shell",
        input: { command: "npm test" },
      },
    ])

    expect(output).toContain("# Pending Approvals")
    expect(output).toContain("Codex CLI")
    expect(output).toContain("npm test")
    expect(output).toContain("/approve <#|request-id>")
  })

  it("resolves approval references by index, exact id, and unique prefix", () => {
    const approvals = [
      { requestId: "alpha-request", providerKind: "claude" },
      { requestId: "beta-request", providerKind: "codex" },
    ]

    expect(resolvePendingApprovalReference("2", approvals)?.requestId).toBe(
      "beta-request"
    )
    expect(
      resolvePendingApprovalReference("alpha-request", approvals)?.requestId
    ).toBe("alpha-request")
    expect(resolvePendingApprovalReference("bet", approvals)?.requestId).toBe(
      "beta-request"
    )
    expect(resolvePendingApprovalReference(undefined, approvals)).toBeNull()
    expect(
      resolvePendingApprovalReference(undefined, approvals.slice(0, 1))
    ).toEqual(approvals[0])
  })
})

describe("pending provider questions", () => {
  it("derives open user-input requests and clears resolved ones", () => {
    const questions = deriveChatPendingUserInputs([
      activity({
        id: "q-1",
        kind: "user-input.requested",
        sequence: 1,
        payload: {
          requestId: "question-scope",
          providerKind: "betterc0de",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scope?",
              options: ["Backend", { label: "Frontend", description: "UI" }],
            },
          ],
        },
      }),
      activity({
        id: "q-2",
        kind: "user-input.requested",
        sequence: 2,
        payload: {
          requestId: "question-mode",
          providerKind: "claude",
          questions: [{ header: "Mode", question: "Which mode?" }],
        },
      }),
      activity({
        id: "q-3",
        kind: "user-input.resolved",
        tone: "info",
        sequence: 3,
        summary: "Question answered",
        payload: { requestId: "question-scope" },
      }),
    ])

    expect(questions).toEqual([
      expect.objectContaining({
        requestId: "question-mode",
        providerKind: "claude",
        questions: [
          expect.objectContaining({
            id: "mode",
            text: "Which mode?",
          }),
        ],
      }),
    ])
  })

  it("formats pending questions for chat and resolves request references", () => {
    const pending = [
      {
        requestId: "alpha-question",
        providerKind: "betterc0de",
        questions: [
          {
            id: "scope",
            text: "Which scope?",
            options: [{ label: "Backend" }],
          },
        ],
      },
      {
        requestId: "beta-question",
        providerKind: "codex",
        questions: [{ id: "mode", text: "Which mode?", options: [] }],
      },
    ]

    const output = buildPendingUserInputsOutput(pending)

    expect(output).toContain("# Pending Questions")
    expect(output).toContain("BetterC0de")
    expect(output).toContain("Which scope?")
    expect(output).toContain("/answer <#|request-id>")
    expect(output).toContain("/reject-question <#|request-id>")
    expect(resolvePendingUserInputReference("2", pending)?.requestId).toBe(
      "beta-question"
    )
    expect(resolvePendingUserInputReference("alpha", pending)?.requestId).toBe(
      "alpha-question"
    )
    expect(resolvePendingUserInputReference(undefined, pending)).toBeNull()
  })

  it("builds single and multi-question answer payloads", () => {
    expect(
      buildUserInputAnswerPayload(
        {
          requestId: "question-1",
          providerKind: "betterc0de",
          questions: [
            {
              id: "scope",
              text: "Which scope?",
              options: [],
            },
          ],
        },
        ["Backend"]
      )
    ).toEqual({ ok: true, answers: { scope: "Backend" } })

    expect(
      buildUserInputAnswerPayload(
        {
          requestId: "question-2",
          providerKind: "betterc0de",
          questions: [
            {
              id: "scope",
              text: "Which scope?",
              options: [],
            },
            {
              id: "targets",
              text: "Which targets?",
              options: [],
              multiSelect: true,
            },
          ],
        },
        ["scope=Backend", "targets=UI,API"]
      )
    ).toEqual({
      ok: true,
      answers: { scope: "Backend", targets: ["UI", "API"] },
    })
  })
})

describe("BetterC0de-compatible session todos", () => {
  it("derives todos from the latest turn plan activity", () => {
    const todos = deriveChatTodosFromActivities([
      activity({
        id: "plan-1",
        kind: "turn.plan.updated",
        tone: "info",
        sequence: 1,
        summary: "Plan updated",
        payload: {
          plan: [
            { step: "Old task", status: "completed" },
            { step: "Old follow-up", status: "pending" },
          ],
        },
      }),
      activity({
        id: "plan-2",
        kind: "turn.plan.updated",
        tone: "info",
        sequence: 2,
        summary: "Plan updated",
        payload: {
          plan: [
            { step: "Inspect BetterC0de todos", status: "completed" },
            { step: "Expose /todos", status: "in_progress" },
          ],
        },
      }),
    ])

    expect(todos).toEqual([
      { text: "Inspect BetterC0de todos", status: "completed" },
      { text: "Expose /todos", status: "in_progress" },
    ])
  })

  it("formats todos like an BetterC0de session.todo response", () => {
    const output = buildThreadTodosOutputFromItems([
      { text: "Inspect BetterC0de todos", status: "completed" },
      { text: "Expose /todos", status: "in_progress" },
    ])

    expect(output).toContain("# Session Todos")
    expect(output).toContain("Done")
    expect(output).toContain("In progress")
    expect(output).toContain("Expose /todos")
  })
})

describe("BetterC0de-compatible session status", () => {
  it("formats the active thread, streaming state, and pending work", () => {
    const output = buildSessionStatusOutputFromSnapshot({
      thread: thread({
        id: "thread-status",
        title: "Status Test",
        projectName: "BetterC0de",
        projectPath: "/repo",
        branch: "main",
        messages: [
          message({ id: "m-1", role: "user", content: "Build it" }),
          message({ id: "m-2", role: "assistant", content: "Working" }),
        ],
      }),
      activities: [
        activity({
          id: "approval-1",
          threadId: "thread-status",
          kind: "approval.requested",
          payload: {
            requestId: "approval-edit",
            providerKind: "codex",
            toolName: "edit",
          },
        }),
        activity({
          id: "question-1",
          threadId: "thread-status",
          kind: "user-input.requested",
          sequence: 2,
          payload: {
            requestId: "question-scope",
            providerKind: "claude",
            questions: [{ id: "scope", question: "Which scope?" }],
          },
        }),
        activity({
          id: "plan-1",
          threadId: "thread-status",
          kind: "turn.plan.updated",
          sequence: 3,
          payload: {
            plan: [{ step: "Fallback task", status: "pending" }],
          },
        }),
      ],
      stream: {
        isStreaming: true,
        streamingText: "Partial response",
        streamingPlanText: "",
        isPlanStreaming: false,
        reasoningText: "Thinking",
        isReasoning: true,
        reasoningStartedAt: null,
        reasoningEndedAt: null,
        lastBoundaryAt: null,
        reasoningSegments: [],
        streamingModelId: "claude-opus-4.7",
        streamingTools: [],
        streamingTasks: [{ text: "Stream task", completed: false }],
        streamingDiffs: [
          {
            path: "src/app.tsx",
            additions: 2,
            deletions: 1,
            oldText: "",
            newText: "",
            isNew: false,
          },
        ],
        pendingQuestions: [],
        activeTurnId: "turn-1",
      },
    })

    expect(output).toContain("# Session Status")
    expect(output).toContain("Compatibility reference: `session.status`")
    expect(output).toContain("| State | reasoning |")
    expect(output).toContain("| Pending approvals | 1 |")
    expect(output).toContain("| Pending questions | 1 |")
    expect(output).toContain("| Todos | 1 |")
    expect(output).toContain("Stream task")
  })

  it("handles missing active chat", () => {
    const output = buildSessionStatusOutputFromSnapshot({ thread: null })

    expect(output).toContain("# Session Status")
    expect(output).toContain("> No active chat is open.")
  })
})

describe("BetterC0de-compatible VCS output", () => {
  it("formats git status like the BetterC0de VCS status route", () => {
    const output = buildVcsStatusOutput("/repo", {
      branch: "main",
      is_clean: false,
      staged: ["src/a.ts"],
      modified: ["src/b.ts"],
      untracked: ["src/c.ts"],
      ahead: 2,
      behind: 1,
      upstream: "origin/main",
    })

    expect(output).toContain("# VCS Status")
    expect(output).toContain("Compatibility reference: `vcs.status`")
    expect(output).toContain("| Branch | main |")
    expect(output).toContain("src/a.ts")
    expect(output).toContain("origin/main")
  })

  it("formats raw and staged VCS diffs with stats", () => {
    const output = buildVcsDiffOutput(
      "/repo",
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+added\n-removed\n",
      { raw: true, staged: true }
    )

    expect(output).toContain("# VCS Diff Raw")
    expect(output).toContain("Compatibility reference: `vcs.diff.raw`")
    expect(output).toContain("Source: staged changes")
    expect(output).toContain("| Files changed | 1 |")
    expect(output).toContain("```diff")
  })

  it("renders BetterC0de VCS apply guidance without mutating files", () => {
    const output = buildVcsApplyOutput("/repo", ["changes.patch", "--terminal"])

    expect(output).toContain("# VCS Apply")
    expect(output).toContain("Compatibility reference: `vcs.apply`")
    expect(output).toContain("Terminal handoff: `git apply changes.patch`")
    expect(output).toContain("does not apply raw patches directly from chat")
    expect(output).toContain("command prefilled")
    expect(output).not.toContain("git apply changes.patch --terminal")
  })
})

describe("BetterC0de-compatible find output", () => {
  it("formats find.text results", () => {
    const output = buildFindTextOutput("/repo", "useChat", [
      {
        path: "src/app.ts",
        name: "app.ts",
        matches: [
          {
            line: 10,
            column: 3,
            length: 7,
            previewColumn: 3,
            previewLength: 7,
            preview: "const useChat = true",
          },
        ],
      },
    ])

    expect(output).toContain("# Find Text")
    expect(output).toContain("Compatibility reference: `find.text`")
    expect(output).toContain("src/app.ts:10:3")
    expect(output).toContain("const useChat = true")
  })

  it("formats find.files results", () => {
    const output = buildFindFilesOutput("/repo", "chat", [
      { path: "src/chat.ts", name: "chat.ts" },
    ])

    expect(output).toContain("# Find Files")
    expect(output).toContain("Compatibility reference: `find.files`")
    expect(output).toContain("src/chat.ts")
  })
})

describe("buildBetterC0deDefaultCommandPrompt", () => {
  it("builds the BetterC0de-compatible init template with workspace context", () => {
    const result = buildBetterC0deDefaultCommandPrompt(
      "/init prefer npm scripts",
      "/repo"
    )

    expect(result?.id).toBe("init")
    expect(result?.prompt).toContain("Create or update `AGENTS.md`")
    expect(result?.prompt).toContain("Workspace path: /repo")
    expect(result?.prompt).toContain("prefer npm scripts")
  })

  it("builds the BetterC0de-compatible review template as read-only ask mode", () => {
    const result = buildBetterC0deDefaultCommandPrompt("/review main", "/repo")

    expect(result?.id).toBe("review")
    expect(result?.chatModeOverride).toBe("ask")
    expect(result?.permissionLevelOverride).toBe("read-only")
    expect(result?.prompt).toContain("You are a code reviewer")
    expect(result?.prompt).toContain("Input: main")
    expect(result?.prompt).toContain("git diff <branch>...HEAD")
  })

  it("routes BetterC0de PR targeting to a read-only review prompt", () => {
    const result = buildBetterC0deDefaultCommandPrompt("/pr 123", "/repo")

    expect(result?.id).toBe("review")
    expect(result?.chatModeOverride).toBe("ask")
    expect(result?.permissionLevelOverride).toBe("read-only")
    expect(result?.prompt).toContain("BetterC0de `pr <number>`")
    expect(result?.prompt).toContain("PR target: 123")
    expect(result?.prompt).toContain("Do not checkout branches")
    expect(result?.prompt).toContain("https://opncd.ai/s/<id>")
    expect(result?.prompt).toContain("/import <url>")
    expect(result?.prompt).toContain("gh pr view <target>")
  })

  it("prefills the BetterC0de PR CLI only when terminal mode is explicit", () => {
    const pending = buildBetterC0dePrTerminalCommand("/pr 123")
    const terminal = buildBetterC0dePrTerminalCommand(
      "/github.pr 123 --terminal"
    )
    const urlTerminal = buildBetterC0dePrTerminalCommand(
      "/pr https://github.com/acme/demo/pull/456 --terminal"
    )
    const invalidTerminal = buildBetterC0dePrTerminalCommand(
      "/pr not-a-number --terminal"
    )
    const output = buildBetterC0dePrTerminalOutput(terminal.command, "/repo")
    const invalidOutput = buildBetterC0dePrTerminalOutput(
      invalidTerminal.command,
      "/repo"
    )

    expect(pending.shouldOpen).toBe(false)
    expect(terminal.shouldOpen).toBe(true)
    expect(terminal.command).toBe("betterc0de pr 123")
    expect(urlTerminal.command).toBe("betterc0de pr 456")
    expect(invalidOutput).toContain("## Validation")
    expect(invalidOutput).toContain(
      "BetterC0de PR target must be a numeric PR number"
    )
    expect(output).toContain(
      "Compatibility reference: `betterc0de pr <number>`"
    )
    expect(output).toContain("betterc0de pr 123")
    expect(output).toContain("fetch and checkout")
  })

  it("ignores unrelated slash commands", () => {
    expect(buildBetterC0deDefaultCommandPrompt("/status", "/repo")).toBeNull()
  })
})

describe("buildGithubAgentOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("shows safe BetterC0de GitHub agent install guidance", async () => {
    const output = await buildGithubAgentOutput("/github.install", [], {
      projectPath: "/repo",
    })

    expect(output).toContain("# BetterC0de GitHub Agent Install")
    expect(output).toContain("betterc0de github install")
    expect(output).toContain(".github/workflows/betterc0de.yml")
    expect(output).toContain("compatibility GitHub App")
    expect(output).toContain("does not silently install")
    expect(output).toContain("--workflow-only")
  })

  it("strips BetterC0de GitHub subcommands before output routing", async () => {
    expect(
      stripBetterC0deGithubSlashSubcommand(["install", "--workflow-only"])
    ).toEqual(["--workflow-only"])
    expect(
      stripBetterC0deGithubSlashSubcommand([
        "--terminal",
        "run",
        "--event",
        "event.json",
      ])
    ).toEqual(["--terminal", "--event", "event.json"])
    expect(stripBetterC0deGithubSlashSubcommand(["status"])).toEqual(["status"])

    const output = await buildGithubAgentOutput(
      "/github.run",
      stripBetterC0deGithubSlashSubcommand([
        "run",
        "--event",
        "event.json",
        "--terminal",
      ]),
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de GitHub Agent Run")
    expect(output).toContain("betterc0de github run --event event.json")
    expect(output).not.toContain("betterc0de github run run")
  })

  it("shows run guidance without spawning the GitHub agent", async () => {
    const output = await buildGithubAgentOutput(
      "/github.run",
      ["--event", "event.json", "--terminal"],
      {
        worktreePath: "/repo/worktree",
      }
    )

    expect(output).toContain("# BetterC0de GitHub Agent Run")
    expect(output).toContain("betterc0de github run")
    expect(output).toContain("betterc0de github run --event event.json")
    expect(output).not.toContain("--terminal")
    expect(output).toContain("## Terminal")
    expect(output).toContain("/repo/worktree")
    expect(output).toContain("terminal")
    expect(output).toContain("MODEL=provider/model")
    expect(output).toContain("Run checks")
    expect(output).toContain("set `--model provider/model`")
  })

  it("maps GitHub run environment flags into the BetterC0de terminal handoff", async () => {
    const output = await buildGithubAgentOutput(
      "/github.run",
      [
        "--event",
        "event.json",
        "--model",
        "anthropic/claude-sonnet-4-5",
        "--run-id",
        "12345",
        "--use-github-token",
        "--share",
        "false",
        "--variant",
        "max",
        "--terminal",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Terminal")
    expect(output).toContain(
      "MODEL=anthropic/claude-sonnet-4-5 GITHUB_RUN_ID=12345 SHARE=false USE_GITHUB_TOKEN=true VARIANT=max betterc0de github run --event event.json"
    )
    expect(output).toContain(
      "Run arguments look complete for the visible compatibility CLI handoff"
    )
    expect(output).not.toContain("--terminal")
  })

  it("validates GitHub run booleans and BetterC0de compatibility provider/model ids", async () => {
    const output = await buildGithubAgentOutput(
      "/github.run",
      [
        "--model",
        "gpt-5.5",
        "--run-id",
        "12345",
        "--share",
        "maybe",
        "--use-github-token",
        "nah",
        "--terminal",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "`--share` maps to BetterC0de `SHARE` and must be `true` or `false`"
    )
    expect(output).toContain(
      "`--use-github-token` maps to BetterC0de `USE_GITHUB_TOKEN` and must be `true` or `false`"
    )
    expect(output).toContain(
      "`--model` must use the compatibility CLI's `provider/model` format for `MODEL`"
    )
    expect(output).toContain(
      "MODEL=gpt-5.5 GITHUB_RUN_ID=12345 betterc0de github run"
    )
    expect(output).not.toContain("SHARE=maybe")
    expect(output).not.toContain("USE_GITHUB_TOKEN=nah")
    expect(output).not.toContain("USE_GITHUB_TOKEN=true")
  })

  it("validates missing GitHub run option values before terminal handoff", async () => {
    const output = await buildGithubAgentOutput(
      "/github.run",
      [
        "--event=",
        "--token",
        "--model=",
        "--run-id",
        "--variant=",
        "--oidc-base-url",
        "--terminal",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("--event requires a value")
    expect(output).toContain("--token requires a value")
    expect(output).toContain("--model requires a value")
    expect(output).toContain("--run-id requires a value")
    expect(output).toContain("--variant requires a value")
    expect(output).toContain("--oidc-base-url requires a value")
    expect(output).toContain("betterc0de github run")
    expect(output).not.toContain("--terminal")
  })

  it("writes an BetterC0de GitHub agent workflow in workflow-only mode", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
        "--env",
        "ANTHROPIC_API_KEY,ANTHROPIC_BETA",
        "--agent",
        "build",
        "--share",
        "false",
        "--mentions",
        "/oc,/better",
        "--variant",
        "max",
        "--use-github-token",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Created the BetterC0de GitHub agent workflow file"
    )
    expect(output).toContain("Model: `anthropic/claude-sonnet-4-5`")
    expect(output).toContain("Agent: `build`")
    expect(output).toContain("Variant: `max`")
    expect(output).toContain("Share: `false`")
    expect(output).toContain("Mentions: `/oc,/better`")
    expect(output).toContain("GitHub token mode")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".github/workflows/betterc0de.yml",
      expect.stringContaining("uses: betterc0de-ai/betterc0de-github@latest")
    )
    const workflow = writeFileMock.mock.calls[0]?.[2] ?? ""
    expect(workflow).toContain(
      "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}"
    )
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}")
    expect(workflow).toContain("contents: write")
    expect(workflow).toContain("pull-requests: write")
    expect(workflow).toContain("issues: write")
    expect(workflow).toContain("ANTHROPIC_BETA: ${{ secrets.ANTHROPIC_BETA }}")
    expect(workflow).toContain('model: "anthropic/claude-sonnet-4-5"')
    expect(workflow).toContain('agent: "build"')
    expect(workflow).toContain('share: "false"')
    expect(workflow).toContain('mentions: "/oc,/better"')
    expect(workflow).toContain(
      "contains(github.event.comment.body, ' /better')"
    )
    expect(workflow).not.toContain(
      "contains(github.event.comment.body, ' /betterc0de')"
    )
    expect(workflow).toContain('variant: "max"')
    expect(workflow).toContain('use_github_token: "true"')
  })

  it("adds BetterC0de-compatible default provider secrets to GitHub workflow-only mode", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildGithubAgentOutput(
      "/github.install",
      ["--workflow-only", "--provider", "openai", "--model", "gpt-5.5"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Secrets referenced: OPENAI_API_KEY")
    const workflow = writeFileMock.mock.calls[0]?.[2] ?? ""
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}")
  })

  it("infers provider from provider/model in GitHub workflow-only mode", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildGithubAgentOutput(
      "/github.install",
      ["--workflow-only", "--model", "openai/gpt-5.5"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Model: `openai/gpt-5.5`")
    expect(output).toContain("Secrets referenced: OPENAI_API_KEY")
    const workflow = writeFileMock.mock.calls[0]?.[2] ?? ""
    expect(workflow).toContain('model: "openai/gpt-5.5"')
    expect(workflow).not.toContain('model: "openai/openai/gpt-5.5"')
  })

  it("validates GitHub workflow-only boolean flags before writing", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--share",
        "maybe",
        "--use-github-token",
        "nah",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Could not write the GitHub agent workflow")
    expect(output).toContain(
      "`--share` maps to BetterC0de `share` action input and must be `true` or `false`"
    )
    expect(output).toContain(
      "`--use-github-token` maps to BetterC0de `use_github_token` action input and must be `true` or `false`"
    )
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates missing GitHub workflow-only values and unsupported triggers", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider=",
        "--model",
        "--agent=",
        "--prompt",
        "--triggers",
        "issue_comment,deploy",
        "--schedule=",
        "--mentions=",
        "--variant=",
        "--oidc=",
        "--env=",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Workflow Checks")
    expect(output).toContain("--provider requires a value")
    expect(output).toContain("--model requires a value")
    expect(output).toContain("--agent requires a value")
    expect(output).toContain("--prompt requires a value")
    expect(output).toContain("Unsupported GitHub workflow trigger: `deploy`")
    expect(output).toContain("--schedule requires a value")
    expect(output).toContain("--mentions requires a value")
    expect(output).toContain("--variant requires a value")
    expect(output).toContain("--oidc requires a value")
    expect(output).toContain("--env requires a value")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates GitHub workflow-only env names before writing", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--env",
        "OPENAI_API_KEY,bad-name,lowercase",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Could not write the GitHub agent workflow")
    expect(output).toContain("Invalid GitHub workflow env name: `bad-name`")
    expect(output).toContain("Invalid GitHub workflow env name: `lowercase`")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates GitHub workflow schedule cron values before writing", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--schedule",
        "every morning",
        "--prompt",
        "Run the repository maintenance agent",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Could not write the GitHub agent workflow")
    expect(output).toContain(
      "Invalid GitHub workflow schedule: `every morning`"
    )
    expect(output).toContain("Use five-field cron like `0 9 * * *`")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("keeps Amazon Bedrock GitHub workflow secrets empty for OIDC setup", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "amazon-bedrock",
        "--model",
        "anthropic.claude-sonnet-4-5",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Secrets referenced: -")
    expect(output).toContain("Configure AWS OIDC")
    const workflow = writeFileMock.mock.calls[0]?.[2] ?? ""
    expect(workflow).not.toContain("${{ secrets.")
    expect(workflow).toContain(
      'model: "amazon-bedrock/anthropic.claude-sonnet-4-5"'
    )
  })

  it("writes BetterC0de GitHub workflow repo triggers when prompt is provided", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--triggers",
        "issue_comment,pull_request,workflow_dispatch",
        "--schedule",
        "0 9 * * *",
        "--prompt",
        "Run the repository maintenance agent",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Triggers: `issue_comment, pull_request, workflow_dispatch, schedule`"
    )
    expect(output).toContain("Schedules: `0 9 * * *`")
    const workflow = writeFileMock.mock.calls[0]?.[2] ?? ""
    expect(workflow).toContain("issue_comment:")
    expect(workflow).not.toContain("pull_request_review_comment:")
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("schedule:")
    expect(workflow).toContain("contents: read")
    expect(workflow).toContain("pull-requests: read")
    expect(workflow).toContain("issues: read")
    expect(workflow).toContain('    - cron: "0 9 * * *"')
    expect(workflow).toContain('prompt: "Run the repository maintenance agent"')
    expect(workflow).toContain("github.event_name == 'pull_request'")
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain("github.event_name == 'schedule'")
  })

  it("expands BetterC0de GitHub workflow trigger aliases before writing", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--triggers",
        "comment,issue,pr,manual",
        "--prompt",
        "Run the requested repository task",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Triggers: `issue_comment, pull_request_review_comment, issues, pull_request, workflow_dispatch`"
    )
    const workflow = writeFileMock.mock.calls[0]?.[2] ?? ""
    expect(workflow).toContain("issue_comment:")
    expect(workflow).toContain("pull_request_review_comment:")
    expect(workflow).toContain("issues:")
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("github.event_name == 'issues'")
    expect(workflow).toContain("github.event_name == 'pull_request'")
  })

  it("requires a prompt for BetterC0de GitHub issue and repo workflow triggers", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )

    const output = await buildGithubAgentOutput(
      "/github.install",
      [
        "--workflow-only",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--triggers",
        "issues,workflow_dispatch",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("`--prompt` is required")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("does not overwrite an existing GitHub workflow without force", async () => {
    readFileMock.mockResolvedValueOnce({
      content: "name: betterc0de\n",
      path: "/repo/.github/workflows/betterc0de.yml",
    })

    const output = await buildGithubAgentOutput(
      "/github.install",
      ["--workflow-only", "--provider=anthropic", "--model=claude-sonnet-4-5"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("GitHub agent workflow already exists")
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe("buildAgentCreateOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("shows BetterC0de agent create guidance with requested args", async () => {
    const output = await buildAgentCreateOutput(
      ["--description", "Review React performance", "--mode", "subagent"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de Agent Create")
    expect(output).toContain(
      "Compatibility reference: `betterc0de agent create`"
    )
    expect(output).toContain("Workspace: `/repo`")
    expect(output).toContain(
      'betterc0de agent create --description "Review React performance" --mode subagent'
    )
    expect(output).toContain(".betterc0de/agents/")
    expect(output).toContain("Add `--permissions read,grep,lsp`")
  })

  it("strips BetterC0de agent subcommands while preserving terminal flags", () => {
    expect(stripBetterC0deAgentSlashSubcommand(["list", "--terminal"])).toEqual(
      ["--terminal"]
    )
    expect(
      stripBetterC0deAgentSlashSubcommand([
        "--terminal",
        "create",
        "--description",
        "Review code",
      ])
    ).toEqual(["--terminal", "--description", "Review code"])
    expect(stripBetterC0deAgentSlashSubcommand(["next"])).toEqual(["next"])
  })

  it("shows BetterC0de agent create terminal guidance without writing files", async () => {
    const output = await buildAgentCreateOutput(
      [
        "--description",
        "Review React performance",
        "--mode",
        "subagent",
        "--permissions",
        "read,grep,lsp",
        "--terminal",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Terminal")
    expect(output).toContain(
      'betterc0de agent create --description "Review React performance" --mode subagent --permissions read,grep,lsp'
    )
    expect(output).toContain("did not create a project agent file")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("renders BetterC0de-compatible subagent list and debug detail output", () => {
    const agent = {
      id: "reviewer",
      name: "Reviewer",
      description: "Review code",
      prompt: "Inspect the diff.",
      enabled: true,
      mode: "subagent",
      model: "anthropic/claude-sonnet-4",
      tools: { read: true, bash: false },
      sourcePath: ".betterc0de/agents/reviewer.md",
    }
    const listOutput = buildRuntimeSubagentListOutput(
      [agent],
      "betterc0de agent list"
    )
    const detailOutput = buildRuntimeSubagentDetailOutput(agent)

    expect(listOutput).toContain("betterc0de agent list")
    expect(listOutput).toContain("`/reviewer`")
    expect(detailOutput).toContain(
      "Compatibility reference: `betterc0de debug agent <name>`"
    )
    expect(detailOutput).toContain("read: enabled")
    expect(detailOutput).toContain("Inspect the diff.")
  })

  it("renders BetterC0de debug agent tool handoff without executing tools", () => {
    const output = buildRuntimeSubagentDebugOutput(
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Review code",
        prompt: "Inspect the diff.",
        enabled: true,
        tools: { read: true, bash: true },
        sourcePath: ".betterc0de/agents/reviewer.md",
      },
      ["reviewer", "--tool", "bash", "--params", '{"cmd":"pwd"}'],
      'betterc0de debug agent reviewer --tool bash --params \'{"cmd":"pwd"}\''
    )

    expect(output).toContain("# BetterC0de Debug Agent Tool")
    expect(output).toContain("`betterc0de debug agent <name> --tool <tool>")
    expect(output).toContain("| **State** | enabled |")
    expect(output).toContain('"cmd": "pwd"')
    expect(output).toContain(
      "BetterC0de does not execute debug tool calls from chat"
    )
    expect(output).toContain("betterc0de debug agent reviewer --tool bash")
  })

  it("surfaces BetterC0de debug agent disabled tools and unsafe params", () => {
    const output = buildRuntimeSubagentDebugOutput(
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Review code",
        prompt: "Inspect the diff.",
        enabled: true,
        tools: { bash: false, read: true },
      },
      ["reviewer", "--tool=bash", "--params", "{ cmd: 'pwd' }"],
      "betterc0de debug agent reviewer --tool=bash --params '{ cmd: 'pwd' }'"
    )

    expect(output).toContain("| **State** | disabled |")
    expect(output).toContain("is disabled for this agent")
    expect(output).toContain("Could not parse `--params` as JSON object")
    expect(output).toContain(
      "the compatibility CLI's CLI also accepts JS object literals"
    )
  })

  it("shows BetterC0de agent create usage without args", async () => {
    const output = await buildAgentCreateOutput([], null)

    expect(output).toContain(
      'betterc0de agent create --description "Review React performance"'
    )
    expect(output).toContain("No folder open")
  })

  it("writes a project agent file for fully specified non-interactive args", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildAgentCreateOutput(
      [
        "--description",
        "Review React performance",
        "--mode",
        "subagent",
        "--permissions",
        "read,grep,lsp",
        "--model",
        "anthropic/claude-sonnet-4",
        "--variant",
        "careful",
        "--temperature",
        "0.2",
        "--top-p",
        "0.8",
        "--color",
        "primary",
        "--steps",
        "7",
        "--hidden",
        "true",
        "--prompt",
        "Review only the changed files and report risks.",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Created a project agent file")
    expect(output).toContain(
      "Target: `.betterc0de/agents/review-react-performance.md`"
    )
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".betterc0de/agents/review-react-performance.md",
      expect.stringContaining("mode: subagent")
    )
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain("bash: deny")
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).not.toContain("read: deny")
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain(
      'model: "anthropic/claude-sonnet-4"'
    )
    expect(output).toContain("Variant: `careful`")
    expect(output).toContain("Temperature: 0.2")
    expect(output).toContain("Top P: 0.8")
    expect(output).toContain("Color: `primary`")
    expect(output).toContain("Steps: 7")
    expect(output).toContain("Hidden: true")
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain(
      'variant: "careful"'
    )
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain(
      "temperature: 0.2"
    )
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain("top_p: 0.8")
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain(
      'color: "primary"'
    )
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain("steps: 7")
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain("hidden: true")
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toContain(
      "Review only the changed files and report risks."
    )
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).not.toContain(
      "You are the review-react-performance agent."
    )
  })

  it("filters unsupported BetterC0de compatibility project agent schema option values", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    await buildAgentCreateOutput(
      [
        "--description",
        "Review React performance",
        "--mode",
        "subagent",
        "--permissions",
        "read",
        "--variant",
        "invalid value",
        "--color",
        "purple",
        "--steps",
        "0",
      ],
      { projectPath: "/repo" }
    )

    const content = vi.mocked(writeFile).mock.calls[0]?.[2] ?? ""
    expect(content).not.toContain("variant:")
    expect(content).not.toContain("color:")
    expect(content).not.toContain("steps:")
  })

  it("refuses to write project agents with invalid BetterC0de model ids", async () => {
    const output = await buildAgentCreateOutput(
      [
        "--description",
        "Review React performance",
        "--mode",
        "subagent",
        "--permissions",
        "read",
        "--model",
        "claude-sonnet-4",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Could not create the agent file")
    expect(output).toContain(
      "`--model` must use the compatibility CLI's `provider/model` format"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("does not overwrite an existing project agent without --force", async () => {
    readFileMock.mockResolvedValueOnce({
      path: "/repo/.betterc0de/agents/review-react-performance.md",
      content: "existing",
    })

    const output = await buildAgentCreateOutput(
      [
        "--description",
        "Review React performance",
        "--mode",
        "subagent",
        "--permissions",
        "read",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Agent file already exists")
    expect(output).toContain("Use `--force`")
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe("buildBetterC0deRuntimeEntrypointOutput", () => {
  beforeEach(() => {
    listProjectConfigSettingsMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("shows current BetterC0de compatibility runtime settings without writing files", async () => {
    listProjectConfigSettingsMock.mockResolvedValueOnce([
      {
        key: "runtime.outputTokenMax",
        label: "Output token max",
        kind: "scalar",
        value: "8192",
        sourcePath:
          "BetterC0de compatibility runtime flags#runtime.outputTokenMax",
      },
      {
        key: "runtime.disableLspDownload",
        label: "Disable LSP download",
        kind: "toggle",
        value: "enabled",
        sourcePath:
          "BetterC0de compatibility runtime flags#runtime.disableLspDownload",
      },
      {
        key: "provider",
        label: "Providers",
        kind: "object",
        value: "openai{1}",
        sourcePath: "betterc0de.json#provider",
      },
    ])

    const output = await buildBetterC0deRuntimeConfigOutput([], {
      projectPath: "/repo",
    })

    expect(output).toContain("## Current Runtime Settings")
    expect(output).toContain("`runtime.outputTokenMax`")
    expect(output).toContain(
      "BetterC0de compatibility runtime flags#runtime.disableLspDownload"
    )
    expect(output).not.toContain("openai{1}")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes BetterC0de compatibility runtime config in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "server": { "hostname": "localhost" } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildBetterC0deRuntimeConfigOutput(
      [
        "--config-only",
        "--port",
        "4096",
        "--mdns",
        "false",
        "--mdns-domain",
        "custom.local",
        "--cors",
        "https://app.example.com",
        "--cors",
        "https://admin.example.com",
        "--watcher-ignore",
        "dist,node_modules",
        "--share",
        "manual",
        "--autoupdate",
        "notify",
        "--snapshot",
        "false",
        "--default-agent",
        "build",
        "--enterprise-url",
        "https://betterc0de.example.com",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Updated the workspace BetterC0de runtime config")
    expect(output).toContain("server")
    expect(output).toContain("enterprise.url")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "server": {\n    "hostname": "localhost",\n    "port": 4096,\n    "mdns": false,\n    "mdnsDomain": "custom.local",\n    "cors": [\n      "https://app.example.com",\n      "https://admin.example.com"\n    ]\n  },\n  "watcher": {\n    "ignore": [\n      "dist",\n      "node_modules"\n    ]\n  },\n  "snapshot": false,\n  "share": "manual",\n  "autoupdate": "notify",\n  "default_agent": "build",\n  "enterprise": {\n    "url": "https://betterc0de.example.com"\n  }\n}\n'
      )
    )
  })

  it("writes BetterC0de compatibility runtime limits in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "attachment": { "image": { "max_width": 1600 } }, "experimental": { "batch_tool": false } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildBetterC0deRuntimeConfigOutput(
      [
        "--config-only",
        "--auto-resize",
        "false",
        "--max-height",
        "1800",
        "--max-base64-bytes",
        "5242880",
        "--max-lines",
        "4000",
        "--max-bytes",
        "102400",
        "--auto",
        "true",
        "--prune",
        "false",
        "--tail-turns",
        "3",
        "--preserve-recent-tokens",
        "12000",
        "--reserved",
        "2000",
        "--disable-paste-summary",
        "true",
        "--batch-tool",
        "true",
        "--open-telemetry",
        "true",
        "--primary-tools",
        "bash,edit",
        "--continue-loop-on-deny",
        "true",
        "--mcp-timeout",
        "10000",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Updated the workspace BetterC0de runtime config")
    expect(output).toContain("attachment.image")
    expect(output).toContain("tool_output")
    expect(output).toContain("compaction")
    expect(output).toContain("experimental")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "attachment": {\n    "image": {\n      "max_width": 1600,\n      "auto_resize": false,\n      "max_height": 1800,\n      "max_base64_bytes": 5242880\n    }\n  },\n  "experimental": {\n    "batch_tool": true,\n    "disable_paste_summary": true,\n    "openTelemetry": true,\n    "primary_tools": [\n      "bash",\n      "edit"\n    ],\n    "continue_loop_on_deny": true,\n    "mcp_timeout": 10000\n  },\n  "tool_output": {\n    "max_lines": 4000,\n    "max_bytes": 102400\n  },\n  "compaction": {\n    "auto": true,\n    "prune": false,\n    "tail_turns": 3,\n    "preserve_recent_tokens": 12000,\n    "reserved": 2000\n  }\n}\n'
      )
    )
  })

  it("validates BetterC0de compatibility runtime config values before writing", async () => {
    const output = await buildBetterC0deRuntimeConfigOutput(
      [
        "--config-only",
        "--port",
        "abc",
        "--hostname",
        "--log-level",
        "TRACE",
        "--mdns",
        "maybe",
        "--share",
        "public",
        "--autoupdate",
        "later",
        "--layout",
        "grid",
        "--max-width",
        "0",
        "--max-lines",
        "nope",
        "--tail-turns",
        "three",
        "--mcp-timeout",
        "never",
        "--enterprise-url=",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--port` must be a positive integer")
    expect(output).toContain("--hostname requires a value")
    expect(output).toContain(
      "`--log-level` must be `DEBUG`, `INFO`, `WARN`, or `ERROR`"
    )
    expect(output).toContain("`--mdns` must be true or false")
    expect(output).toContain(
      "`--share` must be `manual`, `auto`, or `disabled`"
    )
    expect(output).toContain("`--autoupdate` must be true, false, or `notify`")
    expect(output).toContain("`--layout` must be `auto` or `stretch`")
    expect(output).toContain("`--max-width` must be a positive integer")
    expect(output).toContain("`--max-lines` must be a positive integer")
    expect(output).toContain("`--tail-turns` must be a non-negative integer")
    expect(output).toContain("`--mcp-timeout` must be a positive integer")
    expect(output).toContain("--enterprise-url requires a value")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes BetterC0de reference aliases in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "reference": { "docs": { "path": "./docs" } } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectReferenceConfigOutput(
      [
        "--config-only",
        "--alias",
        "sdk",
        "--repo",
        "owner/sdk",
        "--branch",
        "main",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Updated the workspace BetterC0de compatibility config"
    )
    expect(output).toContain("reference.sdk")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "reference": {\n    "docs": {\n      "path": "./docs"\n    },\n    "sdk": {\n      "repository": "owner/sdk",\n      "branch": "main"\n    }\n  }\n}\n'
      )
    )
  })

  it("writes BetterC0de instructions and skill sources in config-only mode", async () => {
    readFileMock
      .mockResolvedValueOnce({
        content: '{ "instructions": ["AGENTS.md"] }',
        path: "/repo/betterc0de.json",
      })
      .mockResolvedValueOnce({
        content: '{ "skills": { "paths": ["./skills"] } }',
        path: "/repo/betterc0de.json",
      })
    writeFileMock.mockResolvedValue(undefined)

    const instructionsOutput = await buildProjectInstructionsConfigOutput(
      [
        "--config-only",
        "--add",
        "CLAUDE.md,.cursor/rules/*.md",
        "--remove",
        "AGENTS.md",
      ],
      { projectPath: "/repo" }
    )
    const skillsOutput = await buildProjectSkillsConfigOutput(
      [
        "--config-only",
        "--path",
        "./.betterc0de/skills",
        "--url",
        "https://example.com/.well-known/skills/",
      ],
      { projectPath: "/repo" }
    )

    expect(instructionsOutput).toContain("Project Instructions")
    expect(skillsOutput).toContain("Skills")
    expect(writeFileMock).toHaveBeenNthCalledWith(
      1,
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "instructions": [\n    "CLAUDE.md",\n    ".cursor/rules/*.md"\n  ]\n}\n'
      )
    )
    expect(writeFileMock).toHaveBeenNthCalledWith(
      2,
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "skills": {\n    "paths": [\n      "./skills",\n      "./.betterc0de/skills"\n    ],\n    "urls": [\n      "https://example.com/.well-known/skills/"\n    ]\n  }\n}\n'
      )
    )
  })

  it("keeps the default skills list compact while preserving exact invocations", () => {
    const output = buildRuntimeSkillsOutput([
      {
        id: "codex-skill-review",
        name: "Code review",
        version: "1",
        public: false,
        enabled: true,
        content: "private body",
        sourcePath: "C:\\Users\\person\\.codex\\skills\\review",
      },
      {
        id: "claude-skill-review",
        name: "Code review",
        version: "1",
        public: false,
        enabled: false,
        content: "private body",
      },
    ])
    expect(output).toContain("1 enabled · 2 installed")
    expect(output).toContain("@codex-skill-review")
    expect(output).toContain("@claude-skill-review")
    expect(output).toContain("Disabled")
    expect(output).toContain("/skills --json")
    expect(output).not.toContain("C:\\Users")
    expect(output).not.toContain("private body")
  })

  it("renders BetterC0de-compatible verbose skills output", () => {
    const output = buildRuntimeSkillsOutput(
      [
        {
          id: "customize-betterc0de",
          name: "customize-betterc0de",
          version: "project",
          public: false,
          enabled: true,
          description: "Use when editing BetterC0de config & skills.",
          content: "Body",
          sourcePath: "<built-in>",
        },
        {
          id: "no-description",
          name: "no-description",
          version: "project",
          public: false,
          enabled: true,
          content: "Body",
          sourcePath: "/repo/.betterc0de/skills/no-description/SKILL.md",
        },
      ],
      ["--verbose"]
    )

    expect(output).toContain("<available_skills>")
    expect(output).toContain("<name>customize-betterc0de</name>")
    expect(output).toContain(
      "<description>Use when editing BetterC0de config &amp; skills.</description>"
    )
    expect(output).toContain("<location>&lt;built-in&gt;</location>")
    expect(output).not.toContain("no-description")
  })

  it("renders BetterC0de debug skill JSON output", () => {
    const output = buildRuntimeSkillsOutput(
      [
        {
          id: "customize-betterc0de",
          name: "customize-betterc0de",
          version: "project",
          public: false,
          enabled: true,
          description: "Use when editing BetterC0de config.",
          content: "Skill body",
          sourcePath: "<built-in>",
        },
        {
          id: "no-description",
          name: "no-description",
          version: "project",
          public: false,
          enabled: true,
          content: "No description body",
          sourcePath: "/repo/.betterc0de/skills/no-description/SKILL.md",
        },
      ],
      ["--json"]
    )

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug skill`"
    )
    expect(output).toContain('"name": "customize-betterc0de"')
    expect(output).toContain('"location": "<built-in>"')
    expect(output).toContain(
      '"location": "file:///repo/.betterc0de/skills/no-description/SKILL.md"'
    )
    expect(output).toContain('"content": "No description body"')
  })

  it("writes BetterC0de compatibility project tool flags in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "tools": { "bash": true, "write": false } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectToolsConfigOutput(
      [
        "--config-only",
        "--disable",
        "bash",
        "--enable",
        "read,grep",
        "--remove",
        "write",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("BetterC0de Project Tools")
    expect(output).toContain("tools.bash")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "tools": {\n    "bash": false,\n    "read": true,\n    "grep": true\n  }\n}\n'
      )
    )
  })

  it("writes a local BetterC0de MCP config entry in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "mcp": { "old": { "type": "remote", "url": "https://old.example.com/mcp" } } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectMcpConfigOutput(
      [
        "--config-only",
        "filesystem",
        "--command",
        "npx @modelcontextprotocol/server-filesystem .",
        "--env",
        "GITHUB_TOKEN",
        "--env",
        "NODE_ENV=test",
        "--timeout",
        "10000",
        "--disabled",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("MCP Add")
    expect(output).toContain("mcp.filesystem")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "mcp": {\n    "old": {\n      "type": "remote",\n      "url": "https://old.example.com/mcp"\n    },\n    "filesystem": {\n      "type": "local",\n      "command": [\n        "npx",\n        "@modelcontextprotocol/server-filesystem",\n        "."\n      ],\n      "environment": {\n        "GITHUB_TOKEN": "${GITHUB_TOKEN}",\n        "NODE_ENV": "test"\n      },\n      "enabled": false,\n      "timeout": 10000\n    }\n  }\n}\n'
      )
    )
  })

  it("writes a remote BetterC0de MCP config entry in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "mcp": { "docs": { "type": "remote", "url": "https://old.example.com/mcp", "headers": { "Accept": "application/json" } } } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectMcpConfigOutput(
      [
        "--config-only",
        "docs",
        "--url",
        "https://docs.example.com/mcp",
        "--header",
        "X-Docs=enabled",
        "--oauth",
        "true",
        "--client-id",
        "docs-client",
        "--scope",
        "docs:read",
        "--redirect-uri",
        "http://127.0.0.1:19876/mcp/oauth/callback",
        "--enabled",
        "true",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Updated the workspace BetterC0de compatibility config"
    )
    expect(output).toContain("mcp.docs")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "mcp": {\n    "docs": {\n      "type": "remote",\n      "url": "https://docs.example.com/mcp",\n      "headers": {\n        "Accept": "application/json",\n        "X-Docs": "enabled"\n      },\n      "oauth": {\n        "clientId": "docs-client",\n        "scope": "docs:read",\n        "redirectUri": "http://127.0.0.1:19876/mcp/oauth/callback"\n      },\n      "enabled": true\n    }\n  }\n}\n'
      )
    )
  })

  it("refuses to write BetterC0de MCP client secrets from chat", async () => {
    const output = await buildProjectMcpConfigOutput(
      [
        "--config-only",
        "docs",
        "--url",
        "https://docs.example.com/mcp",
        "--client-secret",
        "super-secret",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Refusing to write `clientSecret`")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de MCP config-only arguments before writing", async () => {
    const output = await buildProjectMcpConfigOutput(
      [
        "--config-only",
        "docs",
        "--type",
        "socket",
        "--env",
        "1BAD=value",
        "--header",
        "Authorization",
        "--oauth",
        "maybe",
        "--enabled",
        "maybe",
        "--timeout",
        "0",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Refusing to write an invalid BetterC0de MCP config"
    )
    expect(output).toContain("`--type` must be `local` or `remote`")
    expect(output).toContain("`--env` must be an environment key")
    expect(output).toContain("`--header` must use `Header-Name=value`")
    expect(output).toContain("`--oauth` must be true or false")
    expect(output).toContain("`--enabled` must be true or false")
    expect(output).toContain("`--timeout` must be a positive integer")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes an BetterC0de MCP enablement override in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: "{}",
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectMcpConfigOutput(
      ["--config-only", "github", "--enabled", "false"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("mcp.github")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "mcp": {\n    "github": {\n      "enabled": false\n    }\n  }\n}\n'
      )
    )
  })

  it("renders BetterC0de default terminal guidance", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-tui",
      ["./app", "--model", "anthropic/claude-sonnet-4-5", "--terminal"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de Terminal")
    expect(output).toContain("Compatibility reference: `betterc0de [project]`")
    expect(output).toContain(
      "betterc0de ./app --model anthropic/claude-sonnet-4-5"
    )
    expect(output).not.toContain("--terminal")
    expect(output).toContain("default compatibility terminal UI")
    expect(output).toContain("`--prompt`")
    expect(output).toContain("command prefilled")
  })

  it("renders BetterC0de run CLI guidance", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--format", "json", "review", "diff", "--terminal"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de Run")
    expect(output).toContain("Compatibility reference: `betterc0de run`")
    expect(output).toContain("betterc0de run --format json review diff")
    expect(output).not.toContain("--terminal")
    expect(output).toContain("raw JSON events")
    expect(output).toContain("`--command`")
    expect(output).toContain("`--variant`")
    expect(output).toContain("`--interactive`")
    expect(output).toContain("`--replay-limit`")
    expect(output).toContain("`--dangerously-skip-permissions`")
    expect(output).toContain("`--log-level DEBUG|INFO|WARN|ERROR`")
    expect(output).toContain("`--print-logs`")
    expect(output).toContain("`--pure`")
    expect(output).toContain("command prefilled")
  })

  it("surfaces BetterC0de run flag validation conflicts", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      [
        "--interactive",
        "--format",
        "json",
        "--command",
        "status",
        "--replay-limit",
        "0",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "`--interactive` needs a terminal/TTY; add `--terminal`"
    )
    expect(output).toContain("`--interactive` cannot be used with `--command`")
    expect(output).toContain(
      "`--interactive` cannot be used with `--format json`"
    )
    expect(output).toContain("`--replay-limit` must be a positive integer")
  })

  it("warns when BetterC0de run permission skipping is requested", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--dangerously-skip-permissions", "review", "diff"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "`--dangerously-skip-permissions` auto-approves permissions"
    )
  })

  it("treats BetterC0de inline boolean flags as active during runtime validation", () => {
    const run = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--interactive=true", "--format=json", "--command", "status"],
      { projectPath: "/repo" }
    )
    const demo = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--demo=true", "review"],
      { projectPath: "/repo" }
    )
    const tui = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-tui",
      ["--fork=true"],
      { projectPath: "/repo" }
    )
    const tuiContinueFalse = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-tui",
      ["--fork=true", "-c=false"],
      { projectPath: "/repo" }
    )

    expect(run).toContain("`--interactive` needs a terminal/TTY")
    expect(run).toContain("`--interactive` cannot be used with `--command`")
    expect(run).toContain("`--interactive` cannot be used with `--format json`")
    expect(demo).toContain("`--demo` requires `--interactive`")
    expect(tui).toContain("`--fork` requires `--continue` or `--session`")
    expect(tuiContinueFalse).toContain(
      "`--fork` requires `--continue` or `--session`"
    )
  })

  it("surfaces BetterC0de run option value and format validation", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--format", "xml", "--file", "--model"],
      { projectPath: "/repo" }
    )
    const inlineOutput = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["hello", "--model=", "--format="],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--format` must be `default` or `json`")
    expect(output).toContain("--file requires a value")
    expect(output).toContain("--model requires a value")
    expect(inlineOutput).toContain("--model requires a value")
    expect(inlineOutput).toContain("--format requires a value")
  })

  it("allows BetterC0de run's optional empty title value", () => {
    const inlineTitle = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--title=", "review", "diff"],
      { projectPath: "/repo" }
    )
    const flagTitle = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--title", "--format", "json", "review"],
      { projectPath: "/repo" }
    )

    expect(inlineTitle).not.toContain("--title requires a value")
    expect(inlineTitle).not.toContain("BetterC0de run requires a message")
    expect(flagTitle).not.toContain("--title requires a value")
    expect(flagTitle).not.toContain("BetterC0de run requires a message")
  })

  it("surfaces BetterC0de global CLI flag validation", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--log-level", "debug", "--print-logs", "--pure", "--share=maybe"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "`--log-level` must be `DEBUG`, `INFO`, `WARN`, or `ERROR`"
    )
    expect(output).toContain("`--share` must be true or false")
    expect(output).toContain(
      "betterc0de run --log-level debug --print-logs --pure"
    )
  })

  it("surfaces compatibility server option value validation", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-serve",
      ["--hostname", "--cors", "--mdns=maybe"],
      { projectPath: "/repo" }
    )
    const inlineOutput = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-serve",
      ["--hostname=", "--cors="],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--hostname requires a value")
    expect(output).toContain("--cors requires a value")
    expect(output).toContain("`--mdns` must be true or false")
    expect(inlineOutput).toContain("--hostname requires a value")
    expect(inlineOutput).toContain("--cors requires a value")
  })

  it("surfaces BetterC0de compatibility runtime type validation for port and model", () => {
    const run = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["hello", "--port", "abc", "--model", "gpt-5.5", "--attach", "server"],
      { projectPath: "/repo" }
    )
    const tui = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-tui",
      ["--model", "claude-sonnet-4-5"],
      { projectPath: "/repo" }
    )
    const serve = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-serve",
      ["--port", "-1"],
      { projectPath: "/repo" }
    )
    const randomPort = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-serve",
      ["--port", "0"],
      { projectPath: "/repo" }
    )

    expect(run).toContain("`--port` must be a non-negative integer")
    expect(run).toContain(
      "`--model` must use the compatibility CLI's `provider/model` format"
    )
    expect(run).toContain(
      "`--attach` must be a valid `http://` or `https://` URL"
    )
    expect(tui).toContain(
      "`--model` must use the compatibility CLI's `provider/model` format"
    )
    expect(serve).toContain("`--port` must be a non-negative integer")
    expect(randomPort).not.toContain("`--port` must be")
  })

  it("surfaces BetterC0de run's message-or-command requirement", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-run",
      ["--format", "json", "--terminal"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("BetterC0de run requires a message or `--command`")
    expect(output).not.toContain("--terminal")
  })

  it("renders BetterC0de server and ACP guidance", () => {
    const serve = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-serve",
      ["--port", "4096"],
      { projectPath: "/repo" }
    )
    const acp = buildBetterC0deRuntimeEntrypointOutput("/betterc0de-acp", [], {
      projectPath: "/repo",
    })

    expect(serve).toContain("# BetterC0de Serve")
    expect(serve).toContain("BETTERC0DE_SERVER_PASSWORD")
    expect(serve).toContain("`--mdns-domain`")
    expect(serve).toContain("`--cors <origin>`")
    expect(acp).toContain("# BetterC0de ACP")
    expect(acp).toContain("Agent Client Protocol")
    expect(acp).toContain("`--cwd`")
  })

  it("renders BetterC0de attach guidance", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-attach",
      ["http://localhost:4096", "--session", "ses_123", "--fork"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de Attach")
    expect(output).toContain("Compatibility reference: `betterc0de attach`")
    expect(output).toContain(
      "betterc0de attach http://localhost:4096 --session ses_123 --fork"
    )
    expect(output).toContain("`--fork` is only valid")
    expect(output).toContain("`--username`")
  })

  it("surfaces BetterC0de attach URL validation", () => {
    const missing = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-attach",
      ["--session", "ses_123"],
      { projectPath: "/repo" }
    )
    const invalid = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-attach",
      ["server", "--session", "ses_123"],
      { projectPath: "/repo" }
    )

    expect(missing).toContain("BetterC0de attach requires a server URL")
    expect(invalid).toContain(
      "BetterC0de attach URL must be a valid `http://` or `https://` URL"
    )
  })

  it("surfaces BetterC0de fork validation for TUI entrypoints", () => {
    const output = buildBetterC0deRuntimeEntrypointOutput(
      "/betterc0de-tui",
      ["--fork"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--fork` requires `--continue` or `--session`")
  })
})

describe("buildBetterC0deMaintenanceOutput", () => {
  it("renders BetterC0de upgrade and uninstall guidance", () => {
    const upgrade = buildBetterC0deMaintenanceOutput("/betterc0de-upgrade", [
      "v1.2.3",
      "--method",
      "brew",
      "--terminal",
    ])
    const uninstall = buildBetterC0deMaintenanceOutput(
      "/betterc0de-uninstall",
      ["--dry-run", "--keep-data", "--force"]
    )

    expect(upgrade).toContain("# BetterC0de Upgrade")
    expect(upgrade).toContain("betterc0de upgrade v1.2.3 --method brew")
    expect(upgrade).not.toContain("--terminal")
    expect(upgrade).toContain("command prefilled")
    expect(upgrade).toContain("Supported methods include")
    expect(uninstall).toContain("# BetterC0de Uninstall")
    expect(uninstall).toContain(
      "betterc0de uninstall --dry-run --keep-data --force"
    )
    expect(uninstall).toContain("`--force` skips")
  })

  it("renders BetterC0de generate, completion, and database guidance", () => {
    const generate = buildBetterC0deMaintenanceOutput(
      "/betterc0de-generate",
      []
    )
    const completion = buildBetterC0deMaintenanceOutput(
      "/betterc0de-completion",
      ["zsh", "--terminal"]
    )
    const db = buildBetterC0deMaintenanceOutput("/betterc0de-db", ["path"])
    const dbPathAlias = buildBetterC0deMaintenanceOutput(
      "/betterc0de-db-path",
      []
    )
    const dbMigrateAlias = buildBetterC0deMaintenanceOutput(
      "/betterc0de-db-migrate",
      ["--terminal"]
    )
    const dbQueryAlias = buildBetterC0deMaintenanceOutput("/db.query", [
      "select 1",
      "--format=json",
      "--terminal",
    ])
    const dbShell = buildBetterC0deMaintenanceOutput("/betterc0de-db", [])
    const dbFormatOnlyShell = buildBetterC0deMaintenanceOutput(
      "/betterc0de-db",
      ["--format", "json"]
    )

    expect(generate).toContain("# BetterC0de Generate")
    expect(generate).toContain("OpenAPI generation")
    expect(completion).toContain("# BetterC0de Completion")
    expect(completion).toContain("betterc0de completion")
    expect(completion).toContain("shell completion")
    expect(completion).toContain("Selected shell: `zsh`")
    expect(completion).toContain("~/.zsh/completions/_betterc0de")
    expect(completion).not.toContain("--terminal")
    expect(completion).not.toContain("betterc0de completion zsh")
    expect(db).toContain("# BetterC0de DB")
    expect(db).toContain("betterc0de db path")
    expect(dbPathAlias).toContain("betterc0de db path")
    expect(dbMigrateAlias).toContain("betterc0de db migrate")
    expect(dbMigrateAlias).not.toContain("betterc0de db migrate --terminal")
    expect(dbQueryAlias).toContain('betterc0de db "select 1" --format=json')
    expect(dbQueryAlias).toContain("read-only compatibility SQLite query")
    expect(dbQueryAlias).not.toContain(
      'betterc0de db "select 1" --format=json --terminal'
    )
    expect(dbShell).toContain("interactive `sqlite3` shell")
    expect(dbFormatOnlyShell).toContain("interactive `sqlite3` shell")
    expect(dbFormatOnlyShell).not.toContain("read-only BetterC0de SQLite query")
  })

  it("validates BetterC0de maintenance option choices", () => {
    const upgrade = buildBetterC0deMaintenanceOutput("/betterc0de-upgrade", [
      "--method",
      "apt",
    ])
    const db = buildBetterC0deMaintenanceOutput("/betterc0de-db", [
      "select 1",
      "--format",
      "xml",
    ])
    const missingDbFormat = buildBetterC0deMaintenanceOutput("/betterc0de-db", [
      "select 1",
      "--format",
    ])
    const unsupportedPathFormat = buildBetterC0deMaintenanceOutput(
      "/betterc0de-db-path",
      ["--format", "json"]
    )
    const uninstall = buildBetterC0deMaintenanceOutput(
      "/betterc0de-uninstall",
      ["--force=maybe"]
    )
    const completion = buildBetterC0deMaintenanceOutput(
      "/betterc0de-completion",
      ["xonsh"]
    )

    expect(upgrade).toContain("## Validation")
    expect(upgrade).toContain("`--method` must be one of")
    expect(db).toContain("`--format` must be `json` or `tsv`")
    expect(missingDbFormat).toContain("--format requires a value")
    expect(unsupportedPathFormat).toContain(
      "`--format` is only valid for BetterC0de DB queries"
    )
    expect(uninstall).toContain("`--force` must be true or false")
    expect(completion).toContain("Completion shell must be one of")
  })
})

describe("buildBetterC0deSessionCliOutput", () => {
  it("renders BetterC0de session list terminal guidance", () => {
    const output = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-list",
      ["--format", "json", "--max-count", "5", "--terminal"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de Session List")
    expect(output).toContain(
      "Compatibility reference: `betterc0de session list`"
    )
    expect(output).toContain(
      "betterc0de session list --format json --max-count 5"
    )
    expect(output).not.toContain("--terminal")
    expect(output).toContain("matching BetterC0de compatibility CLI")
    expect(output).toContain("command prefilled")
  })

  it("renders BetterC0de session delete terminal guidance", () => {
    const output = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-delete",
      ["ses_123"],
      { projectPath: "/repo" }
    )

    expect(output).toContain("# BetterC0de Session Delete")
    expect(output).toContain(
      "Compatibility reference: `betterc0de session delete`"
    )
    expect(output).toContain("betterc0de session delete ses_123")
    expect(output).toContain("the compatibility CLI's own session storage")
    expect(output).toContain("/delete-session --yes")
  })

  it("validates BetterC0de session list and delete args", () => {
    const list = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-list",
      ["--format", "xml", "--max-count", "0"],
      { projectPath: "/repo" }
    )
    const missingListValues = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-list",
      ["--format", "--max-count"],
      { projectPath: "/repo" }
    )
    const missingDeleteId = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-delete",
      [],
      { projectPath: "/repo" }
    )

    expect(list).toContain("## Validation")
    expect(list).toContain("`--format` must be `table` or `json`")
    expect(list).toContain("`--max-count` must be a positive integer")
    expect(missingListValues).toContain("--format requires a value")
    expect(missingListValues).toContain("--max-count requires a value")
    expect(missingDeleteId).toContain(
      "BetterC0de session delete requires a session ID"
    )
  })

  it("strips BetterC0de session subcommands before raw CLI routing", () => {
    expect(
      stripBetterC0deSessionSlashSubcommand(["list", "--format", "json"])
    ).toEqual(["--format", "json"])
    expect(
      stripBetterC0deSessionSlashSubcommand(["--terminal", "delete", "ses_123"])
    ).toEqual(["--terminal", "ses_123"])
    expect(stripBetterC0deSessionSlashSubcommand(["current"])).toEqual([
      "current",
    ])
  })

  it("does not duplicate BetterC0de session subcommands in CLI output", () => {
    const output = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-delete",
      stripBetterC0deSessionSlashSubcommand([
        "delete",
        "ses_123",
        "--terminal",
      ]),
      { projectPath: "/repo" }
    )

    expect(output).toContain("betterc0de session delete ses_123")
    expect(output).not.toContain("betterc0de session delete delete")
    expect(output).not.toContain("--terminal")
  })
})

describe("app.log parity", () => {
  it("parses BetterC0de-compatible app.log payloads", () => {
    const parsed = parseAppLogCommandArgs([
      "warn",
      "Provider",
      "latency",
      "high",
      "--service",
      "provider-runtime",
      "--extra",
      '{"provider":"codex","ms":1200}',
    ])

    expect(parsed).toEqual({
      payload: {
        service: "provider-runtime",
        level: "warn",
        message: "Provider latency high",
        extra: { provider: "codex", ms: 1200 },
      },
    })
  })

  it("renders BetterC0de app.log guidance and validation errors", () => {
    const ok = buildAppLogOutput(
      parseAppLogCommandArgs(["--level=error", "Disk full"])
    )
    const invalid = buildAppLogOutput(
      parseAppLogCommandArgs(["--extra", "[]", "hello"])
    )

    expect(ok).toContain("Compatibility reference: `app.log` / `POST /log`")
    expect(ok).toContain("| Level | `error` |")
    expect(ok).toContain("Disk full")
    expect(invalid).toContain("`--extra` must be a JSON object.")
  })
})

describe("buildBetterC0deAuthControlOutput", () => {
  it("renders safe BetterC0de auth.set and auth.remove guidance", () => {
    const authSet = buildBetterC0deAuthControlOutput("/auth.set", [
      "--provider",
      "anthropic",
    ])
    const authRemove = buildBetterC0deAuthControlOutput("/auth-remove", [
      "openai",
    ])

    expect(authSet).toContain(
      "Compatibility reference: `auth.set` / `PUT /auth/:providerID`"
    )
    expect(authSet).toContain("| Provider | `anthropic` |")
    expect(authSet).toContain("never accepts raw provider credentials in chat")
    expect(authSet).toContain("betterc0de providers login --provider <id>")
    expect(authRemove).toContain(
      "Compatibility reference: `auth.remove` / `DELETE /auth/:providerID`"
    )
    expect(authRemove).toContain("| Provider | `openai` |")
    expect(authRemove).toContain("explicit provider logout flow")
  })
})

describe("buildBetterC0deInternalRouteOutput", () => {
  it("maps current BetterC0de terminal UI bus route ids to BetterC0de equivalents", () => {
    const append = buildBetterC0deInternalRouteOutput("/tui.prompt.append", [
      "hello",
    ])
    const command = buildBetterC0deInternalRouteOutput("/tui.command.execute", [
      "session.compact",
    ])
    const toast = buildBetterC0deInternalRouteOutput("/tui.toast.show", [
      "--variant",
      "info",
      "Saved",
    ])
    const select = buildBetterC0deInternalRouteOutput("/tui.session.select", [
      "ses_123",
    ])

    expect(append).toContain("Route: `tui.prompt.append`")
    expect(append).toContain("/prompt-paste")
    expect(command).toContain("Route: `tui.command.execute`")
    expect(command).toContain("`/compact`")
    expect(toast).toContain("local notification/toast UI")
    expect(select).toContain("`/resume <session-id>`")
  })

  it("keeps legacy BetterC0de terminal UI route ids reserved", () => {
    const output = buildBetterC0deInternalRouteOutput("/tui.executeCommand", [
      "prompt.clear",
    ])

    expect(output).toContain("Route: `tui.executeCommand`")
    expect(output).toContain("`/prompt.clear`")
    expect(output).toContain("not run from chat")
  })

  it("maps BetterC0de terminal UI command ids through the keybind catalog", () => {
    const docs = buildBetterC0deInternalRouteOutput("/tui.command.execute", [
      "docs.open",
    ])
    const connect = buildBetterC0deInternalRouteOutput("/tui.command.execute", [
      "provider.connect",
    ])
    const whichKey = buildBetterC0deInternalRouteOutput(
      "/tui.command.execute",
      ["which-key.page.down"]
    )
    const variant = buildBetterC0deInternalRouteOutput("/tui.command.execute", [
      "variant.list",
    ])
    const inlineCommand = buildBetterC0deInternalRouteOutput(
      "/tui.command.execute",
      ["--command=docs.open"]
    )
    const namedCommand = buildBetterC0deInternalRouteOutput(
      "/tui.command.execute",
      ["--name", "provider.connect"]
    )

    expect(docs).toContain("`/docs`")
    expect(connect).toContain("`/connect`")
    expect(whichKey).toContain("`/which-key`")
    expect(variant).toContain("`/variants`")
    expect(inlineCommand).toContain("`/docs`")
    expect(namedCommand).toContain("`/connect`")
  })

  it("parses BetterC0de tui.publish events into BetterC0de equivalents", () => {
    const command = buildBetterC0deInternalRouteOutput("/tui.publish", [
      "--type=tui.command.execute",
      "--command=session.compact",
    ])
    const append = buildBetterC0deInternalRouteOutput("/tui.publish", [
      "tui.prompt.append",
      "hello",
      "world",
    ])
    const toast = buildBetterC0deInternalRouteOutput("/tui.publish", [
      "--message",
      "Saved",
      "--variant",
      "success",
    ])
    const select = buildBetterC0deInternalRouteOutput("/tui.publish", [
      '{"type":"tui.session.select","properties":{"sessionID":"ses_123"}}',
    ])

    expect(command).toContain("# BetterC0de Terminal Event Publish")
    expect(command).toContain("| Event | `tui.command.execute` |")
    expect(command).toContain("`/compact`")
    expect(append).toContain("| Event | `tui.prompt.append` |")
    expect(append).toContain("`/prompt-paste hello world`")
    expect(toast).toContain("| Event | `tui.toast.show` |")
    expect(toast).toContain("local notification/toast UI")
    expect(select).toContain("| Event | `tui.session.select` |")
    expect(select).toContain("`/resume ses_123`")
  })

  it("keeps BetterC0de keybind-only command ids visible instead of falling back generically", () => {
    const dialog = buildBetterC0deInternalRouteOutput("/tui.command.execute", [
      "dialog.select.prev",
    ])
    const nativeInput = buildBetterC0deInternalRouteOutput(
      "/tui.command.execute",
      ["--command=input.move.left"]
    )

    expect(dialog).toContain(
      "Settings > Compatibility > BetterC0de Default Keybinds"
    )
    expect(dialog).toContain("`dialog.select.prev`")
    expect(dialog).toContain("Move to previous dialog item")
    expect(nativeInput).toContain("native Native textarea")
    expect(nativeInput).toContain("`input.move.left`")
  })

  it("renders project.initGit as an explicit terminal mutation flow", () => {
    const output = buildBetterC0deInternalRouteOutput("/project.initGit", [
      "--terminal",
    ])

    expect(output).toContain("# BetterC0de Project Git Init")
    expect(output).toContain(
      "Compatibility reference: `project.initGit` / `POST /project/git/init`"
    )
    expect(output).toContain("git init")
    expect(output).toContain("terminal panel")
    expect(output).toContain("Press Enter there")
  })
})

describe("buildBetterC0deSyncRouteOutput", () => {
  const syncThread = thread({
    id: "sync-thread",
    title: "Sync Thread",
    projectPath: "/repo",
    messages: [message({ role: "user", content: "hello" })],
  })
  const syncActivity = activity({
    id: "activity-1",
    threadId: "sync-thread",
    kind: "tool.completed",
    tone: "tool",
    summary: "Ran tool",
  })

  it("renders local sync history snapshots with cursor support", () => {
    const output = buildBetterC0deSyncRouteOutput(
      "/sync.history.list",
      ['{"sync-thread":1}'],
      {
        threads: [syncThread],
        activeThreadId: "sync-thread",
        activitiesByThread: { "sync-thread": [syncActivity] },
      }
    )
    const json = buildBetterC0deSyncRouteOutput(
      "/sync.history.list",
      ["--json"],
      {
        threads: [syncThread],
        activeThreadId: "sync-thread",
        activitiesByThread: { "sync-thread": [syncActivity] },
      }
    )

    expect(output).toContain("# BetterC0de Sync History")
    expect(output).toContain("Cursor aggregates: 1")
    expect(output).toContain("activity.tool.completed")
    expect(output).not.toContain("session.updated")
    expect(json).toContain('"aggregate_id": "sync-thread"')
    expect(json).toContain('"type": "session.updated"')
  })

  it("renders sync start, replay, and steal compatibility outputs", () => {
    const snapshot = {
      threads: [syncThread],
      activeThreadId: "sync-thread",
      activitiesByThread: { "sync-thread": [syncActivity] },
      activeThread: { projectPath: "/repo" },
    }
    const start = buildBetterC0deSyncRouteOutput("/sync.start", [], snapshot)
    const replay = buildBetterC0deSyncRouteOutput(
      "/sync.replay",
      [
        '{"directory":"/repo","events":[{"id":"e1","aggregateID":"sync-thread","seq":1,"type":"session.updated","data":{}}]}',
      ],
      snapshot
    )
    const steal = buildBetterC0deSyncRouteOutput(
      "/sync.steal",
      ["sync-thread"],
      snapshot
    )

    expect(start).toContain("# BetterC0de Sync Start")
    expect(start).toContain("Workspace sessions: 1")
    expect(replay).toContain("# BetterC0de Sync Replay")
    expect(replay).toContain("Events: 1")
    expect(replay).toContain("/import <file>")
    expect(steal).toContain("# BetterC0de Sync Steal")
    expect(steal).toContain("Matched BetterC0de thread")
    expect(steal).toContain("/workspace-new")
  })
})

describe("BetterC0de remaining route compatibility outputs", () => {
  const workspaceThread = thread({
    id: "workspace-thread",
    title: "Workspace Thread",
    projectName: "BetterC0de",
    projectPath: "/repo",
    worktreePath: "/repo-worktree",
  })

  it("renders workspace sync-list and warp compatibility output", () => {
    const syncList = buildBetterC0deWorkspaceRouteOutput(
      "/experimental.workspace.syncList",
      [],
      {
        threads: [workspaceThread],
        activeThreadId: "workspace-thread",
        activeThread: { worktreePath: "/repo-worktree" },
      }
    )
    const warp = buildBetterC0deWorkspaceRouteOutput(
      "/experimental.workspace.warp",
      ['{"id":"wrk_123","sessionID":"workspace-thread","copyChanges":true}'],
      {
        threads: [workspaceThread],
        activeThreadId: "workspace-thread",
      }
    )

    expect(syncList).toContain("# BetterC0de Workspace Sync List")
    expect(syncList).toContain("experimental.workspace.syncList")
    expect(syncList).toContain("`/repo-worktree`")
    expect(warp).toContain("# BetterC0de Workspace Warp")
    expect(warp).toContain("`wrk_123`")
    expect(warp).toContain("Matched BetterC0de thread")
    expect(warp).toContain("/workspace-new")
  })

  it("renders lifecycle and TUI control compatibility output", () => {
    const lifecycle = buildBetterC0deLifecycleRouteOutput("/global.dispose", {
      projectPath: "/repo",
    })
    const next = buildBetterC0deTuiControlRouteOutput("/tui.control.next", [])
    const response = buildBetterC0deTuiControlRouteOutput(
      "/tui.control.response",
      ['{"ok":true}']
    )

    expect(lifecycle).toContain("# BetterC0de Lifecycle")
    expect(lifecycle).toContain("global.dispose")
    expect(lifecycle).toContain("/exit")
    expect(next).toContain("# BetterC0de Terminal Control")
    expect(next).toContain("no external TUI request queue")
    expect(response).toContain('Response payload: `{"ok":true}`')
  })
})

describe("buildBetterC0deDebugUtilityOutput", () => {
  it("renders BetterC0de debug config as JSON preview", () => {
    const output = buildBetterC0deDebugConfigOutput(
      [
        {
          key: "shell",
          label: "Shell",
          kind: "scalar",
          value: "zsh",
          sourcePath: "betterc0de.jsonc#shell",
        },
        {
          key: "snapshot",
          label: "Snapshots",
          kind: "toggle",
          value: "disabled",
          sourcePath: "betterc0de.jsonc#snapshot",
        },
        {
          key: "disabled_providers",
          label: "Disabled providers",
          kind: "list",
          value: "qwen, deepseek",
          sourcePath: "betterc0de.jsonc#disabled_providers",
        },
        {
          key: "tool_output",
          label: "Tool output",
          kind: "object",
          value: "max_lines=2000",
          sourcePath: "betterc0de.jsonc#tool_output",
        },
        {
          key: "tool_output.max_lines",
          label: "Tool output max lines",
          kind: "scalar",
          value: "2000",
          sourcePath: "betterc0de.jsonc#tool_output.max_lines",
        },
        {
          key: "theme",
          label: "TUI theme",
          kind: "scalar",
          value: "catppuccin",
          sourcePath: ".betterc0de/tui.jsonc#theme",
        },
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug config`"
    )
    expect(output).toContain('"shell": "zsh"')
    expect(output).toContain('"snapshot": false')
    expect(output).toContain('"disabled_providers": [')
    expect(output).toContain('"max_lines": 2000')
    expect(output).not.toContain("catppuccin")
    expect(output).toContain("Add `--terminal`")
  })

  it("marks BetterC0de debug config terminal handoff", () => {
    const output = buildBetterC0deDebugConfigOutput(
      [
        {
          key: "model",
          label: "Default model",
          kind: "scalar",
          value: "openai/gpt-5",
          sourcePath: "betterc0de.jsonc#model",
        },
      ],
      thread({ projectPath: "/repo" }),
      ["--terminal"]
    )

    expect(output).toContain("Opened the integrated terminal")
    expect(output).toContain("betterc0de debug config")
  })

  it("renders BetterC0de startup and v2 debug guidance", () => {
    const startup = buildBetterC0deDebugUtilityOutput("/debug-startup", [])
    const v2 = buildBetterC0deDebugUtilityOutput("/debug.v2", [])

    expect(startup).toContain("# BetterC0de Debug Startup")
    expect(startup).toContain("betterc0de debug startup")
    expect(startup).toContain("renderer uptime marker")
    expect(v2).toContain("# BetterC0de Debug V2")
    expect(v2).toContain("/catalog")
  })

  it("renders BetterC0de scrap and wait debug guidance", () => {
    const scrap = buildBetterC0deDebugUtilityOutput("/debug-scrap", [])
    const wait = buildBetterC0deDebugUtilityOutput("/debug.wait", [])
    const terminal = buildBetterC0deDebugUtilityOutput("/debug.wait", [
      "--terminal",
    ])

    expect(scrap).toContain("known BetterC0de compatibility projects")
    expect(wait).toContain("Sleeps indefinitely")
    expect(wait).toContain("does not start an endless wait process")
    expect(terminal).toContain("betterc0de debug wait")
    expect(terminal).not.toContain("--terminal")
    expect(terminal).toContain("terminal panel")
  })
})

describe("hydrateProjectCommandTemplate", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("replaces compatibility command argument placeholders", () => {
    expect(
      hydrateProjectCommandTemplate(
        "Review $1 against $2. All: $ARGUMENTS",
        'feature/main "origin/main" --strict'
      )
    ).toBe(
      'Review feature/main against origin/main --strict. All: feature/main "origin/main" --strict'
    )
  })

  it("drops missing positional arguments", () => {
    expect(hydrateProjectCommandTemplate("Run $1 $3", "build")).toBe(
      "Run build"
    )
  })

  it("uses the compatibility CLI's last positional placeholder as the rest argument", () => {
    expect(
      hydrateProjectCommandTemplate(
        "Review $1 against $2",
        "feature main --strict"
      )
    ).toBe("Review feature against main --strict")
  })

  it("does not rewrite placeholder-like text inside $ARGUMENTS", () => {
    expect(
      hydrateProjectCommandTemplate("Args: $ARGUMENTS", "literal $1")
    ).toBe("Args: literal $1")
  })

  it("hydrates BetterC0de shell blocks through the provided runner", async () => {
    const result = await hydrateProjectCommandShellBlocks(
      "Status:\n!`git status --short`\nDone",
      "/repo",
      "allow-edits",
      async (command, cwd, level) =>
        `${command} @ ${cwd} with ${level}\nM file.ts`
    )

    expect(result).toBe(
      "Status:\ngit status --short @ /repo with allow-edits\nM file.ts\nDone"
    )
  })

  it("turns rejected shell blocks into explicit prompt text", async () => {
    const result = await hydrateProjectCommandShellBlocks(
      "Run !`npm test`",
      "/repo",
      "ask-on-edit",
      async () => {
        throw new Error("requires approval")
      }
    )

    expect(result).toContain("Shell command not executed: requires approval")
    expect(result).toContain("active permission level")
  })

  it("writes compatibility command config entries in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "command": { "old": { "template": "Old" } } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectCommandConfigOutput(
      [
        "--config-only",
        "review",
        "--template",
        "Review $ARGUMENTS",
        "--description",
        "Review code",
        "--agent",
        "build",
        "--model",
        "anthropic/claude-sonnet-4",
        "--subtask",
        "true",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Project Commands")
    expect(output).toContain("command.review")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "command": {\n    "old": {\n      "template": "Old"\n    },\n    "review": {\n      "template": "Review $ARGUMENTS",\n      "description": "Review code",\n      "agent": "build",\n      "model": "anthropic/claude-sonnet-4",\n      "subtask": true\n    }\n  }\n}\n'
      )
    )
  })
})

describe("projectCommandChatModeOverride", () => {
  it("maps BetterC0de primary command agents to BetterC0de chat modes", () => {
    expect(projectCommandChatModeOverride({ agent: "plan" })).toBe("plan")
    expect(projectCommandChatModeOverride({ agent: "ask" })).toBe("ask")
    expect(projectCommandChatModeOverride({ agent: "security" })).toBe(
      "security"
    )
    expect(projectCommandChatModeOverride({ agent: "debug" })).toBe("debug")
  })

  it("leaves normal build and custom agents as command prompt metadata only", () => {
    expect(projectCommandChatModeOverride({ agent: "build" })).toBeUndefined()
    expect(
      projectCommandChatModeOverride({ agent: "frontend" })
    ).toBeUndefined()
    expect(projectCommandChatModeOverride({})).toBeUndefined()
  })
})

describe("resolveProjectCommandModelOverride", () => {
  const codex: UiProvider = {
    id: "codex",
    name: "Codex",
    logo: "",
    providerKind: "codex",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT 5.5",
        context: "400K",
        tier: "Flagship",
      },
    ],
  }
  const betterc0de: UiProvider = {
    id: "betterc0de",
    name: "BetterC0de",
    logo: "",
    providerKind: "betterc0de",
    models: [
      {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet",
        context: "200K",
        tier: "Runtime",
      },
    ],
  }

  it("keeps command models on the selected BetterC0de compatibility provider", () => {
    expect(
      resolveProjectCommandModelOverride(
        "anthropic/claude-sonnet-4-6",
        betterc0de,
        [betterc0de, codex]
      )
    ).toEqual({ provider: betterc0de, modelId: "anthropic/claude-sonnet-4-6" })
  })

  it("routes BetterC0de-compatible provider/model command overrides through BetterC0de", () => {
    expect(
      resolveProjectCommandModelOverride("anthropic/claude-sonnet-4-6", codex, [
        codex,
        betterc0de,
      ])
    ).toEqual({ provider: betterc0de, modelId: "anthropic/claude-sonnet-4-6" })
  })

  it("uses a direct provider only for exact model ids", () => {
    expect(
      resolveProjectCommandModelOverride("gpt-5.5", codex, [codex])
    ).toEqual({ provider: codex, modelId: "gpt-5.5" })
    expect(
      resolveProjectCommandModelOverride("anthropic/claude", codex, [codex])
    ).toBeNull()
  })
})

describe("buildProjectCommandAgentInstructions", () => {
  it("includes BetterC0de agent metadata as command-turn constraints", () => {
    const output = buildProjectCommandAgentInstructions({
      id: "reviewer",
      name: "Reviewer",
      description: "Review changes",
      prompt: "Review carefully",
      enabled: true,
      mode: "subagent",
      model: "anthropic/claude-sonnet-4-6",
      variant: "high",
      steps: 7,
      tools: { read: true, write: false },
      optionKeys: ["effort"],
      permissions: [
        {
          permission: "edit",
          pattern: "*",
          action: "deny",
          sourcePath: ".betterc0de/agent/reviewer.md#tools.write",
        },
      ],
      sourcePath: ".betterc0de/agent/reviewer.md",
    })

    expect(output).toContain("Treat the metadata as constraints")
    expect(output).toContain("Model: anthropic/claude-sonnet-4-6")
    expect(output).toContain("Tools: read: enabled, write: disabled")
    expect(output).toContain("Permissions: edit:*=deny")
    expect(output).toContain("```")
    expect(output).toContain("Review carefully")
  })
})

describe("buildProjectPermissionsOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("keeps global and agent-scoped BetterC0de permissions separate", () => {
    const output = buildProjectPermissionsOutput(
      [
        {
          permission: "bash",
          pattern: "npm test",
          action: "allow",
          sourcePath: ".betterc0de/betterc0de.json#permission.bash.npm test",
        },
      ],
      thread({ projectPath: "/repo" }),
      "ask-on-edit",
      [
        {
          id: "reviewer",
          name: "Reviewer",
          description: "",
          prompt: "",
          enabled: true,
          source: "betterc0de",
          sourcePath: ".betterc0de/agent/reviewer.md",
          permissions: [
            {
              permission: "edit",
              pattern: "*",
              action: "deny",
              sourcePath: ".betterc0de/agent/reviewer.md#tools.write",
            },
          ],
        },
      ]
    )

    expect(output).toContain("## Global Project Rules")
    expect(output).toContain("| `bash` | `npm test` | **allow** |")
    expect(output).toContain("## Agent-Scoped Rules")
    expect(output).toContain("| `reviewer` | `edit` | `*` | **deny** |")
    expect(output).toContain("only apply when that agent is selected")
  })

  it("still surfaces agent-scoped permissions when no global config exists", () => {
    const output = buildProjectPermissionsOutput(
      [],
      thread({ projectPath: "/repo" }),
      "read-only",
      [
        {
          id: "planner",
          name: "Planner",
          description: "",
          prompt: "",
          enabled: true,
          permissions: [
            {
              permission: "read",
              pattern: "*",
              action: "allow",
              sourcePath: ".betterc0de/agent/planner.md#tools.read",
            },
          ],
        },
      ]
    )

    expect(output).toContain(
      "No top-level BetterC0de `permission` config found"
    )
    expect(output).toContain("| `planner` | `read` | `*` | **allow** |")
  })

  it("writes BetterC0de compatibility project permission config in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "permission": { "edit": "deny" } }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectPermissionsConfigOutput(
      [
        "--config-only",
        "--permission",
        "bash",
        "--pattern",
        "npm test",
        "--action",
        "ask",
      ],
      { projectPath: "/repo" }
    )

    expect(output).toContain("Project Permissions")
    expect(output).toContain("permission.bash.npm test")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "permission": {\n    "edit": "deny",\n    "bash": {\n      "npm test": "ask"\n    }\n  }\n}\n'
      )
    )
  })
})

describe("buildProjectProvidersOutput", () => {
  it("renders BetterC0de compatibility provider allow/block lists and model override details", () => {
    const output = buildProjectProvidersOutput(
      {
        defaultModel: "custom/fast-model",
        smallModel: "custom/small-model",
        enabledProviders: ["custom"],
        disabledProviders: ["legacy"],
        authAccounts: [
          {
            serviceId: "custom",
            sourcePath: "~/.local/share/betterc0de/auth-v2.json",
            accountCount: 1,
            credentialTypes: ["api"],
            activeCredentialType: "api",
            metadataKeys: ["org"],
          },
        ],
        providers: [
          {
            id: "custom",
            name: "Custom Provider",
            sourcePath: "betterc0de.jsonc#provider.custom",
            api: "openai-compatible",
            npm: "@ai-sdk/openai-compatible",
            env: ["CUSTOM_API_KEY"],
            whitelist: ["fast-model"],
            blacklist: ["old-model"],
            optionKeys: [
              "apiKey",
              "baseURL",
              "chunkTimeout",
              "enterpriseUrl",
              "setCacheKey",
              "timeout",
              "customFlag",
            ],
            hasApiKey: true,
            baseURL: "https://example.test/v1",
            enterpriseUrl: "https://github.example.test",
            setCacheKey: true,
            timeout: false,
            chunkTimeout: 45000,
            models: [
              {
                id: "fast-model",
                name: "Fast Model",
                family: "gpt",
                releaseDate: "2026-01-01",
                sourcePath:
                  "betterc0de.jsonc#provider.custom.models.fast-model",
                attachment: true,
                reasoning: true,
                temperature: true,
                toolCall: true,
                interleaved: true,
                interleavedField: "reasoning_content",
                experimental: false,
                status: "stable",
                contextLimit: 128000,
                inputLimit: 64000,
                outputLimit: 16000,
                inputModalities: ["text", "image"],
                outputModalities: ["text"],
                cost: {
                  input: 0.000001,
                  output: 0.000002,
                  cache_read: 0.0000001,
                },
                contextOver200kCost: {
                  input: 0.000003,
                  output: 0.000004,
                },
                providerApi: "responses",
                providerNpm: "@ai-sdk/custom",
                optionKeys: ["temperature"],
                headerKeys: ["X-Project"],
                variants: ["fast", "legacy"],
                disabledVariants: ["legacy"],
              },
            ],
          },
        ],
      },
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Allowlist")
    expect(output).toContain("Blocklist")
    expect(output).toContain(
      "apiKey(masked), baseURL https://example.test/v1, enterpriseUrl https://github.example.test, setCacheKey true, timeout disabled, chunkTimeout 45000ms, customFlag"
    )
    expect(output).toContain(
      "| `custom/fast-model` | Fast Model | gpt | 2026-01-01 | stable |"
    )
    expect(output).toContain("interleaved:reasoning_content")
    expect(output).toContain("ctx 128000, in 64000, out 16000")
    expect(output).toContain("in text, image; out text")
    expect(output).toContain(
      "base input 0.000001, output 0.000002, cache_read 1e-7"
    )
    expect(output).toContain(">200k input 0.000003, output 0.000004")
    expect(output).toContain("api responses, npm @ai-sdk/custom")
    expect(output).toContain("temperature")
    expect(output).toContain("X-Project")
    expect(output).toContain("legacy(disabled)")
    expect(output).toContain("## BetterC0de Auth")
    expect(output).toContain("| **custom** | 1 | api | api | org |")
    expect(output).not.toContain("secret")
  })
})

describe("buildProjectProviderConfigOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("writes non-secret BetterC0de compatibility project provider metadata", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--provider-api-id",
        "custom-upstream",
        "--name",
        "Custom Provider",
        "--api",
        "openai-compatible",
        "--npm",
        "@ai-sdk/openai-compatible",
        "--env",
        "CUSTOM_API_KEY",
        "--whitelist",
        "fast-model",
        "--blacklist",
        "legacy-model",
        "--base-url",
        "https://example.test/v1",
        "--enterprise-url",
        "https://github.example.test",
        "--set-cache-key",
        "false",
        "--timeout",
        "false",
        "--chunk-timeout",
        "45000",
        "--option",
        "customFlag=true",
        "--model",
        "fast-model",
        "--model-api-id",
        "fast-model-v2",
        "--model-name",
        "Fast Model",
        "--model-family",
        "gpt",
        "--model-release-date",
        "2026-01-01",
        "--model-status",
        "active",
        "--model-context",
        "128000",
        "--model-input",
        "64000",
        "--model-output",
        "16000",
        "--model-attachment",
        "true",
        "--model-reasoning",
        "true",
        "--model-temperature",
        "false",
        "--model-tool-call",
        "true",
        "--model-interleaved",
        "reasoning_content",
        "--model-experimental",
        "true",
        "--model-provider-api",
        "responses",
        "--model-provider-npm",
        "@ai-sdk/custom-model",
        "--model-option",
        "effort=high",
        "--model-option",
        "maxTokens=4096",
        "--model-header",
        "X-Project=enabled",
        "--model-input-modalities",
        "text,image",
        "--model-output-modalities",
        "text",
        "--model-cost-input",
        "0.000001",
        "--model-cost-output",
        "0.000002",
        "--model-cache-read",
        "0.0000001",
        "--model-cache-write",
        "0.0000002",
        "--model-context-over-200k-cost-input",
        "0.000003",
        "--model-context-over-200k-cost-output",
        "0.000004",
        "--model-context-over-200k-cache-read",
        "0.0000005",
        "--model-context-over-200k-cache-write",
        "0.0000006",
        "--model-variant",
        "fast",
        "--model-disabled-variant",
        "legacy",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Provider: `custom`")
    expect(output).toContain("Model: `fast-model`")
    expect(output).toContain(
      "Provider options: api id custom-upstream, baseURL https://example.test/v1, enterpriseUrl https://github.example.test, setCacheKey false, timeout disabled, chunkTimeout 45000ms, custom options customFlag"
    )
    expect(output).toContain(
      "Model metadata: api id fast-model-v2, family gpt, release 2026-01-01, status active, context 128000, input 64000, output 16000"
    )
    expect(output).toContain("input modalities text/image")
    expect(output).toContain("output modalities text")
    expect(output).toContain("cost in 0.000001 out 0.000002")
    expect(output).toContain(">200k cost in 0.000003 out 0.000004")
    expect(output).toContain("provider api responses")
    expect(output).toContain("provider npm @ai-sdk/custom-model")
    expect(output).toContain("options effort, maxTokens")
    expect(output).toContain("headers X-Project")
    expect(output).toContain("interleaved reasoning_content")
    expect(output).toContain("variants fast/legacy(disabled)")
    expect(output).toContain("reasoning true")
    expect(output).toContain("temperature false")
    expect(output).toContain("tool_call true")
    expect(output).toContain("No API keys")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      expect.stringContaining('"custom"')
    )
    const contents = writeFileMock.mock.calls[0]?.[2] ?? ""
    const writtenConfig = JSON.parse(contents) as {
      provider: {
        custom: {
          id?: string
          models?: Record<string, { id?: string }>
        }
      }
    }
    expect(writtenConfig.provider.custom.id).toBe("custom-upstream")
    expect(writtenConfig.provider.custom.models?.["fast-model"]?.id).toBe(
      "fast-model-v2"
    )
    expect(contents).toContain('"api": "openai-compatible"')
    expect(contents).toContain('"CUSTOM_API_KEY"')
    expect(contents).toContain('"options"')
    expect(contents).toContain('"baseURL": "https://example.test/v1"')
    expect(contents).toContain('"enterpriseUrl": "https://github.example.test"')
    expect(contents).toContain('"setCacheKey": false')
    expect(contents).toContain('"timeout": false')
    expect(contents).toContain('"chunkTimeout": 45000')
    expect(contents).toContain('"customFlag": true')
    expect(contents).toContain('"whitelist"')
    expect(contents).toContain('"legacy-model"')
    expect(contents).toContain('"context": 128000')
    expect(contents).toContain('"family": "gpt"')
    expect(contents).toContain('"release_date": "2026-01-01"')
    expect(contents).toContain('"status": "active"')
    expect(contents).toContain('"input": 64000')
    expect(contents).toContain('"output": 16000')
    expect(contents).toContain('"attachment": true')
    expect(contents).toContain('"reasoning": true')
    expect(contents).toContain('"temperature": false')
    expect(contents).toContain('"tool_call": true')
    expect(contents).toContain('"interleaved"')
    expect(contents).toContain('"field": "reasoning_content"')
    expect(contents).toContain('"experimental": true')
    expect(contents).toContain('"provider"')
    expect(contents).toContain('"api": "responses"')
    expect(contents).toContain('"npm": "@ai-sdk/custom-model"')
    expect(contents).toContain('"options"')
    expect(contents).toContain('"effort": "high"')
    expect(contents).toContain('"maxTokens": 4096')
    expect(contents).toContain('"headers"')
    expect(contents).toContain('"X-Project": "enabled"')
    expect(contents).toContain('"modalities"')
    expect(contents).toContain('"image"')
    expect(contents).toContain('"cost"')
    expect(contents).toContain('"input": 0.000001')
    expect(contents).toContain('"output": 0.000002')
    expect(contents).toContain('"cache_read": 1e-7')
    expect(contents).toContain('"cache_write": 2e-7')
    expect(contents).toContain('"context_over_200k"')
    expect(contents).toContain('"input": 0.000003')
    expect(contents).toContain('"output": 0.000004')
    expect(contents).toContain('"cache_read": 5e-7')
    expect(contents).toContain('"cache_write": 6e-7')
    expect(contents).toContain('"variants"')
    expect(contents).toContain('"fast": {}')
    expect(contents).toContain('"legacy"')
    expect(contents).toContain('"disabled": true')
    expect(contents).not.toContain("sk-")
  })

  it("validates missing BetterC0de compatibility project provider config values before writing", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider=",
        "--name",
        "--api",
        "--env",
        "--default-model",
        "--enable-provider",
        "--model",
        "--model-name",
        "--model-context",
        "--model-option",
        "--model-header",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--provider requires a value")
    expect(output).toContain("--name requires a value")
    expect(output).toContain("--api requires a value")
    expect(output).toContain("--env requires a value")
    expect(output).toContain("--default-model requires a value")
    expect(output).toContain("--enable-provider requires a value")
    expect(output).toContain("--model requires a value")
    expect(output).toContain("--model-name requires a value")
    expect(output).toContain("--model-context requires a value")
    expect(output).toContain("--model-option requires a value")
    expect(output).toContain("--model-header requires a value")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de compatibility project provider boolean and interleaved values before writing", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--set-cache-key",
        "maybe",
        "--model",
        "fast-model",
        "--model-attachment=maybe",
        "--model-reasoning",
        "nah",
        "--model-temperature=bad",
        "--model-tool-call",
        "later",
        "--model-interleaved",
        "banana",
        "--model-experimental=perhaps",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--set-cache-key` must be true or false")
    expect(output).toContain("`--model-attachment` must be true or false")
    expect(output).toContain("`--model-reasoning` must be true or false")
    expect(output).toContain("`--model-temperature` must be true or false")
    expect(output).toContain("`--model-tool-call` must be true or false")
    expect(output).toContain("`--model-interleaved` must be true")
    expect(output).toContain("`--model-experimental` must be true or false")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de compatibility project provider env names before writing", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--env",
        "CUSTOM_API_KEY,bad-name,lowercase",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "Invalid BetterC0de compatibility provider env name: `bad-name`"
    )
    expect(output).toContain(
      "Invalid BetterC0de compatibility provider env name: `lowercase`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de compatibility project provider ids, lists, model status, and modalities before writing", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "bad provider",
        "--provider-api-id",
        "*bad*",
        "--whitelist",
        "fast-model,bad model",
        "--disable-provider",
        "qwen,bad provider",
        "--model",
        "bad model",
        "--model-api-id",
        "*bad-model*",
        "--model-status",
        "stable",
        "--model-input-modalities",
        "text,banana",
        "--model-output-modalities",
        "xml",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--provider` must be an BetterC0de identifier")
    expect(output).toContain(
      "`--provider-api-id` must be an BetterC0de identifier"
    )
    expect(output).toContain(
      "Invalid BetterC0de id for `--whitelist`: `bad model`"
    )
    expect(output).toContain(
      "Invalid BetterC0de id for `--disable-provider`: `bad provider`"
    )
    expect(output).toContain("`--model` must be an BetterC0de identifier")
    expect(output).toContain(
      "`--model-api-id` must be an BetterC0de identifier"
    )
    expect(output).toContain(
      "`--model-status` must be `alpha`, `beta`, `deprecated`, or `active`"
    )
    expect(output).toContain(
      "Invalid BetterC0de model modality for `--model-input-modalities`: `banana`"
    )
    expect(output).toContain(
      "Invalid BetterC0de model modality for `--model-output-modalities`: `xml`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de compatibility project provider numbers, pairs, and variants before writing", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--timeout",
        "soon",
        "--chunk-timeout",
        "0",
        "--option",
        "not-a-pair",
        "--model",
        "fast-model",
        "--model-context",
        "0",
        "--model-input",
        "zero",
        "--model-output",
        "NaN",
        "--model-cost-input",
        "bad",
        "--model-cost-output",
        "Infinity",
        "--model-header",
        "Bad Header=value",
        "--model-variant",
        "bad!",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--timeout` must be a positive integer or false")
    expect(output).toContain("`--chunk-timeout` must be a positive integer")
    expect(output).toContain("`--option` must be a non-secret key=value pair")
    expect(output).toContain("`--model-context` must be a positive number")
    expect(output).toContain("`--model-input` must be a positive number")
    expect(output).toContain("`--model-output` must be a positive number")
    expect(output).toContain(
      "`--model-cost-input` must be a finite non-negative number"
    )
    expect(output).toContain(
      "`--model-cost-output` must be a finite non-negative number"
    )
    expect(output).toContain(
      "`--model-header` must be a non-secret Header-Name=value pair"
    )
    expect(output).toContain(
      "`--model-variant` must be an BetterC0de variant id"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("refuses incomplete BetterC0de compatibility project provider model limits", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--model",
        "fast-model",
        "--model-context",
        "128000",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Refusing to write an invalid BetterC0de model limit"
    )
    expect(output).toContain(
      "requires both `--model-context` and `--model-output`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de compatibility project provider model status values against schema literals", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--model",
        "fast-model",
        "--model-name",
        "Fast Model",
        "--model-status",
        "stable",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "`--model-status` must be `alpha`, `beta`, `deprecated`, or `active`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("refuses incomplete BetterC0de compatibility project provider model modalities", async () => {
    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--model",
        "fast-model",
        "--model-input-modalities",
        "text,image",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Refusing to write invalid BetterC0de model modalities"
    )
    expect(output).toContain(
      "requires both `--model-input-modalities` and `--model-output-modalities`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes BetterC0de top-level provider policy without provider metadata", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "enabled_providers": ["anthropic"], "disabled_providers": ["old"] }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--default-model",
        "anthropic/claude-sonnet-4-5",
        "--small-model",
        "openai/gpt-5-mini",
        "--enable-provider",
        "openai",
        "--disabled-providers",
        "qwen,deepseek",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("provider policy")
    expect(output).toContain("Default model: `anthropic/claude-sonnet-4-5`")
    expect(output).toContain("Small model: `openai/gpt-5-mini`")
    expect(output).toContain("Enabled providers: openai")
    expect(output).toContain("Disabled providers: qwen, deepseek")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "enabled_providers": [\n    "anthropic",\n    "openai"\n  ],\n  "disabled_providers": [\n    "qwen",\n    "deepseek"\n  ],\n  "model": "anthropic/claude-sonnet-4-5",\n  "small_model": "openai/gpt-5-mini"\n}\n'
      )
    )
  })

  it("refuses provider config secrets and avoids overwriting without force", async () => {
    const rejected = await buildProjectProviderConfigOutput(
      ["--config-only", "--provider", "custom", "--api-key", "sk-secret"],
      thread({ projectPath: "/repo" })
    )
    expect(rejected).toContain("Refusing to write provider secrets")
    expect(writeFileMock).not.toHaveBeenCalled()

    const rejectedOption = await buildProjectProviderConfigOutput(
      ["--config-only", "--provider", "custom", "--option", "apiKey=sk-secret"],
      thread({ projectPath: "/repo" })
    )
    expect(rejectedOption).toContain("Refusing to write provider secrets")
    expect(writeFileMock).not.toHaveBeenCalled()

    const rejectedHeader = await buildProjectProviderConfigOutput(
      [
        "--config-only",
        "--provider",
        "custom",
        "--model",
        "fast-model",
        "--model-header",
        "Authorization=Bearer sk-secret",
      ],
      thread({ projectPath: "/repo" })
    )
    expect(rejectedHeader).toContain("Refusing to write provider secrets")
    expect(writeFileMock).not.toHaveBeenCalled()

    readFileMock.mockResolvedValueOnce({
      content: '{ "provider": { "custom": { "name": "Existing" } } }',
      path: "/repo/betterc0de.json",
    })
    const output = await buildProjectProviderConfigOutput(
      ["--config-only", "--provider", "custom"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Provider config entry already exists")
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe("buildProviderCatalogOutput", () => {
  it("renders BetterC0de-compatible provider and model catalog metadata", () => {
    const output = buildProviderCatalogOutput(
      [
        {
          id: "betterc0de",
          name: "BetterC0de",
          logo: "",
          models: [
            {
              id: "anthropic/claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              context: "200K",
              tier: "Runtime",
              catalog: {
                providerId: "anthropic",
                modelId: "claude-sonnet-4-6",
                status: "active",
                limit: { context: 200000, output: 64000 },
                cost: { input: 3, output: 15 },
                variants: { thinking: {} },
              },
            },
          ],
          providerCatalog: [
            {
              id: "anthropic",
              name: "Anthropic",
              connected: true,
              enabled: true,
              env: ["ANTHROPIC_API_KEY"],
              endpoint: { type: "aisdk", package: "@ai-sdk/anthropic" },
            },
          ],
        },
      ],
      ["anthropic", "--verbose", "--terminal"]
    )

    expect(output).toContain("Compatibility reference: `betterc0de models`")
    expect(output).toContain("betterc0de models anthropic --verbose")
    expect(output).not.toContain("--terminal")
    expect(output).toContain("## Terminal")
    expect(output).toContain("Claude Sonnet 4.6")
    expect(output).toContain("200,000")
    expect(output).toContain("in 3, out 15")
    expect(output).toContain("Provider Inventory")
    expect(output).toContain("ANTHROPIC_API_KEY")
  })

  it("filters catalog output by model or provider query", () => {
    const output = buildProviderCatalogOutput(
      [
        {
          id: "codex",
          name: "Codex",
          logo: "",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Flagship",
            },
            { id: "small", name: "Small", context: "100K", tier: "Fast" },
          ],
        },
      ],
      ["gpt"]
    )

    expect(output).toContain("GPT 5.5")
    expect(output).not.toContain("| `small` |")
  })

  it("treats an exact BetterC0de compatibility provider id as a provider filter", () => {
    const output = buildProviderCatalogOutput(
      [
        {
          id: "betterc0de",
          name: "BetterC0de",
          logo: "",
          models: [
            {
              id: "anthropic/claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              context: "200K",
              tier: "Runtime",
              catalog: {
                providerId: "anthropic",
                modelId: "claude-sonnet-4-6",
              },
            },
            {
              id: "openai/gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Runtime",
              catalog: {
                providerId: "openai",
                modelId: "gpt-5.5",
              },
            },
          ],
          providerCatalog: [
            {
              id: "anthropic",
              name: "Anthropic",
              connected: true,
              enabled: true,
              env: ["ANTHROPIC_API_KEY"],
            },
          ],
        },
      ],
      ["anthropic"]
    )

    expect(output).toContain("Provider: `anthropic`")
    expect(output).toContain("Claude Sonnet 4.6")
    expect(output).not.toContain("GPT 5.5")
    expect(output).toContain("Provider Inventory")
    expect(output).toContain("ANTHROPIC_API_KEY")
  })

  it("reports unknown explicit BetterC0de model providers", () => {
    const output = buildProviderCatalogOutput(
      [
        {
          id: "codex",
          name: "Codex",
          logo: "",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Flagship",
            },
          ],
        },
      ],
      ["--provider", "missing"]
    )
    const inlineTerminal = buildProviderCatalogOutput(
      [
        {
          id: "codex",
          name: "Codex",
          logo: "",
          models: [],
        },
      ],
      ["--provider=missing", "--terminal"]
    )

    expect(output).toContain("Provider not found: `missing`")
    expect(output).toContain(
      "Compatibility reference: `betterc0de models [provider]`"
    )
    expect(inlineTerminal).toContain("Provider not found: `missing`")
    expect(inlineTerminal).toContain("betterc0de models missing")
    expect(inlineTerminal).not.toContain("--provider=missing")
  })

  it("treats BetterC0de models flags as catalog controls", () => {
    const output = buildProviderCatalogOutput(
      [
        {
          id: "codex",
          name: "Codex",
          logo: "",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Flagship",
            },
          ],
        },
      ],
      ["--verbose", "--refresh", "gpt"]
    )

    expect(output).toContain("Refresh requested")
    expect(output).toContain("GPT 5.5")
    expect(output).not.toContain("No provider catalog")
  })

  it("validates BetterC0de models provider and boolean flag values", () => {
    const output = buildProviderCatalogOutput(
      [
        {
          id: "codex",
          name: "Codex",
          logo: "",
          models: [],
        },
      ],
      ["--provider", "--verbose", "--refresh=maybe", "--terminal"]
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--provider requires a value")
    expect(output).toContain("`--refresh` must be true or false")
    expect(output).toContain("betterc0de models --verbose --refresh=maybe")
    expect(output).not.toContain("Provider not found")
  })
})

describe("BetterC0de model variants", () => {
  const betterc0deProvider: UiProvider = {
    id: "betterc0de",
    name: "BetterC0de",
    logo: "",
    providerKind: "betterc0de",
    models: [
      {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        context: "200K",
        tier: "Runtime",
        capabilities: {
          optionDescriptors: [
            {
              id: "variant",
              label: "Variant",
              type: "select",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
            },
            {
              id: "agent",
              label: "Agent",
              type: "select",
              currentValue: "build",
              options: [
                { id: "build", label: "Build", isDefault: true },
                { id: "plan", label: "Plan" },
                { id: "reviewer", label: "Reviewer" },
              ],
            },
          ],
        },
      },
    ],
  }

  it("matches the compatibility CLI's model.variant.cycle behavior", () => {
    expect(
      resolveModelVariantValue({
        variants: ["low", "high", "xhigh"],
        selected: undefined,
        configured: "high",
      })
    ).toBe("high")
    expect(
      cycleModelVariantValue({
        variants: ["low", "high", "xhigh"],
        selected: undefined,
        configured: "high",
      })
    ).toBe("xhigh")
    expect(
      cycleModelVariantValue({
        variants: ["low", "high", "xhigh"],
        selected: "xhigh",
        configured: "high",
      })
    ).toBeUndefined()
  })

  it("cycles and persists the selected BetterC0de model variant option", () => {
    const first = cycleProviderModelVariantSelection({
      provider: betterc0deProvider,
      selectedModel: "anthropic/claude-sonnet-4-6",
    })

    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.previousValue).toBe("high")
    expect(first.nextValue).toBe("xhigh")
    expect(first.optionSelections).toEqual([{ id: "variant", value: "xhigh" }])

    const second = cycleProviderModelVariantSelection({
      provider: betterc0deProvider,
      selectedModel: "anthropic/claude-sonnet-4-6",
      optionSelections: first.optionSelections,
    })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.previousValue).toBe("xhigh")
    expect(second.nextValue).toBeUndefined()
    expect(second.optionSelections).toEqual([])
  })

  it("cycles BetterC0de compatibility provider agents without changing chat modes", () => {
    const next = cycleProviderModelAgentSelection({
      provider: betterc0deProvider,
      selectedModel: "anthropic/claude-sonnet-4-6",
    })

    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.previousValue).toBe("build")
    expect(next.nextValue).toBe("plan")
    expect(next.optionSelections).toEqual([{ id: "agent", value: "plan" }])

    const previous = cycleProviderModelAgentSelection({
      provider: betterc0deProvider,
      selectedModel: "anthropic/claude-sonnet-4-6",
      optionSelections: next.optionSelections,
      direction: -1,
    })

    expect(previous.ok).toBe(true)
    if (!previous.ok) return
    expect(previous.previousValue).toBe("plan")
    expect(previous.nextValue).toBe("build")
    expect(previous.optionSelections).toEqual([{ id: "agent", value: "build" }])
  })
})

describe("buildProviderAuthOutput", () => {
  it("renders BetterC0de-compatible provider auth status", () => {
    const providers: UiProvider[] = [
      {
        id: "codex",
        name: "Codex",
        logo: "",
        models: [],
        authType: "cli",
        configured: true,
        status: "ready",
        environment: [
          {
            name: "OPENAI_API_KEY",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
        ],
      },
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
        authType: "api-key",
        configured: false,
        setupHint: "Add OPENAI_API_KEY",
      },
    ]

    const output = buildProviderAuthOutput(
      providers,
      providers[0],
      "/providers.logout",
      ["--terminal"]
    )

    expect(output).toContain("Compatibility references: `auth.list`")
    expect(output).toContain("`betterc0de providers list`")
    expect(output).toContain("`betterc0de auth list`")
    expect(output).toContain("`betterc0de providers logout`")
    expect(output).toContain("`betterc0de auth logout`")
    expect(output).toContain("## Terminal")
    expect(output).toContain("betterc0de providers logout")
    expect(output).toContain("`betterc0de console logout [email]`")
    expect(output).toContain("`betterc0de console orgs`")
    expect(output).toContain("Selected: **Codex**")
    expect(output).toContain(
      "| **Codex** | cli | Ready | OPENAI_API_KEY redacted |"
    )
    expect(output).toContain("Add OPENAI_API_KEY")
    expect(output).not.toContain("sk-")
  })

  it("prefills BetterC0de auth alias logout commands", () => {
    const providers: UiProvider[] = [
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
        authType: "api-key",
        configured: true,
      },
    ]

    const output = buildProviderAuthOutput(
      providers,
      providers[0],
      "/auth.logout",
      ["--terminal"]
    )

    expect(output).toContain("betterc0de auth logout")
  })

  it("warns when BetterC0de compatibility provider auth commands receive ignored arguments", () => {
    const providers: UiProvider[] = [
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
        authType: "api-key",
        configured: true,
      },
    ]

    const logout = buildProviderAuthOutput(
      providers,
      providers[0],
      "/providers.logout",
      ["openai", "--terminal"]
    )
    const list = buildProviderAuthOutput(providers, providers[0], "/auth", [
      "openai",
    ])

    expect(logout).toContain("## Validation")
    expect(logout).toContain(
      "BetterC0de compatibility providers logout does not accept provider arguments"
    )
    expect(logout).toContain("betterc0de providers logout")
    expect(logout).not.toContain("betterc0de providers logout openai")
    expect(list).toContain(
      "BetterC0de compatibility providers list does not accept arguments"
    )
  })

  it("strips BetterC0de compatibility provider and auth subcommands before output routing", () => {
    expect(
      stripBetterC0deProviderSlashSubcommand(["login", "--provider", "openai"])
    ).toEqual(["--provider", "openai"])
    expect(
      stripBetterC0deProviderSlashSubcommand(["--terminal", "logout"])
    ).toEqual(["--terminal"])
    expect(stripBetterC0deProviderSlashSubcommand(["openai"])).toEqual([
      "openai",
    ])

    const providers: UiProvider[] = [
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
        authType: "api-key",
        configured: true,
      },
    ]
    const output = buildProviderAuthOutput(
      providers,
      providers[0],
      "/providers.list",
      stripBetterC0deProviderSlashSubcommand(["list", "--terminal"])
    )

    expect(output).toContain("betterc0de providers list")
    expect(output).not.toContain("does not accept arguments")
  })
})

describe("buildProviderConnectionOutput", () => {
  it("maps BetterC0de compatibility provider and console login commands", () => {
    const output = buildProviderConnectionOutput(
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
        authType: "api-key",
        configured: false,
        setupHint: "Add OPENAI_API_KEY",
      },
      "/providers.login",
      ["--terminal"]
    )

    expect(output).toContain("`betterc0de providers login --provider <id>`")
    expect(output).toContain("`betterc0de auth login --provider <id>`")
    expect(output).toContain(
      "`betterc0de providers login --provider <id> --method <label>`"
    )
    expect(output).toContain("betterc0de providers login --provider openai")
    expect(output).toContain("`betterc0de providers login <url>`")
    expect(output).toContain("`betterc0de console login <url>`")
    expect(output).toContain("`betterc0de console open`")
    expect(output).toContain("plugin provider auth stay in the terminal")
    expect(output).toContain("Add OPENAI_API_KEY")
  })

  it("prefills BetterC0de auth alias login commands", () => {
    const output = buildProviderConnectionOutput(
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
        authType: "api-key",
        configured: false,
      },
      "/auth.login",
      ["--terminal"]
    )

    expect(output).toContain("betterc0de auth login --provider openai")
    expect(output).toContain("/auth.login --provider <id>")
  })

  it("validates BetterC0de compatibility provider and console login arguments", () => {
    const provider: UiProvider = {
      id: "openai",
      name: "OpenAI API",
      logo: "",
      models: [],
    }
    const consoleLogin = buildProviderConnectionOutput(
      provider,
      "/console.login",
      ["--terminal"]
    )
    const providerLogin = buildProviderConnectionOutput(
      provider,
      "/providers.login",
      ["notaurl", "--provider", "--method", "--terminal"]
    )
    const inlineProviderLogin = buildProviderConnectionOutput(
      provider,
      "/providers.login",
      ["--provider=", "--method=", "--terminal"]
    )
    const invalidConsoleLogin = buildProviderConnectionOutput(
      provider,
      "/console.login",
      ["notaurl", "--terminal"]
    )
    const consoleOpen = buildProviderConnectionOutput(
      provider,
      "/account.open",
      ["https://console.example.test", "--terminal"]
    )

    expect(consoleLogin).toContain("## Validation")
    expect(consoleLogin).toContain(
      "Compatibility console login requires a server URL"
    )
    expect(providerLogin).toContain("--provider requires a value")
    expect(providerLogin).toContain("--method requires a value")
    expect(providerLogin).toContain(
      "BetterC0de compatibility provider login URL must be a valid `http://` or `https://` URL"
    )
    expect(inlineProviderLogin).toContain("--provider requires a value")
    expect(inlineProviderLogin).toContain("--method requires a value")
    expect(invalidConsoleLogin).toContain(
      "Compatibility console login URL must be a valid `http://` or `https://` URL"
    )
    expect(consoleOpen).toContain("betterc0de console open")
    expect(consoleOpen).not.toContain("betterc0de console open https://")
    expect(consoleOpen).toContain(
      "Compatibility console open does not accept arguments"
    )
  })

  it("strips Compatibility console/account subcommands before output routing", () => {
    expect(
      stripBetterC0deConsoleSlashSubcommand([
        "--terminal",
        "login",
        "https://console.example.test",
      ])
    ).toEqual(["--terminal", "https://console.example.test"])
    expect(
      stripBetterC0deConsoleSlashSubcommand(["logout", "kerim@example.test"])
    ).toEqual(["kerim@example.test"])
    expect(stripBetterC0deConsoleSlashSubcommand(["status"])).toEqual([
      "status",
    ])

    const output = buildProviderConnectionOutput(
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
      },
      "/console.login",
      stripBetterC0deConsoleSlashSubcommand([
        "login",
        "https://console.example.test",
        "--terminal",
      ])
    )

    expect(output).toContain(
      "betterc0de console login https://console.example.test"
    )
    expect(output).not.toContain("Compatibility console login requires")
  })

  it("shows BetterC0de compatibility provider-specific login notes", () => {
    const betterc0deOutput = buildProviderConnectionOutput(
      {
        id: "betterc0de",
        name: "BetterC0de",
        logo: "",
        models: [],
      },
      "/providers.login",
      ["--terminal"]
    )
    const wellknownOutput = buildProviderConnectionOutput(
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
      },
      "/providers.login",
      ["https://auth.example.test", "--terminal"]
    )
    const bedrockOutput = buildProviderConnectionOutput(
      {
        id: "openai",
        name: "OpenAI API",
        logo: "",
        models: [],
      },
      "/providers.login",
      ["--provider", "amazon-bedrock", "--terminal"]
    )

    expect(betterc0deOutput).toContain("## Compatibility login notes")
    expect(betterc0deOutput).toContain("configured provider auth flow")
    expect(wellknownOutput).toContain("`/.well-known/betterc0de`")
    expect(bedrockOutput).toContain("AWS credential chain")
  })
})

describe("buildComposerInputActionsOutput", () => {
  it("renders the full BetterC0de composer input action reference", () => {
    const output = buildComposerInputActionsOutput("/input-actions")

    expect(output).toContain("# Composer Input Actions")
    expect(output).toContain("`input.submit`")
    expect(output).toContain("`input.newline`")
    expect(output).toContain("`input.delete.word.forward`")
    expect(output).toContain("Native textarea")
  })

  it("renders a single BetterC0de input action when addressed directly", () => {
    const output = buildComposerInputActionsOutput("/input.delete.word.forward")

    expect(output).toContain(
      "Compatibility reference: `input.delete.word.forward`"
    )
    expect(output).toContain("alt+d")
    expect(output).not.toContain("`input.submit`")
  })
})

describe("buildProviderOrganizationOutput", () => {
  it("maps Compatibility console org commands", () => {
    const output = buildProviderOrganizationOutput("/account.switch", [
      "unused",
      "--terminal",
    ])

    expect(output).toContain("`betterc0de console orgs`")
    expect(output).toContain("`betterc0de console switch`")
    expect(output).toContain("/console.orgs")
    expect(output).toContain("/console.switch")
    expect(output).toContain("betterc0de console switch")
    expect(output).not.toContain("betterc0de console switch unused")
    expect(output).toContain("## Validation")
    expect(output).toContain(
      "Compatibility console switch does not accept arguments"
    )
    expect(output).toContain("`console.org.switch` TUI action")
    expect(output).toContain("metadata-only display")
  })
})

describe("buildProjectKeybindsOutput", () => {
  it("shows BetterC0de default keybinds even without project overrides", () => {
    const output = buildProjectKeybindsOutput([], thread())

    expect(output).toContain(
      "No BetterC0de terminal UI keybind overrides found"
    )
    expect(output).toContain("BetterC0de Default Keybinds")
    expect(output).toContain("`session.export`")
    expect(output).toContain("<leader>x")
    expect(output).toContain("`dialog.select.next`")
    expect(output).toContain("`prompt.autocomplete.complete`")
    expect(output).toContain("`dialog.plugins.install`")
    expect(output).toContain("`app.toggle.diffwrap`")
    expect(output).toContain("`provider.connect`")
    expect(output).toContain("`session.message.next`")
    expect(output).toContain("`prompt.stash.pop`")
    expect(output).toContain("`which-key.toggle`")
    expect(output).toContain("`/export`")
    expect(output).toContain("Composer Native Keybinds")
    expect(output).toContain("`input.newline`")
    expect(output).toContain("ctrl+return")
    expect(output).toContain("Composer history")
  })

  it("renders project overrides before the default reference", () => {
    const output = buildProjectKeybindsOutput(
      [
        {
          key: "keybinds.session_export",
          label: "Keybind session export",
          kind: "scalar",
          value: "ctrl+x",
          sourcePath: ".betterc0de/tui.json#keybinds.session_export",
        },
      ],
      thread()
    )

    expect(output).toContain("Project Overrides")
    expect(output).toContain("`session_export`")
    expect(output).toContain("ctrl+x")
    expect(output).toContain("BetterC0de Default Keybinds")
  })
})

describe("buildProjectTuiConfigWriteOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("writes safe BetterC0de terminal UI settings and keybind overrides", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "theme": "system", "keybinds": { "session_export": "<leader>x", "app_exit": "ctrl+q", "prompt_submit": "return" }, "scroll_acceleration": { "enabled": true, "factor": 2 } }',
      path: "/repo/tui.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectTuiConfigWriteOutput(
      [
        "--config-only",
        "--theme",
        "dark",
        "--mouse",
        "false",
        "--diff-style",
        "stacked",
        "--leader-timeout",
        "1500",
        "--scroll-speed",
        "1.25",
        "--scroll-acceleration",
        "false",
        "--keybind",
        "session.copy=ctrl+y",
        "--keybind",
        "input.newline=ctrl+j",
        "--keybind",
        "dialog.select.prev=ctrl+p",
        "--remove-keybind",
        "session.export",
        "--remove-keybind",
        "prompt.submit",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Updated the workspace BetterC0de terminal UI config"
    )
    expect(output).toContain("Target: `tui.json`")
    expect(output).toContain("keybinds.session_copy")
    expect(output).toContain("keybinds.input_newline")
    expect(output).toContain("keybinds.dialog.select.prev")
    expect(output).toContain("keybinds.prompt_submit")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "tui.json",
      expect.any(String)
    )
    const config = JSON.parse(writeFileMock.mock.calls[0]?.[2] as string)
    expect(config).toEqual({
      theme: "dark",
      keybinds: {
        app_exit: "ctrl+q",
        session_copy: "ctrl+y",
        input_newline: "ctrl+j",
        "dialog.select.prev": "ctrl+p",
      },
      scroll_acceleration: {
        enabled: false,
        factor: 2,
      },
      mouse: false,
      diff_style: "stacked",
      leader_timeout: 1500,
      scroll_speed: 1.25,
    })
  })

  it("writes BetterC0de terminal UI attention notification and sound config", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "attention": { "volume": 1, "sounds": { "error": "./old.wav" } } }',
      path: "/repo/tui.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectTuiConfigWriteOutput(
      [
        "--config-only",
        "--attention-enabled",
        "true",
        "--attention-notifications",
        "false",
        "--attention-sound",
        "false",
        "--attention-volume",
        "0.4",
        "--sound-pack",
        "./pack",
        "--sound",
        "done=./done.wav",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("attention.sounds.done")
    const config = JSON.parse(writeFileMock.mock.calls[0]?.[2] as string)
    expect(config).toEqual({
      attention: {
        volume: 0.4,
        sounds: {
          error: "./old.wav",
          done: "./done.wav",
        },
        enabled: true,
        notifications: false,
        sound: false,
        sound_pack: "./pack",
      },
    })
  })

  it("flattens legacy nested BetterC0de terminal UI config before writing", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "tui": { "theme": "system", "mouse": true }, "mouse": false }',
      path: "/repo/tui.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectTuiConfigWriteOutput(
      ["--config-only", "--theme", "dark"],
      { projectPath: "/repo" }
    )

    expect(output).toContain(
      "Updated the workspace BetterC0de terminal UI config"
    )
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "tui.json",
      '{\n  "theme": "dark",\n  "mouse": false\n}\n'
    )
  })

  it("rejects unknown keybinds and attention sound names before writing", async () => {
    const output = await buildProjectTuiConfigWriteOutput(
      [
        "--config-only",
        "--keybind",
        "unknown=ctrl+x",
        "--sound",
        "beep=./beep.wav",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Unknown BetterC0de keybind `unknown`")
    expect(output).toContain("Unknown BetterC0de attention sound `beep`")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe("buildThreadJsonExportPayload", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
    useChatStore.setState({
      threads: [],
      activeThreadId: null,
      messagesLoadedByThread: {},
    })
  })

  it("renders BetterC0de export/import terminal guidance without mutating files or chats", async () => {
    const exportOutput = await buildExportThreadOutput(null, [
      "ses_123",
      "--sanitize",
      "--terminal",
    ])
    const importOutput = await buildImportThreadOutput(
      ["session.json", "--terminal"],
      { projectPath: "/repo" }
    )

    expect(exportOutput).toContain("betterc0de export ses_123 --sanitize")
    expect(exportOutput).toContain("did not write a local export file")
    expect(importOutput).toContain("betterc0de import session.json")
    expect(importOutput).toContain("did not import or mutate chat history")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("exports BetterC0de session aliases as JSON by default and treats the first positional as a session id", async () => {
    const exportThread = thread({
      id: "thread-export",
      title: "BetterC0de Export",
      projectPath: "/repo",
      messages: [
        message({
          id: "msg-1",
          role: "user",
          content: "Export this as JSON",
        }),
      ],
    })
    useChatStore.setState({
      threads: [exportThread],
      activeThreadId: "active-thread",
      messagesLoadedByThread: { "thread-export": true },
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildExportThreadOutput(
      "active-thread",
      ["thread-export"],
      { betterC0deMode: true }
    )

    expect(output).toContain("BetterC0de-compatible JSON")
    expect(output).toContain("| **Format** | JSON |")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de-session-thread-e.json",
      expect.any(String)
    )
    const exported = JSON.parse(writeFileMock.mock.calls[0]?.[2] as string)
    expect(exported.info.id).toBe("thread-export")
    expect(exported.messages).toHaveLength(1)
  })

  it("keeps the BetterC0de /export default as markdown unless JSON is requested", async () => {
    const exportThread = thread({
      id: "thread-markdown",
      title: "Markdown Export",
      projectPath: "/repo",
      messages: [
        message({
          id: "msg-1",
          role: "user",
          content: "Export this as markdown",
        }),
      ],
    })
    useChatStore.setState({
      threads: [exportThread],
      activeThreadId: "thread-markdown",
      messagesLoadedByThread: { "thread-markdown": true },
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildExportThreadOutput("thread-markdown", [])

    expect(output).toContain("Exported this chat transcript")
    expect(output).toContain("| **Format** | Markdown |")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de-session-thread-m.md",
      expect.stringContaining("Export this as markdown")
    )
  })

  it("builds sanitized BetterC0de-compatible JSON session exports", () => {
    const payload = buildThreadJsonExportPayload(
      thread({
        id: "thread-export",
        title: "Sensitive title",
        projectPath: "/secret/repo",
        messages: [
          message({
            id: "user-1",
            role: "user",
            content: "secret prompt",
          }),
          message({
            id: "assistant-1",
            role: "assistant",
            content: "secret answer",
            reasoning: "private chain",
            toolCalls: [
              {
                id: "tool-1",
                name: "Bash",
                input: { cmd: "cat .env" },
                output: "TOKEN=secret",
                state: "output-available",
              },
            ],
          }),
        ],
      }),
      { sanitize: true }
    )
    const serialized = JSON.stringify(payload)

    expect(payload).toMatchObject({
      info: {
        id: "thread-export",
        title: "[redacted:title:thread-export]",
        projectPath: "[redacted:project-path:thread-export]",
      },
    })
    expect(serialized).toContain("[redacted:message:user-1]")
    expect(serialized).toContain("tool-input:tool-1")
    expect(serialized).not.toContain("TOKEN=secret")
    expect(serialized).not.toContain("secret prompt")
  })

  it("imports BetterC0de JSON session exports into chat messages", () => {
    const draft = buildThreadImportDraftFromJsonPayload(
      {
        info: {
          title: "Imported BetterC0de",
          projectName: "Demo",
          projectPath: "/repo",
        },
        messages: [
          {
            id: "original-user",
            role: "user",
            content: "hello",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "original-assistant",
            role: "assistant",
            content: "world",
            reasoning: "thinking",
            toolCalls: [
              {
                id: "tool-original",
                name: "Read",
                input: { path: "a.ts" },
                output: "ok",
                state: "output-available",
              },
            ],
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
      { idPrefix: "import-test", now: "2026-01-02T00:00:00.000Z" }
    )

    expect(draft?.title).toBe("Imported BetterC0de")
    expect(draft?.messages.map((message) => message.id)).toEqual([
      "import-test-1",
      "import-test-2",
    ])
    expect(draft?.messages[1].toolCalls?.[0]).toMatchObject({
      name: "Read",
      state: "output-available",
    })
  })

  it("imports BetterC0de-compatible JSON exports with message parts", () => {
    const draft = buildThreadImportDraftFromJsonPayload(
      {
        info: {
          title: "BetterC0de Export",
          directory: "/repo",
          projectID: "betterc0de-project",
        },
        messages: [
          {
            info: {
              id: "msg-1",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-opus-4-7",
              time: { created: 1767225600000 },
              tokens: {
                input: 10,
                output: 20,
                reasoning: 5,
                cache: { read: 2, write: 1 },
              },
            },
            parts: [
              { id: "part-text", type: "text", text: "answer" },
              { id: "part-reasoning", type: "reasoning", text: "reason" },
              {
                id: "part-tool",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { cmd: "pwd" },
                  output: "/repo",
                },
              },
            ],
          },
        ],
      },
      { idPrefix: "oc", now: "2026-01-02T00:00:00.000Z" }
    )

    expect(draft).toMatchObject({
      title: "BetterC0de Export",
      projectName: "betterc0de-project",
      projectPath: "/repo",
    })
    expect(draft?.messages[0]).toMatchObject({
      id: "oc-1",
      role: "assistant",
      content: "answer",
      reasoning: "reason",
      modelId: "anthropic/claude-opus-4-7",
    })
    expect(draft?.messages[0].toolCalls?.[0]).toMatchObject({
      name: "bash",
      state: "output-available",
    })
    expect(draft?.messages[0].usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      cachedInputTokens: 3,
    })
  })

  it("imports BetterC0de share API data arrays", () => {
    const draft = buildThreadImportDraftFromJsonPayload(
      [
        {
          type: "session",
          data: {
            id: "ses_1",
            title: "Shared Session",
            directory: "/repo",
            projectID: "shared-project",
          },
        },
        {
          type: "message",
          data: {
            id: "msg_1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-5.5",
            time: { created: 1767225600000 },
          },
        },
        {
          type: "part",
          data: {
            id: "part_1",
            messageID: "msg_1",
            type: "text",
            text: "Imported from share data",
          },
        },
      ],
      { idPrefix: "share", now: "2026-01-02T00:00:00.000Z" }
    )

    expect(draft).toMatchObject({
      title: "Shared Session",
      projectName: "shared-project",
      projectPath: "/repo",
    })
    expect(draft?.messages[0]).toMatchObject({
      id: "share-1",
      role: "assistant",
      content: "Imported from share data",
      modelId: "openai/gpt-5.5",
    })
  })

  it("builds BetterC0de import API candidates for /share and /s links", () => {
    expect(
      betterC0deImportUrlCandidates("https://opncd.ai/share/ses_123")
    ).toEqual([
      "https://opncd.ai/share/ses_123",
      "https://opncd.ai/api/share/ses_123/data",
      "https://opncd.ai/api/shares/ses_123/data",
    ])
    expect(betterC0deImportUrlCandidates("https://opncd.ai/s/ses_123")).toEqual(
      [
        "https://opncd.ai/s/ses_123",
        "https://opncd.ai/api/share/ses_123/data",
        "https://opncd.ai/api/shares/ses_123/data",
      ]
    )
  })
})

describe("buildProjectPluginsOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("renders BetterC0de plugin install guidance with aliases and flags", async () => {
    const output = await buildPluginInstallOutput(
      ["@acme/betterc0de-plugin", "--global", "--force", "--terminal"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("# BetterC0de Plugin Install")
    expect(output).toContain(
      "Compatibility reference: `betterc0de plugin <module>`"
    )
    expect(output).toContain("Workspace: `/repo`")
    expect(output).toContain("Module: `@acme/betterc0de-plugin`")
    expect(output).toContain(
      "betterc0de plugin @acme/betterc0de-plugin --global --force"
    )
    expect(output).toContain(
      "betterc0de plug @acme/betterc0de-plugin --global --force"
    )
    expect(output).toContain("## Terminal")
    expect(output).toContain(
      "betterc0de plugin @acme/betterc0de-plugin --global --force"
    )
    expect(output).not.toContain("--terminal")
    expect(output).toContain("does not silently run npm installs")
  })

  it("renders BetterC0de plugin install usage when no module is provided", async () => {
    const output = await buildPluginInstallOutput([], thread())

    expect(output).toContain(
      "betterc0de plugin <npm-module|local-path|repo-spec> [--global] [--force]"
    )
    expect(output).toContain(
      "Chat usage: `/plugin-install <module> [--global] [--force]`"
    )
    expect(output).toContain(
      "Config-only usage: `/plugin-install <module> --config-only --target server|tui|both [--root-config]"
    )
  })

  it("validates BetterC0de plugin terminal handoff when no module is provided", async () => {
    const output = await buildPluginInstallOutput(["--terminal"], thread())

    expect(output).toContain("## Validation")
    expect(output).toContain("BetterC0de plugin install requires a module")
    expect(output).not.toContain("## Terminal")
    expect(output).not.toContain("Opened the terminal panel")
  })

  it("respects BetterC0de plugin boolean inline false values", async () => {
    const output = await buildPluginInstallOutput(
      ["@acme/betterc0de-plugin", "--global=false", "--force=false"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Scope: workspace/project BetterC0de compatibility config"
    )
    expect(output).toContain("Replace existing entry: no")
    expect(output).toContain("betterc0de plugin @acme/betterc0de-plugin")
    expect(output).not.toContain(
      "betterc0de plugin @acme/betterc0de-plugin --global"
    )
    expect(output).not.toContain(
      "betterc0de plugin @acme/betterc0de-plugin --force"
    )
  })

  it("warns for deprecated BetterC0de auth plugin packages", async () => {
    const output = await buildPluginInstallOutput(
      ["betterc0de-copilot-auth"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Deprecated Package")
    expect(output).toContain("BetterC0de now provides this auth flow natively")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de plugin config-only arguments before writing", async () => {
    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target",
        "mobile",
        "--config",
        "[]",
        "--option",
        "1bad=true",
        "--force=maybe",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("`--target` must be `server`, `tui`, or `both`")
    expect(output).toContain("`--config` must be a JSON object")
    expect(output).toContain(
      "`--option` must use `key=value` with an identifier-like key"
    )
    expect(output).toContain("`--force` must be true or false")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates missing BetterC0de plugin config-only option values before writing", async () => {
    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target=",
        "--config",
        "--option=",
        "--set",
        "--force=false",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--target requires a value")
    expect(output).toContain("--config requires a value")
    expect(output).toContain("--option requires a value")
    expect(output).toContain("--set requires a value")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes a workspace BetterC0de plugin config entry in config-only mode", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target",
        "server",
        "--terminal",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Created the workspace BetterC0de plugin config")
    expect(output).toContain("Target: `.betterc0de/betterc0de.json`")
    expect(output).not.toContain("## Terminal")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".betterc0de/betterc0de.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    "@acme/betterc0de-plugin"\n  ]\n}\n'
      )
    )
  })

  it("keeps --betterc0de-dir as a compatibility no-op for native BetterC0de plugin config", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target",
        "tui",
        "--betterc0de-dir",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Target: `.betterc0de/tui.json`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".betterc0de/tui.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    "@acme/betterc0de-plugin"\n  ]\n}\n'
      )
    )
  })

  it("can write both compatibility server and TUI plugin config targets", async () => {
    readFileMock
      .mockRejectedValueOnce(
        new HttpError("file not found", 404, "/workspace/read")
      )
      .mockRejectedValueOnce(
        new HttpError("file not found", 404, "/workspace/read")
      )
    writeFileMock.mockResolvedValue(undefined)

    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target",
        "both",
        "--betterc0de-dir",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Targets: `.betterc0de/betterc0de.json`, `.betterc0de/tui.json`"
    )
    expect(writeFileMock).toHaveBeenCalledTimes(2)
    expect(writeFileMock).toHaveBeenNthCalledWith(
      1,
      "/repo",
      ".betterc0de/betterc0de.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    "@acme/betterc0de-plugin"\n  ]\n}\n'
      )
    )
    expect(writeFileMock).toHaveBeenNthCalledWith(
      2,
      "/repo",
      ".betterc0de/tui.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    "@acme/betterc0de-plugin"\n  ]\n}\n'
      )
    )
  })

  it("writes a workspace BetterC0de plugin config entry with options", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "plugin": ["existing-plugin"] }',
      path: "/repo/.betterc0de/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target",
        "server",
        "--config",
        '{"enabled":true,"mode":"strict"}',
        "--option",
        "retries=3",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Updated the workspace BetterC0de plugin config")
    expect(output).toContain("Options: `enabled`, `mode`, `retries`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".betterc0de/betterc0de.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    "existing-plugin",\n    [\n      "@acme/betterc0de-plugin",\n      {\n        "enabled": true,\n        "mode": "strict",\n        "retries": 3\n      }\n    ]\n  ]\n}\n'
      )
    )
  })

  it("can intentionally target root BetterC0de plugin config files", async () => {
    readFileMock.mockRejectedValueOnce(
      new HttpError("file not found", 404, "/workspace/read")
    )
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target",
        "server",
        "--root-config",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Target: `betterc0de.json`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    "@acme/betterc0de-plugin"\n  ]\n}\n'
      )
    )
  })

  it("refuses to write plugin config-only secrets", async () => {
    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin",
        "--config-only",
        "--target=server",
        "--option",
        "apiKey=sk-secret-value-123456",
        "--config",
        '{"mode":"strict"}',
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Refusing to write plugin secrets")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("requires force before replacing an existing plugin config entry", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "plugin": ["@acme/betterc0de-plugin"] }',
      path: "/repo/.betterc0de/betterc0de.json",
    })

    const output = await buildPluginInstallOutput(
      ["@acme/betterc0de-plugin", "--config-only", "--target=server"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Plugin config entry already exists")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("matches BetterC0de plugin replacement by npm package identity", async () => {
    readFileMock.mockResolvedValueOnce({
      content:
        '{ "plugin": ["@acme/betterc0de-plugin@1.0.0", ["other-plugin", { "mode": "strict" }] ] }',
      path: "/repo/.betterc0de/betterc0de.json",
    })

    const refused = await buildPluginInstallOutput(
      ["@acme/betterc0de-plugin@2.0.0", "--config-only", "--target=server"],
      thread({ projectPath: "/repo" })
    )

    expect(refused).toContain("Plugin config entry already exists")
    expect(writeFileMock).not.toHaveBeenCalled()

    readFileMock.mockResolvedValueOnce({
      content:
        '{ "plugin": ["@acme/betterc0de-plugin@1.0.0", ["other-plugin", { "mode": "strict" }] ] }',
      path: "/repo/.betterc0de/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginInstallOutput(
      [
        "@acme/betterc0de-plugin@2.0.0",
        "--config-only",
        "--target=server",
        "--force",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Replace existing entry: yes")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".betterc0de/betterc0de.json",
      withBetterC0deSchema(
        '{\n  "plugin": [\n    [\n      "other-plugin",\n      {\n        "mode": "strict"\n      }\n    ],\n    "@acme/betterc0de-plugin@2.0.0"\n  ]\n}\n'
      )
    )
  })

  it("writes BetterC0de terminal UI plugin enablement in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "theme": "system", "plugin_enabled": { "old": true } }',
      path: "/repo/.betterc0de/tui.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginToggleOutput(
      ["@acme/betterc0de-plugin", "--enabled", "false", "--config-only"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Updated the workspace BetterC0de terminal UI plugin state"
    )
    expect(output).toContain("Plugin: `@acme/betterc0de-plugin`")
    expect(output).toContain("State: `false`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      ".betterc0de/tui.json",
      '{\n  "theme": "system",\n  "plugin_enabled": {\n    "old": true,\n    "@acme/betterc0de-plugin": false\n  }\n}\n'
    )
  })

  it("can intentionally target root TUI plugin enablement", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "plugin_enabled": {} }',
      path: "/repo/tui.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildPluginToggleOutput(
      [
        "@acme/betterc0de-plugin",
        "--enabled",
        "true",
        "--config-only",
        "--root-config",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Target: `tui.json`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "tui.json",
      '{\n  "plugin_enabled": {\n    "@acme/betterc0de-plugin": true\n  }\n}\n'
    )
  })

  it("requires config-only before writing BetterC0de plugin enablement", async () => {
    const output = await buildPluginToggleOutput(
      ["@acme/betterc0de-plugin", "off"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Add `--config-only`")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates missing BetterC0de plugin toggle values before writing", async () => {
    const output = await buildPluginToggleOutput(
      [
        "@acme/betterc0de-plugin",
        "--enabled=",
        "--state",
        "--config-only=true",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--enabled requires a value")
    expect(output).toContain("--state requires a value")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("renders plugin list with detail hint and index references", () => {
    const output = buildProjectPluginsOutput(
      [
        {
          id: "./plugins/local.ts",
          spec: "./plugins/local.ts",
          kind: "file",
          sourcePath: "betterc0de.jsonc#plugin.0",
          optionsKeys: ["enabled"],
          relativePath: "plugins/local.ts",
          path: "/repo/plugins/local.ts",
          exists: true,
          metaSourcePath: "/state/betterc0de/plugin-meta.json",
          metaSource: "file",
          metaTarget: "/repo/plugins/local.ts",
          metaLoadCount: 3,
          metaThemes: ["agency"],
        },
      ],
      thread()
    )

    expect(output).toContain(
      "| # | Plugin | Kind | Path | Options | Source | Status | Metadata |"
    )
    expect(output).toContain("`./plugins/local.ts`")
    expect(output).toContain("loaded 3x")
    expect(output).toContain("themes agency")
    expect(output).toContain("/project-plugins <#|spec|path>")
  })

  it("renders detailed plugin inspection for a matching index", () => {
    const output = buildProjectPluginsOutput(
      [
        {
          id: "./plugins/local.ts",
          spec: "./plugins/local.ts",
          kind: "file",
          sourcePath: "betterc0de.jsonc#plugin.0",
          optionsKeys: ["enabled"],
          relativePath: "plugins/local.ts",
          path: "/repo/plugins/local.ts",
          exists: true,
          metaSourcePath: "/state/betterc0de/plugin-meta.json",
          metaSource: "file",
          metaLoadCount: 3,
        },
      ],
      thread(),
      ["1"]
    )

    expect(output).toContain("# BetterC0de Project Plugin")
    expect(output).toContain("| Status | Found |")
    expect(output).toContain(
      "| Metadata source | `/state/betterc0de/plugin-meta.json` |"
    )
    expect(output).toContain("source file, loaded 3x")
    expect(output).toContain("`/open plugins/local.ts`")
    expect(output).toContain("does not execute arbitrary project plugin code")
  })

  it("renders BetterC0de pure mode skipped plugin status", () => {
    const output = buildProjectPluginsOutput(
      [
        {
          id: "acme-plugin",
          spec: "acme-plugin",
          kind: "npm",
          sourcePath: "betterc0de.jsonc#plugin.0",
          optionsKeys: [],
          skipped: true,
          skippedReason: "Skipped by BETTERC0DE_PURE",
        },
      ],
      thread()
    )

    expect(output).toContain("Skipped by BETTERC0DE_PURE")
  })
})

describe("buildProjectFormatOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
  })

  it("writes an BetterC0de formatter config entry in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "formatter": true }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectFormatterConfigOutput(
      [
        "--config-only",
        "prettier",
        "--command",
        "prettier --write $FILE",
        "--ext",
        "ts,tsx",
        "--env",
        "PRETTIER_CACHE=1",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain(
      "Updated the workspace BetterC0de formatter config"
    )
    expect(output).toContain("Formatter: `prettier`")
    expect(output).toContain("Command: `prettier --write $FILE`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "formatter": {\n    "prettier": {\n      "command": [\n        "prettier",\n        "--write",\n        "$FILE"\n      ],\n      "extensions": [\n        ".ts",\n        ".tsx"\n      ],\n      "environment": {\n        "PRETTIER_CACHE": "1"\n      }\n    }\n  }\n}\n'
      )
    )
  })

  it("requires force before replacing an existing formatter config entry", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "formatter": { "prettier": { "disabled": true } } }',
      path: "/repo/betterc0de.json",
    })

    const output = await buildProjectFormatterConfigOutput(
      ["--config-only", "prettier", "--command", "prettier --write $FILE"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Formatter config entry already exists")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates missing BetterC0de formatter config values before writing", async () => {
    const output = await buildProjectFormatterConfigOutput(
      [
        "--config-only",
        "--formatter=",
        "--builtins",
        "--command",
        "--arg=",
        "--ext",
        "--env=",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--formatter requires a value")
    expect(output).toContain("--builtins requires a value")
    expect(output).toContain("--command requires a value")
    expect(output).toContain("--arg requires a value")
    expect(output).toContain("--ext requires a value")
    expect(output).toContain("--env requires a value")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de formatter extension values before writing", async () => {
    const output = await buildProjectFormatterConfigOutput(
      [
        "--config-only",
        "prettier",
        "--command",
        "prettier --write $FILE",
        "--ext",
        "ts,bad ext,src/file.ts",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "Invalid BetterC0de file extension for `--ext`: `bad ext`"
    )
    expect(output).toContain(
      "Invalid BetterC0de file extension for `--ext`: `src/file.ts`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes BetterC0de formatter built-in boolean mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: "{}",
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectFormatterConfigOutput(
      ["--config-only", "--enable-builtins"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Built-ins: enabled")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema('{\n  "formatter": true\n}\n')
    )
  })

  it("requires force before replacing formatter map with boolean mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "formatter": { "prettier": { "disabled": true } } }',
      path: "/repo/betterc0de.json",
    })

    const output = await buildProjectFormatterConfigOutput(
      ["--config-only", "--disable-builtins"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Formatter config entries already exist")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("previews a matching formatter and terminal command without formatting", async () => {
    const output = await buildProjectFormatOutput(
      ["src/app.ts", "prettier", "--terminal"],
      [
        {
          id: "prettier",
          name: "Prettier",
          enabled: true,
          sourcePath: "betterc0de.json#formatter.prettier",
          command: "prettier",
          args: ["--write"],
          env: {},
          extensions: [".ts"],
          builtin: false,
        },
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("# Format File Preview")
    expect(output).toContain("Prettier")
    expect(output).toContain("prettier --write src/app.ts")
    expect(output).toContain("## Terminal")
    expect(output).toContain("does not modify files")
  })

  it("reports BetterC0de compatibility runtime built-in formatters without an executable command", async () => {
    const output = await buildProjectFormatOutput(
      ["src/app.ts", "--dry-run"],
      [
        {
          id: "prettier",
          name: "Prettier",
          enabled: true,
          sourcePath: "betterc0de.json#formatter.prettier",
          command: "",
          args: [],
          env: {},
          extensions: [".ts"],
          builtin: true,
        },
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("BetterC0de compatibility runtime built-in")
    expect(output).not.toContain("## Terminal")
  })
})

describe("buildProjectLspServersOutput", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
    useEditorDiagnosticsStore.getState().clearAllDiagnostics()
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      navigationBackStack: [],
      navigationForwardStack: [],
      recentlyClosedTabs: [],
      recentFiles: [],
    })
  })

  const servers = [
    {
      id: "typescript",
      name: "typescript-language-server",
      enabled: true,
      sourcePath: "betterc0de.json#lsp.typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      env: {},
      extensions: [".ts", ".tsx"],
      initialization: {},
      builtin: true,
    },
  ]

  it("writes an BetterC0de LSP config entry in config-only mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "lsp": true }',
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectLspConfigOutput(
      [
        "--config-only",
        "typescript",
        "--command",
        "typescript-language-server --stdio",
        "--ext",
        "ts,tsx",
        "--env",
        "TSS_LOG=-level verbose",
        "--init",
        '{"preferences":{"includePackageJsonAutoImports":"on"}}',
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Updated the workspace BetterC0de LSP config")
    expect(output).toContain("Server: `typescript`")
    expect(output).toContain("Command: `typescript-language-server --stdio`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "lsp": {\n    "typescript": {\n      "command": [\n        "typescript-language-server",\n        "--stdio"\n      ],\n      "extensions": [\n        ".ts",\n        ".tsx"\n      ],\n      "env": {\n        "TSS_LOG": "-level verbose"\n      },\n      "initialization": {\n        "preferences": {\n          "includePackageJsonAutoImports": "on"\n        }\n      }\n    }\n  }\n}\n'
      )
    )
  })

  it("allows BetterC0de built-in LSP overrides without extensions", async () => {
    readFileMock.mockResolvedValueOnce({
      content: "{}",
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectLspConfigOutput(
      [
        "--config-only",
        "typescript",
        "--command",
        "typescript-language-server --stdio",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Updated the workspace BetterC0de LSP config")
    expect(output).toContain("Server: `typescript`")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema(
        '{\n  "lsp": {\n    "typescript": {\n      "command": [\n        "typescript-language-server",\n        "--stdio"\n      ]\n    }\n  }\n}\n'
      )
    )
  })

  it("refuses custom BetterC0de LSP entries without extensions", async () => {
    const output = await buildProjectLspConfigOutput(
      ["--config-only", "custom-lsp", "--command", "custom-lsp --stdio"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("requires `--ext` for custom LSP servers")
    expect(output).toContain("Server: `custom-lsp`")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("refuses enabled BetterC0de LSP entries without commands", async () => {
    const output = await buildProjectLspConfigOutput(
      ["--config-only", "custom-lsp", "--enable", "--ext", ".foo"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("needs `--command` for enabled entries")
    expect(output).toContain("Server: `custom-lsp`")
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("requires force before replacing an existing LSP config entry", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "lsp": { "typescript": { "disabled": true } } }',
      path: "/repo/betterc0de.json",
    })

    const output = await buildProjectLspConfigOutput(
      [
        "--config-only",
        "typescript",
        "--command",
        "typescript-language-server --stdio",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("LSP config entry already exists")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates missing BetterC0de LSP config values before writing", async () => {
    const output = await buildProjectLspConfigOutput(
      [
        "--config-only",
        "custom-lsp",
        "--command=",
        "--arg",
        "--ext",
        "--env",
        "--init",
        "[]",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain("--command requires a value")
    expect(output).toContain("--arg requires a value")
    expect(output).toContain("--ext requires a value")
    expect(output).toContain("--env requires a value")
    expect(output).toContain("`--init` must be a JSON object")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("validates BetterC0de LSP extension values before writing", async () => {
    const output = await buildProjectLspConfigOutput(
      [
        "--config-only",
        "custom-lsp",
        "--command",
        "custom-lsp --stdio",
        "--ext",
        ".foo,bad ext,src/file.foo",
      ],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("## Validation")
    expect(output).toContain(
      "Invalid BetterC0de file extension for `--ext`: `bad ext`"
    )
    expect(output).toContain(
      "Invalid BetterC0de file extension for `--ext`: `src/file.foo`"
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("writes BetterC0de LSP built-in boolean mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: "{}",
      path: "/repo/betterc0de.json",
    })
    writeFileMock.mockResolvedValueOnce(undefined)

    const output = await buildProjectLspConfigOutput(
      ["--config-only", "--disable-builtins"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("Built-ins: disabled")
    expect(writeFileMock).toHaveBeenCalledWith(
      "/repo",
      "betterc0de.json",
      withBetterC0deSchema('{\n  "lsp": false\n}\n')
    )
  })

  it("requires force before replacing LSP map with boolean mode", async () => {
    readFileMock.mockResolvedValueOnce({
      content: '{ "lsp": { "typescript": { "disabled": true } } }',
      path: "/repo/betterc0de.json",
    })

    const output = await buildProjectLspConfigOutput(
      ["--config-only", "--enable-builtins"],
      thread({ projectPath: "/repo" })
    )

    expect(output).toContain("LSP config entries already exist")
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("renders configured BetterC0de LSP servers", () => {
    const output = buildProjectLspServersOutput(servers, thread())

    expect(output).toContain("# Project LSP Servers")
    expect(output).toContain("typescript-language-server")
    expect(output).toContain("/lsp diagnostics <file>")
  })

  it("renders BetterC0de LSP diagnostics guidance and matching servers", () => {
    useEditorDiagnosticsStore
      .getState()
      .setFileDiagnostics("/repo/src/app.ts", [
        {
          id: "diag-1",
          filePath: "/repo/src/app.ts",
          severity: "error",
          message: "Type mismatch",
          source: "typescript",
          code: "2322",
          startLineNumber: 7,
          startColumn: 11,
          endLineNumber: 7,
          endColumn: 16,
        },
      ])

    const output = buildProjectLspServersOutput(servers, thread(), "/lsp", [
      "diagnostics",
      "src/app.ts",
      "--terminal",
    ])

    expect(output).toContain("# BetterC0de LSP Diagnostics")
    expect(output).toContain(
      "Compatibility reference: `betterc0de debug lsp diagnostics src/app.ts`"
    )
    expect(output).not.toContain("--terminal")
    expect(output).toContain("command prefilled")
    expect(output).toContain("## BetterC0de Editor Diagnostics")
    expect(output).toContain("Type mismatch")
    expect(output).toContain("| Server | Extensions | Command | Source |")
    expect(output).toContain("typescript-language-server --stdio")
  })

  it("renders cached diagnostics as an BetterC0de-compatible JSON preview", () => {
    useEditorDiagnosticsStore
      .getState()
      .setFileDiagnostics("/repo/src/app.ts", [
        {
          id: "diag-1",
          filePath: "/repo/src/app.ts",
          severity: "error",
          message: "Type mismatch",
          source: "typescript",
          code: "2322",
          startLineNumber: 7,
          startColumn: 11,
          endLineNumber: 7,
          endColumn: 16,
        },
      ])

    const output = buildProjectLspServersOutput(servers, thread(), "/lsp", [
      "diagnostics",
      "src/app.ts",
      "--json",
    ])

    expect(output).toContain("## BetterC0de JSON Preview")
    expect(output).toContain('"uri": "file:///repo/src/app.ts"')
    expect(output).toContain('"severity": "error"')
    expect(output).toContain('"line": 6')
    expect(output).toContain("BetterC0de-compatible JSON preview")
  })

  it("renders BetterC0de workspace symbols from open editor tabs", () => {
    useEditorStore.setState({
      tabs: [
        editorTab({
          filePath: "/repo/src/user.ts",
          content: "export function loadUser() { return null }\n",
        }),
      ],
      activeTabId: "/repo/src/user.ts",
    })

    const output = buildProjectLspServersOutput(servers, thread(), "/lsp", [
      "symbols",
      "loadUser",
    ])

    expect(output).toContain("# BetterC0de LSP Workspace Symbols")
    expect(output).toContain("## BetterC0de Workspace Symbols")
    expect(output).toContain("loadUser")
    expect(output).toContain("src/user.ts:1:1")
  })

  it("renders workspace symbols as an BetterC0de-compatible JSON preview", () => {
    useEditorStore.setState({
      tabs: [
        editorTab({
          filePath: "/repo/src/user.ts",
          content: "export function loadUser() { return null }\n",
        }),
      ],
      activeTabId: "/repo/src/user.ts",
    })

    const output = buildProjectLspServersOutput(
      servers,
      thread(),
      "/debug.lsp.symbols",
      ["loadUser", "--format", "json"]
    )

    expect(output).toContain("## BetterC0de JSON Preview")
    expect(output).toContain('"name": "loadUser"')
    expect(output).toContain('"uri": "file:///repo/src/user.ts"')
    expect(output).toContain('"file": "src/user.ts"')
  })

  it("renders BetterC0de document symbols from an open editor tab", () => {
    useEditorStore.setState({
      tabs: [
        editorTab({
          filePath: "/repo/src/user.ts",
          content: "export function loadUser() { return null }\n",
        }),
      ],
      activeTabId: "/repo/src/user.ts",
    })

    const output = buildProjectLspServersOutput(servers, thread(), "/lsp", [
      "document-symbols",
      "src/user.ts",
    ])

    expect(output).toContain("# BetterC0de LSP Document Symbols")
    expect(output).toContain("## BetterC0de Document Symbols")
    expect(output).toContain("loadUser")
  })

  it("renders BetterC0de LSP usage for alias commands without a target", () => {
    const output = buildProjectLspServersOutput(
      servers,
      thread(),
      "/debug.lsp.symbols",
      []
    )

    expect(output).toContain("# BetterC0de LSP Workspace Symbols")
    expect(output).toContain("betterc0de debug lsp symbols <query>")
  })
})

function editorTab(
  input: Partial<EditorTab> & { filePath: string; content: string }
): EditorTab {
  const fileName = input.filePath.split(/[/\\]/).pop() ?? input.filePath
  return {
    id: input.id ?? input.filePath,
    filePath: input.filePath,
    fileName: input.fileName ?? fileName,
    language: input.language ?? "typescript",
    content: input.content,
    originalContent: input.originalContent ?? input.content,
    revision: 0,
    readGeneration: 0,
    documentVersion: 0,
    aiBaselineContent: input.aiBaselineContent ?? null,
    isDirty: input.isDirty ?? false,
    isLoading: input.isLoading ?? false,
    isPinned: input.isPinned ?? false,
    isPreview: input.isPreview ?? false,
    cursorLine: input.cursorLine ?? 1,
    cursorColumn: input.cursorColumn ?? 1,
    selectionLineCount: input.selectionLineCount ?? 0,
    selectionCharCount: input.selectionCharCount ?? 0,
    ...(input.selectionContext !== undefined
      ? { selectionContext: input.selectionContext }
      : {}),
  }
}

describe("terminal font slash helpers", () => {
  it("normalizes terminal font command values", () => {
    expect(normalizeTerminalFontCommandValue("")).toBeNull()
    expect(normalizeTerminalFontCommandValue("system")).toBe("")
    expect(normalizeTerminalFontCommandValue("default")).toBe("")
    expect(normalizeTerminalFontCommandValue('"JetBrains Mono"')).toBe(
      "JetBrains Mono"
    )
  })

  it("renders the current terminal font status", () => {
    const output = buildTerminalFontOutput("", false)

    expect(output).toContain("Terminal default")
    expect(output).toContain("/terminal-font")
  })
})

describe("diff style slash helpers", () => {
  it("resolves BetterC0de diff style aliases", () => {
    expect(resolveDiffStyleArg("auto", "stacked")).toBe("auto")
    expect(resolveDiffStyleArg("split", "stacked")).toBe("auto")
    expect(resolveDiffStyleArg("stacked", "auto")).toBe("stacked")
    expect(resolveDiffStyleArg("unified", "auto")).toBe("stacked")
    expect(resolveDiffStyleArg(undefined, "auto")).toBe("stacked")
  })

  it("renders diff style command output", () => {
    const output = buildDiffStyleOutput("stacked", true)

    expect(output).toContain("Diff layout updated")
    expect(output).toContain("`stacked`")
    expect(output).toContain("Split diff view is disabled")
  })
})

describe("projectCommandSubtaskLabel", () => {
  it("formats compatibility command subtask metadata for chat output", () => {
    expect(projectCommandSubtaskLabel(true)).toBe("enabled")
    expect(projectCommandSubtaskLabel(false)).toBe("disabled")
    expect(projectCommandSubtaskLabel(undefined)).toBe("-")
  })
})

describe("betterC0deShareModeFromProjectSettings", () => {
  it("resolves BetterC0de share policy including legacy autoshare", () => {
    expect(
      betterC0deShareModeFromProjectSettings([
        { key: "share", value: "disabled" },
      ])
    ).toBe("disabled")
    expect(
      betterC0deShareModeFromProjectSettings([
        { key: "autoshare", value: "true" },
      ])
    ).toBe("auto")
    expect(
      betterC0deShareModeFromProjectSettings([
        { key: "autoshare", value: "true" },
        { key: "share", value: "manual" },
      ])
    ).toBe("manual")
    expect(
      betterC0deShareModeFromProjectSettings([
        { key: "share", value: "manual" },
        { key: "runtime.autoShare", value: "enabled" },
      ])
    ).toBe("auto")
    expect(
      betterC0deShareModeFromProjectSettings([
        { key: "share", value: "disabled" },
        { key: "runtime.autoShare", value: "enabled" },
      ])
    ).toBe("disabled")
    expect(betterC0deShareModeFromProjectSettings([])).toBeNull()
  })
})

describe("session command helpers", () => {
  it("cycles chat modes with BetterC0de-compatible agent cycle semantics", () => {
    // Three modes now: Security and Debug were removed, and Plan moved to a
    // Shift+Tab toggle (see plan-mode-toggle.ts).
    expect(cycleChatMode("agent", 1)).toBe("plan")
    expect(cycleChatMode("ask", 1)).toBe("agent")
    expect(cycleChatMode("agent", -1)).toBe("ask")
    expect(cycleChatMode("unknown", 1)).toBe("agent")
  })

  it("resolves interrupt provider routing with the same fallback order as stop button", () => {
    expect(
      resolveInterruptProviderKind({ id: "codex", providerKind: "betterc0de" })
    ).toBe("betterc0de")
    expect(resolveInterruptProviderKind({ id: "codex" })).toBe("codex")
    expect(resolveInterruptProviderKind(undefined, "claude-terminal")).toBe(
      "claude-terminal"
    )
    expect(resolveInterruptProviderKind(undefined)).toBe("openai")
  })

  it("extracts the latest assistant text for /copy-last", () => {
    expect(
      lastAssistantMessageText([
        message({ role: "assistant", content: "First" }),
        message({ role: "user", content: "Next" }),
        message({ role: "assistant", content: "  Latest answer  " }),
      ])
    ).toBe("Latest answer")
    expect(
      lastAssistantMessageText([
        message({ role: "user", content: "No assistant yet" }),
        message({ role: "assistant", content: "   " }),
      ])
    ).toBeNull()
  })

  it("normalizes rename titles for /rename", () => {
    expect(sanitizeThreadRenameTitle("  New   Session   Title  ")).toBe(
      "New Session Title"
    )
    expect(sanitizeThreadRenameTitle("x".repeat(130))).toHaveLength(120)
  })

  it("builds a compact timeline with message signals", () => {
    const output = buildThreadTimelineMarkdown(
      thread({
        messages: [
          message({ role: "user", content: "Build the thing" }),
          message({
            role: "assistant",
            content: "Done",
            reasoning: "I should edit one file.",
            toolCalls: [
              {
                id: "tool-1",
                name: "Edit",
                input: { path: "src/app.ts" },
                state: "output-available",
              },
            ],
            diffs: [
              {
                path: "src/app.ts",
                additions: 2,
                deletions: 1,
                oldText: "",
                newText: "",
                isNew: false,
              },
            ],
          }),
        ],
      })
    )

    expect(output).toContain("# Session Timeline")
    expect(output).toContain("| 1 |")
    expect(output).toContain("Build the thing")
    expect(output).toContain("thinking, 1 tool, 1 diff")
  })

  it("builds an BetterC0de-compatible event snapshot", () => {
    const output = buildThreadEventsOutputFromSnapshot({
      thread: thread({ title: "Events Test" }),
      activities: [
        activity({
          id: "activity-1",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "approval-1" },
        }),
      ],
      stream: {
        isStreaming: true,
        streamingText: "",
        streamingPlanText: "",
        isPlanStreaming: false,
        reasoningText: "",
        isReasoning: false,
        reasoningStartedAt: null,
        reasoningEndedAt: null,
        lastBoundaryAt: null,
        reasoningSegments: [],
        streamingModelId: "gpt-5.5",
        streamingTools: [
          {
            id: "tool-1",
            name: "Edit",
            input: { path: "src/app.ts" },
            state: "input-available",
          },
        ],
        streamingTasks: [{ text: "Patch event command", completed: false }],
        streamingDiffs: [],
        pendingQuestions: [],
        activeTurnId: "turn-1",
      },
    })

    expect(output).toContain("# Session Events")
    expect(output).toContain("Compatibility reference: `event.subscribe`")
    expect(output).toContain("approval.requested")
    expect(output).toContain("session.status")
    expect(output).toContain("message.part.updated")
    expect(output).toContain("Patch event command")
  })

  it("builds an BetterC0de-compatible session diff summary", () => {
    const output = buildThreadDiffMarkdown(
      thread({
        messages: [
          message({
            role: "assistant",
            content: "Changed file",
            diffs: [
              {
                path: "src/app.ts",
                additions: 2,
                deletions: 1,
                oldText: "",
                newText: "",
                isNew: false,
              },
            ],
          }),
        ],
      }),
      {
        turnDiffs: [
          {
            threadId: "thread-1",
            turnIndex: 1,
            diffText:
              "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new",
            filesChanged: 1,
            insertions: 1,
            deletions: 1,
            createdAt: "2026-05-19T10:00:00.000Z",
          },
        ],
        checkpointDiffs: [
          {
            id: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            checkpointRef: "thread-1/turn/1",
            diffContent:
              "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@\n-old\n+new",
            createdAt: "2026-05-19T10:01:00.000Z",
          },
        ],
      }
    )

    expect(output).toContain("Compatibility reference: `session.diff`")
    expect(output).toContain("| Turn diffs | 1 |")
    expect(output).toContain("| Checkpoint diffs | 1 |")
    expect(output).toContain("| Message diffs | 1 |")
    expect(output).toContain("src/app.ts")
    expect(output).toContain("Use `/diff --full`")
  })

  it("parses BetterC0de-compatible session.message.list arguments", () => {
    expect(
      parseMessageListArgs(["--limit", "5", "--order=asc", "--cursor", "3"])
    ).toEqual({ limit: 5, order: "asc", cursor: 3 })
    expect(parseMessageListArgs(["250"])).toEqual({
      limit: 20,
      order: "desc",
      cursor: 250,
    })
    expect(parseMessageListArgs(["--limit=500"]).limit).toBe(100)
  })

  it("builds a paginated session.message.list view", () => {
    const output = buildThreadMessagesMarkdown(
      thread({
        title: "Message List",
        messages: [
          message({ role: "user", content: "First" }),
          message({ role: "assistant", content: "Second" }),
          message({ role: "user", content: "Third" }),
        ],
      }),
      { limit: 2, order: "desc", cursor: null }
    )

    expect(output).toContain("Compatibility reference: `session.message.list`")
    expect(output).toContain("| Total messages | 3 |")
    expect(output).toContain("| 3 |")
    expect(output).toContain("Third")
    expect(output).toContain(
      "Next page: `/messages --order desc --limit 2 --cursor 1`"
    )
  })

  it("supports ascending message pages with numeric cursors", () => {
    const output = buildThreadMessagesMarkdown(
      thread({
        messages: [
          message({ role: "user", content: "First" }),
          message({ role: "assistant", content: "Second" }),
          message({ role: "user", content: "Third" }),
        ],
      }),
      { limit: 2, order: "asc", cursor: 2 }
    )

    expect(output).toContain("| Cursor | 2 |")
    expect(output).toContain("| 2 |")
    expect(output).toContain("Second")
    expect(output).toContain("| 3 |")
    expect(output).toContain("> End of message list.")
  })

  it("derives active context from the latest compaction summary", () => {
    const slice = activeContextMessagesFromThread(
      thread({
        messages: [
          message({ role: "user", content: "Old request" }),
          message({
            role: "assistant",
            content: "# Compacted Session Context\n\nOld request summary.",
            compactedContext: true,
          }),
          message({ role: "user", content: "Continue from summary" }),
        ],
      })
    )

    expect(slice.compactionIndex).toBe(1)
    expect(slice.messages.map((item) => item.content)).toEqual([
      "# Compacted Session Context\n\nOld request summary.",
      "Continue from summary",
    ])
  })

  it("builds an BetterC0de-compatible session context view", () => {
    const output = buildThreadContextMarkdown({
      thread: thread({
        title: "Context Test",
        usage: { usedTokens: 1200, maxTokens: 200000 },
        messages: [
          message({ role: "user", content: "Old request" }),
          message({
            role: "assistant",
            content: "# Compacted Session Context\n\nOld request summary.",
            compactedContext: true,
          }),
          message({ role: "user", content: "Continue from summary" }),
        ],
      }),
      selectedProvider: { id: "codex", name: "Codex", logo: "", models: [] },
      selectedModel: "gpt-5.5",
      chatMode: "agent",
      permissionLevel: "ask-on-edit",
      contextWindow: "1m",
    })

    expect(output).toContain("Compatibility reference: `session.context`")
    expect(output).toContain("Messages in active context | 2 of 3")
    expect(output).toContain("Compaction boundary | Message 2")
    expect(output).toContain("Provider token usage | 1,200 / 200,000")
    expect(output).toContain("Continue from summary")
  })

  it("resolves fork parent and latest child session navigation", () => {
    const threads = [
      thread({
        id: "parent",
        title: "Parent",
        updatedAt: "2026-05-19T10:00:00.000Z",
      }),
      thread({
        id: "older-child",
        title: "Older Child",
        parentThreadId: "parent",
        updatedAt: "2026-05-19T10:01:00.000Z",
      }),
      thread({
        id: "newer-child",
        title: "Newer Child",
        parentThreadId: "parent",
        updatedAt: "2026-05-19T10:02:00.000Z",
      }),
    ]

    expect(resolveParentThread(threads, "newer-child")?.id).toBe("parent")
    expect(resolveChildThread(threads, "parent")?.id).toBe("newer-child")
    expect(resolveChildThread(threads, "parent", "older")?.id).toBe(
      "older-child"
    )
    expect(resolveSiblingChildThread(threads, "newer-child", 1)?.id).toBe(
      "older-child"
    )
    expect(resolveSiblingChildThread(threads, "older-child", -1)?.id).toBe(
      "newer-child"
    )
    expect(resolveSiblingChildThread(threads, "parent", 1)).toBeNull()
    expect(resolveParentThread(threads, "parent")).toBeNull()
    expect(resolveChildThread(threads, "missing")).toBeNull()
  })

  it("resolves pinned session quick-switch slots in pin order", () => {
    const threads = [
      thread({ id: "a", title: "A" }),
      thread({ id: "b", title: "B" }),
      thread({ id: "c", title: "C" }),
    ]
    const pinned = new Set(["c", "a", "missing"])

    expect(resolvePinnedThreadSlot(threads, pinned, 1)?.id).toBe("c")
    expect(resolvePinnedThreadSlot(threads, pinned, 2)?.id).toBe("a")
    expect(resolvePinnedThreadSlot(threads, pinned, 3)).toBeNull()
    expect(resolvePinnedThreadSlot(threads, pinned, 10)).toBeNull()
  })

  it("resolves BetterC0de app-style adjacent session and project navigation", () => {
    const threads = [
      thread({
        id: "a",
        projectPath: "/repo/a",
        updatedAt: "2026-05-19T10:00:00.000Z",
      }),
      thread({
        id: "b",
        projectPath: "/repo/b",
        updatedAt: "2026-05-19T10:02:00.000Z",
      }),
      thread({
        id: "b-older",
        projectPath: "/repo/b",
        updatedAt: "2026-05-19T09:00:00.000Z",
      }),
      thread({
        id: "c",
        projectPath: "/repo/c",
        updatedAt: "2026-05-19T10:01:00.000Z",
      }),
    ]

    expect(resolveAdjacentSessionThread(threads, "a", 1)?.id).toBe("b")
    expect(resolveAdjacentSessionThread(threads, "a", -1)?.id).toBe("c")
    expect(resolveAdjacentProjectThread(threads, "b-older", 1)?.id).toBe("c")
    expect(resolveAdjacentProjectThread(threads, "b-older", -1)?.id).toBe("a")
    expect(resolveAdjacentProjectThread([threads[0]!], "a", 1)).toBeNull()
  })

  it("resolves session command targets and archived id patches", () => {
    const threads = [
      thread({ id: "alpha-thread", title: "Alpha Build" }),
      thread({ id: "beta-thread", title: "Beta Review" }),
    ]

    expect(resolveSessionCommandThread(threads, "beta-thread", "")?.id).toBe(
      "beta-thread"
    )
    expect(
      resolveSessionCommandThread(threads, "beta-thread", "alpha")?.id
    ).toBe("alpha-thread")
    expect(
      resolveSessionCommandThread(threads, "beta-thread", "review")?.id
    ).toBe("beta-thread")
    expect(resolveSessionCommandThread(threads, null, "missing")).toBeNull()
    expect(archivedThreadIdsAfterAction(["a"], "b", "archive")).toEqual([
      "a",
      "b",
    ])
    expect(archivedThreadIdsAfterAction(["a", "b"], "a", "unarchive")).toEqual([
      "b",
    ])
  })
})

describe("MCP slash helpers", () => {
  const runtimeMcp = {
    id: "github",
    name: "GitHub",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {},
    enabled: true,
    installedAt: "2026-05-19T10:00:00.000Z",
    type: "command",
  }
  const projectMcp = {
    id: "local-demo",
    name: "local-demo",
    command: "node",
    args: ["mcp.js"],
    env: { TOKEN: "hidden" },
    envKeys: ["TOKEN"],
    headerKeys: ["Authorization"],
    enabled: false,
    type: "local",
    sourcePath: "betterc0de.jsonc#mcp.local-demo",
    timeoutMs: 3000,
    oauth: "configured" as const,
    oauthKeys: ["clientId", "scope"],
    authStatus: "authenticated" as const,
    authStorageKeys: ["tokens", "clientInfo"],
    authSourcePath: "~/.local/share/betterc0de/mcp-auth.json",
  }

  it("matches MCP servers by id, name, prefix, or leading slash", () => {
    const mcps = [runtimeMcp, projectMcp]

    expect(resolveRuntimeMcpServer(mcps, "github")?.id).toBe("github")
    expect(resolveRuntimeMcpServer(mcps, "/github")?.id).toBe("github")
    expect(resolveRuntimeMcpServer(mcps, "local")?.id).toBe("local-demo")
    expect(resolveRuntimeMcpServer(mcps, "demo")?.id).toBe("local-demo")
    expect(resolveRuntimeMcpServer(mcps, "missing")).toBeNull()
  })

  it("strips BetterC0de MCP subcommands while preserving UI flags", () => {
    expect(
      stripBetterC0deMcpSlashSubcommand(["add", "--config-only", "docs"])
    ).toEqual(["--config-only", "docs"])
    expect(
      stripBetterC0deMcpSlashSubcommand(["--terminal", "auth", "list"])
    ).toEqual(["--terminal", "list"])
    expect(stripBetterC0deMcpSlashSubcommand(["resources", "github"])).toEqual([
      "github",
    ])
    expect(stripBetterC0deMcpSlashSubcommand(["github", "off"])).toEqual([
      "github",
      "off",
    ])
  })

  it("renders MCP list output with ids and chat-toggle guidance", () => {
    const output = buildMcpServersOutput(
      [runtimeMcp, projectMcp],
      ["--terminal"]
    )

    expect(output).toContain("# MCP Servers")
    expect(output).toContain("2 servers available, 1 active")
    expect(output).toContain("betterc0de mcp list")
    expect(output).toContain("## Terminal")
    expect(output).toContain("`github`")
    expect(output).toContain("env TOKEN")
    expect(output).toContain("headers Authorization")
    expect(output).toContain("timeout 3000ms")
    expect(output).toContain("oauth configured (clientId, scope)")
    expect(output).toContain("auth authenticated (tokens, clientInfo)")
    expect(output).toContain("Project config")
    expect(output).toContain("/mcp-toggle <mcp-id> [on|off]")
  })

  it("renders BetterC0de-compatible MCP resource availability", () => {
    const output = buildMcpResourcesOutput([runtimeMcp, projectMcp], ["local"])
    const json = buildMcpResourcesOutput([runtimeMcp], ["--json"])

    expect(output).toContain("# MCP Resources")
    expect(output).toContain(
      "Compatibility reference: `experimental.resource.list`"
    )
    expect(output).toContain("Filter: `local` (1 match)")
    expect(output).toContain("`local-demo`")
    expect(output).toContain("node mcp.js")
    expect(output).toContain("listResources()")
    expect(json).toContain('"client": "github"')
    expect(json).toContain('"authStatus": null')
  })

  it("renders BetterC0de-compatible MCP auth list output without secrets", () => {
    const output = buildMcpAuthOutput([runtimeMcp, projectMcp], ["--terminal"])

    expect(output).toContain("# MCP Auth")
    expect(output).toContain(
      "Compatibility reference: `betterc0de mcp auth list`"
    )
    expect(output).toContain("betterc0de mcp auth list")
    expect(output).toContain("## Terminal")
    expect(output).toContain("`local-demo`")
    expect(output).toContain("configured (clientId, scope)")
    expect(output).toContain("authenticated (tokens, clientInfo)")
    expect(output).toContain("Stored tokens and client secrets are never shown")
    expect(output).not.toContain("access_token")
    expect(output).not.toContain("clientSecret")
  })

  it("renders BetterC0de MCP add/logout/debug compatibility outputs", () => {
    const addOutput = buildMcpAddOutput({ projectPath: "/repo" }, [
      "--terminal",
    ])
    expect(addOutput).toContain("Compatibility reference: `betterc0de mcp add`")
    expect(addOutput).toContain("betterc0de mcp add")
    expect(addOutput).toContain("Settings > Tools & MCP")
    expect(addOutput).toContain("/repo")

    const logoutOutput = buildMcpLogoutOutput(
      [runtimeMcp, projectMcp],
      "local",
      ["local", "--terminal"]
    )
    expect(logoutOutput).toContain(
      "Compatibility reference: `betterc0de mcp logout <name>`"
    )
    expect(logoutOutput).toContain("~/.local/share/betterc0de/mcp-auth.json")
    expect(logoutOutput).toContain("betterc0de mcp logout local")
    expect(logoutOutput).toContain("does not silently delete")

    const debugOutput = buildMcpDebugOutput([runtimeMcp, projectMcp], "local", [
      "local",
      "--terminal",
    ])
    expect(debugOutput).toContain(
      "Compatibility reference: `betterc0de mcp debug <name>`"
    )
    expect(debugOutput).toContain("# local-demo")
    expect(debugOutput).toContain("betterc0de mcp debug local")
    expect(debugOutput).toContain("Environment keys")
    expect(debugOutput).toContain("Header keys")
    expect(debugOutput).not.toContain("hidden")
  })

  it("renders BetterC0de-compatible thread usage stats", () => {
    const output = buildThreadStatsOutput({
      totalSessions: 2,
      totalMessages: 5,
      totalCost: 0.024,
      totalTokens: {
        input: 1000,
        output: 500,
        reasoning: 250,
        cache: { read: 400, write: 50 },
      },
      toolUsage: { Read: 3, Bash: 2 },
      modelUsage: {
        "openai/gpt-5.5": {
          messages: 2,
          tokens: {
            input: 1000,
            output: 500,
            reasoning: 250,
            cache: { read: 400, write: 50 },
          },
          cost: 0.024,
        },
      },
      dateRange: {
        earliest: "2026-01-01T00:00:00.000Z",
        latest: "2026-01-02T00:00:00.000Z",
      },
      days: 1,
      costPerDay: 0.024,
      tokensPerSession: 1100,
      medianTokensPerSession: 1100,
    })

    expect(output).toContain("Compatibility reference: `betterc0de stats`")
    expect(output).toContain("| Sessions | 2 |")
    expect(output).toContain("| Total tokens | 2,200 |")
    expect(output).toContain("Model usage is hidden by default")
    expect(output).not.toContain("`openai/gpt-5.5`")
    expect(output).toContain("`Read`")
  })

  it("applies BetterC0de-compatible stats model and tool display limits", () => {
    const output = buildThreadStatsOutput(
      {
        totalSessions: 2,
        totalMessages: 5,
        totalCost: 0.024,
        totalTokens: {
          input: 1000,
          output: 500,
          reasoning: 250,
          cache: { read: 400, write: 50 },
        },
        toolUsage: { Read: 3, Bash: 2 },
        modelUsage: {
          "openai/gpt-5.5": {
            messages: 2,
            tokens: {
              input: 1000,
              output: 500,
              reasoning: 250,
              cache: { read: 400, write: 50 },
            },
            cost: 0.024,
          },
          "anthropic/claude": {
            messages: 1,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            cost: 0.001,
          },
        },
        dateRange: {
          earliest: "2026-01-01T00:00:00.000Z",
          latest: "2026-01-02T00:00:00.000Z",
        },
        days: 1,
        costPerDay: 0.024,
        tokensPerSession: 1100,
        medianTokensPerSession: 1100,
      },
      { modelLimit: 1, toolLimit: 1 }
    )

    expect(output).toContain("Models: **1**")
    expect(output).toContain("Tools: **1**")
    expect(output).toContain("`openai/gpt-5.5`")
    expect(output).not.toContain("`anthropic/claude`")
    expect(output).toContain("`Read`")
    expect(output).not.toContain("`Bash`")
  })

  it("parses BetterC0de stats empty project filter as the current project", () => {
    expect(
      parseStatsCommandOptions(["--project="], { projectPath: "/repo" })
    ).toMatchObject({ projectPath: "/repo" })
    expect(
      parseStatsCommandOptions(["--project", '""'], { worktreePath: "/work" })
    ).toMatchObject({ projectPath: "/work" })
    expect(
      parseStatsCommandOptions(["--project", "/other"], {
        projectPath: "/repo",
      })
    ).toMatchObject({ projectPath: "/other" })
  })

  it("validates BetterC0de stats numeric filters before querying", () => {
    const options = parseStatsCommandOptions(
      [
        "--days",
        "soon",
        "--tools=-1",
        "--models",
        "many",
        "--project",
        "--project-path",
      ],
      { projectPath: "/repo" }
    )
    const output = buildThreadStatsOutput(
      {
        totalSessions: 1,
        totalMessages: 1,
        totalCost: 0,
        totalTokens: {
          input: 1,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        toolUsage: {},
        modelUsage: {},
        dateRange: { earliest: null, latest: null },
        days: 1,
        costPerDay: 0,
        tokensPerSession: 3,
        medianTokensPerSession: 3,
      },
      options
    )

    expect(options.validation).toEqual([
      "--days must be a non-negative integer.",
      "--tools must be a non-negative integer.",
      "--models must be a non-negative integer.",
      "--project requires a value. Use `--project=` for the current project.",
      "--project-path requires a value.",
    ])
    expect(output).toContain("## Validation")
    expect(output).toContain("--days must be a non-negative integer")
    expect(output).not.toContain("| Sessions | 1 |")
  })

  it("prefills BetterC0de stats terminal commands with compatible args", () => {
    const options = parseStatsCommandOptions(
      ["--today", "--current-project", "--models", "2", "--terminal"],
      { projectPath: "/repo" }
    )
    const output = buildThreadStatsOutput(
      {
        totalSessions: 1,
        totalMessages: 1,
        totalCost: 0,
        totalTokens: {
          input: 1,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        toolUsage: {},
        modelUsage: {},
        dateRange: {
          earliest: "2026-01-01T00:00:00.000Z",
          latest: "2026-01-01T00:00:00.000Z",
        },
        days: 1,
        costPerDay: 0,
        tokensPerSession: 3,
        medianTokensPerSession: 3,
      },
      options
    )

    expect(options).toMatchObject({
      days: 0,
      projectPath: "/repo",
      modelLimit: 2,
      terminalCommand: "betterc0de stats --days 0 --project= --models 2",
    })
    expect(output).toContain("## Terminal")
    expect(output).toContain("betterc0de stats --days 0 --project= --models 2")
    expect(output).not.toContain("--terminal")
  })

  it("renders BetterC0de-compatible debug info without environment secrets", () => {
    const output = buildRuntimeDebugInfoOutput({
      app: {
        name: "BetterC0de",
        version: "1.2.3",
        backend: "node",
        startedAt: 1779140000000,
        uptimeSeconds: 3661,
      },
      system: {
        platform: "darwin",
        arch: "arm64",
        release: "25.5.0",
        type: "Darwin",
        hostname: "dev-machine",
      },
      process: {
        pid: 1234,
        node: "v24.15.0",
        versions: {
          node: "24.15.0",
          v8: "14.3.0",
          uv: "1.51.0",
          modules: "145",
        },
        cwd: "/Users/test/project",
      },
      terminal: {
        term: "xterm-256color",
        program: "Apple_Terminal",
        shell: "/bin/zsh",
      },
      envOverrides: {
        betterc0deHome: "unset",
        betterc0deDataDir: "set",
      },
      paths: {
        dataDir: "/Users/test/.betterc0de/userdata",
        dbPath: "/Users/test/.betterc0de/userdata/betterc0de.db",
        settingsPath: "/Users/test/.betterc0de/userdata/settings.json",
        authPath: "/Users/test/.betterc0de/userdata/auth.json",
        logsDir: "/Users/test/.betterc0de/userdata/logs",
        providerLogsDir: "/Users/test/.betterc0de/userdata/logs/provider",
        providerEventLogPath:
          "/Users/test/.betterc0de/userdata/logs/provider/events.log",
      },
      database: {
        path: "/Users/test/.betterc0de/userdata/betterc0de.db",
      },
      betterc0de: {
        configDir: "/Users/test/.config/betterc0de",
        configDirSource: "default",
        dataDir: "/Users/test/.local/share/betterc0de",
        stateDir: "/Users/test/.local/state/betterc0de",
        cacheDir: "/Users/test/.cache/betterc0de",
        binDir: "/Users/test/.cache/betterc0de/bin",
        logDir: "/Users/test/.local/share/betterc0de/log",
        reposDir: "/Users/test/.local/share/betterc0de/repos",
        dbPath: "/Users/test/.local/share/betterc0de/betterc0de.db",
        dbPathSource: "default",
        authPath: "/Users/test/.local/share/betterc0de/auth.json",
        mcpAuthPath: "/Users/test/.local/share/betterc0de/mcp-auth.json",
        pluginMetaPath: "/Users/test/.local/state/betterc0de/plugin-meta.json",
        pureMode: true,
        defaultPluginsDisabled: true,
        externalPlugins: "disabled-by-pure",
        defaultPlugins: "disabled-by-env",
      },
    })

    expect(output).toContain("Compatibility reference: `betterc0de debug info`")
    expect(output).toContain("| Version | `1.2.3` |")
    expect(output).toContain("| Uptime | 1h 1m 1s |")
    expect(output).toContain("| NODE_MODULE_VERSION | `145` |")
    expect(output).toContain("external plugins disabled (--pure)")
    expect(output).toContain("disabled (BETTERC0DE_DISABLE_DEFAULT_PLUGINS)")
    expect(output).toContain(
      "/Users/test/.local/state/betterc0de/plugin-meta.json"
    )
    expect(output).toContain("Secrets and environment values are not printed")
    expect(output).not.toContain("TOKEN")
  })

  it("renders BetterC0de-compatible debug paths and db path", () => {
    const info: RuntimeDebugInfo = {
      app: {
        name: "BetterC0de",
        version: "1.2.3",
        backend: "node",
        startedAt: 1779140000000,
        uptimeSeconds: 1,
      },
      system: {
        platform: "darwin",
        arch: "arm64",
        release: "25.5.0",
        type: "Darwin",
        hostname: "dev-machine",
      },
      process: {
        pid: 1234,
        node: "v24.15.0",
        versions: { node: "24.15.0" },
        cwd: "/Users/test/project",
      },
      terminal: {
        term: null,
        program: null,
        shell: null,
      },
      envOverrides: {
        betterc0deHome: "unset",
        betterc0deDataDir: "unset",
      },
      paths: {
        dataDir: "/Users/test/.betterc0de/userdata",
        dbPath: "/Users/test/.betterc0de/userdata/betterc0de.db",
        settingsPath: "/Users/test/.betterc0de/userdata/settings.json",
        authPath: "/Users/test/.betterc0de/userdata/auth.json",
        logsDir: "/Users/test/.betterc0de/userdata/logs",
        providerLogsDir: "/Users/test/.betterc0de/userdata/logs/provider",
        providerEventLogPath:
          "/Users/test/.betterc0de/userdata/logs/provider/events.log",
      },
      database: {
        path: "/Users/test/.betterc0de/userdata/betterc0de.db",
      },
      betterc0de: {
        configDir: "/Users/test/.config/betterc0de",
        configDirSource: "default",
        dataDir: "/Users/test/.local/share/betterc0de",
        stateDir: "/Users/test/.local/state/betterc0de",
        cacheDir: "/Users/test/.cache/betterc0de",
        binDir: "/Users/test/.cache/betterc0de/bin",
        logDir: "/Users/test/.local/share/betterc0de/log",
        reposDir: "/Users/test/.local/share/betterc0de/repos",
        dbPath: "/Users/test/.local/share/betterc0de/custom.db",
        dbPathSource: "BETTERC0DE_DB",
        authPath: "/Users/test/.local/share/betterc0de/auth.json",
        mcpAuthPath: "/Users/test/.local/share/betterc0de/mcp-auth.json",
        pluginMetaPath: "/Users/test/.local/state/betterc0de/plugin-meta.json",
      },
    }
    const output = buildRuntimeDebugPathsOutput(info)
    const dbPath = buildBetterC0deDbPathOutput(info, "/betterc0de-db-path", [
      "--format",
      "json",
      "--terminal",
    ])

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug paths` / `betterc0de db path`"
    )
    expect(output).toContain("| SQLite database |")
    expect(output).toContain("betterc0de.db")
    expect(output).toContain("| Compatibility data dir |")
    expect(output).toContain(
      "| BetterC0de compatibility config source | `default` |"
    )
    expect(output).toContain("| Compatibility state dir |")
    expect(output).toContain("| Compatibility plugin metadata |")
    expect(output).toContain("plugin-meta.json")
    expect(output).toContain("custom.db")
    expect(output).toContain(
      "| BetterC0de compatibility database source | `BETTERC0DE_DB` |"
    )
    expect(output).toContain(
      "Auth contents and other secrets are not displayed"
    )
    expect(dbPath).toContain("# BetterC0de DB Path")
    expect(dbPath).toContain("Compatibility reference: `betterc0de db path`")
    expect(dbPath).toContain("betterc0de db path --format json")
    expect(dbPath).toContain("| BetterC0de compatibility database |")
    expect(dbPath).toContain("custom.db")
    expect(dbPath).toContain(
      "| BetterC0de compatibility database source | `BETTERC0DE_DB` |"
    )
    expect(dbPath).toContain("| BetterC0de database |")
    expect(dbPath).toContain("## Validation")
    expect(dbPath).toContain(
      "`--format` is only valid for BetterC0de DB queries"
    )
    expect(dbPath).toContain("terminal panel")
  })

  it("renders BetterC0de-compatible heap snapshot output", () => {
    const output = buildRuntimeHeapSnapshotOutput({
      path: "/Users/test/.betterc0de/userdata/logs/heap-42.heapsnapshot",
      bytes: 1536,
    })

    expect(output).toContain("Compatibility reference: `app.heap_snapshot`")
    expect(output).toContain("heap-42.heapsnapshot")
    expect(output).toContain("| Size | 1.5 KB |")
    expect(output).toContain("Keep heap snapshots local")
  })

  it("renders BetterC0de-compatible debug file search outputs", () => {
    const filesOutput = buildDebugRgFilesOutput("/repo", "chat", [
      { path: "src/chat.ts", name: "chat.ts" },
      { path: "src/chat-transcript.tsx", name: "chat-transcript.tsx" },
    ])
    const searchOutput = buildDebugRgSearchOutput("/repo", "useChatSubmit", [
      {
        path: "src/hooks/use-chat-submit.ts",
        name: "use-chat-submit.ts",
        matches: [
          {
            line: 42,
            column: 7,
            length: 13,
            previewColumn: 7,
            previewLength: 13,
            preview: "export function useChatSubmit()",
          },
        ],
      },
    ])

    expect(filesOutput).toContain(
      "Compatibility reference: `betterc0de debug rg files`"
    )
    expect(filesOutput).toContain("`src/chat.ts`")
    expect(searchOutput).toContain(
      "Compatibility reference: `betterc0de debug rg search <pattern>`"
    )
    expect(searchOutput).toContain("src/hooks/use-chat-submit.ts:42:7")
  })

  it("parses BetterC0de debug rg query and glob flags separately", () => {
    expect(
      resolveDebugRgRequest("/debug.rg.files", [
        "--query",
        "chat",
        "--glob",
        "*.ts",
        "--limit=20",
      ])
    ).toMatchObject({
      mode: "files",
      args: [],
      query: "chat",
      globs: ["*.ts"],
      limit: 20,
    })
    expect(
      resolveDebugRgRequest("/debug-rg", [
        "search",
        "useChatSubmit",
        "-g=src/**/*.ts",
      ])
    ).toMatchObject({
      mode: "search",
      args: ["useChatSubmit"],
      globs: ["src/**/*.ts"],
    })
  })

  it("renders BetterC0de debug rg glob filters in output", () => {
    const filesOutput = buildDebugRgFilesOutput(
      "/repo",
      "chat",
      [{ path: "src/chat.ts", name: "chat.ts" }],
      ["*.ts"]
    )
    const searchOutput = buildDebugRgSearchOutput(
      "/repo",
      "useChatSubmit",
      [],
      ["src/**/*.ts"]
    )

    expect(filesOutput).toContain("Glob: `*.ts`")
    expect(searchOutput).toContain("Glob: `src/**/*.ts`")
  })

  it("renders BetterC0de-compatible debug file read output", () => {
    const output = buildDebugFileReadOutput(
      "/repo",
      "package.json",
      '{ "name": "betterc0de" }\n'
    )

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug file read <path>`"
    )
    expect(output).toContain("Compatibility HTTP reference: `file.read`")
    expect(output).toContain("File: `package.json`")
    expect(output).toContain('{ "name": "betterc0de" }')
  })

  it("renders BetterC0de-compatible debug file status output", () => {
    const output = buildDebugFileStatusOutput("/repo", {
      branch: "main",
      is_clean: false,
      staged: ["src/app.ts"],
      modified: ["src/chat.ts"],
      untracked: ["notes.md"],
      ahead: 1,
      behind: 2,
      upstream: "origin/main",
    })

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug file status`"
    )
    expect(output).toContain("Compatibility HTTP reference: `file.status`")
    expect(output).toContain("| Branch | main |")
    expect(output).toContain("`src/app.ts`")
    expect(output).toContain("`notes.md`")
  })

  it("renders BetterC0de-compatible debug file list output", () => {
    const output = buildDebugFileListOutput("/repo", "src", {
      rootName: "repo",
      totalFiles: 3,
      scannedFiles: 3,
      codeFiles: 3,
      totalBytes: 300,
      truncated: false,
      files: [
        {
          path: "src/app.ts",
          name: "app.ts",
          directory: "src",
          extension: "ts",
          sizeBytes: 100,
          kind: "source",
        },
        {
          path: "src/components/button.tsx",
          name: "button.tsx",
          directory: "src/components",
          extension: "tsx",
          sizeBytes: 200,
          kind: "source",
        },
      ],
      topDirectories: [],
      extensions: [],
      importantFiles: [],
      largestFiles: [],
    })

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug file list <path>`"
    )
    expect(output).toContain("Compatibility HTTP reference: `file.list`")
    expect(output).toContain("Directory: `src`")
    expect(output).toContain("`components/`")
    expect(output).toContain("`app.ts`")
  })

  it("renders BetterC0de-compatible debug file tree output", () => {
    const output = buildDebugRgTreeOutput("/repo", {
      rootName: "repo",
      totalFiles: 12,
      scannedFiles: 12,
      codeFiles: 7,
      totalBytes: 4096,
      truncated: false,
      files: [],
      topDirectories: [
        {
          path: "src",
          name: "src",
          fileCount: 7,
          codeFileCount: 7,
          totalBytes: 3072,
        },
      ],
      extensions: [],
      importantFiles: [
        {
          path: "package.json",
          name: "package.json",
          directory: "",
          extension: ".json",
          sizeBytes: 1024,
          kind: "config",
        },
      ],
      largestFiles: [],
    })

    expect(output).toContain(
      "Compatibility reference: `betterc0de debug rg tree` / `betterc0de debug file tree`"
    )
    expect(output).toContain("| Total files | 12 |")
    expect(output).toContain("`package.json`")
  })

  it("renders BetterC0de-compatible debug snapshot track and diff output", () => {
    const diffs = {
      turnDiffs: [],
      checkpointDiffs: [
        {
          id: 1,
          threadId: "thread-abc123",
          turnId: "turn-1",
          checkpointRef: "refs/betterc0de/checkpoints/thread-abc123/turn/3",
          diffContent:
            "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n+export const ok = true\n",
          createdAt: "2026-05-19T10:00:00.000Z",
        },
      ],
    }

    const track = buildDebugSnapshotMarkdown(
      "thread-abc123",
      diffs,
      "/debug-snapshot",
      ["track"]
    )
    const diff = buildDebugSnapshotMarkdown(
      "thread-abc123",
      diffs,
      "/debug.snapshot.diff",
      ["turn/3"]
    )

    expect(track).toContain("betterc0de debug snapshot track")
    expect(track).toContain("Checkpoint diffs | 1")
    expect(diff).toContain("betterc0de debug snapshot diff <hash>")
    expect(diff).toContain("export const ok = true")
    expect(diff).toContain("git-backed checkpoint diffs")
  })

  it("renders BetterC0de-compatible session list JSON", () => {
    const options = parseSessionListOptions(["--format", "json", "-n", "1"])
    const output = buildSessionsOutput(
      [
        {
          id: "thread-abc123",
          title: "Fix Provider Menu",
          projectName: "BetterC0de",
          projectPath: "/repo",
          createdAt: "2026-05-19T08:00:00.000Z",
          updatedAt: "2026-05-19T09:00:00.000Z",
        },
        {
          id: "thread-def456",
          title: "Design Mode",
          projectName: "BetterC0de",
          projectPath: "/repo",
          createdAt: "2026-05-18T08:00:00.000Z",
          updatedAt: "2026-05-18T09:00:00.000Z",
        },
      ],
      "thread-abc123",
      options
    )

    expect(options).toEqual({ format: "json", maxCount: 1 })
    expect(output).toContain(
      "Compatibility reference: `betterc0de session list --format json`"
    )
    expect(output).toContain('"id": "thread-abc123"')
    expect(output).toContain('"projectId": "BetterC0de"')
    expect(output).toContain('"directory": "/repo"')
    expect(output).not.toContain("thread-def456")
  })

  it("renders BetterC0de-compatible session list table with max count", () => {
    const output = buildSessionsOutput(
      [
        {
          id: "thread-abc123",
          title: "Fix Provider Menu",
          projectName: "BetterC0de",
          projectPath: "/repo",
          updatedAt: "2026-05-19T09:00:00.000Z",
        },
      ],
      "thread-abc123",
      parseSessionListOptions(["--max-count=20"])
    )

    expect(output).toContain(
      "Compatibility reference: `betterc0de session list`"
    )
    expect(output).toContain("Showing up to 20 sessions.")
    expect(output).toContain("Active")
  })

  it("applies BetterC0de v2 session list filters locally", () => {
    const options = parseSessionListOptions([
      "--order",
      "asc",
      "--search",
      "design",
      "--path",
      "/repo",
      "--roots",
      "true",
      "--start",
      "1779145200000",
      "--cursor",
      "opaque",
    ])
    const output = buildSessionsOutput(
      [
        {
          id: "thread-old",
          title: "Provider work",
          projectName: "BetterC0de",
          projectPath: "/repo",
          parentThreadId: null,
          updatedAt: "2026-05-18T10:00:00.000Z",
        },
        {
          id: "thread-match",
          title: "Design Mode",
          projectName: "BetterC0de",
          projectPath: "/repo",
          parentThreadId: null,
          updatedAt: "2026-05-19T10:00:00.000Z",
        },
        {
          id: "thread-child",
          title: "Design child",
          projectName: "BetterC0de",
          projectPath: "/repo",
          parentThreadId: "thread-match",
          updatedAt: "2026-05-19T11:00:00.000Z",
        },
      ],
      "thread-match",
      options
    )

    expect(options).toMatchObject({
      order: "asc",
      search: "design",
      path: "/repo",
      roots: true,
      start: 1779145200000,
      cursor: "opaque",
    })
    expect(output).toContain("Filters: order=asc, search=design")
    expect(output).toContain("BetterC0de opaque cursors are accepted")
    expect(output).toContain("Design Mode")
    expect(output).not.toContain("thread-old")
    expect(output).not.toContain("thread-child")
  })

  it("parses BetterC0de session.update arguments without treating flags as titles", () => {
    expect(parseSessionUpdateArgs(["--title", "New title"])).toEqual({
      title: "New title",
    })
    expect(parseSessionUpdateArgs(["--archive=false"])).toEqual({
      archived: false,
    })
    expect(parseSessionUpdateArgs(["--time.archived", "true"])).toEqual({
      archived: true,
    })
    expect(parseSessionUpdateArgs(["--permission", "edit=ask"])).toEqual({
      permission: "edit=ask",
    })
  })

  it("renders project-local MCP details as config-controlled", () => {
    const output = buildRuntimeMcpDetailOutput(projectMcp)

    expect(output).toContain("# local-demo")
    expect(output).toContain("Disabled")
    expect(output).toContain("| **Timeout** | 3000 ms |")
    expect(output).toContain("| **OAuth** | configured (clientId, scope) |")
    expect(output).toContain(
      "| **Auth status** | authenticated (tokens, clientInfo) |"
    )
    expect(output).toContain(
      "| **Auth source** | `~/.local/share/betterc0de/mcp-auth.json` |"
    )
    expect(output).toContain("betterc0de.jsonc#mcp.local-demo")
    expect(output).toContain("Project-local MCPs are controlled")
  })
})
