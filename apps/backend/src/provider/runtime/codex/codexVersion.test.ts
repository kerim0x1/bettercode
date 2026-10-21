import { describe, expect, it } from "vitest"
import {
  MINIMUM_CODEX_APP_SERVER_VERSION,
  codexVersionAdvisory,
  parseCodexInitializeVersion,
} from "./codexVersion"

describe("Codex version negotiation", () => {
  it("reads the version from the initialize userAgent", () => {
    expect(
      parseCodexInitializeVersion({
        userAgent: "codex_cli_rs/0.141.0 (Windows 10.0.26100; x86_64) vscode",
      })
    ).toBe("0.141.0")
    expect(parseCodexInitializeVersion({})).toBeNull()
  })

  it("warns only for versions below the supported minimum", () => {
    expect(codexVersionAdvisory("0.40.2")).toContain(
      MINIMUM_CODEX_APP_SERVER_VERSION
    )
    expect(codexVersionAdvisory(MINIMUM_CODEX_APP_SERVER_VERSION)).toBeNull()
    // Unknown newer builds and unreadable versions are never blocked.
    expect(codexVersionAdvisory("9.9.9")).toBeNull()
    expect(codexVersionAdvisory("nightly")).toBeNull()
    expect(codexVersionAdvisory(null)).toBeNull()
  })

  it("treats an alpha build of the minimum release as supported", () => {
    expect(codexVersionAdvisory("0.50.0-alpha.3")).toBeNull()
    expect(codexVersionAdvisory("0.49.9-alpha.1")).toContain(
      MINIMUM_CODEX_APP_SERVER_VERSION
    )
  })
})
