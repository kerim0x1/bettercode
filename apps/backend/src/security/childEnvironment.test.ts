import { afterEach, describe, expect, it } from "vitest"
import {
  isSafeShellEnvironmentOverrideKey,
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
