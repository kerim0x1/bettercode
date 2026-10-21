import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  BETTERC0DE_INPUT_ACTION_COMMANDS,
  BETTERC0DE_KEYBIND_DEFAULTS,
} from "@/lib/betterc0de-keybinds"
import {
  BUILTIN_SLASH_COMMAND_NAMES,
  PRE_RUNTIME_SLASH_INDEX,
  PRE_RUNTIME_SLASH_SPECS,
  RUNTIME_SLASH_INDEX,
} from "./builtin-slash-specs"
import { useChatStore } from "@/lib/chat-store"
import { runRegisteredSlashCommand } from "@/lib/slash-command-runtime"
import { findSlashCommand } from "./slash-registry"
import type {
  SlashCommandRun,
  SlashCommandRuntimeRun,
  SlashRuntimeContext,
} from "./slash-run"

// Guards only read the command and its arguments.
function preRuntimeSpec(cmd: string, args: string[] = []) {
  const context = { cmd, args } as unknown as SlashCommandRun
  return findSlashCommand(cmd, context, PRE_RUNTIME_SLASH_INDEX)
}

function runtimeSpec(cmd: string, args: string[] = []) {
  const context = { cmd, args } as unknown as SlashCommandRuntimeRun
  return findSlashCommand(cmd, context, RUNTIME_SLASH_INDEX)
}

describe("built-in slash command specs", () => {
  it("never registers a pre-runtime name twice, so that phase is order-independent", () => {
    const names = PRE_RUNTIME_SLASH_SPECS.flatMap((spec) => [
      ...new Set(spec.names),
    ])
    expect(names.length).toBe(new Set(names).size)
  })

  it("hands `/models <query>` to the model catalog instead of the picker", () => {
    expect(preRuntimeSpec("/models")?.names).toContain("model.choose")
    expect(preRuntimeSpec("/model", ["gpt"])?.names).toContain("model.choose")
    expect(preRuntimeSpec("/models", ["gpt"])).toBeUndefined()
    expect(runtimeSpec("/models", ["gpt"])?.names).toContain("catalog")
  })

  it("leaves `/agent <subcommand>` to the subagent specs", () => {
    expect(preRuntimeSpec("/agent")?.names).toContain("agent.cycle")
    expect(preRuntimeSpec("/agent", ["list"])).toBeUndefined()
    expect(runtimeSpec("/agent", ["list"])?.names).toEqual(["agent"])
    expect(runtimeSpec("/agent", ["inspect", "reviewer"])?.names).toEqual([
      "agent",
    ])
    expect(runtimeSpec("/agent", ["new"])?.names).toEqual(["agent"])
    expect(runtimeSpec("/agent")).toBeUndefined()
  })

  it("lists sessions for `/resume` once the pre-runtime spec found no chat", () => {
    expect(preRuntimeSpec("/resume", ["missing"])?.names).toEqual([
      "resume",
      "continue",
    ])
    expect(runtimeSpec("/resume", ["missing"])?.names).toContain("sessions")
    expect(runtimeSpec("/continue")?.names).toContain("sessions")
  })

  it.each([
    ["/session", ["list"], "session"],
    ["/session", ["rm", "abc"], "session"],
    ["/mcp", ["add", "github"], "mcp"],
    ["/mcp", ["ls"], "mcp"],
    ["/providers", ["login"], "providers"],
    ["/auth", ["logout"], "providers"],
    ["/console", ["logout"], "console"],
    ["/account", ["switch"], "console"],
  ])(
    "routes %s %j to its subcommand spec before the bare command",
    (cmd, args, first) => {
      const spec = runtimeSpec(cmd, args)
      expect(spec?.when).toBeDefined()
      expect(spec?.names[0]).toBe(first)
    }
  )

  it.each([
    ["/session", "sessions"],
    ["/mcp", "mcps"],
    ["/providers", "settings"],
    ["/auth", "auth.list"],
    ["/console", "app.console"],
    ["/account", "account.list"],
  ])("keeps the bare %s for the spec that owns %s", (cmd, owner) => {
    expect(runtimeSpec(cmd)?.names).toContain(owner)
  })

  it("answers `/auth.set` with the auth control spec, not the internal route", () => {
    expect(runtimeSpec("/auth.set")?.names).toContain("auth-set")
    expect(runtimeSpec("/auth.remove")?.names).toContain("auth-remove")
    expect(runtimeSpec("/tui.openHelp")?.names).toContain("betterc0de-internal")
  })

  it("registers the pattern-style commands by name", () => {
    expect(preRuntimeSpec("/session.quick_switch.3")?.names).toContain(
      "quick-switch"
    )
    expect(preRuntimeSpec("/session.quick_switch.0")).toBeUndefined()
    expect(runtimeSpec("/streaming")?.names).toEqual(["streaming"])
    expect(runtimeSpec("/settings", ["tools"])?.names).toContain("preferences")
    for (const command of BETTERC0DE_INPUT_ACTION_COMMANDS) {
      expect(runtimeSpec(`/${command}`)?.names).toContain("input-actions")
    }
  })

  it("has a built-in command for every keybind slash alias", () => {
    const names = new Set(BUILTIN_SLASH_COMMAND_NAMES)
    const missing = BETTERC0DE_KEYBIND_DEFAULTS.flatMap((item) =>
      item.slash && !names.has(item.slash.replace(/^\//, ""))
        ? [item.slash]
        : []
    )
    expect(missing).toEqual([])
    expect(BUILTIN_SLASH_COMMAND_NAMES.length).toBe(names.size)
  })
})

describe("built-in slash command precedence end to end", () => {
  function slashContext(
    cmd: string,
    args: string[],
    overrides: Partial<SlashRuntimeContext> = {}
  ): SlashRuntimeContext {
    const text = [cmd, ...args].join(" ")
    return {
      cmd,
      args,
      trimmedText: text,
      rawText: text,
      threadId: null,
      selectedProvider: undefined,
      selectedModel: "test-model",
      thinkingMode: null,
      chatMode: "agent",
      setChatMode: () => {},
      specialMode: null,
      permissionLevel: "ask",
      contextWindow: "default",
      fastMode: false,
      appMode: "agent",
      closeSlash: () => {},
      activeThread: null,
      effectiveChatMode: "agent",
      ...overrides,
    }
  }

  beforeEach(() => {
    useChatStore.setState({
      threads: [],
      activeThreadId: null,
      messagesLoadedByThread: {},
    })
  })

  it("shows the model catalog for `/models <query>` without opening the picker", async () => {
    const closeSlash = vi.fn()
    const openModelPicker = vi.fn()
    const result = await runRegisteredSlashCommand(
      slashContext("/models", ["gpt-5"], { closeSlash, openModelPicker })
    )

    expect(result?.output).toContain("# Model Catalog")
    expect(closeSlash).not.toHaveBeenCalled()
    expect(openModelPicker).not.toHaveBeenCalled()
  })

  it("lists sessions when `/resume <title>` finds no chat", async () => {
    const result = await runRegisteredSlashCommand(
      slashContext("/resume", ["missing-chat"])
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toContain("# Sessions")
  })

  it("lists subagents for `/agent list` instead of cycling the agent", async () => {
    const result = await runRegisteredSlashCommand(
      slashContext("/agent", ["list"])
    )

    expect(result?.output).toContain("# Subagents")
  })
})
