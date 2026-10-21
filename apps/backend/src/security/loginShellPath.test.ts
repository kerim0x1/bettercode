import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetLoginShellPathForTests,
  isMinimalDarwinPath,
  LOGIN_SHELL_PATH_ENV,
  mergePathEntries,
  primeLoginShellPath,
} from "./loginShellPath"

afterEach(() => {
  __resetLoginShellPathForTests()
})

describe("login-shell PATH for Finder-launched macOS apps", () => {
  it("recognizes launchd's minimal PATH", () => {
    expect(isMinimalDarwinPath("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true)
    expect(
      isMinimalDarwinPath("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    ).toBe(false)
  })

  it("puts the login shell's entries first and never imports relative entries", () => {
    expect(
      mergePathEntries(
        "/opt/homebrew/bin:.:node_modules/.bin::/usr/bin",
        "/usr/bin:/bin"
      )
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin")
  })

  it("merges the resolved PATH once when the inherited one is minimal", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh",
    }
    const query = vi.fn(
      async () => "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin"
    )

    await primeLoginShellPath({
      platform: "darwin",
      env,
      queryLoginShellPath: query,
    })
    await primeLoginShellPath({
      platform: "darwin",
      env,
      queryLoginShellPath: query,
    })

    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith("/bin/zsh")
    expect(env.PATH).toBe(
      "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    )
  })

  it("prefers the PATH the Electron host already resolved", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      [LOGIN_SHELL_PATH_ENV]: "/opt/homebrew/bin:/usr/bin",
    }
    const query = vi.fn(async () => "/never")
    await primeLoginShellPath({
      platform: "darwin",
      env,
      queryLoginShellPath: query,
    })
    expect(query).not.toHaveBeenCalled()
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
  })

  it("falls back to the usual Homebrew directories when the shell gives nothing", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" }
    await primeLoginShellPath({
      platform: "darwin",
      env,
      queryLoginShellPath: async () => null,
      directoryExists: (directory) => directory === "/opt/homebrew/bin",
    })
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
  })

  it("leaves other platforms and full PATHs alone", async () => {
    const linux: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }
    const query = vi.fn(async () => "/opt/x")
    await primeLoginShellPath({
      platform: "linux",
      env: linux,
      queryLoginShellPath: query,
    })
    __resetLoginShellPathForTests()
    const terminal: NodeJS.ProcessEnv = { PATH: "/opt/homebrew/bin:/usr/bin" }
    await primeLoginShellPath({
      platform: "darwin",
      env: terminal,
      queryLoginShellPath: query,
    })
    expect(query).not.toHaveBeenCalled()
    expect(linux.PATH).toBe("/usr/bin:/bin")
    expect(terminal.PATH).toBe("/opt/homebrew/bin:/usr/bin")
  })
})
