import { describe, expect, it } from "vitest"
import {
  OPENCODE_RUNTIME_PROFILE,
  buildOpenCodeAcpSpawnInput,
  openCodeAuthError,
  openCodePermissionConfigEnv,
} from "./OpenCodeAcpRuntime"

function configOf(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "null") as Record<
    string,
    unknown
  >
}

describe("buildOpenCodeAcpSpawnInput", () => {
  it("defaults to the bare `opencode acp` command", () => {
    const input = buildOpenCodeAcpSpawnInput({}, "/tmp/project", {
      PATH: "/usr/bin",
    })

    expect(input.command).toBe("opencode")
    expect(input.args).toEqual(["acp"])
    expect(input.cwd).toBe("/tmp/project")
    expect(input.env?.PATH).toBe("/usr/bin")
    expect(configOf(input.env as NodeJS.ProcessEnv)).toEqual({
      permission: { edit: "ask", bash: "ask", webfetch: "ask" },
    })
  })

  it("uses the resolved absolute binary and the deny policy", () => {
    const input = buildOpenCodeAcpSpawnInput(
      {
        binaryPath: "  C:\\Tools\\opencode.exe  ",
        permissionPolicy: "deny",
      },
      "C:\\work",
      {}
    )

    expect(input.command).toBe("C:\\Tools\\opencode.exe")
    expect(input.args).toEqual(["acp"])
    expect(input.cwd).toBe("C:\\work")
    expect(configOf(input.env as NodeJS.ProcessEnv)).toEqual({
      permission: { edit: "deny", bash: "deny", webfetch: "deny" },
    })
  })

  it("inherits process.env when no environment is supplied", () => {
    const inheritedConfig = process.env.OPENCODE_CONFIG_CONTENT
    delete process.env.OPENCODE_CONFIG_CONTENT
    try {
      const input = buildOpenCodeAcpSpawnInput(null, "/tmp/project")

      expect(input.command).toBe("opencode")
      expect(input.env?.PATH).toBe(process.env.PATH)
      expect(configOf(input.env as NodeJS.ProcessEnv)).toEqual({
        permission: { edit: "ask", bash: "ask", webfetch: "ask" },
      })
    } finally {
      if (inheritedConfig !== undefined) {
        process.env.OPENCODE_CONFIG_CONTENT = inheritedConfig
      }
    }
  })
})

describe("openCodePermissionConfigEnv", () => {
  it("asks before mutating the workspace by default", () => {
    const env = openCodePermissionConfigEnv({ PATH: "/bin" })

    expect(env.PATH).toBe("/bin")
    expect(configOf(env)).toEqual({
      permission: { edit: "ask", bash: "ask", webfetch: "ask" },
    })
  })

  it("denies mutating categories for unattended helpers", () => {
    expect(configOf(openCodePermissionConfigEnv({}, "deny"))).toEqual({
      permission: { edit: "deny", bash: "deny", webfetch: "deny" },
    })
  })

  it("merges an inherited JSON config without losing user settings", () => {
    const env = openCodePermissionConfigEnv(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "dark",
          permission: { bash: "allow", read: "allow" },
        }),
      },
      "deny"
    )

    expect(configOf(env)).toEqual({
      theme: "dark",
      permission: {
        bash: "deny",
        read: "allow",
        edit: "deny",
        webfetch: "deny",
      },
    })
  })

  it("replaces malformed inherited JSON instead of passing it through", () => {
    for (const malformed of ["{not json", "[]", '"text"', "null"]) {
      const env = openCodePermissionConfigEnv(
        { OPENCODE_CONFIG_CONTENT: malformed },
        "ask"
      )
      expect(() => configOf(env)).not.toThrow()
      expect(configOf(env), malformed).toEqual({
        permission: { edit: "ask", bash: "ask", webfetch: "ask" },
      })
    }
  })
})

describe("openCodeAuthError", () => {
  it("surfaces the login hint and the underlying cause", () => {
    const error = openCodeAuthError(new Error("401 Unauthorized"))

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("opencode auth login")
    expect(error.message).toContain("401 Unauthorized")
    expect(openCodeAuthError("no credentials").message).toContain(
      "no credentials"
    )
  })
})

describe("OPENCODE_RUNTIME_PROFILE", () => {
  it("declares OpenCode identity, no client fs/terminal, and lazy auth", () => {
    expect(OPENCODE_RUNTIME_PROFILE.label).toBe("OpenCode")
    expect(OPENCODE_RUNTIME_PROFILE.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    })
    expect(OPENCODE_RUNTIME_PROFILE.auth).toMatchObject({
      strategy: "lazy",
    })
    expect(OPENCODE_RUNTIME_PROFILE.buildSpawnInput).toBe(
      buildOpenCodeAcpSpawnInput
    )
  })
})
