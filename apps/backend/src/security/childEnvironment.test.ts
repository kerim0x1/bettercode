import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isSafeShellEnvironmentOverrideKey,
  restrictedChildEnvironment,
  sanitizedChildEnvironment,
  sanitizedShellEnvironment,
} from "./childEnvironment"
import { __resetMasterKeyCache, getMasterKey } from "../settings/crypto"

describe("sanitizedChildEnvironment", () => {
  afterEach(() => {
    delete process.env.BETTERC0DE_SETTINGS_KEY
    __resetMasterKeyCache()
  })

  it("never exposes the settings master key to child processes", () => {
    process.env.BETTERC0DE_SETTINGS_KEY = "master-key"

    expect(sanitizedChildEnvironment()).not.toHaveProperty(
      "BETTERC0DE_SETTINGS_KEY"
    )
    expect(
      sanitizedChildEnvironment({ BETTERC0DE_SETTINGS_KEY: "override" })
    ).not.toHaveProperty("BETTERC0DE_SETTINGS_KEY")
  })

  it("removes runtime loader-injection variables from inherited and override env", () => {
    process.env.NODE_OPTIONS = "--require ./inherited.js"
    process.env.DYLD_INSERT_LIBRARIES = "/tmp/inherited.dylib"
    try {
      expect(
        sanitizedChildEnvironment({
          BASH_ENV: "/tmp/bootstrap.sh",
          LD_PRELOAD: "/tmp/injected.so",
        })
      ).not.toMatchObject({
        NODE_OPTIONS: expect.anything(),
        DYLD_INSERT_LIBRARIES: expect.anything(),
        BASH_ENV: expect.anything(),
        LD_PRELOAD: expect.anything(),
      })
    } finally {
      delete process.env.NODE_OPTIONS
      delete process.env.DYLD_INSERT_LIBRARIES
    }
  })

  it("does not implicitly share one provider's credentials with other children", () => {
    process.env.OPENAI_API_KEY = "openai-secret"
    process.env.ANTHROPIC_API_KEY = "anthropic-secret"
    process.env.GITHUB_TOKEN = "github-secret"
    try {
      const generic = sanitizedChildEnvironment()
      expect(generic).not.toHaveProperty("OPENAI_API_KEY")
      expect(generic).not.toHaveProperty("ANTHROPIC_API_KEY")
      expect(generic).not.toHaveProperty("GITHUB_TOKEN")

      expect(
        sanitizedChildEnvironment({ OPENAI_API_KEY: "instance-secret" })
      ).toMatchObject({ OPENAI_API_KEY: "instance-secret" })
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GITHUB_TOKEN
    }
  })

  it("consumes the master key environment value when caching it", () => {
    process.env.BETTERC0DE_SETTINGS_KEY = Buffer.alloc(32, 4).toString("base64")
    __resetMasterKeyCache()

    expect(getMasterKey()).toHaveLength(32)
    expect(process.env.BETTERC0DE_SETTINGS_KEY).toBeUndefined()
  })

  it("does not expose provider or cloud credentials to shell processes", () => {
    process.env.OPENAI_API_KEY = "openai-secret"
    process.env.ANTHROPIC_API_KEY = "anthropic-secret"
    process.env.GITHUB_TOKEN = "github-secret"
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret"
    try {
      const env = sanitizedShellEnvironment({
        SAFE_FEATURE_FLAG: "enabled",
        CUSTOM_API_TOKEN: "override-secret",
      })

      expect(env.PATH).toBe(process.env.PATH)
      expect(env.SAFE_FEATURE_FLAG).toBe("enabled")
      expect(env).not.toHaveProperty("OPENAI_API_KEY")
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
      expect(env).not.toHaveProperty("GITHUB_TOKEN")
      expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
      expect(env).not.toHaveProperty("CUSTOM_API_TOKEN")
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GITHUB_TOKEN
      delete process.env.AWS_SECRET_ACCESS_KEY
    }
  })

  it("prevents command-scoped overrides from replacing executable lookup paths", () => {
    expect(isSafeShellEnvironmentOverrideKey("FEATURE_FLAG")).toBe(true)
    expect(isSafeShellEnvironmentOverrideKey("PATH")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("NODE_OPTIONS")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("LD_LIBRARY_PATH")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("PYTHONSTARTUP")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("GIT_SSH_COMMAND")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("SERVICE_PASSWORD")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("GIT_CONFIG_COUNT")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("GIT_CONFIG_KEY_0")).toBe(false)
    expect(isSafeShellEnvironmentOverrideKey("npm_config_script_shell")).toBe(
      false
    )
    expect(isSafeShellEnvironmentOverrideKey("GIT_AUTHOR_NAME")).toBe(true)

    const env = sanitizedShellEnvironment({
      PATH: "/attacker/bin",
      NODE_OPTIONS: "--require injected.js",
      FEATURE_FLAG: "on",
    })
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.FEATURE_FLAG).toBe("on")
  })
})

describe("provider and agent CLI environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("inherits the user's non-secret environment the agent's tools need", () => {
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock")
    vi.stubEnv("JAVA_HOME", "/opt/jdk")
    vi.stubEnv("GOPATH", "/home/me/go")
    vi.stubEnv("AWS_PROFILE", "dev")
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1")
    vi.stubEnv("GIT_AUTHOR_NAME", "Me")

    const env = sanitizedChildEnvironment()
    expect(env).toMatchObject({
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      JAVA_HOME: "/opt/jdk",
      GOPATH: "/home/me/go",
      AWS_PROFILE: "dev",
      CLAUDE_CODE_USE_BEDROCK: "1",
      GIT_AUTHOR_NAME: "Me",
    })
  })

  it("withholds credentials, internal variables and launcher artefacts", () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret")
    vi.stubEnv("AWS_SESSION_TOKEN", "aws-session")
    vi.stubEnv("DATABASE_PASSWORD", "db")
    vi.stubEnv("MYSERVICEPASSWORD", "db")
    vi.stubEnv("GH_TOKEN", "gh")
    vi.stubEnv("BETTERC0DE_INTERNAL_AUTH", "internal")
    vi.stubEnv("ELECTRON_NO_ATTACH_CONSOLE", "1")
    vi.stubEnv("npm_config_prefix", "/tmp/npm")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("CLAUDECODE", "1")

    const env = sanitizedChildEnvironment({ OPENAI_API_KEY: "instance" })
    for (const key of [
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DATABASE_PASSWORD",
      "MYSERVICEPASSWORD",
      "GH_TOKEN",
      "BETTERC0DE_INTERNAL_AUTH",
      "ELECTRON_NO_ATTACH_CONSOLE",
      "npm_config_prefix",
      "NODE_ENV",
      "CLAUDECODE",
    ]) {
      expect(env, key).not.toHaveProperty(key)
    }
    expect(env.OPENAI_API_KEY).toBe("instance")
  })

  it.runIf(process.platform === "win32")(
    "keeps cmd.exe from searching the workspace for provider launches",
    () => {
      expect(
        sanitizedChildEnvironment().NoDefaultCurrentDirectoryInExePath
      ).toBe("1")
      expect(
        restrictedChildEnvironment().NoDefaultCurrentDirectoryInExePath
      ).toBe("1")
      expect(sanitizedShellEnvironment()).not.toHaveProperty(
        "NoDefaultCurrentDirectoryInExePath"
      )
    }
  )
})

describe("backend helper environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("is an allowlist: unrelated variables such as GIT_DIR never reach git", () => {
    vi.stubEnv("GIT_DIR", "/elsewhere/.git")
    vi.stubEnv("JAVA_HOME", "/opt/jdk")
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock")
    const env = restrictedChildEnvironment()
    expect(env).not.toHaveProperty("GIT_DIR")
    expect(env).not.toHaveProperty("JAVA_HOME")
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock")
  })
})

describe("shell environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("keeps the SSH agent, session bus and Windows system variables", () => {
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock")
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000")
    vi.stubEnv("NUMBER_OF_PROCESSORS", "8")
    vi.stubEnv("PROGRAMDATA", "C:\\ProgramData")
    const env = sanitizedShellEnvironment()
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock")
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus")
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000")
    expect(env.NUMBER_OF_PROCESSORS).toBe("8")
    expect(env.PROGRAMDATA).toBe("C:\\ProgramData")
  })

  it("refuses overrides that make a shell run other code at startup or trace time", () => {
    for (const key of [
      "ZDOTDIR",
      "SHELLOPTS",
      "BASHOPTS",
      "PS4",
      "PROMPT_COMMAND",
      "BASH_XTRACEFD",
      "EDITOR",
      "PAGER",
      "JAVA_TOOL_OPTIONS",
      "GIT_ASKPASS",
      "CDPATH",
    ]) {
      expect(isSafeShellEnvironmentOverrideKey(key), key).toBe(false)
    }
    expect(isSafeShellEnvironmentOverrideKey("BETTERC0DE_HOOK_EVENT")).toBe(
      true
    )
  })
})
