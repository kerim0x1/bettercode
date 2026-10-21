import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServerConfig, resolveRuntimeHome } from "./config"

afterEach(() => {
  vi.unstubAllEnvs()
})

const root = path.join(os.tmpdir(), "bc0de-config-root")

describe("the runtime home, resolved once for the whole backend", () => {
  it("takes the folder the desktop passes, whatever the data folder is called", () => {
    vi.stubEnv("BETTERC0DE_HOME", path.join(root, "ignored"))
    const config = createServerConfig({
      dataDir: path.join(root, "custom-data"),
      runtimeHome: path.join(root, "desktop"),
    })
    expect(config.runtimeHome).toBe(path.join(root, "desktop"))
    vi.stubEnv("BETTERC0DE_RUNTIME_HOME", path.join(root, "from-env"))
    expect(
      createServerConfig({ dataDir: path.join(root, "custom-data") })
        .runtimeHome
    ).toBe(path.join(root, "from-env"))
  })

  it("falls back to BETTERC0DE_HOME, then the standard layout, then the data folder", () => {
    vi.stubEnv("BETTERC0DE_RUNTIME_HOME", "")
    vi.stubEnv("BETTERC0DE_HOME", path.join(root, "profile"))
    expect(resolveRuntimeHome(path.join(root, "anything"))).toBe(
      path.join(root, "profile")
    )
    vi.stubEnv("BETTERC0DE_HOME", "")
    expect(resolveRuntimeHome(path.join(root, "home", "userdata"))).toBe(
      path.join(root, "home")
    )
    expect(resolveRuntimeHome(path.join(root, "custom-data"))).toBe(
      path.join(root, "custom-data")
    )
  })

  it("refuses a relative runtime home", () => {
    expect(() => resolveRuntimeHome(root, "relative/home")).toThrow(
      /absolute filesystem path/
    )
  })
})
