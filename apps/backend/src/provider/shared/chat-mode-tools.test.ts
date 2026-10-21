import { describe, expect, it } from "vitest"
import {
  IMAGEGEN_TOOL_NAME,
  PLAN_MODE_DENY_MESSAGE,
  classifyToolPermission,
  createClaudePreToolUseApprovalHook,
  isImagegenAutoAllowed,
  getToolsForMode,
} from "./chat-mode-tools"

describe("chat-mode tool rules", () => {
  it("keeps plan mode on explicit read-only planning tools", () => {
    expect(getToolsForMode("Plan")).toEqual(getToolsForMode("plan"))
    expect(getToolsForMode("nope")).toEqual(getToolsForMode("plan"))
    expect(getToolsForMode(null)).toContain("Bash")
    expect(getToolsForMode("plan")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "AskUserQuestion",
      "ExitPlanMode",
    ])
  })

  it("keeps ask mode read-only instead of disabling codebase context", () => {
    expect(getToolsForMode("ask")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
    ])
  })

  it("keeps security mode audit-focused with shell approval available", () => {
    expect(getToolsForMode("security")).toEqual([
      "Read",
      "Bash",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
    ])
  })

  it("auto-allows imagegen only for explicit edit/bypass permission", () => {
    expect(isImagegenAutoAllowed("agent", "allow-edits")).toBe(true)
    expect(isImagegenAutoAllowed("agent", "full")).toBe(true)
    expect(isImagegenAutoAllowed("agent", "read")).toBe(false)
    expect(isImagegenAutoAllowed("debug", "bypass")).toBe(true)
    expect(isImagegenAutoAllowed("agent", "default")).toBe(false)
    expect(isImagegenAutoAllowed("agent", "ask-on-edit")).toBe(false)
    expect(isImagegenAutoAllowed("agent", null)).toBe(false)
    expect(isImagegenAutoAllowed("plan", "bypass")).toBe(false)
    expect(isImagegenAutoAllowed("ask", "bypass")).toBe(false)
    expect(isImagegenAutoAllowed("security", "bypass")).toBe(false)
    // MCP tools never join AGENT_TOOLS — that list feeds the builtins-only
    // SDK `tools` option.
    expect(getToolsForMode("agent")).not.toContain(IMAGEGEN_TOOL_NAME)
  })

  it("classifies the imagegen tool as mutating", () => {
    expect(classifyToolPermission(IMAGEGEN_TOOL_NAME)).toBe("mutate")
  })

  it("keeps TodoWrite available in agent mode for BetterC0de-style progress tracking", () => {
    expect(getToolsForMode("agent")).toContain("TodoWrite")
    expect(classifyToolPermission("TodoWrite")).toBe("mutate")
  })

  it("classifies plan submit/question tools as non-mutating", () => {
    expect(classifyToolPermission("AskUserQuestion")).toBe("read")
    expect(classifyToolPermission("ExitPlanMode")).toBe("read")
  })

  // classifyToolPermission is the hard Plan/Ask/read-only gate, and MCP tool
  // names are chosen by whoever configured the server — including a project's
  // own betterc0de.json. A substring match ("does it contain 'read'?") made the
  // classification forgeable, so a tool called `read_and_apply` executed in Plan
  // mode with no prompt. Membership must be exact; unrecognized means unknown,
  // and every caller treats `!== "read"` as needing approval.
  it("does not infer read-only capability from a tool's name", () => {
    for (const name of [
      "mcp__server__read_and_apply_ab12",
      "mcp__server__grep_replace_cd34",
      "mcp__server__websearch_and_write_ef56",
      "mcp__server__glob_delete_7890",
      "readwrite",
      "spread_files",
      "unlink_readme",
    ]) {
      expect(classifyToolPermission(name), name).not.toBe("read")
    }
  })

  it("keeps the exact builtin read set classified read", () => {
    for (const name of [
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
      "ExitPlanMode",
    ]) {
      expect(classifyToolPermission(name), name).toBe("read")
    }
  })

  it("forces native Claude auto-allow rules through BetterC0de policy", async () => {
    await expect(createClaudePreToolUseApprovalHook()()).resolves.toEqual({
      continue: true,
      hookSpecificOutput: expect.objectContaining({
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      }),
    })
  })

  it("denies mutating plan-mode work with a clear file/code message", () => {
    expect(PLAN_MODE_DENY_MESSAGE).toContain("no file creation")
    expect(PLAN_MODE_DENY_MESSAGE).toContain("code edits")
    expect(PLAN_MODE_DENY_MESSAGE).toContain("shell commands")
  })
})
