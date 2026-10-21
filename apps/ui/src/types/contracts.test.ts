import { describe, it, expect } from "vitest"
import {
  threadSaveSchema,
  threadMetaSchema,
  threadMessageSchema,
  settingsSchema,
  defaultSettings,
  skillSchema,
  mcpServerSchema,
  hookSchema,
} from "@betterc0de/schema"

describe("threads schema", () => {
  it("threadSaveSchema accepts a minimal valid body", () => {
    const result = threadSaveSchema.parse({
      id: "t-1",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    })
    expect(result.id).toBe("t-1")
    expect(result.title).toBe("New Chat")
    expect(result.projectName).toBe("default")
    expect(result.messages).toEqual([])
  })

  it("threadSaveSchema rejects missing id", () => {
    expect(() =>
      threadSaveSchema.parse({ createdAt: "x", updatedAt: "y" })
    ).toThrow()
  })

  it("threadMetaSchema accepts codexThreadId as null", () => {
    const result = threadMetaSchema.parse({
      createdAt: "a",
      updatedAt: "b",
      codexThreadId: null,
    })
    expect(result.codexThreadId).toBeNull()
  })

  it("threadMessageSchema requires id and createdAt", () => {
    expect(() =>
      threadMessageSchema.parse({ role: "user", content: "hi" })
    ).toThrow()
  })

  it("threadMessageSchema preserves structured attachments", () => {
    const parsed = threadMessageSchema.parse({
      id: "m-1",
      role: "user",
      content: "inspect this",
      createdAt: "2026-01-01T00:00:00Z",
      attachments: [
        {
          type: "file",
          filename: "screen.png",
          mediaType: "image/png",
          url: "data:image/png;base64,aGVsbG8=",
        },
      ],
    })

    expect(parsed.attachments).toEqual([
      {
        type: "file",
        filename: "screen.png",
        mediaType: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
      },
    ])
  })
})

describe("settings schema", () => {
  it("defaultSettings() returns a fully-populated object", () => {
    const s = defaultSettings()
    expect(s.theme).toBe("dark")
    expect(s.language).toBe("en")
    expect(s.time_format).toBe("24h")
    expect(s.enable_assistant_streaming).toBe(true)
    expect(s.show_message_timestamps).toBe(true)
    expect(s.show_thinking_blocks).toBe(true)
    expect(s.show_tool_details).toBe(false)
    expect(s.show_chat_scrollbar).toBe(false)
    expect(s.show_generic_tool_output).toBe(false)
    expect(s.conceal_code_blocks).toBe(false)
    expect(s.backend_log_level).toBe("info")
    expect(s.backend_log_format).toBe("simple")
    expect(s.backend_trace_http).toBe(false)
    expect(s.backend_trace_provider_events).toBe(false)
    // Telemetry is opt-in.
    expect(s.crash_reports_enabled).toBe(false)
    expect(s.usage_ping_enabled).toBe(false)
    expect(s.providers).not.toHaveProperty("BetterC0de")
    // Legacy keys: the desktop configuration files hold these now, so a
    // fresh settings object has none of them.
    expect(s.mcp_servers).toBeUndefined()
    expect(s.hooks).toBeUndefined()
    expect(s.skills).toBeUndefined()
  })

  it("migrates legacy BetterC0de provider settings to canonical BetterC0de settings", () => {
    const parsed = settingsSchema.parse({
      providers: {
        BetterC0de: {
          enabled: false,
          binaryPath: "/opt/legacy-open-code",
          custom_models: ["legacy/model"],
        },
      },
    })

    expect(parsed.providers.betterc0de).toMatchObject({
      enabled: false,
      binaryPath: "/opt/legacy-open-code",
      custom_models: ["legacy/model"],
    })
    expect(parsed.providers).not.toHaveProperty("BetterC0de")
  })

  it("settingsSchema rejects undeclared root fields", () => {
    expect(() =>
      settingsSchema.parse({
        theme: "light",
        custom_future_field: 42,
      })
    ).toThrow(/Unrecognized key/)
  })

  it("defaults the helper models and restores a default for a blank value", () => {
    const defaults = defaultSettings()
    expect(defaults.image_generation_model).toBe("gpt-5.5")
    expect(defaults.commit_message_codex_model).toBe("gpt-5.6-luna")
    expect(defaults.commit_message_claude_model).toBe("claude-sonnet-5")

    const parsed = settingsSchema.parse({
      image_generation_model: " gpt-image-3 ",
      commit_message_codex_model: "",
      commit_message_claude_model: null,
    })
    expect(parsed.image_generation_model).toBe("gpt-image-3")
    expect(parsed.commit_message_codex_model).toBe("gpt-5.6-luna")
    expect(parsed.commit_message_claude_model).toBe("claude-sonnet-5")
  })

  it("rejects helper model ids that are not a single model id", () => {
    for (const value of ["gpt-5.5 & calc", "--model=x", "a b", 42]) {
      expect(
        settingsSchema.safeParse({ image_generation_model: value }).success
      ).toBe(false)
    }
    expect(
      settingsSchema.safeParse({
        commit_message_claude_model: "x".repeat(201),
      }).success
    ).toBe(false)
  })

  it("skillSchema requires id and name", () => {
    expect(() => skillSchema.parse({ id: "s-1" })).toThrow()
    const ok = skillSchema.parse({ id: "s-1", name: "My Skill" })
    expect(ok.enabled).toBe(true)
    expect(ok.description).toBe("")
  })

  it("mcpServerSchema requires id/name/command", () => {
    const ok = mcpServerSchema.parse({
      id: "m-1",
      name: "gh",
      command: "gh",
    })
    expect(ok.args).toBe("")
    expect(ok.envVars).toBe("")
    expect(ok.enabled).toBe(true)
  })

  it("hookSchema rejects an invalid event enum", () => {
    expect(() =>
      hookSchema.parse({ id: "h-1", event: "on_nothing", command: "true" })
    ).toThrow()
  })
})
