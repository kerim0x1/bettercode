import { describe, expect, it, vi } from "vitest"
import {
  dispatchSlashCommand,
  findSlashCommand,
  indexSlashCommands,
  slashCommandNames,
} from "./slash-registry"

describe("slash command registry dispatch", () => {
  it("resolves aliases through the registry instead of a sequential callback ladder", () => {
    const index = indexSlashCommands([
      {
        names: ["help", "help.show"],
        run: () => "# Help",
      },
      {
        names: ["diff", "session.diff"],
        run: (context: { thread: string }) => `# Diff ${context.thread}`,
      },
    ])

    expect(dispatchSlashCommand("/help", { thread: "a" }, index)).toBe("# Help")
    expect(dispatchSlashCommand("/help.show", { thread: "a" }, index)).toBe(
      "# Help"
    )
    expect(dispatchSlashCommand("/session.diff", { thread: "t1" }, index)).toBe(
      "# Diff t1"
    )
    expect(
      dispatchSlashCommand("/unknown", { thread: "a" }, index)
    ).toBeUndefined()
  })

  it("gives a shared name to the first registered spec whose guard passes", () => {
    type Context = { args: string[] }
    const index = indexSlashCommands<Context, string>([
      {
        names: ["mcp"],
        when: ({ args }) => args[0] === "add",
        run: () => "add",
      },
      { names: ["mcps", "mcp"], run: () => "list" },
      { names: ["mcp"], run: () => "shadowed" },
    ])

    expect(dispatchSlashCommand("/mcp", { args: ["add"] }, index)).toBe("add")
    expect(dispatchSlashCommand("/mcp", { args: [] }, index)).toBe("list")
    expect(dispatchSlashCommand("/mcps", { args: ["add"] }, index)).toBe("list")
  })

  it("leaves a command unhandled when every guard for it declines", () => {
    const run = vi.fn(() => "ran")
    const index = indexSlashCommands<{ args: string[] }, string>([
      { names: ["models"], when: ({ args }) => args.length === 0, run },
    ])

    expect(
      findSlashCommand("/models", { args: ["gpt"] }, index)
    ).toBeUndefined()
    expect(
      dispatchSlashCommand("/models", { args: ["gpt"] }, index)
    ).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it("registers a spec once even when it lists a name twice", () => {
    const spec = { names: ["export", "export", "session.export"], run: () => 1 }
    const index = indexSlashCommands([spec])

    expect(index.get("/export")).toEqual([spec])
    expect(slashCommandNames([spec, { names: ["export", "import"] }])).toEqual([
      "export",
      "session.export",
      "import",
    ])
  })
})
